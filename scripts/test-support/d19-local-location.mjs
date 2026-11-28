import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
export async function canonicalLocalLocation(path, allowRelative = false) {
    if (!isAbsolute(path) && !allowRelative) throw new Error('Record locations must be absolute paths.');
    const absolute = resolve(path);
    try {
        return await realpath(absolute);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = dirname(absolute);
        if (parent === absolute) throw error;
        return join(await canonicalLocalLocation(parent), basename(absolute));
    }
}
export const localLocationRecordKey = 'framework/local-locations';
export class LocalLocationMovedError extends Error {
    location;
    destination;
    constructor(location, destination){
        super('This local storage location has moved to ' + destination + '; the old copy must not reopen the same storage identity.'), this.location = location, this.destination = destination;
        this.name = 'LocalLocationMovedError';
    }
}
export class LocalLocationOutcomeUnknownError extends Error {
    commandId;
    constructor(commandId, cause){
        super('Local move receipt outcome is unknown; resolve the original command before continuing.', {
            cause
        }), this.commandId = commandId;
        this.name = 'LocalLocationOutcomeUnknownError';
    }
}
const queues = new WeakMap();
function serialized(storage, action) {
    const result = (queues.get(storage) ?? Promise.resolve()).catch(()=>{}).then(action);
    queues.set(storage, result.catch(()=>{}));
    return result;
}
function location(value) {
    if (!value || !isAbsolute(value) || normalize(value) !== value || value.includes('\0')) throw new Error('Use the physical copy operation’s canonical absolute location.');
}
function same(a, b) {
    return a.source === b.source && a.target === b.target && a.scope === b.scope && a.fingerprint === b.fingerprint;
}
export class LocalLocationRegistry {
    storage;
    constructor(storage){
        this.storage = storage;
    }
    async state() {
        const value = await this.storage.get(localLocationRecordKey);
        if (value === undefined) return {
            version: 1,
            moves: [],
            bindings: {}
        };
        if (value.version !== 1 || !Array.isArray(value.moves) || !value.bindings || typeof value.bindings !== 'object' || value.moves.some((move)=>!move.commandId || ![
                'prepared',
                'published',
                'applied'
            ].includes(move.phase) || typeof move.source !== 'string' || typeof move.target !== 'string' || typeof move.scope !== 'string' || typeof move.fingerprint !== 'string')) throw new Error('Invalid local location receipt record; inspect it before opening storage.');
        if (new Set(value.moves.map((move)=>move.commandId)).size !== value.moves.length) throw new Error('Duplicate local move command receipts.');
        for (const [path, binding] of Object.entries(value.bindings)){
            const receipt = binding && value.moves.find((move)=>move.commandId === binding.commandId);
            if (!receipt || receipt.phase === 'prepared' || binding.scope !== receipt.scope || (binding.state === 'current' ? path !== receipt.target : binding.state === 'departed' ? path !== receipt.source || binding.destination !== receipt.target : true)) throw new Error('Local location binding has no matching verified publication receipt.');
        }
        return structuredClone(value);
    }
    scope(state, canonical) {
        const binding = Object.hasOwn(state.bindings, canonical) ? state.bindings[canonical] : undefined;
        if (binding?.state === 'departed') throw new LocalLocationMovedError(canonical, binding.destination);
        if (binding && (binding.state !== 'current' || typeof binding.scope !== 'string')) throw new Error('Invalid local location binding.');
        if (state.moves.some((move)=>move.phase === 'prepared' && move.target === canonical)) throw new Error('This location has a pending explicit move; resolve its original command before opening it.');
        return binding?.scope ?? JSON.stringify([
            'local',
            canonical
        ]);
    }
    async resolve(canonical) {
        location(canonical);
        return this.scope(await this.state(), canonical);
    }
    async receipt(commandId) {
        return (await this.state()).moves.find((move)=>move.commandId === commandId);
    }
    async save(state, commandId) {
        try {
            await this.storage.set(localLocationRecordKey, structuredClone(state));
        } catch (error) {
            throw new LocalLocationOutcomeUnknownError(commandId, error);
        }
    }
    prepare(commandId, identity) {
        return serialized(this.storage, async ()=>{
            location(identity.source);
            location(identity.target);
            if (!commandId || !identity.scope || !identity.fingerprint || identity.source === identity.target) throw new Error('An explicit move requires distinct locations and its verified source identity.');
            const state = await this.state(), prior = state.moves.find((move)=>move.commandId === commandId);
            if (prior) {
                if (!same(prior, identity)) throw new Error('Move command identity was reused with another source, target or fingerprint.');
                return prior;
            }
            if (this.scope(state, identity.source) !== identity.scope) throw new Error('Move source does not own the supplied logical scope.');
            if (state.moves.some((move)=>move.phase !== 'applied' && [
                    move.source,
                    move.target
                ].some((path)=>path === identity.source || path === identity.target))) throw new Error('Resolve the existing move involving these locations first.');
            const target = state.bindings[identity.target];
            if (target && target.scope !== identity.scope) throw new Error('Move destination already belongs to another verified storage scope.');
            const receipt = {
                ...identity,
                commandId,
                phase: 'prepared'
            };
            state.moves.push(receipt);
            await this.save(state, commandId);
            return receipt;
        });
    }
    publish(commandId, verified) {
        return serialized(this.storage, async ()=>{
            const state = await this.state(), receipt = state.moves.find((move)=>move.commandId === commandId);
            if (!receipt || !same(receipt, verified)) throw new Error('Physical publication must match the original prepared move exactly.');
            if (receipt.phase !== 'prepared') return receipt;
            if (this.scope(state, receipt.source) !== receipt.scope) throw new Error('Move source identity changed before publication.');
            state.bindings[receipt.source] = {
                scope: receipt.scope,
                state: 'departed',
                commandId,
                destination: receipt.target
            };
            state.bindings[receipt.target] = {
                scope: receipt.scope,
                state: 'current',
                commandId
            };
            receipt.phase = 'published';
            await this.save(state, commandId);
            return receipt;
        });
    }
    applied(commandId) {
        return serialized(this.storage, async ()=>{
            const state = await this.state(), receipt = state.moves.find((move)=>move.commandId === commandId);
            if (!receipt || receipt.phase === 'prepared') throw new Error('Only a verified published move can be applied.');
            if (receipt.phase === 'applied') return receipt;
            receipt.phase = 'applied';
            await this.save(state, commandId);
            return receipt;
        });
    }
}
