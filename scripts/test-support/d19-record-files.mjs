import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
const descriptor = {
    name: 'record',
    version: 1,
    tables: [
        'records'
    ],
    hasGlobal: false
};
const LAYOUT = {
    format: 'deepseek-servant-record-folders',
    version: 1
};
export const recordCategories = [
    'tasks',
    'assistants',
    'skills',
    'knowledge/facts',
    'knowledge/preferences',
    'settings',
    'other',
    'work-planning',
    'archives',
    'conversations'
];
export function recordFolder(key) {
    const category = key.startsWith('task:') ? 'tasks' : key.startsWith('foreground-memory/') ? 'work-planning' : [
        'records/',
        'record-archive/',
        'task-history/',
        'tombstone/'
    ].some((prefix)=>key.startsWith(prefix)) ? 'archives' : key.startsWith('assistant-history/') && key.includes('/delivery/') ? 'archives' : key.startsWith('conversation') || key.startsWith('assistant-history/') ? 'conversations' : key.startsWith('assistant/') ? 'assistants' : key.startsWith('knowledge/skills/') ? 'skills' : key.startsWith('knowledge/facts/') ? 'knowledge/facts' : key.startsWith('knowledge/preferences/') ? 'knowledge/preferences' : key.startsWith('retention/') || key.startsWith('settings/') ? 'settings' : 'other';
    const label = (key.split(/[/:]/).at(-1) ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32).toLowerCase() || 'record';
    return path.join(category, label + '--' + createHash('sha256').update(key).digest('hex'));
}
export async function recordFileUsage(directory, keys) {
    const identities = new Map([
        ...keys
    ].map((key)=>[
            recordFolder(key),
            key
        ]));
    const result = [];
    async function visit(relative = '') {
        let entries;
        try {
            entries = await readdir(path.join(directory, relative), {
                withFileTypes: true
            });
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries){
            const child = path.join(relative, entry.name);
            if (entry.isDirectory()) await visit(child);
            else {
                const info = await lstat(path.join(directory, child)).catch((error)=>{
                    if (error.code === 'ENOENT') return undefined;
                    throw error;
                });
                if (info) result.push({
                    key: identities.get(relative),
                    path: child.replaceAll(path.sep, '/'),
                    bytes: info.size
                });
            }
        }
    }
    await visit();
    return result;
}
export class RecordFilesBackend {
    directory;
    files = new Map();
    opened = false;
    faults = new Map();
    recovered = false;
    problems() {
        return [
            ...this.faults.values()
        ].map((error)=>error.message);
    }
    assertReadable(key) {
        const error = this.faults.get(recordFolder(key));
        if (error) throw error;
    }
    async retryFaults() {
        for (const relative of [
            ...this.faults.keys()
        ]){
            try {
                await this.readRecord(relative);
                this.recovered = true;
            } catch  {}
        }
        return this.recovered;
    }
    closing;
    constructor(directory){
        this.directory = directory;
    }
    kv = {
        open: async (input)=>{
            this.assertOpen();
            if (this.opened) throw new Error('Servant record tree is already open.');
            if (input.name !== 'deepseek_servant' || input.version !== 1 || input.hasGlobal || input.tables.length !== 1 || input.tables[0] !== 'records') throw new Error('Unexpected Servant record domain.');
            this.opened = true;
            return {
                loadAll: ()=>this.loadAll(),
                putRecord: async (table, key, value)=>{
                    this.assertTable(table);
                    if (this.faults.has(recordFolder(key))) await this.readRecord(recordFolder(key));
                    const file = await this.openFile(recordFolder(key));
                    await file.unit.putRecord('records', key, value);
                },
                deleteRecord: async (table, key)=>{
                    this.assertTable(table);
                    const relative = recordFolder(key);
                    this.assertReadable(key);
                    const file = this.files.get(relative);
                    if (!file) return;
                    await mkdir(path.join(this.directory, relative), {
                        recursive: true
                    });
                    await file.unit.deleteRecord('records', key);
                    await file.backend.close();
                    this.files.delete(relative);
                    await rm(path.join(this.directory, relative), {
                        recursive: true,
                        force: true
                    });
                },
                setGlobal: async ()=>{
                    throw new Error('Servant records have no global slot.');
                },
                close: ()=>this.close()
            };
        }
    };
    close() {
        return this.closing ??= Promise.all([
            ...this.files.values()
        ].map((file)=>file.backend.close())).then(()=>{
            this.files.clear();
        });
    }
    assertOpen() {
        if (this.closing) throw new Error('Servant record tree is closed.');
    }
    assertTable(table) {
        this.assertOpen();
        if (table !== 'records') throw new Error('Unknown Servant record table: ' + table);
    }
    async openFile(relative) {
        this.assertOpen();
        await mkdir(path.join(this.directory, relative), {
            recursive: true
        });
        const existing = this.files.get(relative);
        if (existing) return existing;
        const backend = new JsonStorageBackend(path.join(this.directory, relative));
        try {
            const unit = await backend.kv.open(descriptor);
            const file = {
                backend,
                unit
            };
            this.files.set(relative, file);
            return file;
        } catch (error) {
            await backend.close();
            throw error;
        }
    }
    async readRecord(relative) {
        const filePath = path.join(this.directory, relative, 'record.json');
        try {
            const file = await this.openFile(relative);
            const snapshot = await file.unit.loadAll();
            const entries = Object.entries(snapshot.tables.records ?? {});
            if (entries.length > 1) throw new Error('每个记录文件只能保存一个记录');
            for (const [key, value] of entries){
                const target = recordFolder(key);
                if (path.dirname(target) !== 'other' && relative === path.join('other', path.basename(target)) && value && typeof value === 'object' && 'key' in value && value.key === key && 'value' in value) {
                    const destination = await this.openFile(target);
                    const saved = await destination.unit.loadAll();
                    if (!Object.keys(saved.tables.records ?? {}).length) await destination.unit.putRecord('records', key, value);
                    const migrated = await this.readRecord(target);
                    await file.unit.deleteRecord('records', key);
                    await file.backend.close();
                    this.files.delete(relative);
                    try {
                        await unlink(filePath);
                        await rmdir(path.join(this.directory, relative));
                    } catch  {}
                    this.faults.delete(relative);
                    return migrated;
                }
                if (recordFolder(key) !== relative || !value || typeof value !== 'object' || !('key' in value) || value.key !== key || !('value' in value)) throw new Error('记录路径、身份或封装不匹配');
            }
            this.faults.delete(relative);
            return entries;
        } catch (reason) {
            const error = new Error(filePath + ': ' + (reason instanceof Error ? reason.message : String(reason)));
            if (this.faults.get(relative)?.message !== error.message) console.error('deepseek-servant record', error.message);
            this.faults.set(relative, error);
            const file = this.files.get(relative);
            this.files.delete(relative);
            await file?.backend.close();
            throw error;
        }
    }
    async loadAll() {
        this.assertOpen();
        const records = Object.create(null);
        for (const category of recordCategories){
            const categoryPath = path.join(this.directory, category);
            const kind = await lstat(categoryPath).catch((error)=>{
                if (error.code === 'ENOENT') return undefined;
                throw error;
            });
            if (!kind) continue;
            if (!kind.isDirectory() || kind.isSymbolicLink()) throw new Error('记录分类目录不是普通文件夹：' + categoryPath);
            for (const entry of (await readdir(categoryPath, {
                withFileTypes: true
            }))){
                if (entry.isSymbolicLink()) throw new Error('记录目录不能是符号链接：' + entry.name);
                if (!entry.isDirectory()) continue;
                const relative = path.join(category, entry.name);
                const filePath = path.join(this.directory, relative, 'record.json');
                const fileKind = await lstat(filePath).catch((error)=>{
                    if (error.code === 'ENOENT') return undefined;
                    throw error;
                });
                if (!fileKind) continue;
                if (!fileKind.isFile() || fileKind.isSymbolicLink()) throw new Error('记录不是普通文件：' + filePath);
                try {
                    for (const [key, value] of (await this.readRecord(relative)))records[key] = value;
                } catch  {}
            }
        }
        return {
            tables: {
                records
            },
            global: null
        };
    }
}
export async function ensureRecordTree(directory) {
    await mkdir(directory, {
        recursive: true
    });
    const kind = await lstat(directory);
    if (!kind.isDirectory() || kind.isSymbolicLink()) throw new Error('Servant 记录目录不是普通文件夹：' + directory);
    const marker = path.join(directory, 'layout.json');
    let created = false;
    let text;
    try {
        text = await readFile(marker, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (text === undefined) {
        const handle = await open(marker, 'wx');
        try {
            await handle.writeFile(JSON.stringify(LAYOUT, null, 2) + '\n', 'utf8');
            await handle.sync();
        } finally{
            await handle.close();
        }
        created = true;
    } else {
        let layout;
        try {
            layout = JSON.parse(text);
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            const suffix = randomUUID();
            await mkdir(path.join(directory, 'backups'), {
                recursive: true
            });
            await copyFile(marker, path.join(directory, 'backups', 'layout-' + suffix + '.json'));
            const temporary = marker + '.' + suffix + '.tmp';
            await writeFile(temporary, JSON.stringify(LAYOUT, null, 2) + '\n', {
                flag: 'wx'
            });
            await rename(temporary, marker);
            layout = LAYOUT;
        }
        if (!isDeepStrictEqual(layout, LAYOUT)) throw new Error('不支持的 Servant 记录目录格式：' + directory);
    }
    for (const category of [
        ...recordCategories,
        'backups'
    ])await mkdir(path.join(directory, category), {
        recursive: true
    });
    return created;
}
