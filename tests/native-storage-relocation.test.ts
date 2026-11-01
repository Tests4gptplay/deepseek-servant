import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage, { type KvFacet } from '@deepseek-ai/dsh-storage';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { DomainFacility, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { DshStorageAdapter } from '../src/adapters/dsh/storage.js';
import { RecordFilesBackend } from '../src/adapters/dsh/record-files.js';
import { z } from 'zod';
async function fixture(t: test.TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'dss-native-relocation-')), ctx = new Context();
    await ctx.plugin(Storage);
    const backend = new JsonStorageBackend(join(root, 'native'));
    const failure = new Error('synthetic active-location acknowledgement loss');
    const state = { failWrite: '' as '' | 'before' | 'after', failRead: false, failReadAfterWriteFailure: false };
    const kv: KvFacet = { open: async (descriptor) => {
            if (descriptor.name === 'deepseek_servant_location' && state.failRead)
                throw new Error('synthetic locator read unavailable');
            const unit = await backend.kv.open(descriptor);
            if (descriptor.name !== 'deepseek_servant_location')
                return unit;
            return { loadAll: () => unit.loadAll(), setGlobal: value => unit.setGlobal(value),
                deleteRecord: (table, key) => unit.deleteRecord(table, key), close: () => unit.close(),
                putRecord: async (table, key, value) => {
                    const fail = descriptor.name === 'deepseek_servant_location' ? state.failWrite : '';
                    if (fail)
                        state.failWrite = '';
                    if (fail === 'before') {
                        state.failRead ||= state.failReadAfterWriteFailure;
                        throw failure;
                    }
                    await unit.putRecord(table, key, value);
                    if (fail === 'after') {
                        state.failRead ||= state.failReadAfterWriteFailure;
                        throw failure;
                    }
                } };
        } };
    const unregister = ctx.storage.backend.register('relocation-fixture', { kv, close: () => backend.close() });
    const facility = new DomainFacility(ctx, { backend: 'relocation-fixture' });
    ctx.provide('storageDomain', facility);
    let store = await DshStorageAdapter.open(ctx);
    t.after(async () => { await store.close(); await facility.closeAll(); await ctx.fiber.dispose(); await backend.close(); unregister(); await rm(root, { recursive: true, force: true }); });
    return { root, ctx, state, failure, get store() { return store; }, reopen: async () => { await store.close(); store = await DshStorageAdapter.open(ctx); return store; } };
}
test('native relocation resolves an actually committed locator after lost acknowledgement without deleting the selected records', async (t) => {
    const f = await fixture(t);
    await f.store.set('history/keep', { text: '完整原文🙂' });
    const source = f.store.recordsDirectory(), destination = join(f.root, 'moved');
    f.state.failWrite = 'after';
    const result = await f.store.moveRecords(destination, source, new AbortController().signal);
    assert.equal(result.directory, destination);
    assert.equal((await stat(join(destination, 'deepseek_servant'))).isDirectory(), true);
    assert.deepEqual(await f.store.get('history/keep'), { text: '完整原文🙂' });
    const reopened = await f.reopen();
    assert.equal(reopened.recordsDirectory(), destination);
    assert.deepEqual(await reopened.get('history/keep'), { text: '完整原文🙂' });
});
test('native relocation with a proven uncommitted locator preserves the original store and rolls back only its new target', async (t) => {
    const f = await fixture(t);
    await f.store.set('history/keep', { value: 17 });
    const source = f.store.recordsDirectory(), destination = join(f.root, 'not-selected');
    f.state.failWrite = 'before';
    await assert.rejects(f.store.moveRecords(destination, source, new AbortController().signal), error => error === f.failure);
    assert.equal(f.store.recordsDirectory(), source);
    assert.deepEqual(await f.store.get('history/keep'), { value: 17 });
    await assert.rejects(stat(join(destination, 'deepseek_servant')), { code: 'ENOENT' });
    assert.equal((await f.reopen()).recordsDirectory(), source);
});
test('startup locator acknowledgement loss reopens its actual persisted location instead of failing a committed selection', async (t) => {
    const f = await fixture(t);
    await f.store.set('history/startup', { value: 'preserved' });
    f.state.failWrite = 'after';
    const reopened = await f.reopen();
    assert.deepEqual(await reopened.get('history/startup'), { value: 'preserved' });
});
test('published filesystem verification runs before location selection and preserves the source when it rejects', async (t) => {
    const f = await fixture(t);
    await f.store.set('history/verify', { exact: 'keep' });
    const source = f.store.recordsDirectory(), destination = join(f.root, 'verification-fails');
    const failure = new Error('synthetic framework SQLite verification failure');
    let called = 0;
    await assert.rejects(f.store.moveRecords(destination, source, new AbortController().signal, async (target) => {
        called++;
        assert.equal(target, destination);
        assert.equal((await stat(join(target, 'deepseek_servant'))).isDirectory(), true);
        assert.equal((await stat(join(source, 'deepseek_servant'))).isDirectory(), true);
        throw failure;
    }), error => error === failure);
    assert.equal(called, 1);
    assert.equal(f.store.recordsDirectory(), source);
    assert.deepEqual(await f.store.get('history/verify'), { exact: 'keep' });
    await assert.rejects(stat(join(destination, 'deepseek_servant')), { code: 'ENOENT' });
});
for (const phase of ['before', 'after'] as const)
    test(`unknown locator ${phase} commit retains both trees and blocks writes until fresh native readback`, async (t) => {
        const f = await fixture(t);
        await f.store.set('history/unknown', { exact: 'original' });
        const source = f.store.recordsDirectory(), destination = join(f.root, 'unknown-' + phase);
        f.state.failWrite = phase;
        f.state.failReadAfterWriteFailure = true;
        await assert.rejects(f.store.moveRecords(destination, source, new AbortController().signal), /could not be confirmed/);
        assert.equal((await stat(join(source, 'deepseek_servant'))).isDirectory(), true);
        assert.equal((await stat(join(destination, 'deepseek_servant'))).isDirectory(), true);
        await assert.rejects(f.store.set('history/blocked', { mustNotWrite: true }), /read unavailable/);
        f.state.failRead = false;
        f.state.failReadAfterWriteFailure = false;
        assert.deepEqual(await f.store.get('history/unknown'), { exact: 'original' });
        assert.equal(await f.store.get('history/blocked'), undefined);
        assert.equal(f.store.recordsDirectory(), phase === 'after' ? destination : source);
        await f.store.set('history/after-resolution', { accepted: true });
        const reopened = await f.reopen();
        assert.deepEqual(await reopened.get('history/after-resolution'), { accepted: true });
    });
// Independent real-native fault boundaries: synthetic directories and exact owned handles only.
async function independentFixture(t: test.TestContext, cold = false) {
    const root = await mkdtemp(join(tmpdir(), 'dss-independent-relocation-')), ctx = new Context();
    await ctx.plugin(Storage);
    const backend = new JsonStorageBackend(join(root, 'native')), failure = new Error('synthetic location write uncertainty');
    const expectedFreshCloseFailure = new Error('synthetic fresh locator close lost acknowledgement');
    const state = { write: '' as '' | 'before' | 'after' | 'other-shape', read: false, readAfter: false, closeFresh: false, opens: 0 };
    const kv: KvFacet = { open: async (descriptor) => {
            if (descriptor.name === 'deepseek_servant_location' && state.read)
                throw new Error('synthetic location medium unavailable');
            const unit = await backend.kv.open(descriptor);
            if (descriptor.name !== 'deepseek_servant_location')
                return unit;
            const ordinal = ++state.opens;
            return { loadAll: () => unit.loadAll(), setGlobal: v => unit.setGlobal(v), deleteRecord: (a, b) => unit.deleteRecord(a, b), close: async () => { await unit.close(); if (state.closeFresh && ordinal === 2)
                    throw expectedFreshCloseFailure; }, putRecord: async (a, b, v) => {
                    const fail = state.write;
                    state.write = '';
                    if (fail === 'before') {
                        state.read = state.readAfter;
                        throw failure;
                    }
                    await unit.putRecord(a, b, fail === 'other-shape' ? { directory: (v as any).directory } : v);
                    if (fail) {
                        state.read = state.readAfter;
                        throw failure;
                    }
                } };
        } };
    const unregister = ctx.storage.backend.register('independent-relocation', { kv, close: () => backend.close() }), facility = new DomainFacility(ctx, { backend: 'independent-relocation' });
    ctx.provide('storageDomain', facility);
    let store: DshStorageAdapter | undefined;
    if (cold) {
        const legacy = await facility.open(defineDomain({ name: 'deepseek_servant', version: 1, tables: { records: domainTable<string, {
                    key: string;
                    value: any;
                }>(z.object({ key: z.string(), value: z.json() })) } }));
        await legacy.table('records').put('history/keep', { key: 'history/keep', value: { original: '完整🙂' } });
        await legacy.close();
    }
    else
        store = await DshStorageAdapter.open(ctx);
    t.after(async () => {
        const failures: unknown[] = [];
        // The injected fresh-close failure happened after native unit release. The
        // Domain retains that exact rejected disposal; no other teardown is ignored.
        for (const close of [() => store?.close(), () => facility.closeAll(), () => backend.close(), () => ctx.fiber.dispose()]) {
            try {
                await close();
            }
            catch (error) {
                if (error !== expectedFreshCloseFailure)
                    failures.push(error);
            }
        }
        unregister();
        if (failures.length)
            throw new AggregateError(failures, 'Independent native fixture teardown failed; synthetic evidence retained.');
        await rm(root, { recursive: true, force: true });
    });
    return { root, ctx, state, failure, facility, backend, get store() { return store!; }, open: async () => { store = await DshStorageAdapter.open(ctx); return store; } };
}
for (const phase of ['before', 'after'] as const)
    test(`independent: unknown ${phase} commit then close/restart preserves both trees and selects the durable owner`, async (t) => {
        const f = await independentFixture(t);
        await f.store.set('history/keep', { original: '完整🙂' });
        const source = f.store.recordsDirectory(), destination = join(f.root, 'target');
        f.state.write = phase;
        f.state.readAfter = true;
        await assert.rejects(f.store.moveRecords(destination, source, new AbortController().signal), /could not be confirmed/);
        await f.store.close();
        await assert.rejects(f.store.set('late', 1), /closed/);
        for (const dir of [source, destination])
            assert.ok((await stat(join(dir, 'deepseek_servant'))).isDirectory());
        f.state.read = false;
        f.state.readAfter = false;
        const restarted = await f.open();
        assert.equal(restarted.recordsDirectory(), phase === 'after' ? destination : source);
        assert.deepEqual(await restarted.get('history/keep'), { original: '完整🙂' });
        await restarted.set('after-restart', 17);
        for (const dir of [source, destination])
            assert.ok((await stat(join(dir, 'deepseek_servant'))).isDirectory(), 'restart never guesses deletion of an uncertain retained copy');
    });
test('independent: caller cancellation after published verification but before locator dispatch rolls back only new target', async (t) => {
    const f = await independentFixture(t);
    await f.store.set('history/keep', 17);
    const source = f.store.recordsDirectory(), destination = join(f.root, 'target'), owner = new AbortController(), reason = new Error('user cancelled exact move');
    await assert.rejects(f.store.moveRecords(destination, source, owner.signal, async () => { owner.abort(reason); }), e => e === reason);
    assert.equal(f.store.recordsDirectory(), source);
    assert.equal(await f.store.get('history/keep'), 17);
    await assert.rejects(stat(join(destination, 'deepseek_servant')), { code: 'ENOENT' });
    await f.store.close();
    assert.equal((await f.open()).recordsDirectory(), source);
});
test('independent: filesystem verification failure never switches locator or removes original', async (t) => {
    const f = await independentFixture(t);
    await f.store.set('history/keep', 17);
    const source = f.store.recordsDirectory(), destination = join(f.root, 'target'), failure = new Error('exact FS verification failure');
    await assert.rejects(f.store.moveRecords(destination, source, new AbortController().signal, async () => { throw failure; }), e => e === failure);
    assert.equal(await f.store.get('history/keep'), 17);
    await f.store.close();
    assert.equal((await f.open()).recordsDirectory(), source);
    await assert.rejects(stat(join(destination, 'deepseek_servant')), { code: 'ENOENT' });
});
for (const readAfter of [false, true])
    test(`independent: cold split locator loss with readback ${readAfter ? 'unavailable' : 'available'} never removes an actually selected tree`, async (t) => {
        const f = await independentFixture(t, true);
        f.state.write = 'after';
        f.state.readAfter = readAfter;
        if (readAfter)
            await assert.rejects(f.open(), /could not be confirmed/);
        else
            await f.open();
        assert.ok((await stat(join(f.root, 'native', 'deepseek_servant'))).isDirectory());
        if (readAfter) {
            assert.ok((await stat(join(f.root, 'native', 'deepseek_servant.json'))).isFile());
            f.state.read = false;
            f.state.readAfter = false;
            await f.open();
        }
        assert.deepEqual(await f.store.get('history/keep'), { original: '完整🙂' });
    });
test('independent: source-close failure retains source after target became active', async (t) => {
    const f = await independentFixture(t);
    await f.store.set('history/keep', 17);
    const source = f.store.recordsDirectory(), destination = join(f.root, 'target'), original = RecordFilesBackend.prototype.close;
    let triggered = false;
    RecordFilesBackend.prototype.close = function () { if ((this as any).directory === join(source, 'deepseek_servant') && !triggered) {
        triggered = true;
        return original.call(this).then(() => { throw new Error('synthetic source close acknowledgement loss'); });
    } return original.call(this); };
    try {
        const result = await f.store.moveRecords(destination, source, new AbortController().signal);
        assert.ok(triggered);
        assert.equal(result.directory, destination);
        assert.equal(result.retainedSource, source);
        assert.ok((await stat(join(source, 'deepseek_servant'))).isDirectory());
        assert.equal(await f.store.get('history/keep'), 17);
    }
    finally {
        RecordFilesBackend.prototype.close = original;
    }
});
test('independent: ambiguous persisted locator plus fresh-close failure must retain possibly selected target', async (t) => {
    const f = await independentFixture(t);
    await f.store.set('history/keep', 17);
    const source = f.store.recordsDirectory(), destination = join(f.root, 'target');
    f.state.write = 'other-shape';
    f.state.closeFresh = true;
    await assert.rejects(f.store.moveRecords(destination, source, new AbortController().signal));
    const native = JSON.parse(await readFile(join(f.root, 'native', 'deepseek_servant_location.json'), 'utf8'));
    assert.ok(JSON.stringify(native).includes(destination), 'real JSON locator points to destination with optional layout absent');
    assert.ok((await stat(join(destination, 'deepseek_servant'))).isDirectory(), 'possibly active target must not be deleted on a failed readback teardown');
});
function containsError(error: unknown, expected: unknown): boolean {
    if (error === expected)
        return true;
    if (error instanceof AggregateError && error.errors.some(item => containsError(item, expected)))
        return true;
    return error instanceof Error && error.cause !== undefined && containsError(error.cause, expected);
}
test('independent: cold startup failure closes all owned handles and preserves primary plus teardown errors', async (t) => {
    const f = await independentFixture(t, true), closeFailure = new Error('synthetic published records close acknowledgement loss'), original = RecordFilesBackend.prototype.close;
    RecordFilesBackend.prototype.close = function () { const closing = original.call(this); return (this as any).directory === join(f.root, 'native', 'deepseek_servant') ? closing.then(() => { throw closeFailure; }) : closing; };
    let error: unknown;
    try {
        f.state.write = 'before';
        await f.open();
    }
    catch (e) {
        error = e;
    }
    finally {
        RecordFilesBackend.prototype.close = original;
    }
    const facts = { originalErrorRetained: containsError(error, f.failure), closeErrorRetained: containsError(error, closeFailure), locatorHandleReleased: f.facility.get('deepseek_servant_location') === undefined, legacyHandleReleased: f.facility.get('deepseek_servant') === undefined };
    t.diagnostic(JSON.stringify(facts));
    assert.ok((await stat(join(f.root, 'native', 'deepseek_servant'))).isDirectory(), 'failed close must not guess target removal');
    assert.ok((await stat(join(f.root, 'native', 'deepseek_servant.json'))).isFile(), 'original legacy source stays');
    assert.deepEqual(facts, { originalErrorRetained: true, closeErrorRetained: true, locatorHandleReleased: true, legacyHandleReleased: true });
});
test('independent: move failure preserves original verification error when target close also loses acknowledgement', async (t) => {
    const f = await independentFixture(t);
    await f.store.set('history/keep', 17);
    const source = f.store.recordsDirectory(), destination = join(f.root, 'target'), primary = new Error('synthetic exact verification rejection'), closeFailure = new Error('synthetic target close acknowledgement loss'), original = RecordFilesBackend.prototype.close;
    RecordFilesBackend.prototype.close = function () { const closing = original.call(this); return (this as any).directory === join(destination, 'deepseek_servant') ? closing.then(() => { throw closeFailure; }) : closing; };
    let error: unknown;
    try {
        await f.store.moveRecords(destination, source, new AbortController().signal, async () => { throw primary; });
    }
    catch (e) {
        error = e;
    }
    finally {
        RecordFilesBackend.prototype.close = original;
    }
    t.diagnostic(JSON.stringify({ originalErrorRetained: containsError(error, primary), closeErrorRetained: containsError(error, closeFailure) }));
    assert.equal(await f.store.get('history/keep'), 17);
    assert.ok((await stat(join(destination, 'deepseek_servant'))).isDirectory(), 'uncertain teardown copy retained');
    assert.ok(containsError(error, primary), 'preserve the original caller-visible failure');
    assert.ok(containsError(error, closeFailure), 'also report owned handle close failure');
});
