// src/framework/dispose-resources.ts
async function disposeResources(steps) {
  const errors = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "DSS resource disposal failed.");
}

// src/host.ts
import { z as z9 } from "zod";
import { join as join5 } from "node:path";

// src/adapters/dsh/storage.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { constants } from "node:fs";
import { copyFile as copyFile2, cp, lstat as lstat2, mkdir as mkdir2, open as open2, readdir as readdir2, realpath, rename as rename2, rm as rm2, stat, unlink as unlink2 } from "node:fs/promises";
import path2 from "node:path";
import { isDeepStrictEqual as isDeepStrictEqual2 } from "node:util";
import { defineDomain, domainTable, DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend as JsonStorageBackend2 } from "@deepseek-ai/dsh-storage-json";
import { z } from "zod";

// src/adapters/dsh/json-record.ts
function omitAbsentFields(value, ancestors = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  if (ancestors.has(value)) throw new TypeError("Storage records cannot contain circular references.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => omitAbsentFields(item, ancestors));
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== void 0).map(([key, item]) => [key, omitAbsentFields(item, ancestors)]));
  } finally {
    ancestors.delete(value);
  }
}

// src/adapters/dsh/record-files.ts
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
var descriptor = { name: "record", version: 1, tables: ["records"], hasGlobal: false };
var LAYOUT = { format: "deepseek-servant-record-folders", version: 1 };
var recordCategories = ["tasks", "assistants", "skills", "knowledge/facts", "knowledge/preferences", "settings", "other", "work-planning", "archives", "conversations"];
function recordFolder(key) {
  const category = key.startsWith("task:") ? "tasks" : key.startsWith("foreground-memory/") ? "work-planning" : ["records/", "record-archive/", "task-history/", "tombstone/"].some((prefix) => key.startsWith(prefix)) ? "archives" : key.startsWith("assistant-history/") && key.includes("/delivery/") ? "archives" : key.startsWith("conversation") || key.startsWith("assistant-history/") ? "conversations" : key.startsWith("assistant/") ? "assistants" : key.startsWith("knowledge/skills/") ? "skills" : key.startsWith("knowledge/facts/") ? "knowledge/facts" : key.startsWith("knowledge/preferences/") ? "knowledge/preferences" : key.startsWith("retention/") || key.startsWith("settings/") ? "settings" : "other";
  const label = (key.split(/[/:]/).at(-1) ?? "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32).toLowerCase() || "record";
  return path.join(category, label + "--" + createHash("sha256").update(key).digest("hex"));
}
async function recordFileUsage(directory, keys) {
  const identities = new Map([...keys].map((key) => [recordFolder(key), key]));
  const result = [];
  async function visit(relative2 = "") {
    let entries;
    try {
      entries = await readdir(path.join(directory, relative2), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(relative2, entry.name);
      if (entry.isDirectory()) await visit(child);
      else {
        const info = await lstat(path.join(directory, child)).catch((error) => {
          if (error.code === "ENOENT") return void 0;
          throw error;
        });
        if (info) result.push({ key: identities.get(relative2), path: child.replaceAll(path.sep, "/"), bytes: info.size });
      }
    }
  }
  await visit();
  return result;
}
var RecordFilesBackend = class {
  constructor(directory) {
    this.directory = directory;
  }
  files = /* @__PURE__ */ new Map();
  opened = false;
  faults = /* @__PURE__ */ new Map();
  recovered = false;
  problems() {
    return [...this.faults.values()].map((error) => error.message);
  }
  assertReadable(key) {
    const error = this.faults.get(recordFolder(key));
    if (error) throw error;
  }
  async retryFaults() {
    for (const relative2 of [...this.faults.keys()]) {
      try {
        await this.readRecord(relative2);
        this.recovered = true;
      } catch {
      }
    }
    return this.recovered;
  }
  closing;
  kv = {
    open: async (input) => {
      this.assertOpen();
      if (this.opened) throw new Error("Servant record tree is already open.");
      if (input.name !== "deepseek_servant" || input.version !== 1 || input.hasGlobal || input.tables.length !== 1 || input.tables[0] !== "records") throw new Error("Unexpected Servant record domain.");
      this.opened = true;
      return {
        loadAll: () => this.loadAll(),
        putRecord: async (table, key, value) => {
          this.assertTable(table);
          if (this.faults.has(recordFolder(key))) await this.readRecord(recordFolder(key));
          const file = await this.openFile(recordFolder(key));
          await file.unit.putRecord("records", key, value);
        },
        deleteRecord: async (table, key) => {
          this.assertTable(table);
          const relative2 = recordFolder(key);
          this.assertReadable(key);
          const file = this.files.get(relative2);
          if (!file) return;
          await mkdir(path.join(this.directory, relative2), { recursive: true });
          await file.unit.deleteRecord("records", key);
          await file.backend.close();
          this.files.delete(relative2);
          await rm(path.join(this.directory, relative2), { recursive: true, force: true });
        },
        setGlobal: async () => {
          throw new Error("Servant records have no global slot.");
        },
        close: () => this.close()
      };
    }
  };
  close() {
    return this.closing ??= Promise.all([...this.files.values()].map((file) => file.backend.close())).then(() => {
      this.files.clear();
    });
  }
  assertOpen() {
    if (this.closing) throw new Error("Servant record tree is closed.");
  }
  assertTable(table) {
    this.assertOpen();
    if (table !== "records") throw new Error("Unknown Servant record table: " + table);
  }
  async openFile(relative2) {
    this.assertOpen();
    await mkdir(path.join(this.directory, relative2), { recursive: true });
    const existing = this.files.get(relative2);
    if (existing) return existing;
    const backend = new JsonStorageBackend(path.join(this.directory, relative2));
    try {
      const unit = await backend.kv.open(descriptor);
      const file = { backend, unit };
      this.files.set(relative2, file);
      return file;
    } catch (error) {
      await backend.close();
      throw error;
    }
  }
  async readRecord(relative2) {
    const filePath2 = path.join(this.directory, relative2, "record.json");
    try {
      const file = await this.openFile(relative2);
      const snapshot = await file.unit.loadAll();
      const entries = Object.entries(snapshot.tables.records ?? {});
      if (entries.length > 1) throw new Error("\u6BCF\u4E2A\u8BB0\u5F55\u6587\u4EF6\u53EA\u80FD\u4FDD\u5B58\u4E00\u4E2A\u8BB0\u5F55");
      for (const [key, value] of entries) {
        const target = recordFolder(key);
        if (path.dirname(target) !== "other" && relative2 === path.join("other", path.basename(target)) && value && typeof value === "object" && "key" in value && value.key === key && "value" in value) {
          const destination2 = await this.openFile(target);
          const saved = await destination2.unit.loadAll();
          if (!Object.keys(saved.tables.records ?? {}).length) await destination2.unit.putRecord("records", key, value);
          const migrated = await this.readRecord(target);
          await file.unit.deleteRecord("records", key);
          await file.backend.close();
          this.files.delete(relative2);
          try {
            await unlink(filePath2);
            await rmdir(path.join(this.directory, relative2));
          } catch {
          }
          this.faults.delete(relative2);
          return migrated;
        }
        if (recordFolder(key) !== relative2 || !value || typeof value !== "object" || !("key" in value) || value.key !== key || !("value" in value)) throw new Error("\u8BB0\u5F55\u8DEF\u5F84\u3001\u8EAB\u4EFD\u6216\u5C01\u88C5\u4E0D\u5339\u914D");
      }
      this.faults.delete(relative2);
      return entries;
    } catch (reason) {
      const error = new Error(filePath2 + ": " + (reason instanceof Error ? reason.message : String(reason)));
      if (this.faults.get(relative2)?.message !== error.message) console.error("deepseek-servant record", error.message);
      this.faults.set(relative2, error);
      const file = this.files.get(relative2);
      this.files.delete(relative2);
      await file?.backend.close();
      throw error;
    }
  }
  async loadAll() {
    this.assertOpen();
    const records = /* @__PURE__ */ Object.create(null);
    for (const category of recordCategories) {
      const categoryPath = path.join(this.directory, category);
      const kind2 = await lstat(categoryPath).catch((error) => {
        if (error.code === "ENOENT") return void 0;
        throw error;
      });
      if (!kind2) continue;
      if (!kind2.isDirectory() || kind2.isSymbolicLink()) throw new Error("\u8BB0\u5F55\u5206\u7C7B\u76EE\u5F55\u4E0D\u662F\u666E\u901A\u6587\u4EF6\u5939\uFF1A" + categoryPath);
      for (const entry of await readdir(categoryPath, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("\u8BB0\u5F55\u76EE\u5F55\u4E0D\u80FD\u662F\u7B26\u53F7\u94FE\u63A5\uFF1A" + entry.name);
        if (!entry.isDirectory()) continue;
        const relative2 = path.join(category, entry.name);
        const filePath2 = path.join(this.directory, relative2, "record.json");
        const fileKind = await lstat(filePath2).catch((error) => {
          if (error.code === "ENOENT") return void 0;
          throw error;
        });
        if (!fileKind) continue;
        if (!fileKind.isFile() || fileKind.isSymbolicLink()) throw new Error("\u8BB0\u5F55\u4E0D\u662F\u666E\u901A\u6587\u4EF6\uFF1A" + filePath2);
        try {
          for (const [key, value] of await this.readRecord(relative2)) records[key] = value;
        } catch {
        }
      }
    }
    return { tables: { records }, global: null };
  }
};
async function ensureRecordTree(directory) {
  await mkdir(directory, { recursive: true });
  const kind2 = await lstat(directory);
  if (!kind2.isDirectory() || kind2.isSymbolicLink()) throw new Error("Servant \u8BB0\u5F55\u76EE\u5F55\u4E0D\u662F\u666E\u901A\u6587\u4EF6\u5939\uFF1A" + directory);
  const marker = path.join(directory, "layout.json");
  let created = false;
  let text;
  try {
    text = await readFile(marker, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (text === void 0) {
    const handle = await open(marker, "wx");
    try {
      await handle.writeFile(JSON.stringify(LAYOUT, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
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
      await mkdir(path.join(directory, "backups"), { recursive: true });
      await copyFile(marker, path.join(directory, "backups", "layout-" + suffix + ".json"));
      const temporary = marker + "." + suffix + ".tmp";
      await writeFile(temporary, JSON.stringify(LAYOUT, null, 2) + "\n", { flag: "wx" });
      await rename(temporary, marker);
      layout = LAYOUT;
    }
    if (!isDeepStrictEqual(layout, LAYOUT)) throw new Error("\u4E0D\u652F\u6301\u7684 Servant \u8BB0\u5F55\u76EE\u5F55\u683C\u5F0F\uFF1A" + directory);
  }
  for (const category of [...recordCategories, "backups"]) await mkdir(path.join(directory, category), { recursive: true });
  return created;
}

// src/adapters/dsh/storage.ts
var storedEnvelope = z.object({ key: z.string().min(1), value: z.json() });
var servantDomain = defineDomain({ name: "deepseek_servant", version: 1, tables: { records: domainTable(storedEnvelope) } });
var locationDomain = defineDomain({
  name: "deepseek_servant_location",
  version: 1,
  tables: { settings: domainTable(
    z.object({ directory: z.string().min(1), layout: z.literal("folders-v1").optional() })
  ) }
});
var DATA_FOLDER = "deepseek_servant";
var LEGACY_FILE = "deepseek_servant.json";
var LocationCommitUncertainError = class extends Error {
  constructor(destination2, cause) {
    super("Record location could not be confirmed. Both record copies are retained: " + destination2, { cause });
    this.destination = destination2;
    this.name = "LocationCommitUncertainError";
  }
};
async function selectLocation(ctx, location2, value) {
  const previous = location2.table("settings").get("active");
  try {
    await location2.table("settings").put("active", value);
    return { location: location2, committed: true };
  } catch (error) {
    let fresh;
    try {
      await location2.close();
      fresh = await ctx.storageDomain.open(locationDomain);
    } catch (readback) {
      throw new LocationCommitUncertainError(value.directory, new AggregateError([error, readback], "Location write and durable readback failed."));
    }
    const selected = fresh.table("settings").get("active");
    if (isDeepStrictEqual2(selected, value)) return { location: fresh, committed: true };
    if (isDeepStrictEqual2(selected, previous)) return { location: fresh, committed: false, error };
    try {
      await fresh.close();
    } catch (close) {
      throw new LocationCommitUncertainError(value.directory, new AggregateError([error, close], "Unexpected location readback and handle-close failure."));
    }
    throw new LocationCommitUncertainError(value.directory, error);
  }
}
var DshStorageAdapter = class _DshStorageAdapter {
  constructor(ctx, records, directory, location2) {
    this.ctx = ctx;
    this.records = records;
    this.directory = directory;
    this.location = location2;
  }
  chain = Promise.resolve();
  retainedSource;
  closed = false;
  disposal;
  pendingRelocation;
  static async open(ctx) {
    let location2 = await ctx.storageDomain.open(locationDomain);
    let legacy3;
    let records;
    let createdTree = false;
    let stage;
    let directory;
    try {
      const selected = location2.table("settings").get("active");
      if (selected) {
        if (!path2.isAbsolute(selected.directory)) throw new Error("\u8BB0\u5F55\u76EE\u5F55\u5FC5\u987B\u662F\u5B8C\u6574\u8DEF\u5F84\u3002");
        await mkdir2(selected.directory, { recursive: true });
        directory = await realpath(selected.directory);
        if (!(await stat(directory)).isDirectory()) throw new Error("\u8BB0\u5F55\u76EE\u5F55\u4E0D\u53EF\u7528\uFF1A" + directory);
      } else {
        const domain = await ctx.storageDomain.open(servantDomain);
        legacy3 = { domain, close: () => domain.close() };
        directory = path2.dirname(legacyFile(domain));
      }
      const tree = path2.join(directory, DATA_FOLDER);
      if (selected?.layout === "folders-v1" || await exists(tree)) {
        records = await openTree(ctx, tree);
      } else {
        if (!legacy3) {
          legacy3 = await openBackend(ctx, new JsonStorageBackend2(directory));
        }
        stage = path2.join(directory, ".servant-split-" + randomUUID2());
        await createTree(stage);
        records = await openTree(ctx, stage);
        for (const [key, record] of legacy3.domain.table("records").entries()) {
          await records.domain.table("records").put(key, record);
        }
        await records.close();
        records = await openTree(ctx, stage);
        assertSameRecords(legacy3.domain, records.domain);
        await records.close();
        records = void 0;
        const original = path2.join(directory, LEGACY_FILE);
        if (await exists(original)) {
          const backup2 = path2.join(stage, "backups", "deepseek_servant.before-split.json");
          await copyFile2(original, backup2, constants.COPYFILE_EXCL);
          await syncFile(backup2);
        }
        await rename2(stage, tree);
        stage = void 0;
        createdTree = true;
        records = await openTree(ctx, tree);
      }
      const selection = await selectLocation(ctx, location2, { directory, layout: "folders-v1" });
      location2 = selection.location;
      if (!selection.committed) throw selection.error;
      const adapter = new _DshStorageAdapter(ctx, records, directory, location2);
      if (legacy3) {
        try {
          await legacy3.close();
          if (createdTree && await exists(path2.join(directory, LEGACY_FILE))) await unlink2(path2.join(directory, LEGACY_FILE));
        } catch {
          adapter.retainedSource = directory;
        }
      }
      return adapter;
    } catch (error) {
      const closed = await Promise.allSettled([records?.close(), legacy3?.close(), location2.close()]);
      const failures = [error, ...closed.flatMap((result) => result.status === "rejected" ? [result.reason] : [])];
      if (failures.length === 1) {
        try {
          if (stage) await rm2(stage, { recursive: true, force: true });
          if (createdTree && directory && !(error instanceof LocationCommitUncertainError)) await rm2(path2.join(directory, DATA_FOLDER), { recursive: true, force: true });
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, "Opening record storage failed; owned copies are retained where cleanup was not confirmed.");
      throw error;
    }
  }
  usageFiles() {
    return this.serial(async () => recordFileUsage(
      path2.join(this.directory, DATA_FOLDER),
      [...this.records.domain.table("records").entries()].map(([key]) => key)
    ));
  }
  recordsDirectory() {
    return this.directory;
  }
  ensureRecordsDirectory() {
    return this.serial(async () => {
      await this.prepareRecords(true);
      return this.directory;
    });
  }
  storageView() {
    const nativeRoot = this.ctx.get("sessionPersistence")?.root;
    return {
      directory: this.directory,
      issues: this.records.files?.problems(),
      ...typeof nativeRoot === "string" && path2.isAbsolute(nativeRoot) ? { nativeDirectory: nativeRoot } : {},
      ...this.retainedSource ? { retainedSource: this.retainedSource } : {}
    };
  }
  /** Move the owned tree, including its legacy backup, without moving other host files. */
  moveRecords(directory, expectedDirectory, signal, verifyPublished) {
    return this.serial(async () => {
      signal.throwIfAborted();
      if (expectedDirectory !== this.directory) throw new Error("\u8BB0\u5F55\u76EE\u5F55\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002");
      if (!path2.isAbsolute(directory)) throw new Error("\u8BF7\u8F93\u5165\u6587\u4EF6\u5939\u7684\u5B8C\u6574\u7EDD\u5BF9\u8DEF\u5F84\u3002");
      await this.refreshRecords();
      await this.prepareRecords(true);
      await mkdir2(directory, { recursive: true });
      const destination2 = await realpath(directory);
      if (!(await stat(destination2)).isDirectory()) throw new Error("\u8BF7\u9009\u62E9\u4E00\u4E2A\u6587\u4EF6\u5939\u3002");
      if (destination2 === await realpath(this.directory)) return this.storageView();
      const sourceTree = path2.join(this.directory, DATA_FOLDER);
      const relative2 = path2.relative(sourceTree, destination2);
      if (relative2 === "" || !relative2.startsWith(".." + path2.sep) && relative2 !== ".." && !path2.isAbsolute(relative2)) {
        throw new Error("\u4E0D\u80FD\u8FC1\u79FB\u5230\u5F53\u524D\u8BB0\u5F55\u5B50\u6587\u4EF6\u5939\u5185\u90E8\u3002");
      }
      const targetTree = path2.join(destination2, DATA_FOLDER);
      if (await exists(targetTree) || await exists(path2.join(destination2, LEGACY_FILE))) throw new Error("\u76EE\u6807\u6587\u4EF6\u5939\u5DF2\u6709 Servant \u8BB0\u5F55\uFF0C\u8BF7\u9009\u62E9\u5176\u4ED6\u6587\u4EF6\u5939\uFF1B\u4E0D\u4F1A\u8986\u76D6\u5DF2\u6709\u8BB0\u5F55\u3002");
      const stage = path2.join(destination2, ".servant-move-" + randomUUID2());
      let target;
      let published = false;
      try {
        await cp(sourceTree, stage, { recursive: true, errorOnExist: true, force: false });
        await syncCopiedTree(stage);
        target = await openTree(this.ctx, stage);
        assertSameRecords(this.records.domain, target.domain);
        await target.close();
        target = void 0;
        signal.throwIfAborted();
        await rename2(stage, targetTree);
        published = true;
        target = await openTree(this.ctx, targetTree);
        await verifyPublished?.(destination2);
        signal.throwIfAborted();
        const selection = await selectLocation(this.ctx, this.location, { directory: destination2, layout: "folders-v1" });
        this.location = selection.location;
        if (!selection.committed) throw selection.error;
      } catch (error) {
        if (error instanceof LocationCommitUncertainError && target) {
          this.pendingRelocation = { destination: destination2, sourceTree, targetTree, target, verifyPublished };
          throw error;
        }
        try {
          await target?.close();
        } catch (close) {
          throw new AggregateError([error, close], "Record relocation and target close failed; both record copies are retained.");
        }
        try {
          await rm2(published ? targetTree : stage, { recursive: true, force: true });
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "Record relocation failed and the unselected target could not be removed.");
        }
        throw error;
      }
      await this.finishRelocation({ destination: destination2, sourceTree, targetTree, target, verifyPublished });
      return this.storageView();
    });
  }
  get(key) {
    return this.serial(async () => {
      await this.refreshRecords();
      this.records.files?.assertReadable(key);
      const record = this.records.domain.table("records").get(key);
      if (record === void 0) return void 0;
      if (record.key !== key) throw new Error("Servant storage key mismatch: " + key);
      return structuredClone(record.value);
    });
  }
  set(key, value) {
    const record = storedEnvelope.parse({ key, value: omitAbsentFields(structuredClone(value)) });
    return this.serial(async () => {
      await this.refreshRecords();
      this.records.files?.assertReadable(key);
      await this.prepareRecords();
      await this.records.domain.table("records").put(key, record);
    });
  }
  list(prefix) {
    return this.serial(async () => {
      await this.refreshRecords();
      const records = [];
      for (const [key, record] of this.records.domain.table("records").entries()) {
        if (record.key !== key) throw new Error("Servant storage key mismatch: " + key);
        if (key.startsWith(prefix)) records.push({ key, value: structuredClone(record.value) });
      }
      return records;
    });
  }
  delete(key) {
    return this.serial(async () => {
      await this.refreshRecords();
      this.records.files?.assertReadable(key);
      await this.prepareRecords();
      await this.records.domain.table("records").delete(key);
    });
  }
  close() {
    if (this.disposal) return this.disposal;
    this.closed = true;
    const result = this.chain.then(async () => {
      const outcomes = await Promise.allSettled([this.records.close(), this.location.close(), this.pendingRelocation?.target.close()]);
      const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Record storage close failed.");
    });
    this.chain = result.catch(() => {
    });
    return this.disposal = result;
  }
  async finishRelocation(move) {
    const previous = this.records;
    this.records = move.target;
    this.directory = move.destination;
    this.pendingRelocation = void 0;
    this.retainedSource = void 0;
    try {
      await previous.close();
      await rm2(move.sourceTree, { recursive: true });
    } catch {
      this.retainedSource = path2.dirname(move.sourceTree);
    }
  }
  async reconcileRelocation() {
    const move = this.pendingRelocation;
    if (!move) return;
    await this.location.close();
    this.location = await this.ctx.storageDomain.open(locationDomain);
    const selected = this.location.table("settings").get("active");
    if (selected?.directory === move.destination && selected.layout === "folders-v1") {
      assertSameRecords(this.records.domain, move.target.domain);
      await move.verifyPublished?.(move.destination);
      await this.finishRelocation(move);
    } else if (selected?.directory === this.directory && selected.layout === "folders-v1") {
      await move.target.close();
      await rm2(move.targetTree, { recursive: true });
      this.pendingRelocation = void 0;
    } else throw new LocationCommitUncertainError(move.destination, new Error("The durable locator does not match either owned record location."));
  }
  async refreshRecords() {
    if (!await this.records.files?.retryFaults()) return;
    const next = await openTree(this.ctx, path2.join(this.directory, DATA_FOLDER));
    const previous = this.records;
    this.records = next;
    await previous.close();
  }
  async prepareRecords(repairMissingFiles = false) {
    const tree = path2.join(this.directory, DATA_FOLDER);
    const recreated = await ensureRecordTree(tree);
    if (recreated || repairMissingFiles) {
      for (const [key, record] of this.records.domain.table("records").entries()) {
        if (!await exists(path2.join(tree, recordFolder(key), "record.json"))) {
          await this.records.domain.table("records").put(key, record);
        }
      }
    }
  }
  serial(operation) {
    if (this.closed) return Promise.reject(new Error("Record storage is closed."));
    const result = this.chain.then(async () => {
      await this.reconcileRelocation();
      return operation();
    });
    this.chain = result.catch(() => {
    });
    return result;
  }
};
function legacyFile(domain) {
  const unit = domain.unit;
  if (typeof unit?.path !== "string" || !path2.isAbsolute(unit.path)) throw new Error("\u5F53\u524D\u8BB0\u5F55\u5B58\u50A8\u6CA1\u6709\u53EF\u7BA1\u7406\u7684\u672C\u5730\u6587\u4EF6\u5939\u3002");
  return unit.path;
}
async function openBackend(ctx, backend) {
  const backendName = "servant_records_" + randomUUID2().replaceAll("-", "_");
  const unregister = ctx.storage.backend.register(backendName, backend);
  try {
    const facility = new DomainFacility(ctx, { backend: backendName });
    const domain = await facility.open(servantDomain);
    return { domain, close: async () => {
      await domain.close();
      await backend.close();
      unregister();
    } };
  } catch (error) {
    await backend.close();
    unregister();
    throw error;
  }
}
async function openTree(ctx, tree) {
  await ensureRecordTree(tree);
  const files = new RecordFilesBackend(tree);
  return { ...await openBackend(ctx, files), files };
}
async function createTree(tree) {
  await mkdir2(tree);
  await ensureRecordTree(tree);
}
function assertSameRecords(left, right) {
  if (!isDeepStrictEqual2(new Map(left.table("records").entries()), new Map(right.table("records").entries()))) {
    throw new Error("\u8BB0\u5F55\u8FC1\u79FB\u6821\u9A8C\u5931\u8D25\uFF0C\u539F\u76EE\u5F55\u4FDD\u6301\u4E0D\u53D8\u3002");
  }
}
async function exists(file) {
  try {
    await lstat2(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function syncFile(file) {
  const handle = await open2(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncCopiedTree(directory) {
  for (const entry of await readdir2(directory, { withFileTypes: true })) {
    const file = path2.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("\u8BB0\u5F55\u8FC1\u79FB\u4E0D\u63A5\u53D7\u7B26\u53F7\u94FE\u63A5\uFF1A" + file);
    if (entry.isDirectory()) await syncCopiedTree(file);
    else if (entry.isFile()) await syncFile(file);
  }
}

// src/framework/legacy-artifacts.ts
import { createHash as createHash9 } from "node:crypto";

// src/framework/legacy-record-export.ts
import { createHash as createHash5 } from "node:crypto";

// src/framework/transactions.ts
import { createHash as createHash4 } from "node:crypto";

// src/experimental/private-git/github.ts
import { createHash as createHash2 } from "node:crypto";
var GITHUB_CLI_SETUP_REQUIRED = "Configure GitHub CLI: install gh and run gh auth login --hostname github.com.";
var GITHUB_CLI_ACCESS_REQUIRED = "Configure GitHub CLI and verify access to this repository.";
var GitHubError = class extends Error {
  constructor(status, message, retryAfter, retryAt, rateLimit) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.retryAt = retryAt;
    this.rateLimit = rateLimit;
    this.name = "GitHubError";
  }
};
var GitConflictError = class extends Error {
  constructor(message = "Git HEAD changed. Read the latest snapshot before retrying this transaction.") {
    super(message);
    this.name = "GitConflictError";
  }
};
function repositoryPath(ownerRepo) {
  const parts = ownerRepo.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) throw new Error("Use a GitHub owner/repo name.");
  return "/repos/" + parts.map(encodeURIComponent).join("/");
}
var GitHubClient = class {
  constructor(tokenSource, fetcher = fetch, options) {
    this.tokenSource = tokenSource;
    this.fetcher = fetcher;
    this.signal = options?.signal ? AbortSignal.any([this.requests.signal, options.signal]) : this.requests.signal;
  }
  requests = new AbortController();
  signal;
  authorization;
  cancel(reason) {
    this.requests.abort(reason);
    this.requests = new AbortController();
    this.signal = this.requests.signal;
  }
  async session(operation, ownerSignal) {
    const signal = ownerSignal ? AbortSignal.any([this.signal, ownerSignal]) : this.signal;
    signal.throwIfAborted();
    const token = await this.tokenSource(signal);
    signal.throwIfAborted();
    if (!token?.value) throw new GitHubError(401, GITHUB_CLI_SETUP_REQUIRED);
    const fingerprint = createHash2("sha256").update(token.value).digest("hex");
    if (this.authorization?.fingerprint !== fingerprint) this.authorization = { fingerprint, scope: {}, limits: /* @__PURE__ */ new Map() };
    const authorization = this.authorization;
    for (const [key, error] of authorization.limits) if (error.retryAt !== void 0 && error.retryAt <= Date.now()) authorization.limits.delete(key);
    const request = async (method, path3, body, sha) => {
      signal.throwIfAborted();
      if (!path3.startsWith("/") || path3.startsWith("//") || path3.includes("://")) throw new Error("Invalid GitHub API path.");
      const resource = path3 === "/graphql" ? "graphql" : "core", requestKey = method + " " + path3;
      const limited = [authorization.limits.get("*"), authorization.limits.get(resource)].filter((error) => error?.retryAt !== void 0 && error.retryAt > Date.now()).sort((a, b) => b.retryAt - a.retryAt)[0];
      if (limited) throw new GitHubError(limited.status, limited.message, (limited.retryAt - Date.now()) / 1e3, limited.retryAt, limited.rateLimit);
      let response;
      try {
        response = await this.fetcher("https://api.github.com" + path3, {
          method,
          signal,
          headers: {
            Accept: sha ? "application/vnd.github.sha" : "application/vnd.github+json",
            ...sha?.knownHead ? { "If-None-Match": '"' + sha.knownHead + '"' } : {},
            Authorization: "Bearer " + token.value,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "DeepSeek-Servant-Coop",
            ...body === void 0 ? {} : { "Content-Type": "application/json" }
          },
          ...body === void 0 ? {} : { body: JSON.stringify(body) }
        });
      } catch (error) {
        if (signal.aborted && (error === signal.reason || error instanceof Error && error.name === "AbortError" && error.cause === signal.reason)) throw error;
        throw new GitHubError(0, (error instanceof Error ? error.message : "GitHub network request failed.").split(token.value).join("[redacted]"));
      }
      signal.throwIfAborted();
      if (response.status === 304) {
        if (sha?.knownHead) {
          if (authorization.secondaryFailure?.request === requestKey) authorization.secondaryFailure = void 0;
          return sha.knownHead;
        }
        throw new GitHubError(304, "GitHub returned 304 without a previously observed HEAD.");
      }
      const rejection = (status, message, primary) => {
        const now = Date.now(), retry = response.headers.get("retry-after"), reset = response.headers.get("x-ratelimit-reset");
        let retryTime = retry === null ? NaN : /^\d+(?:\.\d+)?$/.test(retry.trim()) ? now + Number(retry) * 1e3 : Date.parse(retry);
        const headerReset = response.headers.get("x-ratelimit-remaining") === "0" && reset !== null ? Number(reset) * 1e3 : NaN;
        const bodyReset = primary?.remaining === 0 && primary.resetAt ? Date.parse(primary.resetAt) : NaN;
        const resetTime = Math.max(Number.isFinite(headerReset) ? headerReset : 0, Number.isFinite(bodyReset) ? bodyReset : 0);
        if ([403, 429].includes(status) && /\bsecondary rate limit\b/i.test(message) && !(retryTime > now) && !(resetTime > now)) {
          const delay = authorization.secondaryFailure === void 0 ? 6e4 : authorization.secondaryFailure.delay * 2;
          authorization.secondaryFailure = { request: requestKey, delay };
          retryTime = now + delay;
        }
        const until = Math.max(Number.isFinite(retryTime) ? retryTime : 0, Number.isFinite(resetTime) ? resetTime : 0);
        const retryAt = [403, 429].includes(status) && until > now ? until : void 0;
        const hint = token.source === "GitHub CLI" && [401, 403, 404].includes(status) && retryAt === void 0 ? GITHUB_CLI_ACCESS_REQUIRED + " " : "";
        const error = new GitHubError(status, hint + "GitHub " + status + ": " + message + " (" + method + " " + path3 + "; authorization: " + token.source + ")", retryAt === void 0 ? void 0 : (retryAt - now) / 1e3, retryAt, retryAt === void 0 ? void 0 : {});
        if (retryAt !== void 0) {
          const retain = (key, deadline) => {
            if (Number.isFinite(deadline) && deadline > now && (authorization.limits.get(key)?.retryAt ?? 0) < deadline) {
              authorization.limits.set(key, new GitHubError(error.status, error.message, (deadline - now) / 1e3, deadline, error.rateLimit));
            }
          };
          retain("*", retryTime);
          retain(response.headers.get("x-ratelimit-resource") || resource, resetTime);
        }
        return error;
      };
      if (!response.ok) {
        const data = await response.json().catch((error) => {
          if (error instanceof SyntaxError) return {};
          throw error;
        });
        signal.throwIfAborted();
        const message = String(data.message ?? response.statusText).split(token.value).join("[redacted]");
        throw rejection(response.status, message);
      }
      const result = response.status === 204 ? void 0 : sha ? (await response.text()).trim() : await response.json();
      signal.throwIfAborted();
      if (path3 === "/graphql" && result?.errors?.some((error) => error.type === "RATE_LIMITED")) {
        const message = result.errors.map((error) => String(error.message ?? "GraphQL rate limit")).join("; ").split(token.value).join("[redacted]");
        throw rejection(429, message, result.data?.rateLimit);
      }
      if (authorization.secondaryFailure?.request === requestKey) authorization.secondaryFailure = void 0;
      if (sha && (typeof result !== "string" || !/^[0-9a-f]{40}$/.test(result))) throw new GitHubError(502, "GitHub returned an invalid commit SHA.");
      signal.throwIfAborted();
      return result;
    };
    return operation({
      authorizationScope: authorization.scope,
      request,
      // Official Get a commit SHA media type permits the local SHA as its ETag:
      // https://docs.github.com/en/rest/commits/commits#get-a-commit
      head: (path3, knownHead) => request("GET", path3, void 0, { knownHead })
    });
  }
};
async function inspectPrivateRepo(session, binding) {
  const [repo, identity2] = await Promise.all([
    session.request("GET", repositoryPath(binding.ownerRepo)),
    session.request("GET", "/user")
  ]);
  if (!repo.private) throw new GitHubError(422, "This repository is public. Git collaboration requires a private repository.");
  if (binding.repositoryId !== void 0 && repo.id !== binding.repositoryId) throw new GitHubError(409, "This is a different GitHub repository. Confirm the repository selection.");
  if (binding.participantId !== void 0 && identity2.id !== binding.participantId) throw new GitHubError(409, "The GitHub account changed. Connect this account before continuing.");
  return { identity: { id: identity2.id, login: identity2.login }, repository: {
    id: repo.id,
    fullName: repo.full_name,
    branch: binding.branch ?? repo.default_branch ?? "main",
    private: true,
    permissions: { pull: repo.permissions?.pull ?? true, push: repo.permissions?.push ?? false, admin: repo.permissions?.admin ?? false }
  } };
}
var GitHubMembers = class {
  constructor(client, binding) {
    this.client = client;
    this.binding = binding;
  }
  async withRepo(action, expected = {}) {
    const binding = this.binding();
    if (expected.expectedRepositoryId !== void 0 && expected.expectedRepositoryId !== binding.repositoryId || expected.expectedParticipantId !== void 0 && expected.expectedParticipantId !== binding.participantId) {
      throw new GitHubError(409, "The GitHub account or repository changed. Refresh members and confirm the action again.");
    }
    return this.client.session(async (session) => {
      const connection = await inspectPrivateRepo(session, binding);
      return action(session, repositoryPath(connection.repository.fullName), connection);
    });
  }
  async pages(session, path3) {
    const result = [];
    for (let page = 1; ; page++) {
      const batch = await session.request("GET", path3 + "?per_page=100&page=" + page);
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }
  invitations(expected) {
    return this.withRepo(async (session, path3) => (await this.pages(session, path3 + "/invitations")).map((item) => ({ id: item.id, login: item.invitee.login, status: "pending", htmlUrl: item.html_url })), expected);
  }
  collaborators(expected) {
    return this.withRepo(async (session, path3) => (await this.pages(session, path3 + "/collaborators")).map((item) => ({ id: item.id, login: item.login, permissions: item.permissions, status: "accepted" })), expected);
  }
  invite(login, expected) {
    if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error("Enter a GitHub username.");
    return this.withRepo(async (session, path3, connection) => {
      const result = await session.request("PUT", path3 + "/collaborators/" + encodeURIComponent(login), { permission: "push" });
      return { status: result ? "pending" : "accepted", id: result?.id, login };
    }, expected);
  }
  cancelInvitation(id, expected) {
    return this.withRepo(async (session, path3) => {
      await session.request("DELETE", path3 + "/invitations/" + id);
    }, expected);
  }
  remove(login, expected) {
    if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error("Enter a GitHub username.");
    return this.withRepo(async (session, path3) => {
      await session.request("DELETE", path3 + "/collaborators/" + encodeURIComponent(login));
    }, expected);
  }
};

// src/experimental/private-git/git-repository.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash as createHash3, randomUUID as randomUUID3 } from "node:crypto";

// src/experimental/private-git/read-plan.ts
var oid = (value) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
var GitRefNotResolvedError = class extends Error {
};
async function readPlan(session, repository, branch, revision, demands, isolatePathErrors = false) {
  const [owner, name2] = repository.split("/");
  const variables = { owner, name: name2, ref: revision ?? "refs/heads/" + branch };
  const declarations2 = ["$owner:String!", "$name:String!", revision ? "$ref:GitObjectID!" : "$ref:String!"];
  const fields2 = demands.map((demand, i) => {
    variables["p" + i] = demand.path;
    declarations2.push("$p" + i + ":String!");
    const selection = demand.body ? "... on Blob { oid byteSize isBinary isTruncated text }" : "... on Tree { oid entries { name type oid object { ... on Blob { byteSize } } } }";
    return `p${i}:file(path:$p${i}) { oid type object { ${selection} } }`;
  }).join(" ");
  const commit = `... on Commit { oid tree { oid } ${fields2} }`;
  const target = revision ? `object(oid:$ref) { ${commit} }` : `ref(qualifiedName:$ref) { target { ${commit} } }`;
  const query = `query DSSReadPlan(${declarations2.join(",")}) { repository(owner:$owner,name:$name) { ${target} } rateLimit { cost remaining resetAt } }`;
  const result = await session.request("POST", "/graphql", { query, variables });
  const value = revision ? result.data?.repository?.object : result.data?.repository?.ref?.target;
  const parent = revision ? ["repository", "object"] : ["repository", "ref", "target"];
  const failures = /* @__PURE__ */ new Map();
  for (const error of result.errors ?? []) {
    const alias = error.path?.[parent.length], index = typeof alias === "string" && /^p\d+$/.test(alias) ? Number(alias.slice(1)) : -1;
    const located = index >= 0 && index < demands.length && alias === "p" + index && value && Object.hasOwn(value, alias) && JSON.stringify(error.path?.slice(0, parent.length)) === JSON.stringify(parent);
    if (located && error.type === "NOT_FOUND" && error.path?.length === parent.length + 1 && value[alias] === null) continue;
    if (!isolatePathErrors || !located) throw new GitHubError(200, "GitHub GraphQL read failed: " + error.message);
    failures.set(index, [...failures.get(index) ?? [], error.message]);
  }
  if (revision === void 0 && result.data?.repository?.ref === null && !result.errors?.length) throw new GitRefNotResolvedError("GitHub did not resolve this branch.");
  if (!oid(value?.oid) || !oid(value?.tree?.oid) || revision !== void 0 && value.oid !== revision)
    throw new GitHubError(502, "GitHub did not return the requested commit and tree.");
  const entries = demands.map((_, i) => {
    if (failures.has(i)) return new GitHubError(200, "GitHub GraphQL read failed: " + failures.get(i).join("; "));
    const entry = value["p" + i];
    if (entry === null) return null;
    if (!entry || !oid(entry.oid) || !["blob", "tree", "commit"].includes(entry.type)) {
      const error = new GitHubError(502, "GitHub returned an incomplete file entry.");
      if (isolatePathErrors) return error;
      throw error;
    }
    return entry;
  });
  return { head: value.oid, tree: value.tree.oid, entries };
}

// src/experimental/private-git/git-repository.ts
function validCoopPath(path3) {
  return path3.startsWith("dss-coop/") && !/[\\\0\r\n]/.test(path3) && path3.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
var GitCommitOutcomeUnknownError = class extends Error {
  constructor(operation, options) {
    super("Git commit result is unknown; retain operation " + operation.id + " and resolve it before creating a replacement.", options);
    this.operation = operation;
    this.name = "GitCommitOutcomeUnknownError";
    this.operationId = operation.id;
    this.expectedHead = operation.expectedHead;
  }
  operationId;
  expectedHead;
};
var sha256 = (value) => createHash3("sha256").update(value).digest("hex");
function changeBytes(change) {
  if (change.bytes !== void 0) {
    if (!(change.bytes instanceof Uint8Array) || change.content !== void 0) throw new Error("Use either text content or binary bytes for a Git file, not both.");
    return Buffer.from(change.bytes);
  }
  if (change.content === null) return null;
  if (typeof change.content !== "string") throw new Error("A Git file requires text content, binary bytes, or an explicit deletion.");
  return Buffer.from(change.content, "utf8");
}
var encodePath = (path3) => path3.split("/").map(encodeURIComponent).join("/");
var GitHubRepository = class {
  constructor(client, binding, _tokens, _legacyCacheRoot) {
    this.client = client;
    this.binding = binding;
  }
  readOperations = new AsyncLocalStorage();
  scopes = new AbortController();
  checked;
  metadata;
  states = /* @__PURE__ */ new WeakMap();
  cancel(reason) {
    this.scopes.abort(reason);
    this.client.cancel(this.scopes.signal.reason);
    this.scopes = new AbortController();
    this.checked = void 0;
    this.metadata = void 0;
  }
  async releaseCache() {
    this.cancel();
    this.states = /* @__PURE__ */ new WeakMap();
  }
  async session(operation, ownerSignal) {
    const owner = this.readOperations.getStore();
    if (owner) {
      if (!owner.active) throw new Error("Read operation ownership has ended.");
      owner.reusable = false;
    }
    try {
      return await this.client.session(operation, ownerSignal);
    } catch (error) {
      if (error instanceof GitHubError && [401, 403].includes(error.status) && error.retryAt === void 0) {
        this.checked = void 0;
        this.metadata = void 0;
      }
      throw error;
    }
  }
  /** Reuse an actual authorized session only inside this awaited callback.
   * No token is persisted or cached beyond GitHubClient.session's operation. */
  async withReadOperation(operation) {
    const previous = this.readOperations.getStore();
    if (previous && !previous.active) return this.readOperations.exit(() => this.withReadOperation(operation));
    if (previous?.reusable) {
      this.checkReadOperation(previous);
      return operation();
    }
    const controller = new AbortController();
    return this.session(async (session) => {
      const scope = await this.scope(session);
      const owner = { session, scope, signal: controller.signal, binding: this.readBindingKey(), active: true, reusable: true, pending: /* @__PURE__ */ new Set() };
      return this.readOperations.run(owner, async () => {
        let result, failure, failed = false;
        try {
          result = await operation();
        } catch (error) {
          failure = error;
          failed = true;
        } finally {
          owner.active = false;
        }
        const outstanding = [...owner.pending];
        if (outstanding.length) {
          if (!failed) {
            failure = scope.signal.aborted ? scope.signal.reason : new Error("Read operation callback ended with unawaited requests.");
            failed = true;
          }
          controller.abort(failure);
        }
        const settled = await Promise.allSettled(outstanding);
        const errors = [.../* @__PURE__ */ new Set([
          ...failed ? [failure] : [],
          ...settled.flatMap((value) => value.status === "rejected" ? [value.reason] : [])
        ])];
        owner.pending.clear();
        owner.session = void 0;
        if (!errors.length) {
          try {
            this.check(scope);
            if (owner.reusable && this.metadata !== scope.metadata) throw new GitHubError(409, "The GitHub read authority changed. Start a new read operation.");
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, "Owned read operation failed.");
        return result;
      });
    }, controller.signal);
  }
  readBindingKey() {
    const value = this.binding();
    return JSON.stringify([value.ownerRepo, value.repositoryId, value.participantId, value.branch, value.repositoryDirectory]);
  }
  checkReadOperation(owner) {
    if (!owner.active) throw new Error("Read operation ownership has ended.");
    this.check(owner.scope);
    if (owner.binding !== this.readBindingKey() || this.metadata !== owner.scope.metadata) {
      throw new GitHubError(409, "The GitHub read authority changed. Start a new read operation.");
    }
  }
  async readSession(operation) {
    const owner = this.readOperations.getStore();
    if (!owner) return this.session(operation);
    if (!owner.active) throw new Error("Read operation ownership has ended.");
    if (owner.reusable) this.checkReadOperation(owner);
    const pending = (owner.reusable ? operation(owner.session) : this.session(operation, owner.signal)).catch((error) => {
      if (error instanceof GitHubError && [401, 403].includes(error.status) && error.retryAt === void 0) {
        owner.reusable = false;
        this.checked = void 0;
        this.metadata = void 0;
      }
      throw error;
    });
    owner.pending.add(pending);
    void pending.then(() => owner.pending.delete(pending), () => owner.pending.delete(pending));
    return pending;
  }
  async connect() {
    return this.session(async (session) => (await this.scope(session, true, true)).connection);
  }
  async scope(session, recheck = false, connect = false) {
    const signal = this.scopes.signal, binding = this.binding();
    const key = JSON.stringify([binding.ownerRepo, binding.repositoryId, binding.participantId, binding.branch, binding.repositoryDirectory]);
    let connection = !recheck && this.checked?.key === key && this.checked.authorizationScope === session.authorizationScope ? this.checked.connection : void 0;
    if (!connection) {
      connection = await inspectPrivateRepo(session, connect ? { ...binding, participantId: void 0 } : binding);
      signal.throwIfAborted();
      this.checked = { key, authorizationScope: session.authorizationScope, connection };
    }
    const directory = binding.repositoryDirectory ?? "dss-coop";
    if (directory && (!validCoopPath("dss-coop/" + directory) || directory.startsWith("/"))) throw new Error("Use a directory inside the Git repository.");
    const metadataKey = JSON.stringify([key, connection.identity.id, connection.repository.id, connection.repository.fullName, connection.repository.branch, directory]);
    if (this.metadata?.key !== metadataKey || this.metadata.authorizationScope !== session.authorizationScope) {
      this.metadata = { key: metadataKey, authorizationScope: session.authorizationScope };
    }
    return { connection, directory, path: repositoryPath(connection.repository.fullName), signal, metadata: this.metadata };
  }
  check(scope) {
    scope.signal.throwIfAborted();
  }
  physical(scope, path3) {
    if (path3 === "dss-coop") return scope.directory;
    if (!validCoopPath(path3)) throw new Error("Choose a record inside the configured DSS directory.");
    return (scope.directory ? scope.directory + "/" : "") + path3.slice("dss-coop/".length);
  }
  async head(session, scope) {
    try {
      const head = await session.head(scope.path + "/commits/heads/" + encodePath(scope.connection.repository.branch), scope.metadata.head);
      this.check(scope);
      scope.metadata.head = head;
      return head;
    } catch (error) {
      if (!(error instanceof GitHubError) || ![404, 409].includes(error.status)) throw error;
      scope.metadata.head = void 0;
      const branches = await session.request("GET", scope.path + "/branches?per_page=1");
      if (branches.length) throw error;
      return "";
    }
  }
  async makeSnapshot(session, scope, head, knownTree) {
    let tree = knownTree ?? (scope.metadata.latestTree?.head === head ? scope.metadata.latestTree.tree : void 0);
    if (tree === void 0) tree = head ? (await session.request("GET", scope.path + "/git/commits/" + head)).tree.sha : "";
    this.check(scope);
    if (head === scope.metadata.head) scope.metadata.latestTree = { head, tree };
    const view = scope.metadata.view;
    const root = view?.sha === tree ? view : { sha: tree, children: /* @__PURE__ */ new Map(), previous: view };
    const nodes = /* @__PURE__ */ new Map();
    const index = (node) => {
      if (nodes.has(node.sha)) return;
      nodes.set(node.sha, node);
      for (const child of node.children.values()) index(child);
      if (node.previous) index(node.previous);
    };
    index(root);
    const snapshot = { head, tree, files: /* @__PURE__ */ new Map(), reads: /* @__PURE__ */ new Map() };
    this.states.set(snapshot, { scope, head, root, nodes, loaded: /* @__PURE__ */ new Set(), planned: /* @__PURE__ */ new Map(), pathErrors: /* @__PURE__ */ new Map(), bodies: /* @__PURE__ */ new Map() });
    return snapshot;
  }
  snapshot(_afterWrite = false, plan) {
    plan?.signal?.throwIfAborted();
    return this.readSession(async (session) => {
      const scope = await this.scope(session);
      if (plan) {
        plan.signal?.throwIfAborted();
        const demands = this.demands(scope, plan);
        const first = demands.slice(0, 64);
        let result;
        try {
          result = await readPlan(session, scope.connection.repository.fullName, scope.connection.repository.branch, void 0, first, plan.isolatePathErrors);
        } catch (error) {
          if (!(error instanceof GitRefNotResolvedError)) throw error;
          plan.signal?.throwIfAborted();
          const snapshot2 = await this.makeSnapshot(session, scope, await this.head(session, scope));
          if (snapshot2.head) await this.prefetchDemands(session, snapshot2, demands, plan.signal, plan.isolatePathErrors);
          return snapshot2;
        }
        plan.signal?.throwIfAborted();
        this.check(scope);
        const snapshot = await this.makeSnapshot(session, scope, result.head, result.tree);
        this.acceptPlan(snapshot, first, result.entries, plan.isolatePathErrors);
        scope.metadata.head = result.head;
        scope.metadata.latestTree = { head: result.head, tree: result.tree };
        await this.prefetchDemands(session, snapshot, demands.slice(first.length), plan.signal, plan.isolatePathErrors);
        return snapshot;
      }
      return this.makeSnapshot(session, scope, await this.head(session, scope));
    });
  }
  demands(scope, plan) {
    const requested = /* @__PURE__ */ new Map();
    for (const path3 of plan.directories ?? []) requested.set(this.physical(scope, path3), false);
    for (const path3 of plan.files ?? []) {
      const physical = this.physical(scope, path3);
      if (requested.get(physical) === false) throw new Error("A read plan cannot request the same path as both file and directory.");
      requested.set(physical, true);
    }
    return [...requested].map(([path3, body]) => ({ path: path3, body }));
  }
  async prefetch(snapshot, plan) {
    plan.signal?.throwIfAborted();
    const state = this.state(snapshot);
    const demands = this.demands(state.scope, plan).filter((demand) => {
      if (state.pathErrors.has(demand.path)) return false;
      const entry = state.planned.get(demand.path);
      return !state.planned.has(demand.path) || !!entry && (demand.body ? entry.type === "blob" && !state.bodies.has(entry.sha) : entry.type === "tree" && !entry.node?.entries);
    });
    if (!demands.length || !snapshot.head) return;
    await this.readSession((session) => this.prefetchDemands(session, snapshot, demands, plan.signal, plan.isolatePathErrors));
  }
  async prefetchDemands(session, snapshot, demands, signal, isolatePathErrors = false) {
    const state = this.state(snapshot);
    if (session.authorizationScope !== state.scope.metadata.authorizationScope) throw new GitHubError(409, "The GitHub authorization changed. Read a new snapshot before continuing.");
    for (let start = 0; start < demands.length; start += 64) {
      signal?.throwIfAborted();
      const batch = demands.slice(start, start + 64);
      const result = await readPlan(session, state.scope.connection.repository.fullName, state.scope.connection.repository.branch, snapshot.head, batch, isolatePathErrors);
      signal?.throwIfAborted();
      this.check(state.scope);
      this.acceptPlan(snapshot, batch, result.entries, isolatePathErrors);
    }
  }
  acceptPlan(snapshot, demands, values2, isolatePathErrors = false) {
    const state = this.state(snapshot), updates = [];
    const gitOid = (value) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
    for (let i = 0; i < demands.length; i++) {
      const demand = demands[i], value = values2[i], start = updates.length;
      try {
        if (value instanceof GitHubError) throw value;
        if (value === null) {
          updates.push(() => state.planned.set(demand.path, null));
          continue;
        }
        const entry = { path: demand.path.split("/").at(-1), type: value.type, sha: value.oid };
        const object4 = value.object;
        if (demand.body && value.type === "blob") {
          if (!object4 || object4.oid !== value.oid || !Number.isSafeInteger(object4.byteSize) || object4.byteSize < 0 || typeof object4.isTruncated !== "boolean" || ![true, false, null].includes(object4.isBinary) || object4.text !== null && typeof object4.text !== "string")
            throw new GitHubError(502, "GitHub returned incomplete blob metadata.");
          entry.size = object4.byteSize;
          if (object4.isBinary === false && !object4.isTruncated && typeof object4.text === "string") {
            const bytes = Buffer.from(object4.text, "utf8");
            if (bytes.length === object4.byteSize) updates.push(() => state.bodies.set(value.oid, bytes));
          }
        } else if (!demand.body && value.type === "tree") {
          if (!object4 || object4.oid !== value.oid || !Array.isArray(object4.entries)) throw new GitHubError(502, "GitHub returned an incomplete directory.");
          const entries = object4.entries.map((child) => {
            if (!child.name || child.name.includes("/") || [".", ".."].includes(child.name) || !gitOid(child.oid) || !["blob", "tree", "commit"].includes(child.type))
              throw new GitHubError(502, "GitHub returned an invalid directory entry.");
            return { path: child.name, type: child.type, sha: child.oid, ...child.object?.byteSize === void 0 ? {} : { size: child.object.byteSize } };
          });
          const node = { sha: value.oid, entries, children: /* @__PURE__ */ new Map() };
          for (const child of entries) if (child.type === "tree") node.children.set(child.path, state.nodes.get(child.sha) ?? { sha: child.sha, children: /* @__PURE__ */ new Map() });
          entry.node = node;
          updates.push(() => {
            state.nodes.set(node.sha, node);
            for (const child of node.children.values()) state.nodes.set(child.sha, child);
          });
        }
        updates.push(() => state.planned.set(demand.path, entry));
      } catch (error) {
        if (!isolatePathErrors) throw error;
        updates.length = start;
        updates.push(() => state.pathErrors.set(demand.path, error));
      }
    }
    this.check(state.scope);
    for (const update of updates) update();
  }
  async at(revision) {
    if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("Use a Git commit id.");
    return this.readSession(async (session) => this.makeSnapshot(session, await this.scope(session), revision));
  }
  state(snapshot) {
    if (this.readOperations.getStore()?.active === false) throw new Error("Read operation ownership has ended.");
    const state = this.states.get(snapshot);
    if (!state) throw new Error("Use a snapshot obtained from this repository.");
    this.check(state.scope);
    return state;
  }
  async tree(session, state, node) {
    let pending = node.pending?.get(session);
    if (!node.entries && !pending) {
      node.pending ??= /* @__PURE__ */ new WeakMap();
      pending = session.request("GET", state.scope.path + "/git/trees/" + node.sha).then((result) => {
        this.check(state.scope);
        if (result.truncated) throw new Error("GitHub returned a truncated directory tree: " + node.sha);
        for (const child of result.tree.filter((entry) => entry.type === "tree")) {
          let next = state.nodes.get(child.sha);
          if (!next) {
            const prior = node.previous?.children.get(child.path);
            next = { sha: child.sha, children: /* @__PURE__ */ new Map(), previous: prior?.entries ? prior : prior?.previous };
            state.nodes.set(child.sha, next);
          }
          node.children.set(child.path, next);
        }
        node.entries = result.tree;
        node.previous = void 0;
        return result.tree;
      }).finally(() => {
        node.pending.delete(session);
      });
      node.pending.set(session, pending);
    }
    const entries = node.entries ?? await pending;
    this.check(state.scope);
    if (node === state.root && state.head === state.scope.metadata.head) state.scope.metadata.view = node;
    return entries;
  }
  async entry(session, snapshot, physical) {
    const state = this.state(snapshot);
    if (session.authorizationScope !== state.scope.metadata.authorizationScope) throw new GitHubError(409, "The GitHub authorization changed. Read a new snapshot before continuing.");
    if (!snapshot.tree) return;
    if (state.pathErrors.has(physical)) throw state.pathErrors.get(physical);
    if (state.planned.has(physical)) return state.planned.get(physical) ?? void 0;
    if (!physical) return { path: "", type: "tree", sha: snapshot.tree, node: state.root };
    let node = state.root;
    const parts = physical.split("/");
    for (let i = 0; i < parts.length; i++) {
      const found = (await this.tree(session, state, node)).find((item) => item.path === parts[i]);
      if (!found) return;
      if (i === parts.length - 1) return found.type === "tree" ? { ...found, node: node.children.get(found.path) } : found;
      if (found.type !== "tree") return;
      node = node.children.get(found.path);
    }
  }
  /** Direct children only: Host can inspect root signals without watching other
   * participants' subtrees. Paths are logical, with no trailing slash. Resolving
   * ancestors and the directory reads only immutable non-recursive tree metadata.
   * This does not mark a recursive listing complete or populate snapshot.files.
   */
  async listDirectory(snapshot, prefix) {
    const root = prefix.replace(/\/$/, ""), state = this.state(snapshot);
    return this.readSession(async (session) => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, root));
      if (!entry || entry.type !== "tree") return [];
      const children = await this.tree(session, state, entry.node);
      this.check(state.scope);
      return children.map((child) => ({ ...child, path: root + "/" + child.path }));
    });
  }
  async directories(snapshot, prefix) {
    const root = prefix.replace(/\/$/, ""), state = this.state(snapshot);
    return this.readSession(async (session) => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, root));
      if (!entry || entry.type !== "tree") return [];
      return (await this.tree(session, state, entry.node)).filter((item) => item.type === "tree").map((item) => root + "/" + item.path + "/");
    });
  }
  async list(snapshot, prefix) {
    const root = prefix.replace(/\/$/, ""), state = this.state(snapshot);
    if (state.loaded.has(root)) return;
    await this.readSession(async (session) => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, root)), files = /* @__PURE__ */ new Map();
      const visit = async (node, logical) => {
        for (const child of await this.tree(session, state, node)) {
          if (child.type === "tree") await visit(node.children.get(child.path), logical + "/" + child.path);
          else if (child.type === "blob") files.set(logical + "/" + child.path, child.sha);
        }
      };
      if (entry?.type === "tree") await visit(entry.node, root);
      this.check(state.scope);
      for (const [path3, sha] of files) snapshot.files.set(path3, sha);
      state.loaded.add(root);
    });
  }
  async read(snapshot, path3) {
    const bytes = await this.readBytes(snapshot, path3);
    return bytes === void 0 ? void 0 : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  async readBytes(snapshot, path3) {
    const state = this.state(snapshot);
    return this.readSession(async (session) => {
      const entry = await this.entry(session, snapshot, this.physical(state.scope, path3));
      const sha = entry?.type === "blob" ? entry.sha : void 0;
      snapshot.reads?.set(path3, sha);
      if (!sha) return;
      snapshot.files.set(path3, sha);
      let bytes = state.bodies.get(sha);
      if (!bytes) {
        const blob = await session.request("GET", state.scope.path + "/git/blobs/" + sha);
        this.check(state.scope);
        if (blob.encoding !== "base64") throw new Error("Unsupported GitHub blob encoding: " + blob.encoding);
        bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
      }
      const algorithm = sha.length === 64 ? "sha256" : "sha1";
      const actual = createHash3(algorithm).update("blob " + bytes.length + "\0").update(bytes).digest("hex");
      if (actual !== sha) throw new Error("Git blob integrity mismatch: " + path3);
      return Buffer.from(bytes);
    });
  }
  /** Net file difference between two immutable snapshots, including own writes.
   * This is NOT a per-commit event log. Host discovery uses current Inbox/state
   * versions; consumers must not infer transient intermediate events from it.
   * Only tree metadata is read, never the business file bodies.
   */
  async changes(snapshot, from, _ownInstance) {
    const state = this.state(snapshot);
    if (snapshot.head === from) return [];
    const before = from ? await this.session((session) => this.makeSnapshot(session, state.scope, from)) : void 0;
    await this.list(snapshot, "dss-coop/");
    if (before) await this.list(before, "dss-coop/");
    const paths2 = /* @__PURE__ */ new Set([...snapshot.files.keys(), ...before?.files.keys() ?? []]);
    return [...paths2].sort().flatMap((path3) => {
      const old = before?.files.get(path3), next = snapshot.files.get(path3);
      return old === next ? [] : [{
        path: path3,
        status: !old ? "A" : !next ? "D" : "M",
        commit: snapshot.head,
        parent: from || void 0,
        before: old,
        after: next
      }];
    });
  }
  /** GitHub cannot create a ref in an empty repository. Explicit connection-time
   * bootstrap uses one Contents commit, never splits a business transaction.
   * https://docs.github.com/en/rest/git/refs#create-a-reference
   */
  async ensureBranch() {
    return this.session(async (session) => {
      const scope = await this.scope(session, true), head = await this.head(session, scope);
      if (head) return this.makeSnapshot(session, scope, head);
      const path3 = this.physical(scope, "dss-coop/README.md");
      const content = "# DSS collaboration\n\nShared conversation, task execution and durable records for DeepSeek Servant.\n";
      try {
        await session.request("PUT", scope.path + "/contents/" + encodePath(path3), {
          message: "Initialize DSS collaboration repository",
          content: Buffer.from(content).toString("base64"),
          branch: scope.connection.repository.branch
        });
      } catch (error) {
        const observed2 = await this.head(session, scope).catch(() => "");
        if (!observed2) throw error;
        return this.makeSnapshot(session, scope, observed2);
      }
      const observed = await this.head(session, scope);
      if (!observed) throw new Error("GitHub repository initialization could not be confirmed.");
      const snapshot = await this.makeSnapshot(session, scope, observed);
      if (await this.read(snapshot, "dss-coop/README.md") !== content) throw new Error("GitHub repository initialization read-back differs; inspect the current branch before continuing.");
      return snapshot;
    });
  }
  writes(changes) {
    if (changes.some((change) => !validCoopPath(change.path))) throw new Error("Commit changes inside the configured DSS directory.");
    if (new Set(changes.map((change) => change.path)).size !== changes.length) throw new Error("Duplicate paths in a Git transaction.");
    return changes.map((change) => {
      const bytes = changeBytes(change);
      return { path: change.path, sha256: bytes === null ? null : sha256(bytes) };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  /** Synchronous preparation: callers persist the returned metadata before commitPrepared. */
  prepareCommit(base, changes, message) {
    const { scope } = this.state(base), writes = this.writes(changes);
    if (!base.head) throw new Error("Initialize the empty repository with ensureBranch before committing a business transaction.");
    return {
      version: 1,
      id: randomUUID3(),
      expectedHead: base.head,
      repositoryId: scope.connection.repository.id,
      repository: scope.connection.repository.fullName,
      branch: scope.connection.repository.branch,
      directory: scope.directory,
      authorId: scope.connection.identity.id,
      writes,
      requestHash: sha256(JSON.stringify({ writes, message }))
    };
  }
  matchesScope(scope, operation) {
    return scope.connection.repository.id === operation.repositoryId && scope.connection.repository.fullName === operation.repository && scope.connection.repository.branch === operation.branch && scope.directory === operation.directory && scope.connection.identity.id === operation.authorId;
  }
  validateOperation(operation) {
    if (operation.version !== 1 || !/^[0-9a-f-]+$/i.test(operation.id) || !/^[0-9a-f]{40,64}$/.test(operation.expectedHead) || !/^[0-9a-f]{64}$/.test(operation.requestHash) || operation.writes.some((write) => !validCoopPath(write.path) || write.sha256 !== null && !/^[0-9a-f]{64}$/.test(write.sha256))) {
      throw new Error("Invalid persisted Git operation metadata.");
    }
  }
  async resolve(session, scope, operation, knownHead) {
    if (!this.matchesScope(scope, operation)) return { status: "unknown", reason: "Repository, branch or account changed; resolve in the original scope." };
    const head = knownHead ?? await this.head(session, scope);
    if (head === operation.expectedHead) return { status: "pending", head };
    let cursor = head;
    while (cursor && cursor !== operation.expectedHead) {
      const commit = await session.request("GET", scope.path + "/git/commits/" + cursor);
      const lines = commit.message.split("\n");
      if (lines.includes("DSS-Operation: " + operation.id)) {
        if (commit.parents.length !== 1 || commit.parents[0]?.sha !== operation.expectedHead || !lines.includes("DSS-Request-SHA256: " + operation.requestHash)) return { status: "unknown", head, reason: "Operation marker does not match the prepared transaction." };
        const snapshot = await this.makeSnapshot(session, scope, cursor);
        for (const write of operation.writes) {
          const content = await this.readBytes(snapshot, write.path);
          if ((content === void 0 ? null : sha256(content)) !== write.sha256) return { status: "unknown", head, reason: "Operation content verification differs from its prepared hashes." };
        }
        this.check(scope);
        this.state(snapshot).verifiedWrites = Object.freeze(operation.writes.map((write) => Object.freeze({ ...write })));
        return { status: "confirmed", commit: cursor, head, verifiedWrites: snapshot };
      }
      cursor = commit.parents[0]?.sha ?? "";
    }
    return cursor === operation.expectedHead ? { status: "conflict", head } : { status: "unknown", head, reason: "Expected base is not on the current first-parent chain; history may have been rewritten." };
  }
  /** Reuse only a complete verification owned by this repository's current
   * authority epoch. Callers must still obtain a fresh authoritative snapshot. */
  matchesVerifiedWrites(current, verified, expected) {
    const now = this.states.get(current), prior = verified && this.states.get(verified);
    if (!now || !prior?.verifiedWrites || now.head !== prior.head || now.scope.signal.aborted || prior.scope.signal.aborted || now.scope.metadata !== this.metadata || now.scope.metadata !== prior.scope.metadata) return false;
    if (expected.length !== prior.verifiedWrites.length) return false;
    const actual = new Map(prior.verifiedWrites.map((write) => [write.path, write.sha256]));
    const paths2 = new Set(expected.map((write) => write.path));
    return paths2.size === expected.length && expected.every((write) => actual.has(write.path) && actual.get(write.path) === write.sha256);
  }
  /** Safe after process restart: the receipt metadata alone locates and verifies
   * a successful commit even if other people committed after it. No body mirror.
   */
  async resolveCommit(operation) {
    this.validateOperation(operation);
    try {
      return await this.session(async (session) => this.resolve(session, await this.scope(session, true), operation));
    } catch (error) {
      return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  async commitPrepared(base, changes, message, operation) {
    changes = changes.map((change) => {
      const bytes = changeBytes(change);
      return bytes === null ? { path: change.path, content: null } : { path: change.path, bytes };
    });
    this.validateOperation(operation);
    const writes = this.writes(changes), state = this.state(base);
    if (operation.expectedHead !== base.head || JSON.stringify(writes) !== JSON.stringify(operation.writes) || sha256(JSON.stringify({ writes, message })) !== operation.requestHash) throw new Error("Prepared Git operation was reused for different input or snapshot.");
    return this.session(async (session) => {
      const scope = await this.scope(session, true);
      if (!this.matchesScope(scope, operation) || scope.path !== state.scope.path || scope.directory !== state.scope.directory) {
        throw new GitCommitOutcomeUnknownError(operation, { cause: new Error("Repository scope or account changed.") });
      }
      const head = await this.head(session, scope);
      if (head !== base.head) {
        const resolution2 = await this.resolve(session, scope, operation, head);
        if (resolution2.status === "confirmed") return { commit: resolution2.commit, replay: true, ...resolution2.verifiedWrites ? { verifiedWrites: resolution2.verifiedWrites } : {} };
        if (resolution2.status === "conflict") throw new GitConflictError();
        throw new GitCommitOutcomeUnknownError(operation);
      }
      const additions = changes.flatMap((change) => {
        const bytes = changeBytes(change);
        return bytes === null ? [] : [{ path: this.physical(scope, change.path), contents: bytes.toString("base64") }];
      });
      const deletions = [];
      for (const change of changes) if (change.content === null && (await this.entry(session, base, this.physical(scope, change.path)))?.type === "blob") deletions.push({ path: this.physical(scope, change.path) });
      const input = {
        branch: { repositoryNameWithOwner: scope.connection.repository.fullName, branchName: scope.connection.repository.branch },
        expectedHeadOid: base.head,
        message: { headline: message.split("\n")[0], body: message.split("\n").slice(1).join("\n") + "\n\nDSS-Operation: " + operation.id + "\nDSS-Request-SHA256: " + operation.requestHash },
        fileChanges: { additions, deletions },
        clientMutationId: operation.id
      };
      let result;
      let failure;
      try {
        result = await session.request("POST", "/graphql", { query: "mutation DSSCommit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid tree { oid } } } }", variables: { input } });
      } catch (error) {
        if (error instanceof GitHubError && [401, 403].includes(error.status)) {
          if (error.retryAt === void 0) this.checked = void 0;
          throw error;
        }
        failure = error;
      }
      const oid2 = result?.data?.createCommitOnBranch?.commit?.oid;
      if (oid2) {
        const tree = result?.data?.createCommitOnBranch?.commit?.tree?.oid;
        const gitOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
        if (!result?.errors?.length && gitOid.test(oid2) && typeof tree === "string" && gitOid.test(tree)) {
          scope.metadata.latestTree = { head: oid2, tree };
        }
        return { commit: oid2, replay: false };
      }
      let resolution;
      try {
        resolution = await this.resolve(session, scope, operation);
      } catch {
      }
      if (resolution?.status === "confirmed") return { commit: resolution.commit, replay: false, ...resolution.verifiedWrites ? { verifiedWrites: resolution.verifiedWrites } : {} };
      if (resolution?.status === "conflict") throw new GitConflictError();
      if (resolution?.status === "pending" && result?.errors?.length && result.data?.createCommitOnBranch === null) {
        throw new Error("GitHub commit rejected: " + result.errors.map((error) => error.message).join("; "));
      }
      throw new GitCommitOutcomeUnknownError(operation, { cause: failure });
    });
  }
  /** Compatibility entry point. New durable callers use prepare/persist/commitPrepared. */
  async commit(base, changes, message) {
    return this.commitPrepared(base, changes, message, this.prepareCommit(base, changes, message));
  }
};

// src/framework/transactions.ts
var FilesConflictError = class extends Error {
  constructor(expectedRevision, options) {
    super("Storage changed since the checked snapshot; read and evaluate the business conditions again.", options);
    this.expectedRevision = expectedRevision;
    this.name = "FilesConflictError";
  }
};
var FilesOutcomeUnknownError = class extends Error {
  constructor(operationId, options, confirmed) {
    super(confirmed ? "Commit succeeded but its local receipt could not be saved; retain the operation identity." : "Commit result is uncertain; resolve the same persisted operation before retrying.", options);
    this.operationId = operationId;
    this.confirmed = confirmed;
    this.name = "FilesOutcomeUnknownError";
  }
};
function filePath(path3) {
  if (!path3 || /[\\\0\r\n]/.test(path3) || path3.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Use a relative file path inside the DSS storage root.");
  }
  return path3;
}
function directoryPrefix(prefix) {
  return prefix === "" ? "" : filePath(prefix.replace(/\/$/, "")) + "/";
}
function validateChanges(changes) {
  const paths2 = /* @__PURE__ */ new Set();
  for (const change of changes) {
    filePath(change.path);
    if (change.bytes !== void 0 ? !(change.bytes instanceof Uint8Array) || change.content !== void 0 : typeof change.content !== "string" && change.content !== null) throw new Error("A change must carry text, bytes, or a deletion, never mixed representations.");
    if (paths2.has(change.path)) throw new Error("A transaction cannot write the same path twice: " + change.path);
    paths2.add(change.path);
  }
}
function withReadOperation(store, operation) {
  return store.withReadOperation ? store.withReadOperation(operation) : operation();
}
async function withSnapshot(store, operation, plan) {
  const owned = async () => {
    const snapshot = await store.snapshot(plan);
    try {
      return await operation(snapshot);
    } finally {
      await snapshot.release();
    }
  };
  return withReadOperation(store, owned);
}
var GitFiles = class {
  constructor(repository, operations2) {
    this.repository = repository;
    this.operations = operations2;
  }
  snapshots = /* @__PURE__ */ new WeakMap();
  withReadOperation(operation) {
    return this.repository.withReadOperation(operation);
  }
  wrap(native) {
    const snapshot = { revision: native.head, release: async () => {
      this.snapshots.delete(snapshot);
    } };
    this.snapshots.set(snapshot, native);
    return snapshot;
  }
  plan(plan) {
    return {
      signal: plan.signal,
      isolatePathErrors: plan.isolatePathErrors,
      files: plan.files?.map((path3) => "dss-coop/" + filePath(path3)),
      directories: plan.directories?.map((path3) => "dss-coop/" + directoryPrefix(path3).replace(/\/$/, ""))
    };
  }
  async snapshot(plan) {
    return this.wrap(await this.repository.snapshot(false, plan && this.plan(plan)));
  }
  prefetch(snapshot, plan) {
    return this.repository.prefetch(this.native(snapshot), this.plan(plan));
  }
  async at(revision) {
    return this.wrap(await this.repository.at(revision));
  }
  native(snapshot) {
    const native = this.snapshots.get(snapshot);
    if (!native) throw new Error("Snapshot was released or belongs to another store.");
    return native;
  }
  read(snapshot, path3) {
    return this.repository.read(this.native(snapshot), "dss-coop/" + filePath(path3));
  }
  readBytes(snapshot, path3) {
    return this.repository.readBytes(this.native(snapshot), "dss-coop/" + filePath(path3));
  }
  async list(snapshot, prefix) {
    const native = this.native(snapshot), logical = directoryPrefix(prefix), remote = "dss-coop/" + logical;
    await this.repository.list(native, remote);
    return [...native.files].filter(([path3]) => path3.startsWith(remote)).map(([path3, version]) => ({
      path: path3.slice("dss-coop/".length),
      version,
      ...version === createHash4(version.length === 64 ? "sha256" : "sha1").update("blob 0\0").digest("hex") ? { bytes: 0, empty: true } : { empty: false }
    })).sort((a, b) => a.path.localeCompare(b.path));
  }
  async listDirectory(snapshot, prefix) {
    const entries = await this.repository.listDirectory(this.native(snapshot), "dss-coop/" + directoryPrefix(prefix));
    return entries.filter((entry) => entry.type === "blob").map((entry) => ({
      path: entry.path.slice("dss-coop/".length),
      version: entry.sha,
      ...entry.size === void 0 ? {} : { bytes: entry.size },
      empty: entry.size === 0 || entry.sha === createHash4(entry.sha.length === 64 ? "sha256" : "sha1").update("blob 0\0").digest("hex")
    })).sort((a, b) => a.path.localeCompare(b.path));
  }
  async prepare(snapshot, changes, message) {
    validateChanges(changes);
    const native = this.native(snapshot);
    const operation = this.repository.prepareCommit(native, changes.map((change) => ({ ...change, path: "dss-coop/" + change.path })), message);
    await this.operations.save({ operation });
    return operation;
  }
  async commitPrepared(snapshot, changes, message, id) {
    const record = await this.operations.get(id);
    if (!record) throw new Error("No persisted operation: " + id);
    return this.dispatch(this.native(snapshot), changes.map((change) => ({ ...change, path: "dss-coop/" + change.path })), message, record.operation);
  }
  async commit(snapshot, changes, message) {
    const operation = await this.prepare(snapshot, changes, message);
    return this.commitPrepared(snapshot, changes, message, operation.id);
  }
  async dispatch(native, changes, message, operation) {
    let receipt;
    try {
      const result = await this.repository.commitPrepared(native, changes, message, operation);
      receipt = { revision: result.commit, replay: result.replay, operationId: operation.id };
      if (result.verifiedWrites) Object.defineProperty(receipt, "verifiedWrites", { value: result.verifiedWrites });
    } catch (error) {
      if (error instanceof GitConflictError) throw new FilesConflictError(operation.expectedHead, { cause: error });
      if (error instanceof GitCommitOutcomeUnknownError) throw new FilesOutcomeUnknownError(operation.id, { cause: error });
      throw error;
    }
    try {
      await this.operations.save({ operation, resolution: { status: "confirmed", commit: receipt.revision, head: receipt.revision } });
    } catch (error) {
      throw new FilesOutcomeUnknownError(operation.id, { cause: error }, receipt);
    }
    return receipt;
  }
  /** Explicit retry uses the original operation and snapshot, never a replacement identity. */
  async retryPrepared(id, changes, message) {
    validateChanges(changes);
    const record = await this.operations.get(id);
    if (!record) throw new Error("No persisted operation: " + id);
    const native = await this.repository.at(record.operation.expectedHead);
    const remote = changes.map((change) => ({ ...change, path: "dss-coop/" + change.path }));
    return this.dispatch(native, remote, message, record.operation);
  }
  matchesVerifiedWrites(snapshot, receipt, expected) {
    return this.repository.matchesVerifiedWrites(
      this.native(snapshot),
      receipt.verifiedWrites,
      expected.map((write) => ({ ...write, path: "dss-coop/" + filePath(write.path) }))
    );
  }
  /** Check a persisted uncertain operation before deciding whether to retry or re-evaluate. */
  async resolve(id) {
    const record = await this.operations.get(id);
    if (!record) throw new Error("No persisted operation: " + id);
    const resolution = await this.repository.resolveCommit(record.operation);
    const persisted = resolution.status === "confirmed" ? { status: resolution.status, commit: resolution.commit, head: resolution.head } : resolution;
    await this.operations.save({ operation: record.operation, resolution: persisted });
    return resolution;
  }
};

// src/framework/legacy-record-export.ts
var hash = (value) => createHash5("sha256").update(value).digest("hex");
var LEGACY_BASELINE = "0acd3ba39a2ae23d66759279b3c54c4637cd0ad5";
function legacyMigratedTaskId(scope, oldId) {
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(oldId)) return oldId;
  const digest9 = hash(scope + "\0" + oldId);
  return `${digest9.slice(0, 8)}-${digest9.slice(8, 12)}-8${digest9.slice(13, 16)}-a${digest9.slice(17, 20)}-${digest9.slice(20, 32)}`;
}
var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var integer = (value) => Number.isSafeInteger(value) && value >= 0;
var digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
var legacyLocalRecordsReference = (id) => "records/" + encodeURIComponent(id) + "/records.md";
async function readSealedPart(part, taskId, read) {
  if (!object(part) || !digest(part.sha256) || !integer(part.characters) || !integer(part.bytes) || part.key !== "records/" + encodeURIComponent(taskId) + "/content/" + part.sha256)
    throw new Error("Invalid sealed legacy record part: " + taskId);
  const body = await read(part.key);
  if (!object(body) || body.schemaVersion !== 1 || typeof body.text !== "string" || hash(body.text) !== part.sha256 || body.text.length !== part.characters || Buffer.byteLength(body.text, "utf8") !== part.bytes)
    throw new Error("Sealed legacy record part is missing or corrupt: " + part.key);
  return body.text;
}
async function decodeLegacySealedTask(value, taskId, read) {
  if (!object(value) || value.schemaVersion !== 1 || value.state !== "sealed" || value.taskId !== taskId || !Array.isArray(value.snapshot))
    throw new Error("Legacy sealed Task snapshot is missing or invalid: " + taskId);
  const pieces = [];
  for (const part of value.snapshot) pieces.push(await readSealedPart(part, taskId, read));
  const task = JSON.parse(pieces.join(""));
  if (!object(task) || task.schemaVersion !== 1 || task.id !== taskId) throw new Error("Invalid legacy sealed Task identity: " + taskId);
  return task;
}
async function decodeLegacySealedRecords(value, taskId, read) {
  if (!object(value) || value.schemaVersion !== 1 || value.state !== "sealed" || value.taskId !== taskId || !["accepted", "ended"].includes(value.stage) || !Array.isArray(value.document) || !integer(value.characters) || !integer(value.bytes) || !digest(value.sha256))
    throw new Error("Invalid sealed legacy records: " + taskId);
  const sections = [];
  for (const segment5 of value.document) {
    if (!object(segment5)) throw new Error("Invalid sealed legacy document segment: " + taskId);
    if (typeof segment5.text === "string" && !("parts" in segment5)) sections.push(segment5.text);
    else if (Array.isArray(segment5.parts) && !("text" in segment5)) {
      for (const part of segment5.parts) {
        sections.push(await readSealedPart(part, taskId, read));
      }
    } else throw new Error("Invalid sealed legacy document segment: " + taskId);
  }
  const text = sections.join("");
  if (text.length !== value.characters || Buffer.byteLength(text, "utf8") !== value.bytes || hash(text) !== value.sha256)
    throw new Error("Sealed legacy records integrity mismatch: " + taskId);
  return text;
}
async function context(files, snapshot, manifestPath2) {
  filePath(manifestPath2);
  const match = /^technical\/legacy-migrations\/([^/]+)\/manifest\.json$/.exec(manifestPath2);
  if (!match) throw new Error("Select an existing legacy migration manifest.");
  const raw = await files.read(snapshot, manifestPath2);
  if (raw === void 0) throw new Error("Legacy migration manifest is missing.");
  const manifest = JSON.parse(raw);
  if (manifest?.version !== 1 || manifest.id !== match[1] || manifest.baseline !== LEGACY_BASELINE || !["local", "git"].includes(manifest.source?.mode) || !Array.isArray(manifest.records) || !Array.isArray(manifest.tasks) || !object(manifest.references) || !object(manifest.referenceHashes) || manifest.clearedTasks !== void 0 && !Array.isArray(manifest.clearedTasks))
    throw new Error("Invalid legacy migration manifest.");
  const root = manifestPath2.slice(0, -"/manifest.json".length);
  const bytes = async (reference) => {
    const path3 = manifest.references[reference], expected = manifest.referenceHashes[reference];
    if (typeof path3 !== "string" || !digest(expected)) throw new Error("Legacy records reference has not been migrated: " + reference);
    filePath(path3);
    if (!path3.startsWith(root + "/source/") && !path3.startsWith(root + "/text/")) throw new Error("Legacy records reference escapes its migration: " + reference);
    const body = await files.readBytes(snapshot, path3);
    if (body === void 0 || hash(body) !== expected) throw new Error("Migrated legacy records are missing or corrupt: " + reference);
    return body;
  };
  const json4 = async (key) => {
    const rows = manifest.records.filter((row) => row.key === key);
    if (rows.length !== 1 || rows[0].path !== root + "/source/" + hash(key) + ".bin" || manifest.references[key] !== rows[0].path || manifest.referenceHashes[key] !== rows[0].sha256)
      throw new Error("Legacy source record has not been preserved unambiguously: " + key);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(key)));
  };
  return { manifest, root, bytes, json: json4 };
}
async function identityFor(c, oldTaskId) {
  const { manifest, json: json4 } = c;
  if (typeof oldTaskId !== "string" || !oldTaskId) throw new Error("A preserved legacy Task identity is required.");
  if (manifest.clearedTasks?.some((task) => task.oldId === oldTaskId)) return void 0;
  const matches = manifest.tasks.filter((task) => task.oldId === oldTaskId);
  if (matches.length > 1) throw new Error("Ambiguous migrated legacy Task identity: " + oldTaskId);
  const mapped = matches[0];
  if (mapped && mapped.taskId !== legacyMigratedTaskId(manifest.id, oldTaskId)) throw new Error("Migrated legacy Task identity differs from its original mapping.");
  if (!mapped && manifest.source.mode === "local" && manifest.records.some((row) => row.key === "task:" + oldTaskId)) return void 0;
  if (mapped && !["complete", "cancelled"].includes(mapped.continuation)) return void 0;
  const key = manifest.source.mode === "local" ? "records/" + encodeURIComponent(oldTaskId) + "/manifest" : "records/" + oldTaskId + "/manifest.json";
  if (!manifest.records.some((row) => row.key === key)) return void 0;
  const sealed = await json4(key);
  if (!object(sealed) || sealed.taskId !== oldTaskId || (manifest.source.mode === "local" ? sealed.schemaVersion !== 1 || sealed.state !== "sealed" : sealed.version !== 1))
    throw new Error("Invalid preserved legacy records manifest: " + oldTaskId);
  let continuation = mapped?.continuation;
  if (manifest.source.mode === "local") {
    const historyKey = "task-history/" + encodeURIComponent(oldTaskId);
    if (manifest.records.some((row) => row.key === historyKey)) {
      const history = await json4(historyKey);
      if (!object(history) || history.schemaVersion !== 1 || history.taskId !== oldTaskId) throw new Error("Invalid preserved legacy history: " + oldTaskId);
      if (history.deleting) return void 0;
    } else if (!mapped) return void 0;
    if (!mapped) {
      const task = await decodeLegacySealedTask(sealed, oldTaskId, json4);
      continuation = task.phase === "cancelled" || task.control === "cancelled" ? "cancelled" : task.phase === "completed" ? "complete" : void 0;
      if (!continuation) return void 0;
    }
  }
  if (!continuation) return void 0;
  return { oldTaskId, taskId: mapped?.taskId ?? legacyMigratedTaskId(manifest.id, oldTaskId), continuation };
}
async function listLegacyRecordExports(files, snapshot, manifestPath2, onError) {
  const c = await context(files, snapshot, manifestPath2), { manifest } = c;
  const ids = new Set(manifest.tasks.map((task) => task.oldId));
  if (manifest.source.mode === "local") for (const row of manifest.records) {
    if (!row.key.startsWith("task-history/")) continue;
    try {
      const id = decodeURIComponent(row.key.slice("task-history/".length));
      if (!id || row.key !== "task-history/" + encodeURIComponent(id)) throw new Error("Invalid legacy history identity.");
      ids.add(id);
    } catch (error) {
      if (!onError) throw error;
      onError(error, row.key);
    }
  }
  const result = [];
  for (const id of ids) {
    try {
      const item = await identityFor(c, id);
      if (item) result.push(item);
    } catch (error) {
      if (!onError) throw error;
      onError(error, id);
    }
  }
  return result;
}
async function readLegacyRecordExport(files, snapshot, input) {
  const c = await context(files, snapshot, input.manifestPath), selected = await identityFor(c, input.oldTaskId);
  if (!selected) throw new Error("Sealed legacy task records are unavailable or were explicitly cleared.");
  const { manifest, root, bytes, json: json4 } = c;
  if (manifest.source.mode === "local") {
    const sealed2 = await json4("records/" + encodeURIComponent(input.oldTaskId) + "/manifest");
    const text = await decodeLegacySealedRecords(sealed2, input.oldTaskId, json4);
    const reference = legacyLocalRecordsReference(input.oldTaskId), path3 = manifest.references[reference];
    if (path3 !== void 0 || manifest.referenceHashes[reference] !== void 0) {
      if (path3 !== root + "/text/" + hash(reference) + ".md") throw new Error("Invalid materialized legacy records path.");
      const body2 = await bytes(reference);
      if (!Buffer.from(body2).equals(Buffer.from(text, "utf8"))) throw new Error("Materialized legacy records differ from the original sealed document.");
      return { taskId: selected.taskId, path: path3, bytes: body2 };
    }
    return { taskId: selected.taskId, bytes: Buffer.from(text, "utf8") };
  }
  const sealed = await json4("records/" + input.oldTaskId + "/manifest.json");
  if (!object(sealed) || typeof sealed.recordsPath !== "string" || !digest(sealed.recordsSha256) || !sealed.recordsPath.startsWith("dss-coop/records/" + input.oldTaskId + "/versions/")) throw new Error("Invalid sealed legacy Git records reference.");
  if (manifest.references[sealed.recordsPath] !== root + "/text/" + hash(sealed.recordsPath) + ".md") throw new Error("Invalid materialized legacy Git records path.");
  const body = await bytes(sealed.recordsPath);
  if (hash(body) !== sealed.recordsSha256) throw new Error("Sealed legacy Git records integrity mismatch.");
  return { taskId: selected.taskId, path: manifest.references[sealed.recordsPath], bytes: body };
}

// src/framework/local-files.ts
import { createHash as createHash6, randomUUID as randomUUID4 } from "node:crypto";
import { mkdir as mkdir3, realpath as realpath2 } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var digest2 = (bytes) => createHash6("sha256").update(bytes).digest("hex");
var LocalFiles = class _LocalFiles {
  constructor(directory, databasePath, writer) {
    this.directory = directory;
    this.databasePath = databasePath;
    this.writer = writer;
  }
  snapshots = /* @__PURE__ */ new Map();
  closed = false;
  static async open(directory) {
    await mkdir3(directory, { recursive: true });
    const root = await realpath2(directory), databasePath = join(root, "dss-files.sqlite");
    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, content TEXT NOT NULL, version TEXT NOT NULL, bytes INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS git_operations(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
      const columns = writer.prepare("PRAGMA table_info(files)").all();
      if (!columns.some((column) => column.name === "binary")) writer.exec("ALTER TABLE files ADD COLUMN binary BLOB");
      writer.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)").run("head", randomUUID4());
      return new _LocalFiles(root, databasePath, writer);
    } catch (error) {
      writer.close();
      throw error;
    }
  }
  assertOpen() {
    if (this.closed) throw new Error("Local file storage is closed.");
  }
  async snapshot() {
    this.assertOpen();
    const reader = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      reader.exec("BEGIN");
      const revision = reader.prepare("SELECT value FROM metadata WHERE key='head'").get().value;
      const snapshot = { revision, release: async () => {
        const current = this.snapshots.get(snapshot);
        if (!current) return;
        current.exec("ROLLBACK");
        current.close();
        this.snapshots.delete(snapshot);
      } };
      this.snapshots.set(snapshot, reader);
      return snapshot;
    } catch (error) {
      reader.close();
      throw error;
    }
  }
  reader(snapshot) {
    this.assertOpen();
    const reader = this.snapshots.get(snapshot);
    if (!reader) throw new Error("Snapshot was released or belongs to another store.");
    return reader;
  }
  async read(snapshot, path3) {
    const bytes = await this.readBytes(snapshot, path3);
    return bytes === void 0 ? void 0 : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  async readBytes(snapshot, path3) {
    const row = this.reader(snapshot).prepare("SELECT content,binary FROM files WHERE path=?").get(filePath(path3));
    return row === void 0 ? void 0 : row.binary ?? Buffer.from(row.content, "utf8");
  }
  async list(snapshot, prefix) {
    const value = directoryPrefix(prefix);
    const rows = value ? this.reader(snapshot).prepare("SELECT path,version,bytes FROM files WHERE path>=? AND path<? ORDER BY path").all(value, value.slice(0, -1) + "0") : this.reader(snapshot).prepare("SELECT path,version,bytes FROM files ORDER BY path").all();
    return rows.map((row) => ({ ...row, empty: row.bytes === 0 }));
  }
  async listDirectory(snapshot, prefix) {
    const value = directoryPrefix(prefix);
    const rows = value ? this.reader(snapshot).prepare(
      "SELECT path,version,bytes FROM files WHERE path>=? AND path<? AND instr(substr(path,?),'/')=0 ORDER BY path"
    ).all(value, value.slice(0, -1) + "0", value.length + 1) : this.reader(snapshot).prepare("SELECT path,version,bytes FROM files WHERE instr(path,'/')=0 ORDER BY path").all();
    return rows.map((row) => ({ ...row, empty: row.bytes === 0 }));
  }
  async commit(snapshot, changes, _message) {
    this.reader(snapshot);
    validateChanges(changes);
    this.writer.exec("BEGIN IMMEDIATE");
    try {
      const head = this.writer.prepare("SELECT value FROM metadata WHERE key='head'").get().value;
      if (head !== snapshot.revision) throw new FilesConflictError(snapshot.revision);
      const put = this.writer.prepare("INSERT INTO files(path,content,version,bytes,binary) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content,version=excluded.version,bytes=excluded.bytes,binary=excluded.binary");
      const remove = this.writer.prepare("DELETE FROM files WHERE path=?");
      for (const change of changes) {
        if (change.content === null) remove.run(change.path);
        else {
          const bytes = change.bytes ?? Buffer.from(change.content, "utf8");
          put.run(change.path, change.content ?? "", digest2(bytes), bytes.byteLength, change.bytes ?? null);
        }
      }
      for (const change of changes) if (change.content !== null) {
        const parts = change.path.split("/");
        for (let index = 1; index < parts.length; index++) {
          const ancestor = parts.slice(0, index).join("/");
          if (this.writer.prepare("SELECT 1 FROM files WHERE path=?").get(ancestor)) throw new Error("File occupies a parent directory: " + ancestor);
        }
        const prefix = change.path + "/";
        if (this.writer.prepare("SELECT 1 FROM files WHERE path>=? AND path<? LIMIT 1").get(prefix, prefix.slice(0, -1) + "0")) {
          throw new Error("Directory already contains files: " + change.path);
        }
      }
      const revision = randomUUID4();
      this.writer.prepare("UPDATE metadata SET value=? WHERE key='head'").run(revision);
      this.writer.exec("COMMIT");
      return { revision, replay: false };
    } catch (error) {
      if (this.writer.isTransaction) this.writer.exec("ROLLBACK");
      throw error;
    }
  }
  /** Technical write receipts stay local; values are operation IDs and hashes, not Git bodies. */
  operations = {
    save: async (record) => {
      this.assertOpen();
      this.writer.prepare("INSERT INTO git_operations(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(record.operation.id, JSON.stringify(record));
    },
    get: async (id) => {
      this.assertOpen();
      const row = this.writer.prepare("SELECT value FROM git_operations WHERE id=?").get(id);
      return row ? JSON.parse(row.value) : void 0;
    },
    list: async () => {
      this.assertOpen();
      const rows = this.writer.prepare("SELECT value FROM git_operations ORDER BY id").all();
      return rows.map((row) => JSON.parse(row.value));
    }
  };
  async close() {
    if (this.closed) return;
    for (const snapshot of [...this.snapshots.keys()]) await snapshot.release();
    this.writer.close();
    this.closed = true;
  }
};

// src/application/record-journal.ts
import { createHash as createHash7 } from "node:crypto";
var PART_CHARACTERS = 64 * 1024;
var PAGE_CHARACTERS = 32 * 1024;
var kinds = /* @__PURE__ */ new Set(["planner-memory", "planner-note", "worker-reply", "task-origin", "recovery", "execution", "conversation"]);
var digest3 = (text) => createHash7("sha256").update(text, "utf8").digest("hex");
function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== void 0).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
function component(value) {
  if (!value || /[\0\r\n]/.test(value)) throw new Error("A stable record scope identity is required.");
  return encodeURIComponent(value);
}
function recordStream(scope) {
  if (!kinds.has(scope.kind)) throw new Error("Unknown record family.");
  if (scope.kind === "conversation") return "conversations/" + component(scope.assistantId) + "/" + component(scope.date);
  const root = scope.kind + "/" + component(scope.taskId);
  return scope.kind === "worker-reply" ? root + "/" + component(scope.childId) : root;
}
function archivedRecordKey(key) {
  return "record-archive/" + key.split("/")[1] + "/entry/" + digest3(key);
}
function keyFromRef(ref) {
  if (!ref.startsWith("dss-record://")) throw new Error("Use the exact record reference returned by a record tool.");
  return decodeURIComponent(ref.slice("dss-record://".length));
}
function summary(entry) {
  const { parts: _parts, fingerprint: _fingerprint, ...result } = entry;
  return structuredClone(result);
}
function isEntry(value) {
  return !!value && typeof value === "object" && value.kind === "servant-record-entry" && value.schemaVersion === 1;
}
function positiveLimit(value, fallback, maximum) {
  if (value === void 0) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("Invalid page size.");
  return value;
}
var RecordJournal = class {
  constructor(storage, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
    this.storage = storage;
    this.now = now;
  }
  queues = /* @__PURE__ */ new Map();
  async append(input) {
    const request = structuredClone(input);
    const stream = recordStream(request.scope);
    if (!request.commandId || typeof request.text !== "string") throw new Error("A command identity and text are required.");
    const previous = this.queues.get(stream) ?? Promise.resolve();
    const pending = previous.catch(() => {
    }).then(async () => {
      const fingerprint = digest3(canonicalJson({
        scope: request.scope,
        text: request.text,
        source: request.source,
        metadata: request.metadata ?? {},
        expectedRevision: request.expectedRevision
      }));
      const entryId = digest3(request.commandId);
      const key = stream + "/entry/" + entryId;
      const existing = await this.storage.get(key);
      if (existing) {
        if (!isEntry(existing) || existing.fingerprint !== fingerprint) throw new Error("COMMAND_ID_REUSED: Record command has different content.");
        return summary(existing);
      }
      const entries = await this.entries(request.scope);
      const revision = entries.at(-1)?.sequence ?? 0;
      if (request.expectedRevision !== void 0 && request.expectedRevision !== revision) throw new Error("STALE_RECORD_REVISION: Read the current note before updating it.");
      const parts = [];
      let offset = 0;
      do {
        let end = Math.min(request.text.length, offset + PART_CHARACTERS);
        const last = request.text.charCodeAt(end - 1);
        if (end < request.text.length && last >= 55296 && last <= 56319) end--;
        const text = request.text.slice(offset, end);
        const part = {
          key: stream + "/content/" + entryId + "/" + parts.length,
          characters: text.length,
          bytes: Buffer.byteLength(text, "utf8"),
          sha256: digest3(text)
        };
        await this.storage.set(part.key, { schemaVersion: 1, text });
        parts.push(part);
        offset = end;
      } while (offset < request.text.length);
      const entry = {
        schemaVersion: 1,
        kind: "servant-record-entry",
        ref: "dss-record://" + encodeURIComponent(key),
        scope: request.scope,
        sequence: revision + 1,
        commandId: request.commandId,
        fingerprint,
        createdAt: request.createdAt ?? this.now(),
        source: request.source,
        characters: request.text.length,
        bytes: Buffer.byteLength(request.text, "utf8"),
        sha256: digest3(request.text),
        parts,
        metadata: request.metadata ?? {}
      };
      await this.storage.set(key, entry);
      return summary(entry);
    });
    this.queues.set(stream, pending);
    try {
      return await pending;
    } finally {
      if (this.queues.get(stream) === pending) this.queues.delete(stream);
    }
  }
  async byCommand(scope, commandId) {
    return this.storage.get(recordStream(scope) + "/entry/" + digest3(commandId));
  }
  async entries(scope) {
    const live = await this.storage.list(recordStream(scope) + "/entry/");
    const archived = scope.taskId ? (await this.storage.list("record-archive/" + component(scope.taskId) + "/entry/")).filter((row) => isEntry(row.value) && recordStream(row.value.scope) === recordStream(scope)) : [];
    const unique2 = new Map([...archived, ...live].map((row) => [row.value.ref, row]));
    return [...unique2.values()].map((row) => {
      if (!isEntry(row.value) || recordStream(row.value.scope) !== recordStream(scope)) throw new Error("Invalid record manifest: " + row.key);
      return row.value;
    }).sort((a, b) => a.sequence - b.sequence);
  }
  async page(scope, cursor = 0, limit = 20) {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Invalid record cursor.");
    limit = positiveLimit(limit, 20, 100);
    const all = await this.entries(scope);
    const candidates = all.filter((entry) => entry.sequence > cursor);
    const entries = candidates.slice(0, limit);
    return {
      entries: entries.map(summary),
      revision: all.at(-1)?.sequence ?? 0,
      ...candidates.length > entries.length ? { nextCursor: entries.at(-1).sequence } : {}
    };
  }
  async manifest(ref) {
    const key = keyFromRef(ref);
    const entry = await this.storage.get(archivedRecordKey(key)) ?? await this.storage.get(key);
    if (!isEntry(entry) || entry.ref !== ref) throw new Error("Record not found: " + ref);
    return entry;
  }
  async read(ref, cursor = 0, limit = PAGE_CHARACTERS) {
    const entry = await this.manifest(ref);
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > entry.characters) throw new Error("Invalid text cursor.");
    limit = positiveLimit(limit, PAGE_CHARACTERS, 256 * 1024);
    const end = Math.min(entry.characters, cursor + limit);
    let position = 0;
    let text = "";
    for (const part of entry.parts) {
      const next = position + part.characters;
      if (next > cursor && position < end) {
        const value = await this.storage.get(part.key);
        if (!value || digest3(value.text) !== part.sha256) throw new Error("Record part is missing or corrupt: " + part.key);
        text += value.text.slice(Math.max(0, cursor - position), Math.min(part.characters, end - position));
      }
      position = next;
    }
    return { entry: summary(entry), text, cursor, ...end < entry.characters ? { nextCursor: end } : {} };
  }
  async fullText(ref) {
    const entry = await this.manifest(ref);
    const texts = [];
    for (const part of entry.parts) {
      const value = await this.storage.get(part.key);
      if (!value || digest3(value.text) !== part.sha256) throw new Error("Record part is missing or corrupt: " + part.key);
      texts.push(value.text);
    }
    const text = texts.join("");
    if (digest3(text) !== entry.sha256 || Buffer.byteLength(text, "utf8") !== entry.bytes) throw new Error("Record content hash mismatch.");
    return text;
  }
  async search(scope, query, cursor = 0, limit = 20) {
    if (!query.trim()) throw new Error("Enter a search phrase.");
    limit = positiveLimit(limit, 20, 100);
    const matches = [];
    const entries = (await this.entries(scope)).filter((entry) => entry.sequence > cursor);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const text = await this.fullText(entry.ref);
      const found = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if (found >= 0) matches.push({ entry: summary(entry), excerpt: text.slice(Math.max(0, found - 100), found + query.length + 160) });
      if (matches.length === limit) return { matches, ...index + 1 < entries.length ? { nextCursor: entry.sequence } : {} };
    }
    return { matches };
  }
  async flush() {
    await Promise.allSettled([...this.queues.values()]);
  }
};

// src/application/task-records.ts
import { createHash as createHash8 } from "node:crypto";
var fields = ["goal", "goalHistory", "plannerNote", "plan", "children", "reports", "executions", "pendingActions", "receipts", "waits", "incidents", "decisions"];
var scalar = /* @__PURE__ */ new Set(["goal", "plannerNote", "plan"]);
var arrays = /* @__PURE__ */ new Set(["goalHistory", "decisions"]);
function isSeparatedTask(value) {
  return !!value && typeof value === "object" && value.recordsLayout?.version === 1;
}
function values(task, field) {
  const value = task?.[field];
  if (value === void 0) return /* @__PURE__ */ new Map();
  if (scalar.has(field)) return /* @__PURE__ */ new Map([["current", value]]);
  if (arrays.has(field)) return new Map(value.map((entry) => [entry.commandId, entry]));
  return new Map(Object.entries(value));
}
function recordKind(field) {
  if (field === "goal" || field === "goalHistory") return "task-origin";
  if (field === "plannerNote") return "planner-note";
  if (field === "decisions") return "planner-memory";
  if (field === "reports") return "worker-reply";
  return field === "waits" || field === "incidents" ? "recovery" : "execution";
}
var TaskRecords = class {
  constructor(journal) {
    this.journal = journal;
  }
  prepare(task, previous) {
    const root = JSON.parse(JSON.stringify(task));
    const storedFields = fields.filter((field) => task[field] !== void 0);
    root.recordsLayout = {
      version: 1,
      fields: storedFields,
      counts: Object.fromEntries(storedFields.map((field) => [field, values(task, field).size]))
    };
    const writes = [];
    for (const field of fields) {
      const before = values(previous, field), after = values(task, field);
      for (const id of /* @__PURE__ */ new Set([...before.keys(), ...after.keys()])) {
        const old = before.get(id), value = after.get(id);
        if (previous && canonicalJson(old) === canonicalJson(value)) continue;
        const text = canonicalJson(value);
        const hash13 = createHash8("sha256").update(text).digest("hex");
        const report = field === "reports" ? value ?? old : void 0;
        const binding = report ? task.executions[report.executionId] : void 0;
        const source = binding ? { kind: "agent", id: binding.agentId, executionId: binding.executionId, sessionId: binding.sessionId, role: binding.role } : field === "goal" ? task.source : { kind: "runtime", id: "deepseek-servant-records" };
        writes.push({
          scope: { kind: recordKind(field), taskId: task.id, ...report ? { childId: report.childId } : {} },
          commandId: "capture:" + task.revision + ":" + field + ":" + id + ":" + hash13,
          text,
          source,
          createdAt: task.updatedAt,
          metadata: { field, recordKey: id, taskRevision: task.revision, deleted: value === void 0 }
        });
      }
      delete root[field];
    }
    return { schemaVersion: 1, expectedRevision: previous?.revision ?? 0, root, writes };
  }
  async write(prepared) {
    for (const entry of prepared.writes) await this.journal.append(entry);
  }
  async entries(taskId, maximumRevision = Number.POSITIVE_INFINITY) {
    const result = [];
    for (const kind2 of ["task-origin", "planner-memory", "planner-note", "worker-reply", "execution", "recovery"]) {
      const rows = await this.journal.storage.list(kind2 + "/" + encodeURIComponent(taskId) + "/");
      for (const { value } of rows) {
        const entry = value;
        if (entry?.kind === "servant-record-entry" && entry.scope.taskId === taskId && typeof entry.metadata.taskRevision === "number" && entry.metadata.taskRevision <= maximumRevision && fields.includes(entry.metadata.field)) result.push(entry);
      }
    }
    return result;
  }
  async hydrate(root) {
    const result = structuredClone(root);
    delete result.recordsLayout;
    const selected = /* @__PURE__ */ new Map();
    for (const entry of await this.entries(root.id, root.revision)) {
      const key = entry.metadata.field + ":" + entry.metadata.recordKey;
      const prior = selected.get(key);
      if (!prior || Number(entry.metadata.taskRevision) > Number(prior.metadata.taskRevision)) selected.set(key, entry);
    }
    for (const field of root.recordsLayout.fields) {
      const entries = [...selected.values()].filter((entry) => entry.metadata.field === field && !entry.metadata.deleted).sort((a, b) => Number(a.metadata.taskRevision) - Number(b.metadata.taskRevision) || a.sequence - b.sequence);
      const expected = root.recordsLayout.counts?.[field];
      if (expected !== void 0 && entries.length !== expected) throw new Error("Task records incomplete: " + root.id + "/" + field);
      const contents = await Promise.all(entries.map(async (entry) => [String(entry.metadata.recordKey), JSON.parse(await this.journal.fullText(entry.ref))]));
      const value = scalar.has(field) ? contents[0]?.[1] : arrays.has(field) ? contents.map(([, value2]) => value2) : Object.fromEntries(contents);
      Object.defineProperty(result, field, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
};

// src/framework/task-files.ts
import { randomUUID as randomUUID5 } from "node:crypto";
var encodeJson = (value) => JSON.stringify(value, null, 2) + "\n";
var segment = (value) => {
  filePath(value);
  if (value.includes("/")) throw new Error("An identity must occupy one path segment.");
  return value;
};
var paths = {
  task: (taskId) => "tasks/" + segment(taskId) + ".json",
  run: (taskId) => "task-runs/" + segment(taskId),
  state: (member, taskId) => "state/" + segment(member) + "/" + segment(taskId),
  member: (taskId, member) => "task-runs/" + segment(taskId) + "/" + segment(member),
  inbox: (taskId, member) => "task-runs/" + segment(taskId) + "/" + segment(member) + "/" + segment(member) + "_Inbox/" + segment(member) + "_" + segment(taskId) + ".md",
  memberStatus: (taskId, member) => "task-runs/" + segment(taskId) + "/" + segment(member) + "/" + segment(member) + "_Inbox/status.json",
  inboxCursor: (taskId, member) => "task-runs/" + segment(taskId) + "/" + segment(member) + "/inbox-observation.json",
  cache: (taskId) => "Recorder Cache/" + segment(taskId) + "/links.json",
  archive: (taskId) => "archives/" + segment(taskId)
};
async function readJson(store, snapshot, path3) {
  const value = await store.read(snapshot, path3);
  return value === void 0 ? void 0 : JSON.parse(value);
}
async function readMemberStatus(store, snapshot, path3) {
  let value;
  try {
    value = await readJson(store, snapshot, path3);
  } catch (cause) {
    throw new Error("Cannot read member status: " + path3, { cause });
  }
  if (value === void 0) return void 0;
  if (!value || typeof value !== "object" || !("state" in value) || !("deliveryId" in value) || typeof value.state !== "string" || !["running", "complete"].includes(value.state) || typeof value.deliveryId !== "string") {
    throw new Error("Invalid member status: " + path3);
  }
  return value;
}
function taskIdentity(text) {
  return /^Task ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\r?\n|$)/i.exec(text)?.[1];
}
function templates(taskId, member) {
  const root = paths.member(taskId, member);
  return [
    { path: paths.inbox(taskId, member), content: "" },
    { path: paths.memberStatus(taskId, member), content: encodeJson({ state: "running", deliveryId: "" }) },
    { path: root + "/Planner_Memory.md", content: "" },
    { path: root + "/Plan_Note.md", content: "" },
    { path: root + "/Plan.md", content: "" },
    { path: root + "/Reply.md", content: "" }
  ];
}
async function initializeTask(store, snapshot, sourcePath, owner, members, assignedTaskId) {
  filePath(sourcePath);
  segment(owner);
  const route = /^tasks\/[^/]+_(P|O)\.md$/.exec(sourcePath)?.[1];
  if (!route) throw new Error("New tasks use tasks/<name>_P.md or tasks/<name>_O.md.");
  const source = await store.read(snapshot, sourcePath);
  if (source === void 0) throw new Error("Task source is missing: " + sourcePath);
  if (assignedTaskId && !taskIdentity("Task ID: " + assignedTaskId)) throw new Error("Assigned task identity must be a UUID.");
  const taskId = taskIdentity(source) ?? assignedTaskId ?? randomUUID5();
  const existing = await readJson(store, snapshot, paths.task(taskId));
  if (existing) return { value: existing, changes: [] };
  const metadata = { version: 1, taskId, route, sourcePath, owner, status: "running", members: [.../* @__PURE__ */ new Set([owner, ...members])] };
  const changes = /* @__PURE__ */ new Map();
  const add = (change) => changes.set(change.path, change);
  add({ path: sourcePath, content: taskIdentity(source) ? source : "Task ID: " + taskId + "\n" + source });
  add({ path: paths.task(taskId), content: encodeJson(metadata) });
  const run = paths.run(taskId);
  for (const change of [
    { path: run + "/Organizer_Note.md", content: "" },
    { path: run + "/Dispatch.md", content: "" },
    ...[.../* @__PURE__ */ new Set([owner, ...members])].flatMap((member) => templates(taskId, member))
  ]) if (await store.read(snapshot, change.path) === void 0) add(change);
  add({ path: paths.cache(taskId), content: encodeJson({ version: 1, links: [
    { kind: "file", path: sourcePath },
    { kind: "file", path: paths.task(taskId) },
    { kind: "directory", path: run + "/" }
  ] }) });
  if (route === "P") {
    const cleanPlan = taskIdentity(source) ? source.replace(/^Task ID: [^\r\n]+\r?\n?/, "") : source;
    add({ path: paths.inbox(taskId, owner), content: cleanPlan });
    add({ path: paths.memberStatus(taskId, owner), content: encodeJson({ state: "running", deliveryId: taskId }) });
  } else add({ path: paths.state(owner, taskId) + "/Organizer_Task", content: "" });
  return { value: metadata, changes: [...changes.values()] };
}
async function deliverMember(store, snapshot, task, member, plan, records = [], deliveryId = randomUUID5()) {
  const changes = /* @__PURE__ */ new Map();
  if (!(task.members ?? [task.owner]).includes(member)) changes.set(paths.task(task.taskId), {
    path: paths.task(task.taskId),
    content: encodeJson({ ...task, members: [.../* @__PURE__ */ new Set([...task.members ?? [task.owner], member])] })
  });
  for (const template of templates(task.taskId, member)) {
    if (await store.read(snapshot, template.path) === void 0) changes.set(template.path, template);
  }
  for (const record of records) changes.set(record.path, record);
  changes.set(paths.inbox(task.taskId, member), { path: paths.inbox(task.taskId, member), content: plan });
  changes.set(paths.memberStatus(task.taskId, member), {
    path: paths.memberStatus(task.taskId, member),
    content: encodeJson({ state: "running", deliveryId })
  });
  return [...changes.values()];
}
var observedInboxes = /* @__PURE__ */ new WeakMap();
function clearInboxDiscoveryCache(store, taskId) {
  const entries = observedInboxes.get(store), prefix = paths.run(taskId) + "/";
  for (const path3 of entries?.keys() ?? []) if (path3.startsWith(prefix)) entries.delete(path3);
}
async function discoverInbox(store, snapshot, taskId, member) {
  const inbox = paths.inbox(taskId, member);
  const directory = await store.listDirectory(snapshot, inbox.slice(0, inbox.lastIndexOf("/") + 1));
  const entry = directory.find((entry2) => entry2.path === inbox);
  const cached = observedInboxes.get(store);
  if (!entry || entry.empty || entry.bytes === 0) {
    cached?.delete(inbox);
    return [];
  }
  const statusPath = paths.memberStatus(taskId, member), cursorPath = paths.inboxCursor(taskId, member);
  const cursor = (await store.listDirectory(snapshot, paths.member(taskId, member) + "/")).find((entry2) => entry2.path === cursorPath);
  const signature = JSON.stringify([entry.version, directory.find((entry2) => entry2.path === statusPath)?.version ?? null, cursor?.version ?? null]);
  if (cached?.get(inbox) === signature) return [];
  cached?.delete(inbox);
  const status = await readMemberStatus(store, snapshot, statusPath);
  const version = encodeJson({ version: entry.version, deliveryId: status?.deliveryId ?? "" });
  if (await store.read(snapshot, cursorPath) === version) {
    const observations = cached ?? /* @__PURE__ */ new Map();
    observations.set(inbox, signature);
    observedInboxes.set(store, observations);
    return [];
  }
  return [
    { path: paths.inboxCursor(taskId, member), content: version },
    { path: paths.state(member, taskId) + "/Planner_Inbox", content: "" }
  ];
}
async function claimSignals(store, snapshot, signals, records) {
  const removals = [];
  for (const signal of signals) {
    filePath(signal);
    if (!signal.startsWith("state/") || signal.split("/").at(-1) === "recovery") throw new Error("Claim only ordinary state notifications; recovery has its own Planner consumption.");
    if (await store.read(snapshot, signal) === void 0) throw new Error("Notification is no longer present: " + signal);
    removals.push({ path: signal, content: null });
  }
  return [...records, ...removals];
}
async function completeMember(store, snapshot, taskId, member, results) {
  const current = await readMemberStatus(store, snapshot, paths.memberStatus(taskId, member));
  if (!current) throw new Error("Member Inbox status is missing.");
  return [
    ...results,
    { path: paths.memberStatus(taskId, member), content: encodeJson({ ...current, state: "complete" }) },
    { path: paths.state(member, taskId) + "/complete", content: "" }
  ];
}

// src/framework/legacy-artifacts.ts
var hash2 = (value) => createHash9("sha256").update(value).digest("hex");
var json = (value) => JSON.stringify(value, null, 2) + "\n";
var digest4 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
var WINDOW = 1024 * 1024;
function legacyDeclaredArtifacts(task) {
  const found = /* @__PURE__ */ new Map();
  for (const artifact of [...task.delivery?.artifacts ?? [], ...Object.values(task.reports).flatMap((report) => report.artifacts)]) {
    if (!artifact || typeof artifact.id !== "string" || !artifact.id || typeof artifact.path !== "string" || !artifact.path || artifact.sha256 !== void 0 && !digest4(artifact.sha256)) throw new Error("Invalid original legacy artifact declaration: " + task.id);
    const prior = found.get(artifact.id);
    if (prior && (prior.path !== artifact.path || prior.sha256 && artifact.sha256 && prior.sha256 !== artifact.sha256))
      throw new Error("Ambiguous original legacy artifact id: " + task.id + ":" + artifact.id);
    found.set(artifact.id, { ...artifact, ...prior?.sha256 ? { sha256: prior.sha256 } : {} });
  }
  return [...found.values()];
}
function declarations(capture, options) {
  if (capture.mode !== "local") return [];
  const result = [];
  for (const row of capture.tasks) {
    const task = row.original;
    try {
      if (task?.schemaVersion !== 1 || task.id !== row.id || !task.workspace?.directory || !task.reports) throw new Error("Original Task workspace and identity are unavailable.");
      for (const artifact of legacyDeclaredArtifacts(task)) result.push({ task, artifact });
    } catch (error) {
      issue(options, row.id, "", "", error);
    }
  }
  return result;
}
function issue(options, oldTaskId, id, sourcePath, error) {
  if (options.signal?.aborted && (error === options.signal.reason || error instanceof Error && error.name === "AbortError" && error.cause === options.signal.reason)) throw error;
  const item = { oldTaskId, id, sourcePath, detail: error instanceof Error ? error.message : String(error), error };
  if (!options.onIssue) throw error;
  options.onIssue(item);
  return item;
}
async function captureOne(ctx, value, signal) {
  const { task, artifact } = value;
  signal?.throwIfAborted();
  const root = await ctx.fs.resolve(task.workspace.directory, { signal });
  if ((await ctx.fs.stat(root, signal))?.type !== "directory") throw new Error("Original Task workspace is not an existing directory.");
  const target = await ctx.fs.resolve(artifact.path, { cwd: task.workspace.directory, signal });
  if (!ctx.fs.contains(root, target)) throw new Error("Original artifact is outside its Task workspace; retain its path/hash for explicit user access, not automatic import.");
  const before = await ctx.fs.stat(target, signal);
  if (!before || before.type !== "file") throw new Error("Original artifact is not an existing regular file.");
  const chunks = [];
  let offset = 0;
  for (; ; ) {
    signal?.throwIfAborted();
    const chunk = await ctx.fs.readByteRange(target, { offset, length: WINDOW }, signal);
    if (chunk.byteLength > WINDOW) throw new Error("Filesystem returned more bytes than requested.");
    if (!chunk.byteLength) break;
    chunks.push(chunk.slice());
    offset += chunk.byteLength;
  }
  const after = await ctx.fs.stat(target, signal);
  if (!after || after.type !== "file" || after.version !== before.version || after.size !== before.size || after.size !== void 0 && after.size !== offset) throw new Error("Original artifact changed while being captured.");
  signal?.throwIfAborted();
  const bytes = Buffer.concat(chunks, offset);
  if (artifact.sha256 && hash2(bytes) !== artifact.sha256) throw new Error("Original artifact bytes differ from its recorded hash.");
  return bytes;
}
function destination(taskId, artifact) {
  const name2 = artifact.path.split(/[\\/]/).at(-1) || artifact.id;
  return paths.archive(taskId) + "/legacy/artifacts/" + hash2(artifact.path) + "/" + encodeURIComponent(name2);
}
async function readManifest(files, snapshot, manifestPath2) {
  const match = /^technical\/legacy-migrations\/([^/]+)\/manifest.json$/.exec(filePath(manifestPath2));
  const raw = match && await files.read(snapshot, manifestPath2), manifest = raw && JSON.parse(raw);
  if (!manifest || manifest.version !== 1 || manifest.id !== match[1] || manifest.baseline !== LEGACY_BASELINE || manifest.source.mode !== "local" || !Array.isArray(manifest.records) || !Array.isArray(manifest.tasks) || !Array.isArray(manifest.pendingAdapters)) throw new Error("A preserved Local migration manifest is required.");
  return manifest;
}
async function preserved(files, snapshot, manifestPath2) {
  const manifest = await readManifest(files, snapshot, manifestPath2);
  const root = manifestPath2.slice(0, -"/manifest.json".length), index = /* @__PURE__ */ new Map();
  for (const record of manifest.records) {
    if (index.has(record.key)) throw new Error("Original legacy source record identity is ambiguous.");
    index.set(record.key, record);
  }
  const decoded = /* @__PURE__ */ new Map();
  const read = async (key) => {
    if (decoded.has(key)) return decoded.get(key);
    const record = index.get(key);
    if (!record) return void 0;
    if (record.path !== root + "/source/" + hash2(record.key) + ".bin" || !digest4(record.sha256) || manifest.references[record.key] !== record.path || manifest.referenceHashes[record.key] !== record.sha256) throw new Error("Original legacy source record identity is ambiguous.");
    const bytes = await files.readBytes(snapshot, record.path);
    if (!bytes || hash2(bytes) !== record.sha256) throw new Error("Original legacy source record is missing or corrupt: " + record.key);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    decoded.set(key, value);
    return value;
  };
  const ids = /* @__PURE__ */ new Set();
  for (const key of index.keys()) {
    if (key.startsWith("task:")) ids.add(key.slice(5));
    else if (key.startsWith("task-history/")) {
      const id = decodeURIComponent(key.slice("task-history/".length));
      if (key !== "task-history/" + encodeURIComponent(id)) throw new Error("Invalid original history identity.");
      ids.add(id);
    } else if (/^task-staging\/[^/]+\/commit$/.test(key)) ids.add(decodeURIComponent(key.split("/")[1]));
  }
  const capture = { mode: "local", baseline: LEGACY_BASELINE, revision: manifest.source.revision, records: [], texts: [], tasks: [], issues: [] };
  for (const id of ids) {
    if (manifest.clearedTasks?.some((item) => item.oldId === id)) continue;
    let value = await read("task:" + id);
    const staged = await read("task-staging/" + encodeURIComponent(id) + "/commit");
    const overlay = /* @__PURE__ */ new Map(), prefix = "worker-reply/" + encodeURIComponent(id) + "/", archivePrefix = "record-archive/" + encodeURIComponent(id) + "/";
    const reportStorage = {
      get: async (key) => {
        if (!key.startsWith(prefix) && !key.startsWith(archivePrefix)) throw new Error("Original report reference escapes its Task.");
        return overlay.has(key) ? overlay.get(key) : read(key);
      },
      set: async (key, value2) => {
        if (!key.startsWith(prefix)) throw new Error("Staged report escaped its original Task.");
        overlay.set(key, value2);
      },
      list: async (requested) => {
        if (!requested.startsWith(prefix) && !requested.startsWith(archivePrefix)) return [];
        const keys = new Set([...index.keys(), ...overlay.keys()].filter((key) => key.startsWith(requested) && key.includes("/entry/")));
        const rows = [];
        for (const key of keys) {
          const value2 = overlay.has(key) ? overlay.get(key) : await read(key);
          if (value2 !== void 0) rows.push({ key, value: value2 });
        }
        return rows;
      }
    };
    const records = new TaskRecords(new RecordJournal(reportStorage));
    if (staged) {
      if (staged.schemaVersion !== 1 || staged.root?.id !== id) throw new Error("Invalid original pending Task record.");
      if ((value?.revision ?? 0) < staged.root.revision) {
        if ((value?.revision ?? 0) !== staged.expectedRevision) throw new Error("Original Task staging revision differs.");
        await records.write({ ...staged, writes: staged.writes.filter((write) => write.metadata?.field === "reports") });
        value = staged.root;
      }
    }
    let task;
    if (value && value.kind !== "task-tombstone") {
      task = isSeparatedTask(value) ? await records.hydrate({ ...value, recordsLayout: {
        ...value.recordsLayout,
        fields: value.recordsLayout.fields.filter((field) => field === "reports"),
        counts: { reports: value.recordsLayout.counts?.reports }
      } }) : value;
    } else {
      const history = await read("task-history/" + encodeURIComponent(id));
      if (!history || history.deleting) continue;
      if (history.schemaVersion !== 1 || history.taskId !== id) throw new Error("Invalid original Task history identity.");
      task = await decodeLegacySealedTask(await read("records/" + encodeURIComponent(id) + "/manifest"), id, read);
      if (task.phase !== "completed" && task.phase !== "cancelled" && task.control !== "cancelled") throw new Error("Historical artifact declaration has no terminal Task identity.");
    }
    if (!task || task.schemaVersion !== 1 || task.id !== id) throw new Error("Original Task identity is missing or corrupt.");
    capture.tasks.push({ id, original: task, continuation: "unresolved", request: "", participants: [] });
  }
  return { manifest, capture };
}
function artifactMetadataPath(path3) {
  return "technical/artifacts/manifests/" + hash2(path3) + ".json";
}
async function checkArchived(files, snapshot, manifest, value, allBytes) {
  const taskId = legacyMigratedTaskId(manifest.id, value.task.id), reference = "legacy-task/" + value.task.id + "/" + value.artifact.id;
  const path3 = manifest.references[reference];
  if (!path3) return void 0;
  if (path3 !== destination(taskId, value.artifact) || !digest4(manifest.referenceHashes[reference])) throw new Error("Archived legacy artifact has a different original identity.");
  const raw = await files.read(snapshot, artifactMetadataPath(path3)), metadata = raw && JSON.parse(raw);
  if (!metadata || metadata.version !== 1 || metadata.taskId !== taskId || metadata.path !== path3 || metadata.manifestPath !== artifactMetadataPath(path3) || metadata.sha256 !== manifest.referenceHashes[reference] || value.artifact.sha256 && metadata.sha256 !== value.artifact.sha256 || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0) throw new Error("Archived legacy artifact manifest is missing or inconsistent.");
  if (files instanceof LocalFiles) {
    const entry = (await files.listDirectory(snapshot, path3.slice(0, path3.lastIndexOf("/") + 1))).find((entry2) => entry2.path === path3);
    if (!entry || entry.version !== metadata.sha256 || entry.bytes !== metadata.bytes) throw new Error("Archived legacy artifact bytes are missing or changed.");
  }
  if (allBytes || !(files instanceof LocalFiles)) {
    const bytes = await files.readBytes(snapshot, path3);
    if (!bytes || bytes.byteLength !== metadata.bytes || hash2(bytes) !== metadata.sha256) throw new Error("Archived legacy artifact bytes are missing or corrupt.");
  }
  return path3;
}
async function listLegacyArtifactReferences(files, snapshot, manifestPath2) {
  const { manifest, capture } = await preserved(files, snapshot, manifestPath2), result = [];
  const values2 = declarations(capture, { onIssue: ({ error: _error, ...item }) => result.push({ ...item, taskId: legacyMigratedTaskId(manifest.id, item.oldTaskId), status: "unavailable" }) });
  for (const value of values2) {
    const base = { oldTaskId: value.task.id, taskId: legacyMigratedTaskId(manifest.id, value.task.id), id: value.artifact.id, sourcePath: value.artifact.path, sha256: value.artifact.sha256 };
    try {
      const archivedPath = await checkArchived(files, snapshot, manifest, value, false);
      result.push({ ...base, archivedPath, status: archivedPath ? "archived" : "pending", detail: archivedPath ? "" : "Original declared path is not archived. Automatic import is limited to its original Task workspace; external paths require explicit user access." });
    } catch (error) {
      result.push({ ...base, status: "unavailable", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
async function resumePendingLegacyArtifacts(ctx, files, transactions, manifestPath2, options = {}) {
  if (!(files instanceof LocalFiles)) throw new Error("Legacy filesystem artifact import is Local only.");
  const pending = [], observed = { ...options, onIssue: (item) => {
    pending.push(item);
    options.onIssue?.(item);
  } };
  const original = await withSnapshot(files, (snapshot) => preserved(files, snapshot, manifestPath2)), attached = [];
  for (const value of declarations(original.capture, observed)) {
    options.signal?.throwIfAborted();
    const marker = "artifact-bytes:" + value.task.id + ":" + value.artifact.id;
    const identity2 = hash2(json([original.manifest.id, value.task.id, value.artifact]));
    const command = "legacy-artifact:" + identity2, receiptPath = "technical/legacy-artifacts/" + identity2 + ".json";
    try {
      const existingReceipt = await withSnapshot(files, (snapshot) => files.read(snapshot, receiptPath));
      if (existingReceipt === void 0 && !original.manifest.pendingAdapters.includes(marker) && await withSnapshot(files, (snapshot) => checkArchived(files, snapshot, original.manifest, value, false))) continue;
      const request = {
        migrationId: original.manifest.id,
        oldTaskId: value.task.id,
        workspace: value.task.workspace,
        artifact: value.artifact
      };
      const verify = async (snapshot, fullBytes) => {
        const manifest = await readManifest(files, snapshot, manifestPath2);
        const path3 = await checkArchived(files, snapshot, manifest, value, fullBytes);
        const raw = await files.read(snapshot, receiptPath), receipt = raw && JSON.parse(raw);
        if (!path3 || manifest.pendingAdapters.includes(marker) || !receipt || receipt.version !== 1 || receipt.path !== path3 || receipt.manifestPath !== artifactMetadataPath(path3) || receipt.request.migrationId !== manifest.id || receipt.request.oldTaskId !== value.task.id || json(receipt.request.artifact) !== json(value.artifact) || receipt.request.sha256 !== manifest.referenceHashes["legacy-task/" + value.task.id + "/" + value.artifact.id])
          throw new Error("Legacy artifact read-back has not confirmed its original preservation request.");
        return path3;
      };
      if (await transactions.confirmed(command, request)) {
        attached.push(await withSnapshot(files, (snapshot) => verify(snapshot, false)));
        continue;
      }
      const apply2 = () => transactions.run(command, request, { reevaluate: true }, async (snapshot) => {
        const { manifest, capture } = await preserved(files, snapshot, manifestPath2);
        const actual = declarations(capture, observed).find((item) => item.task.id === value.task.id && item.artifact.id === value.artifact.id);
        if (!actual || json(actual) !== json(value)) throw new Error("Original artifact declaration changed; retain its same operation.");
        if (await files.read(snapshot, receiptPath) !== void 0) throw new Error("Legacy artifact exists without its matching transaction receipt.");
        const bytes = await captureOne(ctx, actual, options.signal), sha2563 = hash2(bytes);
        const taskId = legacyMigratedTaskId(manifest.id, value.task.id), path3 = destination(taskId, value.artifact), metadataPath = artifactMetadataPath(path3);
        const existing = await files.readBytes(snapshot, path3);
        if (existing && hash2(existing) !== sha2563) throw new Error("Artifact destination already contains different bytes.");
        const name2 = value.artifact.path.split(/[\\/]/).at(-1) || value.artifact.id;
        const metadata = { version: 1, taskId, path: path3, manifestPath: metadataPath, name: name2, sha256: sha2563, bytes: bytes.byteLength };
        const priorMetadata = await files.read(snapshot, metadataPath);
        if (priorMetadata !== void 0 && json(JSON.parse(priorMetadata)) !== json(metadata)) throw new Error("Artifact destination metadata already differs.");
        for (const reference of [value.artifact.path, value.artifact.id]) {
          const qualified = "legacy-task/" + value.task.id + "/" + reference;
          manifest.references[qualified] = path3;
          manifest.referenceHashes[qualified] = sha2563;
          const ambiguous = "Legacy artifact reference is task-scoped and ambiguous without its Task: " + reference;
          if (manifest.issues.includes(ambiguous)) continue;
          if (manifest.references[reference] && manifest.referenceHashes[reference] !== sha2563) {
            delete manifest.references[reference];
            delete manifest.referenceHashes[reference];
            manifest.issues.push(ambiguous);
          } else {
            manifest.references[reference] = path3;
            manifest.referenceHashes[reference] = sha2563;
          }
        }
        manifest.pendingAdapters = manifest.pendingAdapters.filter((item) => item !== marker);
        const changes = [
          { path: path3, bytes },
          { path: metadataPath, content: json(metadata) },
          { path: receiptPath, content: json({ version: 1, request: { migrationId: manifest.id, oldTaskId: value.task.id, artifact: value.artifact, sha256: sha2563 }, path: path3, manifestPath: metadataPath, bytes: bytes.byteLength }) },
          { path: manifestPath2, content: json(manifest) }
        ];
        for (const task of manifest.tasks) changes.push({ path: task.recordPath.replace(/task.json$/, "references.json"), content: json(manifest.references) });
        options.signal?.throwIfAborted();
        return changes;
      });
      for (; ; ) {
        options.signal?.throwIfAborted();
        try {
          await apply2();
          break;
        } catch (error) {
          if (!(error instanceof FilesConflictError) || await withSnapshot(files, async (snapshot) => snapshot.revision) === error.expectedRevision) throw error;
        }
      }
      attached.push(await withSnapshot(files, (snapshot) => verify(snapshot, true)));
    } catch (error) {
      issue(observed, value.task.id, value.artifact.id, value.artifact.path, error);
    }
  }
  return { attached, pending };
}

// src/framework/record-move.ts
import { createHash as createHash11 } from "node:crypto";
import { isDeepStrictEqual as isDeepStrictEqual3 } from "node:util";
import { lstat as lstat4 } from "node:fs/promises";
import { join as join4 } from "node:path";

// src/framework/local-location.ts
import { realpath as realpath3 } from "node:fs/promises";
import { basename, dirname, isAbsolute, join as join2, normalize, resolve } from "node:path";
async function canonicalLocalLocation(path3, allowRelative = false) {
  if (!isAbsolute(path3) && !allowRelative) throw new Error("Record locations must be absolute paths.");
  const absolute = resolve(path3);
  try {
    return await realpath3(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join2(await canonicalLocalLocation(parent), basename(absolute));
  }
}
var localLocationRecordKey = "framework/local-locations";
var LocalLocationMovedError = class extends Error {
  constructor(location2, destination2) {
    super("This local storage location has moved to " + destination2 + "; the old copy must not reopen the same storage identity.");
    this.location = location2;
    this.destination = destination2;
    this.name = "LocalLocationMovedError";
  }
};
var LocalLocationOutcomeUnknownError = class extends Error {
  constructor(commandId, cause) {
    super("Local move receipt outcome is unknown; resolve the original command before continuing.", { cause });
    this.commandId = commandId;
    this.name = "LocalLocationOutcomeUnknownError";
  }
};
var queues = /* @__PURE__ */ new WeakMap();
function serialized(storage, action) {
  const result = (queues.get(storage) ?? Promise.resolve()).catch(() => {
  }).then(action);
  queues.set(storage, result.catch(() => {
  }));
  return result;
}
function location(value) {
  if (!value || !isAbsolute(value) || normalize(value) !== value || value.includes("\0")) throw new Error("Use the physical copy operation\u2019s canonical absolute location.");
}
function same(a, b) {
  return a.source === b.source && a.target === b.target && a.scope === b.scope && a.fingerprint === b.fingerprint;
}
var LocalLocationRegistry = class {
  constructor(storage) {
    this.storage = storage;
  }
  async state() {
    const value = await this.storage.get(localLocationRecordKey);
    if (value === void 0) return { version: 1, moves: [], bindings: {} };
    if (value.version !== 1 || !Array.isArray(value.moves) || !value.bindings || typeof value.bindings !== "object" || value.moves.some((move) => !move.commandId || !["prepared", "published", "applied"].includes(move.phase) || typeof move.source !== "string" || typeof move.target !== "string" || typeof move.scope !== "string" || typeof move.fingerprint !== "string"))
      throw new Error("Invalid local location receipt record; inspect it before opening storage.");
    if (new Set(value.moves.map((move) => move.commandId)).size !== value.moves.length) throw new Error("Duplicate local move command receipts.");
    for (const [path3, binding] of Object.entries(value.bindings)) {
      const receipt = binding && value.moves.find((move) => move.commandId === binding.commandId);
      if (!receipt || receipt.phase === "prepared" || binding.scope !== receipt.scope || (binding.state === "current" ? path3 !== receipt.target : binding.state === "departed" ? path3 !== receipt.source || binding.destination !== receipt.target : true))
        throw new Error("Local location binding has no matching verified publication receipt.");
    }
    return structuredClone(value);
  }
  scope(state, canonical2) {
    const binding = Object.hasOwn(state.bindings, canonical2) ? state.bindings[canonical2] : void 0;
    if (binding?.state === "departed") throw new LocalLocationMovedError(canonical2, binding.destination);
    if (binding && (binding.state !== "current" || typeof binding.scope !== "string")) throw new Error("Invalid local location binding.");
    if (state.moves.some((move) => move.phase === "prepared" && move.target === canonical2)) throw new Error("This location has a pending explicit move; resolve its original command before opening it.");
    return binding?.scope ?? JSON.stringify(["local", canonical2]);
  }
  async resolve(canonical2) {
    location(canonical2);
    return this.scope(await this.state(), canonical2);
  }
  async receipt(commandId) {
    return (await this.state()).moves.find((move) => move.commandId === commandId);
  }
  async save(state, commandId) {
    try {
      await this.storage.set(localLocationRecordKey, structuredClone(state));
    } catch (error) {
      throw new LocalLocationOutcomeUnknownError(commandId, error);
    }
  }
  prepare(commandId, identity2) {
    return serialized(this.storage, async () => {
      location(identity2.source);
      location(identity2.target);
      if (!commandId || !identity2.scope || !identity2.fingerprint || identity2.source === identity2.target) throw new Error("An explicit move requires distinct locations and its verified source identity.");
      const state = await this.state(), prior = state.moves.find((move) => move.commandId === commandId);
      if (prior) {
        if (!same(prior, identity2)) throw new Error("Move command identity was reused with another source, target or fingerprint.");
        return prior;
      }
      if (this.scope(state, identity2.source) !== identity2.scope) throw new Error("Move source does not own the supplied logical scope.");
      if (state.moves.some((move) => move.phase !== "applied" && [move.source, move.target].some((path3) => path3 === identity2.source || path3 === identity2.target)))
        throw new Error("Resolve the existing move involving these locations first.");
      const target = state.bindings[identity2.target];
      if (target && target.scope !== identity2.scope) throw new Error("Move destination already belongs to another verified storage scope.");
      const receipt = { ...identity2, commandId, phase: "prepared" };
      state.moves.push(receipt);
      await this.save(state, commandId);
      return receipt;
    });
  }
  /** Call only after physical publication and exact fingerprint verification.
   * Neither preparing nor merely opening a directory establishes this binding.
   */
  publish(commandId, verified) {
    return serialized(this.storage, async () => {
      const state = await this.state(), receipt = state.moves.find((move) => move.commandId === commandId);
      if (!receipt || !same(receipt, verified)) throw new Error("Physical publication must match the original prepared move exactly.");
      if (receipt.phase !== "prepared") return receipt;
      if (this.scope(state, receipt.source) !== receipt.scope) throw new Error("Move source identity changed before publication.");
      state.bindings[receipt.source] = { scope: receipt.scope, state: "departed", commandId, destination: receipt.target };
      state.bindings[receipt.target] = { scope: receipt.scope, state: "current", commandId };
      receipt.phase = "published";
      await this.save(state, commandId);
      return receipt;
    });
  }
  applied(commandId) {
    return serialized(this.storage, async () => {
      const state = await this.state(), receipt = state.moves.find((move) => move.commandId === commandId);
      if (!receipt || receipt.phase === "prepared") throw new Error("Only a verified published move can be applied.");
      if (receipt.phase === "applied") return receipt;
      receipt.phase = "applied";
      await this.save(state, commandId);
      return receipt;
    });
  }
};

// src/framework/maintenance.ts
import { createHash as createHash10 } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat as lstat3, mkdir as mkdir4, mkdtemp, open as open3, realpath as realpath4, rm as rm3, unlink as unlink3 } from "node:fs/promises";
import { isAbsolute as isAbsolute2, join as join3, relative, sep } from "node:path";
import { backup, DatabaseSync as DatabaseSync2 } from "node:sqlite";
async function frameworkStorageUsage(files, now = /* @__PURE__ */ new Date()) {
  return withSnapshot(files, async (snapshot) => {
    const usage = {
      totalBytes: 0,
      permanentBytes: 0,
      temporaryBytes: 0,
      recordedAt: now.toISOString(),
      permanent: { chatBytes: 0, assistantBytes: 0, knowledgeBytes: 0, originBytes: 0, archiveBytes: 0, planningBytes: 0, otherBytes: 0 },
      temporary: { taskBytes: 0, plannerMemoryBytes: 0, plannerNoteBytes: 0, workerReplyBytes: 0, executionBytes: 0, recoveryBytes: 0 }
    };
    for (const entry of await files.list(snapshot, "")) {
      const bytes = entry.bytes ?? (await files.readBytes(snapshot, entry.path))?.byteLength;
      if (bytes === void 0) throw new Error("Record disappeared from the statistics snapshot: " + entry.path);
      const p = entry.path;
      if (p.startsWith("conversations/") || p.startsWith("conversation-index/")) usage.permanent.chatBytes += bytes;
      else if (p.startsWith("assistants/") && /\/Foreground_(?:List|Cache)\.md$/.test(p)) usage.permanent.planningBytes += bytes;
      else if (p.startsWith("assistants/")) usage.permanent.assistantBytes += bytes;
      else if (p.startsWith("skills/") || p.startsWith("knowledge/")) usage.permanent.knowledgeBytes += bytes;
      else if (p.startsWith("archives/")) usage.permanent.archiveBytes += bytes;
      else if (/^tasks\/.*_(P|O)\.md$/.test(p)) usage.permanent.originBytes += bytes;
      else if (p.startsWith("task-runs/")) {
        if (p.endsWith("/Planner_Memory.md")) usage.temporary.plannerMemoryBytes += bytes;
        else if (p.endsWith("/Plan_Note.md") || p.endsWith("/Organizer_Note.md")) usage.temporary.plannerNoteBytes += bytes;
        else if (p.includes("/workers/") || p.endsWith("/Reply.md")) usage.temporary.workerReplyBytes += bytes;
        else usage.temporary.taskBytes += bytes;
      } else if (p.startsWith("tasks/")) usage.temporary.taskBytes += bytes;
      else if (p.startsWith("state/")) usage.temporary.recoveryBytes += bytes;
      else if (p.startsWith("instances/") || p.startsWith("Recorder Cache/")) usage.temporary.executionBytes += bytes;
      else usage.permanent.otherBytes += bytes;
    }
    usage.permanentBytes = Object.values(usage.permanent).reduce((sum, bytes) => sum + bytes, 0);
    usage.temporaryBytes = Object.values(usage.temporary).reduce((sum, bytes) => sum + bytes, 0);
    usage.totalBytes = usage.permanentBytes + usage.temporaryBytes;
    return usage;
  });
}
async function fileDigest(path3) {
  const digest9 = createHash10("sha256");
  for await (const chunk of createReadStream(path3)) digest9.update(chunk);
  return digest9.digest("hex");
}
async function removeOwnedOutput(path3, identity2) {
  let current;
  try {
    current = await lstat3(path3);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (current.dev === identity2.dev && current.ino === identity2.ino) await unlink3(path3);
}
async function rollbackOutput(path3, identity2, original) {
  try {
    await removeOwnedOutput(path3, identity2);
  } catch (cleanup) {
    throw new AggregateError([original, cleanup], "Record output failed and its owned rollback also failed.");
  }
  throw original;
}
async function assertAbsent(paths2) {
  for (const path3 of paths2) {
    try {
      await lstat3(path3);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw Object.assign(new Error("The destination already contains SQLite records or sidecar state: " + path3), { code: "EEXIST" });
  }
}
async function exportFrameworkRecords(files, taskId, workspace) {
  return exportFrameworkDocument(files, paths.archive(taskId) + "/records.md", taskId, workspace);
}
async function exportFrameworkDocument(files, recordPath, taskId, workspace) {
  filePath(recordPath);
  const data = await withSnapshot(files, async (snapshot) => {
    const body = await files.readBytes(snapshot, recordPath);
    if (body === void 0) throw new Error("Task records have not been saved yet.");
    return body;
  });
  return exportFrameworkBytes(data, taskId, workspace);
}
async function exportFrameworkBytes(data, taskId, workspace) {
  const sha2563 = createHash10("sha256").update(data).digest("hex");
  const filename = "records-" + createHash10("sha256").update(taskId).digest("hex").slice(0, 12) + "-" + sha2563.slice(0, 12) + ".md";
  const path3 = join3(await realpath4(workspace), filename);
  let file;
  try {
    file = await open3(path3, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await fileDigest(path3) !== sha2563) throw new Error("The export path already contains different content: " + path3);
    return { path: path3, sha256: sha2563, bytes: data.byteLength };
  }
  let identity2;
  try {
    identity2 = await file.stat();
    await file.writeFile(data);
    await file.sync();
    await file.close();
    if (await fileDigest(path3) !== sha2563) throw new Error("The exported records differ from the source snapshot.");
    return { path: path3, sha256: sha2563, bytes: data.byteLength };
  } catch (error) {
    let failure = error;
    try {
      await file.close();
    } catch (close) {
      failure = new AggregateError([error, close], "Export failure and handle-close failure.");
    }
    if (!identity2) throw new Error("Could not verify the created export; inspect the retained output path: " + path3, { cause: failure });
    return rollbackOutput(path3, identity2, failure);
  }
}
function databaseDigest(database) {
  const digest9 = createHash10("sha256");
  const encode3 = (value) => JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? { binary: Buffer.from(item).toString("base64") } : typeof item === "bigint" ? { integer: String(item) } : item);
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  digest9.update(encode3(schema));
  for (const [table, key] of [["files", "path"], ["metadata", "key"], ["git_operations", "id"]]) {
    digest9.update(table);
    for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).iterate()) digest9.update(encode3(row) + "\n");
  }
  return digest9.digest("hex");
}
function inspectDatabase(path3) {
  const database = new DatabaseSync2(path3, { readOnly: true });
  try {
    const checks = database.prepare("PRAGMA integrity_check").all();
    if (checks.length !== 1 || Object.values(checks[0])[0] !== "ok") throw new Error("The copied Local records database failed its integrity check.");
    database.exec("BEGIN");
    return databaseDigest(database);
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
  }
}
async function localRecordFingerprint(directory) {
  return inspectDatabase(join3(await realpath4(directory), "dss-files.sqlite"));
}
async function prepareLocalRecordCopy(sourceDirectory, destinationDirectory, signal) {
  signal?.throwIfAborted();
  if (!isAbsolute2(sourceDirectory) || !isAbsolute2(destinationDirectory)) throw new Error("Choose absolute record directory paths.");
  const source = await realpath4(sourceDirectory);
  await mkdir4(destinationDirectory, { recursive: true });
  const destination2 = await realpath4(destinationDirectory);
  const nested = relative(source, destination2);
  if (nested === "" || !isAbsolute2(nested) && nested !== ".." && !nested.startsWith(".." + sep))
    throw new Error("The record destination must not be the current directory or inside it.");
  const sourcePath = join3(source, "dss-files.sqlite"), targetPath = join3(destination2, "dss-files.sqlite");
  const stage = await mkdtemp(join3(destination2, ".dss-record-copy-")), stagePath = join3(stage, "dss-files.sqlite");
  let fingerprint, stagedSha256;
  try {
    const database = new DatabaseSync2(sourcePath, { readOnly: true });
    try {
      database.exec("BEGIN");
      fingerprint = databaseDigest(database);
      await backup(database, stagePath);
    } finally {
      if (database.isTransaction) database.exec("ROLLBACK");
      database.close();
    }
    signal?.throwIfAborted();
    if (inspectDatabase(stagePath) !== fingerprint) throw new Error("Copied records do not match the source snapshot.");
    stagedSha256 = await fileDigest(stagePath);
  } catch (error) {
    await rm3(stage, { recursive: true, force: true });
    throw error;
  }
  let disposed = false, publishing, disposal;
  const publish = async () => {
    signal?.throwIfAborted();
    if (inspectDatabase(sourcePath) !== fingerprint) throw new Error("Source records changed after the copy was prepared.");
    const sidecars = [targetPath + "-wal", targetPath + "-shm", targetPath + "-journal"];
    await assertAbsent([targetPath, ...sidecars]);
    const output = await open3(targetPath, "wx");
    let identity2;
    try {
      identity2 = await output.stat();
      await output.writeFile(createReadStream(stagePath));
      await output.sync();
      await output.close();
      signal?.throwIfAborted();
      await assertAbsent(sidecars);
      const current = await lstat3(targetPath);
      if (current.dev !== identity2.dev || current.ino !== identity2.ino || await fileDigest(targetPath) !== stagedSha256 || inspectDatabase(sourcePath) !== fingerprint)
        throw new Error("Record contents changed before the destination was confirmed.");
    } catch (error) {
      let failure = error;
      try {
        await output.close();
      } catch (close) {
        failure = new AggregateError([error, close], "Database copy failure and handle-close failure.");
      }
      if (!identity2) throw new Error("Could not verify the created database; inspect the retained destination: " + targetPath, { cause: failure });
      return rollbackOutput(targetPath, identity2, failure);
    }
  };
  return {
    source,
    destination: destination2,
    fingerprint,
    publish: () => {
      if (disposed) return Promise.reject(new Error("The prepared record copy has been released."));
      if (publishing) return publishing;
      return publishing = publish();
    },
    dispose: () => {
      if (disposal) return disposal;
      disposed = true;
      return disposal = (async () => {
        await publishing?.catch(() => {
        });
        await rm3(stage, { recursive: true, force: true });
      })();
    }
  };
}

// src/framework/record-move.ts
var recordMoveKey = "framework/record-moves";
var RecordMoveOutcomeUnknownError = class extends Error {
  constructor(commandId, cause) {
    super("Record move is not confirmed; retain both locations and resume the original command.", { cause });
    this.commandId = commandId;
    this.name = "RecordMoveOutcomeUnknownError";
  }
};
async function exists2(path3) {
  try {
    await lstat4(path3);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
var equalRequest = (a, b) => a.sourceRecords === b.sourceRecords && a.targetRecords === b.targetRecords && a.sourceLocal === b.sourceLocal && a.scope === b.scope && isDeepStrictEqual3(a.settingsBefore, b.settingsBefore) && a.nextSettingsRevision === b.nextSettingsRevision;
var queues2 = /* @__PURE__ */ new WeakMap();
var FrameworkRecordMove = class {
  constructor(storage, physical, lifecycle) {
    this.storage = storage;
    this.physical = physical;
    this.lifecycle = lifecycle;
    this.locations = new LocalLocationRegistry(storage);
  }
  locations;
  serial(action) {
    const result = (queues2.get(this.storage) ?? Promise.resolve()).catch(() => {
    }).then(action);
    queues2.set(this.storage, result.catch(() => {
    }));
    return result;
  }
  async receipts() {
    const value = await this.storage.get(recordMoveKey);
    if (value === void 0) return [];
    if (value.version !== 1 || !Array.isArray(value.receipts) || value.receipts.some((item) => !item.commandId || !["prepared", "published", "reopening", "applied"].includes(item.phase)))
      throw new Error("Invalid record move receipts; inspect before reopening storage.");
    return structuredClone(value.receipts);
  }
  async save(receipts, commandId) {
    try {
      await this.storage.set(recordMoveKey, { version: 1, receipts: structuredClone(receipts) });
    } catch (error) {
      throw new RecordMoveOutcomeUnknownError(commandId, error);
    }
  }
  async receipt(commandId) {
    return (await this.receipts()).find((item) => item.commandId === commandId);
  }
  async pendingReceipt() {
    const pending = (await this.receipts()).filter((item) => item.phase !== "applied");
    if (pending.length > 1) throw new Error("Multiple unresolved record moves require inspection.");
    return pending[0];
  }
  run(commandId, input, signal) {
    return this.serial(async () => {
      signal.throwIfAborted();
      const request = {
        ...structuredClone(input),
        sourceRecords: await canonicalLocalLocation(input.sourceRecords),
        targetRecords: await canonicalLocalLocation(input.targetRecords),
        ...input.sourceLocal ? { sourceLocal: await canonicalLocalLocation(input.sourceLocal) } : {}
      };
      const receipts = await this.receipts(), prior = receipts.find((item) => item.commandId === commandId);
      if (prior) {
        if (!equalRequest(prior, request)) throw new Error("Move command was reused with different locations or settings revisions.");
        return this.advance(receipts, prior, signal);
      }
      if (!commandId || !request.settingsBefore?.revision || !request.nextSettingsRevision || request.sourceRecords === request.targetRecords || Boolean(request.sourceLocal) !== Boolean(request.scope)) throw new Error("An explicit record move requires its original settings and Local scope identity.");
      if (receipts.some((item) => item.phase !== "applied")) throw new Error("Resolve the existing record move before starting another.");
      if (await canonicalLocalLocation(this.physical.storageView().directory) !== request.sourceRecords) throw new Error("Active record storage changed before preparing the move.");
      const localKind = !request.sourceLocal ? "none" : request.sourceLocal === join4(request.sourceRecords, "deepseek_servant", "framework") ? "owned" : "custom";
      const targetLocal = localKind === "none" ? void 0 : localKind === "owned" ? join4(request.targetRecords, "deepseek_servant", "framework") : join4(request.targetRecords, "framework-local-" + createHash11("sha256").update(request.scope).digest("hex"));
      if (targetLocal && await exists2(join4(targetLocal, "dss-files.sqlite"))) throw new Error("Move target already has Local records without this prepared command.");
      const configuredDefault = request.settingsBefore.settings.localDirectory && await canonicalLocalLocation(request.settingsBefore.settings.localDirectory) === join4(request.sourceRecords, "deepseek_servant", "framework");
      const localDirectory = targetLocal ?? (configuredDefault ? join4(request.targetRecords, "deepseek_servant", "framework") : request.settingsBefore.settings.localDirectory);
      const settingsAfter = { revision: request.nextSettingsRevision, settings: { ...request.settingsBefore.settings, localDirectory } };
      const receipt = { ...request, commandId, localKind, ...targetLocal ? { targetLocal } : {}, settingsAfter, phase: "prepared" };
      receipts.push(receipt);
      await this.save(receipts, commandId);
      return this.advance(receipts, receipt, signal);
    });
  }
  resumePending(signal) {
    return this.serial(async () => {
      const receipts = await this.receipts(), pending = receipts.filter((item) => item.phase !== "applied");
      if (pending.length > 1) throw new Error("Multiple unresolved record moves require inspection.");
      return pending[0] ? this.advance(receipts, pending[0], signal) : void 0;
    });
  }
  async advance(receipts, receipt, signal) {
    if (receipt.phase === "applied") return receipt;
    signal.throwIfAborted();
    const actual = await canonicalLocalLocation(this.physical.storageView().directory);
    if (actual !== receipt.sourceRecords && actual !== receipt.targetRecords) throw new RecordMoveOutcomeUnknownError(receipt.commandId, new Error("Active root is neither retained move location."));
    const verify = async (directory) => {
      if (await canonicalLocalLocation(directory) !== receipt.targetRecords) throw new Error("Published record destination differs from the prepared move.");
      if (receipt.targetLocal && (!receipt.fingerprint || await localRecordFingerprint(receipt.targetLocal) !== receipt.fingerprint)) throw new Error("Published Local records differ from the frozen source fingerprint.");
    };
    if (actual === receipt.sourceRecords) {
      if (receipt.phase !== "prepared") throw new RecordMoveOutcomeUnknownError(receipt.commandId, new Error("Published receipt disagrees with active root."));
      await this.lifecycle.quiesce(structuredClone(receipt), signal);
      signal.throwIfAborted();
      if (receipt.sourceLocal) {
        const fingerprint = await localRecordFingerprint(receipt.sourceLocal);
        if (receipt.fingerprint && receipt.fingerprint !== fingerprint) throw new Error("Original Local records changed after the move fingerprint was frozen.");
        if (!receipt.fingerprint) {
          receipt.fingerprint = fingerprint;
          await this.save(receipts, receipt.commandId);
        }
        const identity2 = { source: receipt.sourceLocal, target: receipt.targetLocal, scope: receipt.scope, fingerprint };
        await this.locations.prepare(receipt.commandId, identity2);
        if (receipt.localKind === "custom") {
          if (await exists2(join4(receipt.targetLocal, "dss-files.sqlite"))) await verify(receipt.targetRecords);
          else {
            const copy = await prepareLocalRecordCopy(receipt.sourceLocal, receipt.targetLocal, signal);
            try {
              if (copy.fingerprint !== fingerprint) throw new Error("Local records changed while preparing their physical copy.");
              await copy.publish();
            } finally {
              await copy.dispose();
            }
          }
        }
      }
      await this.physical.moveRecords(receipt.targetRecords, receipt.sourceRecords, signal, verify);
      if (await canonicalLocalLocation(this.physical.storageView().directory) !== receipt.targetRecords) throw new RecordMoveOutcomeUnknownError(receipt.commandId, new Error("Physical move did not confirm the active target."));
    }
    if (receipt.phase !== "reopening") {
      await verify(receipt.targetRecords);
      if (receipt.sourceLocal) await this.locations.publish(receipt.commandId, { source: receipt.sourceLocal, target: receipt.targetLocal, scope: receipt.scope, fingerprint: receipt.fingerprint });
      if (receipt.phase === "prepared") {
        receipt.phase = "published";
        await this.save(receipts, receipt.commandId);
      }
    } else if (receipt.targetLocal && await this.locations.resolve(receipt.targetLocal) !== receipt.scope) {
      throw new Error("Reopened target no longer owns the published logical scope.");
    }
    await this.lifecycle.applySettings(structuredClone(receipt));
    if (receipt.phase !== "reopening") {
      if (receipt.sourceLocal) await this.locations.applied(receipt.commandId);
      receipt.phase = "reopening";
      await this.save(receipts, receipt.commandId);
    }
    await this.lifecycle.reopen(structuredClone(receipt), signal);
    receipt.phase = "applied";
    await this.save(receipts, receipt.commandId);
    return receipt;
  }
};

// src/framework/service.ts
import { isDeepStrictEqual as isDeepStrictEqual4 } from "node:util";

// src/framework/manual-cleanup.ts
import { createHash as createHash14 } from "node:crypto";

// src/framework/cleaner.ts
import { createHash as createHash13 } from "node:crypto";

// src/framework/recorder-retention.ts
import { createHash as createHash12 } from "node:crypto";
var hash3 = (value) => createHash12("sha256").update(value).digest("hex");
var within = (path3, root) => path3 === root || path3.startsWith(root + "/");
function taskWorkingRoots(task) {
  return [
    paths.run(task.taskId),
    "Recorder Cache/" + task.taskId,
    "technical/recovery-inputs/" + task.taskId,
    ...new Set([task.owner, ...task.members ?? []].map((member) => paths.state(member, task.taskId)))
  ];
}
function taskStateSignal(task, path3, bytes) {
  return [.../* @__PURE__ */ new Set([task.owner, ...task.members ?? []])].some((member) => within(path3, paths.state(member, task.taskId))) && (bytes.byteLength === 0 || /^(recovery|Cleaner|complete|running|(?:Foreground|Planner|Worker|Organizer|Recorder|Helper)(?:_.*)?)$/.test(path3.split("/").at(-1)));
}
async function prepareRecorderRetention(files, snapshot, task, manifest, staged = []) {
  const changes = new Map(staged.map((change) => [change.path, change]));
  const roots = taskWorkingRoots(task), mapping = { ...manifest.relocatedReferences }, sources = { ...manifest.relocatedSources };
  const reads = /* @__PURE__ */ new Map();
  const read = async (path3) => {
    const change = changes.get(path3);
    if (change) return change.bytes ?? (change.content === null ? void 0 : Buffer.from(change.content, "utf8"));
    let pending = reads.get(path3);
    if (!pending) {
      pending = files.readBytes(snapshot, path3);
      reads.set(path3, pending);
    }
    return pending;
  };
  const ownSource = /^tasks\/[^/]+_(P|O)\.md$/.test(task.sourcePath) && taskIdentity(await files.read(snapshot, task.sourcePath) ?? "") === task.taskId;
  const working = (path3) => roots.some((root) => within(path3, root)) || ownSource && path3 === task.sourcePath;
  let relocated = false;
  const expandReference = async (reference) => {
    const path3 = filePath(reference), bytes = await read(path3);
    const listed = bytes === void 0 ? await files.list(snapshot, path3 + "/") : [];
    const entries = [.../* @__PURE__ */ new Set([...bytes === void 0 ? [] : [path3], ...listed.map((entry) => entry.path)])];
    if (!entries.length) return [path3];
    const result = [];
    for (const source of entries) {
      if (!working(source)) {
        result.push(source);
        continue;
      }
      const value = await read(source);
      if (value === void 0) throw new Error("Retained reference is missing: " + source);
      relocated = true;
      const leaf = source.split("/").at(-1);
      if (taskStateSignal(task, source, value)) continue;
      const destination2 = paths.archive(task.taskId) + "/retained/" + hash3(source) + "/" + hash3(value) + "/" + leaf;
      const prior = await read(destination2);
      if (prior !== void 0 && hash3(prior) !== hash3(value)) throw new Error("Archived retained reference already differs: " + destination2);
      if (prior === void 0) changes.set(destination2, { path: destination2, bytes: value });
      mapping[source] = destination2;
      sources[destination2] = { sourcePath: source, sourceRevision: snapshot.revision, sha256: hash3(value) };
      result.push(destination2);
    }
    return [...new Set(result)];
  };
  const expansions = /* @__PURE__ */ new Map();
  const expand = (reference) => {
    const path3 = filePath(reference);
    let pending = expansions.get(path3);
    if (!pending) {
      pending = expandReference(path3);
      expansions.set(path3, pending);
    }
    return pending;
  };
  const outputs = [...new Set((await Promise.all(manifest.outputs.map(expand))).flat())];
  const retainedPaths = [...new Set((await Promise.all(manifest.retainedPaths.map(expand))).flat())];
  const resultPaths = task.resultPaths ? [...new Set((await Promise.all(task.resultPaths.map(expand))).flat())] : void 0;
  const updated = { ...task, ...resultPaths ? { resultPaths } : {} };
  if (JSON.stringify(task.resultPaths) !== JSON.stringify(resultPaths)) changes.set(paths.task(task.taskId), { path: paths.task(task.taskId), content: encodeJson(updated) });
  const references = [.../* @__PURE__ */ new Set([...outputs, ...retainedPaths, ...resultPaths ?? []])], verifiedReferences = {};
  for (const path3 of references) {
    const bytes = await read(path3);
    if (bytes !== void 0) verifiedReferences[path3] = hash3(bytes);
  }
  return {
    changes: [...changes.values()],
    task: updated,
    relocated,
    retention: {
      ...manifest,
      outputs,
      retainedPaths: [.../* @__PURE__ */ new Set([...retainedPaths, ...resultPaths ?? []])],
      verifiedReferences,
      ...Object.keys(mapping).length ? { relocatedReferences: mapping, relocatedSources: sources } : {}
    }
  };
}
async function readArchivedReference(files, snapshot, taskId, originalPath) {
  filePath(originalPath);
  const root = paths.archive(taskId), raw = await files.read(snapshot, root + "/retention.json");
  if (raw === void 0) return void 0;
  const manifest = JSON.parse(raw);
  const target = manifest.relocatedReferences?.[originalPath];
  if (target === void 0) return void 0;
  if (typeof target !== "string" || !filePath(target).startsWith(root + "/")) throw new Error("Archived reference escapes its Task: " + originalPath);
  const expected = manifest.verifiedReferences?.[target];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Archived reference lacks verified content: " + originalPath);
  const bytes = await files.readBytes(snapshot, target);
  if (bytes === void 0 || hash3(bytes) !== expected) throw new Error("Archived reference integrity differs: " + originalPath);
  const source = manifest.relocatedSources?.[target];
  if (!source || source.sourcePath !== originalPath || source.sha256 !== expected || typeof source.sourceRevision !== "string" || !source.sourceRevision) throw new Error("Archived reference source identity differs: " + originalPath);
  return bytes;
}

// src/framework/cleaner.ts
async function captureCleanupInputs(files, snapshot, task) {
  const inputs = {};
  for (const root of [paths.run(task.taskId), "Recorder Cache/" + task.taskId]) {
    for (const entry of await files.list(snapshot, root)) {
      if (entry.path.endsWith("/inbox-observation.json")) continue;
      inputs[entry.path] = entry.version;
    }
  }
  if (/^tasks\/[^/]+_(P|O)\.md$/.test(task.sourcePath)) {
    const source = await files.read(snapshot, task.sourcePath);
    if (source !== void 0 && taskIdentity(source) === task.taskId) {
      const entry = (await files.listDirectory(snapshot, "tasks/")).find((row) => row.path === task.sourcePath);
      if (entry) inputs[entry.path] = entry.version;
    }
  }
  return Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)));
}
async function captureCleanupReferences(files, snapshot, references, stagedChanges = []) {
  const staged = new Map(stagedChanges.map((change) => [change.path, change]));
  const hashes = {};
  for (const path3 of [...new Set(references.map(filePath))].sort()) {
    const change = staged.get(path3);
    const bytes = change ? change.bytes ?? (change.content === null ? void 0 : Buffer.from(change.content, "utf8")) : await files.readBytes(snapshot, path3);
    if (bytes !== void 0) hashes[path3] = createHash13("sha256").update(bytes).digest("hex");
  }
  return hashes;
}
var referenceCache = /* @__PURE__ */ new WeakMap();
function clearCleanupReferenceCache(files, taskId) {
  referenceCache.get(files)?.delete(taskId);
}
async function cachedCleanupReferences(files, snapshot, taskId, references) {
  let tasks = referenceCache.get(files);
  if (!tasks) referenceCache.set(files, tasks = /* @__PURE__ */ new Map());
  let cache = tasks.get(taskId);
  if (!cache) tasks.set(taskId, cache = /* @__PURE__ */ new Map());
  const selected = new Set(references);
  for (const path3 of cache.keys()) if (!selected.has(path3)) cache.delete(path3);
  const versions = /* @__PURE__ */ new Map();
  for (const directory of new Set(references.map((path3) => path3.slice(0, path3.lastIndexOf("/") + 1)))) {
    for (const entry of await files.listDirectory(snapshot, directory)) if (selected.has(entry.path)) versions.set(entry.path, entry.version);
  }
  const hashes = {};
  for (const path3 of references) {
    const version = versions.get(path3), previous = cache.get(path3);
    if (version && previous?.version === version) {
      hashes[path3] = previous.hash;
      continue;
    }
    cache.delete(path3);
    if (!version) continue;
    const bytes = await files.readBytes(snapshot, path3);
    if (bytes === void 0) continue;
    const hash13 = createHash13("sha256").update(bytes).digest("hex");
    hashes[path3] = hash13;
    if (version) cache.set(path3, { version, hash: hash13 });
  }
  return hashes;
}
var CleanupMaterialsChangedError = class extends Error {
  constructor(taskId, paths2, signature) {
    super("Recorder must review changed or previously unverified original material or retained references before cleanup.");
    this.taskId = taskId;
    this.paths = paths2;
    this.signature = signature;
    this.name = "CleanupMaterialsChangedError";
  }
};
async function changedCleanupMaterials(files, snapshot, task, manifest, raw) {
  const inputs = await captureCleanupInputs(files, snapshot, task);
  const changed = [.../* @__PURE__ */ new Set([...Object.keys(inputs), ...Object.keys(manifest.inputs ?? {})])].filter((path3) => !manifest.inputs || manifest.inputs[path3] !== inputs[path3]).sort();
  const references = /* @__PURE__ */ new Set(), evaluatedDirectoryFiles = /* @__PURE__ */ new Set();
  for (const reference of [...new Set([...manifest.outputs, ...manifest.retainedPaths].map(filePath))]) {
    const directory = reference.slice(0, reference.lastIndexOf("/") + 1);
    const exact = (await files.listDirectory(snapshot, directory)).some((entry) => entry.path === reference);
    const children = await files.list(snapshot, reference + "/");
    const selected = [...exact || !children.length ? [reference] : [], ...children.map((entry) => entry.path)];
    for (const path3 of selected) {
      if (path3.startsWith("state/")) {
        const bytes = await files.readBytes(snapshot, path3);
        if (bytes !== void 0 && taskStateSignal(task, path3, bytes)) continue;
      }
      references.add(path3);
      if (path3 !== reference && inputs[path3] && manifest.inputs?.[path3] === inputs[path3]) evaluatedDirectoryFiles.add(path3);
    }
  }
  const actual = await cachedCleanupReferences(files, snapshot, task.taskId, [...references]);
  for (const path3 of references) if (!actual[path3] || (manifest.verifiedReferences?.[path3] ? actual[path3] !== manifest.verifiedReferences[path3] : !evaluatedDirectoryFiles.has(path3))) changed.push(path3);
  if (!manifest.inputs || !manifest.verifiedReferences || changed.length) return new CleanupMaterialsChangedError(
    task.taskId,
    [...new Set(changed)].sort(),
    createHash13("sha256").update(JSON.stringify([createHash13("sha256").update(raw).digest("hex"), inputs, actual])).digest("hex")
  );
}
var CleanupReleaseError = class extends Error {
  constructor(taskId, record, cause) {
    super("Task files are cleaned; Host association release remains pending.", { cause });
    this.taskId = taskId;
    this.record = record;
    this.name = "CleanupReleaseError";
  }
};
var cleanupRecordPath = (taskId) => "technical/cleanup/" + filePath(taskId) + ".json";
var digest5 = (text) => createHash13("sha256").update(text).digest("hex");
var FrameworkCleaner = class {
  constructor(files, transactions, onTaskReleased) {
    this.files = files;
    this.transactions = transactions;
    this.onTaskReleased = onTaskReleased;
  }
  async clean(task, snapshot) {
    const recordPath = cleanupRecordPath(task.taskId);
    let recordRevision = snapshot.revision;
    let record = await readJson(this.files, snapshot, recordPath);
    const cleaner = paths.state(task.owner, task.taskId) + "/Cleaner";
    if (!record && await this.files.read(snapshot, cleaner) === void 0) return { status: "not-requested" };
    if (!record) {
      const expectedRetention = await this.files.read(snapshot, paths.archive(task.taskId) + "/retention.json");
      if (expectedRetention === void 0) throw new Error("Recorder retention manifest is missing.");
      const originalManifest = JSON.parse(expectedRetention);
      const currentTask = await readJson(this.files, snapshot, paths.task(task.taskId));
      if (!currentTask || currentTask.status !== "complete" || currentTask.owner !== task.owner) throw new Error("Cleanup requires the principal\u2019s sealed task.");
      const materialChanged = await changedCleanupMaterials(this.files, snapshot, currentTask, originalManifest, expectedRetention);
      if (materialChanged) throw materialChanged;
      const archival = await prepareRecorderRetention(this.files, snapshot, currentTask, originalManifest);
      if (archival.relocated) {
        await this.transactions.run(
          "cleanup:" + task.taskId + ":archive:" + digest5(expectedRetention),
          { taskId: task.taskId, retentionHash: digest5(expectedRetention) },
          { snapshot, expectedRevision: snapshot.revision, reevaluate: true },
          async (checked) => {
            const selected = await readJson(this.files, checked, paths.task(task.taskId));
            const raw = await this.files.read(checked, paths.archive(task.taskId) + "/retention.json");
            if (!selected || selected.status !== "complete" || selected.owner !== task.owner || raw !== expectedRetention || await this.files.read(checked, cleaner) === void 0) throw new Error("Recorder retention changed; inspect the current cleanup request.");
            const changed = await changedCleanupMaterials(this.files, checked, selected, originalManifest, raw);
            if (changed) throw changed;
            const plan = await prepareRecorderRetention(this.files, checked, selected, originalManifest);
            return [...plan.changes, { path: paths.archive(task.taskId) + "/retention.json", content: encodeJson(plan.retention) }];
          }
        );
        return withSnapshot(this.files, (checked) => this.clean(archival.task, checked));
      }
      const retentionHash = digest5(expectedRetention);
      await this.transactions.run(
        "cleanup:" + task.taskId + ":files:" + retentionHash,
        { taskId: task.taskId, owner: task.owner, retentionHash },
        { snapshot, expectedRevision: snapshot.revision, reevaluate: true },
        async (checked) => {
          const current = await readJson(this.files, checked, paths.task(task.taskId));
          if (!current || current.status !== "complete" || current.owner !== task.owner) throw new Error("Cleanup requires the principal\u2019s sealed task.");
          if (await this.files.read(checked, cleaner) === void 0) throw new Error("Recorder has not requested cleanup at this revision.");
          const manifestPath2 = paths.archive(task.taskId) + "/retention.json";
          const raw = await this.files.read(checked, manifestPath2);
          if (raw === void 0) throw new Error("Recorder retention manifest is missing.");
          if (digest5(raw) !== retentionHash) throw new Error("Recorder retention changed; inspect the current cleanup request.");
          const manifest = JSON.parse(raw);
          if (!Array.isArray(manifest.outputs) || !Array.isArray(manifest.retainedPaths) || !manifest.outputs.includes(paths.archive(task.taskId) + "/records.md")) throw new Error("Recorder retention manifest lacks its Task records.");
          const changed = await changedCleanupMaterials(this.files, checked, current, manifest, raw);
          if (changed) throw changed;
          const preserve = new Set([...manifest.outputs, ...manifest.retainedPaths, ...current.resultPaths ?? []].map(filePath));
          for (const path3 of [...manifest.outputs, ...manifest.retainedPaths]) {
            if (await this.files.readBytes(checked, path3) === void 0) throw new Error("Retained Recorder reference is missing: " + path3);
          }
          const candidates = /* @__PURE__ */ new Set();
          for (const root of taskWorkingRoots(current)) {
            for (const entry of await this.files.list(checked, root)) candidates.add(entry.path);
          }
          const source = await this.files.read(checked, filePath(current.sourcePath));
          if (/^tasks\/[^/]+_(P|O)\.md$/.test(current.sourcePath) && source !== void 0 && taskIdentity(source) === task.taskId) candidates.add(current.sourcePath);
          const retained = (path3) => [...preserve].some((reference) => path3 === reference || path3.startsWith(reference.replace(/\/$/, "") + "/"));
          const deletedPaths = [...candidates].filter((path3) => !retained(path3)).sort();
          const cleanup = {
            version: 1,
            taskId: task.taskId,
            phase: "files-cleaned",
            retentionHash: digest5(raw),
            deletedPaths,
            preservedPaths: [...preserve].sort()
          };
          return [...deletedPaths.map((path3) => ({ path: path3, content: null })), { path: recordPath, content: encodeJson(cleanup) }];
        }
      );
      const confirmed = await withSnapshot(this.files, async (checked) => ({ revision: checked.revision, record: await readJson(this.files, checked, recordPath) }));
      record = confirmed.record;
      recordRevision = confirmed.revision;
    }
    if (!record || record.taskId !== task.taskId) throw new Error("Confirmed cleanup receipt is missing or belongs to another Task.");
    if (record.phase === "released") return { status: "released", record, receipt: { revision: recordRevision, replay: true } };
    try {
      await this.onTaskReleased(task, record);
    } catch (error) {
      throw new CleanupReleaseError(task.taskId, record, error);
    }
    const released = { ...record, phase: "released" };
    const receipt = await withSnapshot(this.files, (checked) => this.transactions.run(
      "cleanup:" + task.taskId + ":released",
      { taskId: task.taskId },
      { snapshot: checked, expectedRevision: checked.revision, reevaluate: true },
      async () => [{ path: recordPath, content: encodeJson(released) }]
    ));
    return { status: "released", record: released, receipt };
  }
};

// src/framework/manual-cleanup.ts
var hash4 = (value) => createHash14("sha256").update(value).digest("hex");
var json2 = (value) => JSON.stringify(value, null, 2) + "\n";
function segment2(value) {
  filePath(value);
  if (value.includes("/")) throw new Error("Identity must be one path segment.");
  return value;
}
var unique = (paths2) => [...new Set(paths2)].sort();
var FrameworkManualCleanup = class {
  constructor(files, transactions, conversation, lifecycle) {
    this.files = files;
    this.transactions = transactions;
    this.conversation = conversation;
    this.lifecycle = lifecycle;
    this.scope = JSON.stringify(conversation.scope);
  }
  scope;
  local() {
    if (!(this.files instanceof LocalFiles) || this.conversation.scope.mode !== "local") throw new Error("Manual record cleanup is a Local user action.");
  }
  async previewTasks() {
    this.local();
    return withSnapshot(this.files, async (snapshot) => {
      const candidates = await this.candidates(snapshot);
      const tasks = candidates.map((item) => ({ taskId: item.taskId, signature: item.signature, files: item.targets.filter((t) => t.action === "delete").length, bytes: item.bytes }));
      return {
        id: hash4(json2([this.scope, tasks])),
        tasks,
        fileCount: tasks.reduce((sum, task) => sum + task.files, 0),
        bytes: tasks.reduce((sum, task) => sum + task.bytes, 0),
        preservedPaths: unique(candidates.flatMap((item) => item.preservedPaths))
      };
    });
  }
  async clearTasks(commandId, preview, confirmation) {
    this.local();
    this.confirm(commandId, confirmation, "clear-ended-task-records");
    if (!preview || !Array.isArray(preview.tasks) || preview.id !== hash4(json2([this.scope, preview.tasks])) || new Set(preview.tasks.map((task) => task.taskId)).size !== preview.tasks.length) throw new Error("Task cleanup requires its exact reviewed preview.");
    await this.intent({ version: 1, kind: "tasks", commandId, scope: this.scope, confirmation, preview });
    return this.execute(commandId, "tasks", { previewId: preview.id }, async (snapshot) => {
      const candidates = await this.candidates(snapshot), selected = [];
      for (const expected of preview.tasks) {
        const current = candidates.find((item) => item.taskId === expected.taskId);
        if (!current || current.signature !== expected.signature) throw new Error("Task cleanup preview changed; review the current records before clearing.");
        selected.push(current);
      }
      for (const item of selected) await this.lifecycle.prepareTaskCleanup(item.taskId);
      for (const item of selected) if (item.cancelled) await this.assertCancellation(item.taskId, item.cancelled);
      return {
        version: 1,
        kind: "tasks",
        scope: this.scope,
        targets: mergeTargets(selected.flatMap((item) => item.targets)),
        taskIds: selected.map((item) => item.taskId),
        cancelledTasks: Object.fromEntries(selected.filter((item) => item.cancelled).map((item) => [item.taskId, item.cancelled])),
        legacySelections: selected.flatMap((item) => item.legacySelections),
        taskSignatures: Object.fromEntries(selected.map((item) => [item.taskId, item.signature])),
        messagePaths: [],
        preservedPaths: unique(selected.flatMap((item) => item.preservedPaths))
      };
    });
  }
  async clearConversation(commandId, confirmation) {
    this.local();
    this.confirm(commandId, confirmation, "clear-foreground-conversation");
    const done = await this.completed(commandId, "conversation");
    if (done) return done;
    const intent = await this.intent({ version: 1, kind: "conversation", commandId, scope: this.scope, confirmation }, (snapshot) => this.conversationPlan(snapshot));
    const original = intent.conversation ?? await withSnapshot(this.files, (snapshot) => readJson(this.files, snapshot, this.planPath(commandId)));
    if (!original) throw new Error("The original confirmed conversation selection is unavailable; preserve its records.");
    return this.lifecycle.withForegroundReset(commandId, (capturedMessageIds) => this.execute(commandId, "conversation", {}, async (snapshot) => {
      if (!capturedMessageIds?.length) return original;
      const captured = await this.conversationPlan(snapshot, capturedMessageIds);
      return {
        ...original,
        targets: mergeTargets([...original.targets, ...captured.targets]),
        messagePaths: unique([...original.messagePaths, ...captured.messagePaths]),
        messageIds: { ...original.messageIds, ...captured.messageIds }
      };
    }));
  }
  async clearPlanning(commandId, confirmation) {
    this.local();
    this.confirm(commandId, confirmation, "clear-work-planning-notes");
    await this.intent({ version: 1, kind: "planning", commandId, scope: this.scope, confirmation });
    return this.execute(commandId, "planning", {}, async (snapshot) => {
      const targets = [];
      for (const name2 of ["Foreground_List.md", "Foreground_Cache.md"]) {
        const path3 = this.conversation.foregroundRoot + "/" + name2;
        targets.push({ path: path3, version: await this.version(snapshot, path3), action: "empty" });
      }
      return { version: 1, kind: "planning", scope: this.scope, targets, taskIds: [], messagePaths: [], preservedPaths: [] };
    });
  }
  confirm(commandId, actual, expected) {
    if (!commandId || actual !== expected) throw new Error("This cleanup requires its explicit confirmation and stable command identity.");
  }
  planPath(commandId) {
    return "technical/manual-cleanup/commands/" + hash4(this.scope + "\0" + commandId) + ".json";
  }
  async intent(intent, conversation) {
    const id = hash4(this.scope + "\0" + intent.commandId);
    const path3 = "technical/manual-cleanup/intents/" + id + ".json";
    await this.transactions.run("manual-cleanup:" + id + ":intent", intent, { reevaluate: true }, async (snapshot) => [
      { path: path3, content: json2({ ...intent, ...conversation ? { conversation: await conversation(snapshot) } : {} }) }
    ]);
    const saved = await withSnapshot(this.files, (snapshot) => readJson(this.files, snapshot, path3));
    if (!saved || saved.commandId !== intent.commandId || saved.scope !== this.scope || saved.kind !== intent.kind) throw new Error("Confirmed cleanup intent does not match its original owner.");
    return saved;
  }
  /** Service resumes only these actually confirmed operations, before admitting
   * new input or restoring Foreground. No preview is automatically confirmed. */
  async resumePending(onError) {
    this.local();
    const pending = await withSnapshot(this.files, async (snapshot) => {
      const result = [];
      for (const entry of await this.files.listDirectory(snapshot, "technical/manual-cleanup/intents/")) {
        const intent = await readJson(this.files, snapshot, entry.path);
        if (!intent || intent.scope !== this.scope) continue;
        if (intent.version !== 1 || entry.path !== "technical/manual-cleanup/intents/" + hash4(this.scope + "\0" + intent.commandId) + ".json") throw new Error("Invalid confirmed cleanup identity.");
        const plan = await readJson(this.files, snapshot, this.planPath(intent.commandId));
        if (!plan?.completed) result.push(intent);
      }
      return result;
    });
    const results = [], errors = [];
    for (const intent of pending) {
      try {
        if (intent.kind === "conversation") results.push(await this.clearConversation(intent.commandId, intent.confirmation));
        else if (intent.kind === "planning") results.push(await this.clearPlanning(intent.commandId, intent.confirmation));
        else if (intent.kind === "tasks" && intent.preview) results.push(await this.clearTasks(intent.commandId, intent.preview, intent.confirmation));
        else throw new Error("Invalid confirmed cleanup action.");
      } catch (error) {
        if (onError) {
          try {
            onError(error, intent.commandId);
          } catch (reportError) {
            errors.push(error, reportError);
          }
        } else errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Some confirmed manual cleanup operations remain incomplete.");
    return results;
  }
  async completed(commandId, kind2) {
    return withSnapshot(this.files, async (snapshot) => {
      const plan = await readJson(this.files, snapshot, this.planPath(commandId));
      if (plan && (plan.kind !== kind2 || plan.scope !== this.scope)) throw new Error("Cleanup command identity belongs to another action.");
      if (plan?.completed) return this.result(plan, { revision: snapshot.revision, replay: true });
    });
  }
  result(plan, receipt) {
    return { cleared: true, receipt, deletedPaths: plan.targets.filter((item) => item.action === "delete").map((item) => item.path), preservedPaths: plan.preservedPaths };
  }
  async execute(commandId, kind2, selection, build) {
    const path3 = this.planPath(commandId), id = "manual-cleanup:" + hash4(this.scope + "\0" + commandId);
    await this.transactions.run(id + ":plan", { scope: this.scope, kind: kind2, selection }, { reevaluate: true }, async (snapshot) => {
      if (await this.files.read(snapshot, path3) !== void 0) throw new Error("Cleanup command plan exists without its matching receipt.");
      return [{ path: path3, content: json2(await build(snapshot)) }];
    });
    const plan = await withSnapshot(this.files, (snapshot) => readJson(this.files, snapshot, path3));
    if (!plan || plan.kind !== kind2 || plan.scope !== this.scope) throw new Error("Cleanup plan is missing or belongs to another action.");
    if (plan.completed) return this.result(plan, { revision: await withSnapshot(this.files, async (snapshot) => snapshot.revision), replay: true });
    const apply2 = () => this.transactions.run(id + ":apply", { scope: this.scope, kind: kind2, planHash: hash4(json2(plan)) }, { reevaluate: true }, async (snapshot) => {
      const changes = [];
      const index = kind2 === "conversation" ? await this.conversationIndex(snapshot) : void 0;
      if (index) for (const path4 of plan.messagePaths) {
        const current2 = index.messages.find((message) => message.path === path4);
        if (!current2 || plan.messageIds?.[path4] !== void 0 && current2.id !== plan.messageIds[path4]) throw new Error("Confirmed conversation message identity changed: " + path4);
      }
      let current = [];
      if (plan.taskSignatures) {
        current = await this.candidates(snapshot);
        for (const [taskId, signature] of Object.entries(plan.taskSignatures)) if (current.find((task) => task.taskId === taskId)?.signature !== signature) throw new Error("Reviewed Task cleanup changed before dispatch: " + taskId);
      }
      for (const target of plan.targets) {
        if (target.action === "index") {
          if (!index || target.path !== this.conversation.indexPath) throw new Error("Invalid conversation cleanup index target.");
          changes.push({ path: target.path, content: json2({ ...index, messages: index.messages.filter((message) => !plan.messagePaths.includes(message.path)) }) });
          continue;
        }
        if (target.action === "notification") {
          if (index?.messages.some((message) => message.notification === target.path && !plan.messagePaths.includes(message.path))) continue;
          const version = await this.version(snapshot, target.path);
          if (version === null) continue;
          if (version !== target.version) throw new Error("Reviewed cleanup target changed: " + target.path);
          changes.push({ path: target.path, content: null });
          continue;
        }
        if (await this.version(snapshot, target.path) !== target.version) throw new Error("Reviewed cleanup target changed: " + target.path);
        if (target.action === "migration") {
          const manifest = await readJson(this.files, snapshot, target.path);
          if (!manifest) throw new Error("Migration map disappeared.");
          const removed = new Set(plan.targets.filter((item) => item.action === "delete").map((item) => item.path));
          const cleared = plan.legacySelections?.filter((item) => item.manifestPath === target.path) ?? manifest.tasks.filter((task) => plan.taskIds.includes(task.taskId)).map(({ oldId, taskId }) => ({ oldId, taskId }));
          manifest.clearedTasks ??= [];
          for (const { oldId, taskId } of cleared) {
            if (!plan.taskIds.includes(taskId)) throw new Error("Legacy cleanup identity is outside the fixed selection.");
            const prior = manifest.clearedTasks.find((item) => item.oldId === oldId);
            if (prior && prior.taskId !== taskId) throw new Error("Legacy cleanup identity differs from its retained receipt.");
            const preservedArtifacts = plan.preservedPaths.filter((path4) => path4.startsWith(paths.archive(taskId) + "/"));
            if (prior) prior.preservedArtifacts = unique([...prior.preservedArtifacts ?? [], ...preservedArtifacts]);
            else manifest.clearedTasks.push({ oldId, taskId, preservedArtifacts });
          }
          manifest.tasks = manifest.tasks.filter((task) => !plan.taskIds.includes(task.taskId));
          manifest.messages = manifest.messages.filter((message) => !plan.messagePaths.includes(message.path));
          manifest.records = manifest.records.filter((record) => !removed.has(record.path));
          for (const [reference, destination2] of Object.entries(manifest.references)) if (removed.has(destination2)) {
            delete manifest.references[reference];
            delete manifest.referenceHashes[reference];
          }
          changes.push({ path: target.path, content: json2(manifest) });
        } else changes.push({ path: target.path, content: target.action === "delete" ? null : "" });
      }
      for (const taskId of plan.taskIds) {
        const cleanup = await readJson(this.files, snapshot, cleanupRecordPath(taskId));
        const cancelled = plan.cancelledTasks?.[taskId];
        if (cancelled) {
          const candidate = current.find((item) => item.taskId === taskId);
          if (!candidate?.cancelled || json2(candidate.cancelled) !== json2(cancelled)) throw new Error("Task cancellation ownership changed before cleanup.");
          if (cleanup && (cleanup.version !== 1 || cleanup.taskId !== taskId)) throw new Error("Task cleanup receipt belongs to another identity.");
          const retired = { ...cleanup ?? {
            version: 1,
            taskId,
            retentionHash: "manual:" + hash4(json2(plan)),
            deletedPaths: candidate.targets.filter((target) => target.action === "delete").map((target) => target.path),
            preservedPaths: candidate.preservedPaths
          }, phase: "released", historyCleared: true, preservedArtifacts: candidate.preservedPaths, manualCancellation: cancelled };
          changes.push({ path: cleanupRecordPath(taskId), content: json2(retired) });
        } else if (cleanup) {
          if (cleanup.phase !== "released" || cleanup.taskId !== taskId) throw new Error("Task cleanup has no confirmed released identity.");
          const task = await readJson(this.files, snapshot, paths.task(taskId));
          changes.push({ path: cleanupRecordPath(taskId), content: json2({
            ...cleanup,
            historyCleared: true,
            preservedArtifacts: plan.preservedPaths.filter((path4) => path4.startsWith(paths.archive(taskId) + "/") || path4.startsWith(paths.run(taskId) + "/") || task?.resultPaths?.includes(path4))
          }) });
        }
      }
      changes.push({ path: path3, content: json2({ ...plan, completed: true }) });
      for (const [taskId, evidence] of Object.entries(plan.cancelledTasks ?? {})) await this.assertCancellation(taskId, evidence);
      return changes;
    });
    for (; ; ) {
      try {
        return this.result(plan, await apply2());
      } catch (error) {
        if (kind2 !== "conversation" || !(error instanceof FilesConflictError) || await withSnapshot(this.files, async (snapshot) => snapshot.revision) === error.expectedRevision) throw error;
      }
    }
  }
  async cancellation(taskId) {
    const evidence = await this.lifecycle.cancelledTaskCleanupEvidence?.(taskId);
    if (evidence === void 0) return void 0;
    if (!evidence || typeof evidence.commandId !== "string" || !evidence.commandId || typeof evidence.signature !== "string" || !evidence.signature)
      throw new Error("Cancelled Task cleanup requires exact cancellation and settled producer evidence.");
    return { commandId: evidence.commandId, signature: evidence.signature };
  }
  async assertCancellation(taskId, expected) {
    const current = await this.cancellation(taskId);
    if (!current || current.commandId !== expected.commandId || current.signature !== expected.signature)
      throw new Error("Task cancellation or settled producer ownership changed before cleanup: " + taskId);
  }
  async version(snapshot, path3) {
    filePath(path3);
    return (await this.files.listDirectory(snapshot, path3.slice(0, path3.lastIndexOf("/") + 1))).find((entry) => entry.path === path3)?.version ?? null;
  }
  async migrations(snapshot) {
    const index = await readJson(this.files, snapshot, "technical/legacy-migrations/index.json");
    const result = [];
    for (const item of index?.migrations ?? []) {
      if (!/^technical\/legacy-migrations\/[^/]+\/manifest.json$/.test(item.manifestPath)) throw new Error("Invalid migration manifest path.");
      const manifest = await readJson(this.files, snapshot, item.manifestPath), version = await this.version(snapshot, item.manifestPath);
      if (!manifest || !version || manifest.source.mode !== "local") continue;
      result.push({ path: item.manifestPath, manifest, version });
    }
    return result;
  }
  async candidates(snapshot) {
    const taskFiles = await this.files.listDirectory(snapshot, "tasks/"), migrations = await this.migrations(snapshot);
    const currentIds = new Set(taskFiles.filter((entry) => /^tasks\/[^/]+\.json$/.test(entry.path)).map((entry) => entry.path.slice("tasks/".length, -".json".length)));
    const tasks = /* @__PURE__ */ new Map(), cancellations = /* @__PURE__ */ new Map(), resultReferences = [];
    for (const entry of taskFiles.filter((entry2) => /^tasks\/[^/]+\.json$/.test(entry2.path))) {
      const task = await readJson(this.files, snapshot, entry.path);
      for (const path3 of task?.resultPaths ?? []) resultReferences.push(filePath(path3));
      if (task && entry.path === paths.task(task.taskId)) {
        if (task.status === "complete") tasks.set(task.taskId, task);
        else if (task.status === "running") {
          const evidence = await this.cancellation(task.taskId);
          if (evidence) {
            tasks.set(task.taskId, task);
            cancellations.set(task.taskId, evidence);
          }
        }
      }
    }
    const legacyIdentities = /* @__PURE__ */ new Map();
    for (const migration of migrations) {
      const identities = migration.manifest.tasks.filter((task) => !migration.manifest.clearedTasks?.some((cleared) => cleared.oldId === task.oldId)).map(({ oldId, taskId, continuation }) => ({ oldId, taskId, continuation }));
      const missing = new Set(migration.manifest.records.filter((record) => record.key.startsWith("task-history/")).map((record) => {
        const oldId = decodeURIComponent(record.key.slice("task-history/".length));
        if (!oldId || record.key !== "task-history/" + encodeURIComponent(oldId)) throw new Error("Invalid preserved legacy history identity.");
        return oldId;
      }).filter((oldId) => !migration.manifest.tasks.some((task) => task.oldId === oldId)));
      if (missing.size) {
        const failures = [];
        const found = await listLegacyRecordExports(this.files, snapshot, migration.path, (error, oldId) => {
          if (missing.has(oldId)) failures.push(error);
        });
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, "Preserved legacy histories could not be verified for cleanup.");
        for (const identity2 of found) if (missing.has(identity2.oldTaskId)) {
          await readLegacyRecordExport(this.files, snapshot, { manifestPath: migration.path, oldTaskId: identity2.oldTaskId });
          identities.push({ oldId: identity2.oldTaskId, taskId: identity2.taskId, continuation: identity2.continuation });
        }
      }
      legacyIdentities.set(migration.path, identities);
      for (const task of identities) if (["complete", "cancelled"].includes(task.continuation) && !currentIds.has(task.taskId)) tasks.set(segment2(task.taskId), void 0);
    }
    const artifacts = await this.files.list(snapshot, "technical/artifacts/manifests/");
    const artifactPaths = /* @__PURE__ */ new Map();
    for (const entry of artifacts) {
      const value = await readJson(this.files, snapshot, entry.path);
      if (value?.taskId && value.path?.startsWith(paths.archive(value.taskId) + "/")) artifactPaths.set(value.taskId, [...artifactPaths.get(value.taskId) ?? [], filePath(value.path)]);
    }
    const result = [];
    for (const [taskId, task] of tasks) {
      if ((await readJson(this.files, snapshot, cleanupRecordPath(taskId)))?.historyCleared) continue;
      const cancelled = cancellations.get(taskId);
      if (task && !cancelled && (await readJson(this.files, snapshot, cleanupRecordPath(taskId)))?.phase !== "released") continue;
      const preservedPaths = unique([
        ...task?.resultPaths ?? [],
        ...artifactPaths.get(taskId) ?? [],
        ...resultReferences.filter((path3) => path3.startsWith(paths.archive(taskId) + "/") || path3.startsWith(paths.run(taskId) + "/"))
      ].map(filePath));
      const preserve = (path3) => preservedPaths.some((keep) => path3 === keep || path3.startsWith(keep + "/"));
      const entries = /* @__PURE__ */ new Map(), targets = [], guards = [], legacySelections = [];
      for (const root of [paths.archive(taskId), paths.run(taskId), "Recorder Cache/" + taskId]) for (const entry of await this.files.list(snapshot, root)) entries.set(entry.path, entry);
      if (task) {
        for (const path3 of [paths.task(taskId), cleanupRecordPath(taskId)]) {
          const version = await this.version(snapshot, path3);
          if (version) guards.push({ path: path3, version });
        }
        const source = await this.files.read(snapshot, task.sourcePath);
        if (/^tasks\/[^/]+_(P|O)\.md$/.test(task.sourcePath) && source !== void 0 && taskIdentity(source) === taskId) {
          const entry = taskFiles.find((item) => item.path === task.sourcePath);
          if (entry) entries.set(entry.path, entry);
        }
      }
      for (const migration of migrations) {
        const selected = legacyIdentities.get(migration.path)?.find((item) => item.taskId === taskId);
        if (!selected) continue;
        legacySelections.push({ manifestPath: migration.path, oldId: selected.oldId, taskId });
        const owns = legacyTaskOwns(selected.oldId);
        for (const record of migration.manifest.records) if (owns(record.key)) await addMigrationEntry(this.files, snapshot, entries, migration.path, record.path, migration.manifest, owns);
        for (const [ref, path3] of Object.entries(migration.manifest.references)) if (owns(decodeReference(ref))) await addMigrationEntry(this.files, snapshot, entries, migration.path, path3, migration.manifest, owns);
        targets.push({ path: migration.path, version: migration.version, action: "migration" });
      }
      for (const entry of entries.values()) if (!preserve(entry.path)) targets.push({ path: entry.path, version: entry.version, action: "delete" });
      const all = [...entries.values(), ...guards].sort((a, b) => a.path.localeCompare(b.path));
      const identity2 = [taskId, all.map(({ path: path3, version }) => [path3, version]), mergeTargets(targets), preservedPaths];
      if (cancelled) identity2.push({ cancelled });
      const signature = hash4(json2(identity2));
      result.push({
        taskId,
        ...cancelled ? { cancelled } : {},
        legacySelections,
        targets: mergeTargets(targets),
        guards,
        preservedPaths,
        signature,
        bytes: [...entries.values()].filter((entry) => !preserve(entry.path)).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
      });
    }
    return result.sort((a, b) => a.taskId.localeCompare(b.taskId));
  }
  async conversationIndex(snapshot) {
    const index = await readJson(this.files, snapshot, this.conversation.indexPath) ?? { version: 1, messages: [] };
    if (index.version !== 1 || !Array.isArray(index.messages)) throw new Error("Invalid conversation index.");
    return index;
  }
  async conversationPlan(snapshot, capturedMessageIds) {
    const index = await this.conversationIndex(snapshot);
    const targets = [], messagePaths = [], oldAssistants = /* @__PURE__ */ new Set();
    const selected = capturedMessageIds ? index.messages.filter((item) => capturedMessageIds.includes(item.id)) : index.messages;
    if (capturedMessageIds?.some((id) => !selected.some((item) => item.id === id))) throw new Error("Confirmed old Foreground capture is absent from this conversation.");
    const messageIds = {};
    for (const item of selected) {
      const entry = await readJson(this.files, snapshot, item.path);
      if (!entry || entry.id !== item.id || entry.collaborationId !== this.conversation.scope.collaborationId || capturedMessageIds && entry.role !== "assistant" || !/^conversations\/local\/[^/]+\/[^/]+\/[^/]+\/entry.json$/.test(item.path) || entry.textPath !== item.path.replace(/entry.json$/, "text")) throw new Error("Conversation cleanup requires exact owned message references.");
      const root = item.path.slice(0, -"entry.json".length);
      for (const file of await this.files.list(snapshot, root)) targets.push({ path: file.path, version: file.version, action: "delete" });
      messagePaths.push(item.path);
      messageIds[item.path] = item.id;
      if (entry.legacy?.reference) {
        const old = /^conversations\/([^/]+)\//.exec(decodeReference(entry.legacy.reference));
        if (old) oldAssistants.add(old[1]);
      }
      if (item.notification) {
        if (!/^state\/Foreground_[^/]+$/.test(item.notification)) throw new Error("Invalid conversation notification path.");
        const version = await this.version(snapshot, item.notification);
        if (version) targets.push({ path: item.notification, version, action: "notification" });
      }
    }
    for (const migration of await this.migrations(snapshot)) {
      if (!migration.manifest.messages.some((message) => messagePaths.includes(message.path))) continue;
      const entries = /* @__PURE__ */ new Map();
      const exclusive = [...oldAssistants].filter((id) => !migration.manifest.messages.some((message) => !messagePaths.includes(message.path) && decodeReference(message.reference).startsWith("conversations/" + id + "/")));
      const owns = (key) => exclusive.some((id) => ["conversations", "conversation-index", "conversation-staging", "conversation-exchanges"].some((root) => key.startsWith(root + "/" + id + "/")) || key.startsWith("assistant-history/" + id + "/session/") || key.startsWith("assistant-history/" + id + "/input/"));
      for (const record of migration.manifest.records) if (owns(record.key)) await addMigrationEntry(this.files, snapshot, entries, migration.path, record.path, migration.manifest, owns);
      for (const [reference, path3] of Object.entries(migration.manifest.references)) if (owns(decodeReference(reference))) await addMigrationEntry(this.files, snapshot, entries, migration.path, path3, migration.manifest, owns);
      for (const file of entries.values()) targets.push({ path: file.path, version: file.version, action: "delete" });
      targets.push({ path: migration.path, version: migration.version, action: "migration" });
    }
    targets.push({ path: this.conversation.indexPath, version: null, action: "index" });
    return { version: 1, kind: "conversation", scope: this.scope, targets: mergeTargets(targets), taskIds: [], messagePaths, messageIds, preservedPaths: [] };
  }
};
function mergeTargets(targets) {
  const values2 = /* @__PURE__ */ new Map();
  for (const target of targets) {
    const prior = values2.get(target.path);
    if (prior && json2(prior) !== json2(target)) throw new Error("Cleanup target has conflicting ownership.");
    values2.set(target.path, target);
  }
  return [...values2.values()].sort((a, b) => a.path.localeCompare(b.path));
}
function decodeReference(ref) {
  return ref.startsWith("dss-record://") ? decodeURIComponent(ref.slice("dss-record://".length)) : ref;
}
function legacyTaskOwns(taskId) {
  const id = encodeURIComponent(taskId), roots = ["planner-memory", "planner-note", "worker-reply", "recovery", "execution", "task-runtime", "task-staging", "records", "record-archive", "task-origin"];
  return (key) => key === "task:" + taskId || key === "task-history/" + id || roots.some((root) => key.startsWith(root + "/" + id + "/"));
}
async function addMigrationEntry(files, snapshot, entries, manifestPath2, path3, manifest, owns) {
  filePath(path3);
  const root = manifestPath2.slice(0, -"manifest.json".length);
  if (!path3.startsWith(root + "source/") && !path3.startsWith(root + "text/")) return;
  if (manifest.records.some((record) => record.path === path3 && !owns(record.key)) || Object.entries(manifest.references).some(([reference, destination2]) => destination2 === path3 && !owns(decodeReference(reference)))) return;
  const entry = (await files.listDirectory(snapshot, path3.slice(0, path3.lastIndexOf("/") + 1))).find((entry2) => entry2.path === path3);
  if (entry) entries.set(path3, entry);
}

// src/framework/knowledge.ts
import { createHash as createHash16 } from "node:crypto";
import { parse as parseYaml2 } from "yaml";

// src/framework/skills.ts
import { createHash as createHash15 } from "node:crypto";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { isSkillName } from "@deepseek-ai/dsh-skill";
import { parse as parseYaml } from "yaml";
var frameworkSkillControlsPath = "technical/skills/controls.json";
var frameworkSkillIndexPath = "technical/skills/catalog.json";
var providerName = "deepseek-servant-framework";
var hash5 = (text) => createHash15("sha256").update(text).digest("hex");
var sameScope = (left, right) => left.assistantId === right.assistantId && left.workspaceId === right.workspaceId;
function markdown(text) {
  const normalized = text.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(normalized);
  if (!match) return void 0;
  const data = parseYaml(match[1]);
  if (!data || typeof data !== "object" || typeof data.name !== "string" || !isSkillName(data.name) || typeof data.description !== "string" || !data.description.trim()) return void 0;
  for (const key of ["disableModelInvocation", "modelInvocable", "userInvocable"]) if (Object.hasOwn(data, key)) return void 0;
  for (const key of ["disable-model-invocation", "user-invocable"]) if (data[key] !== void 0 && typeof data[key] !== "boolean") return void 0;
  return {
    name: data.name,
    description: data.description,
    invocation: { modelInvocable: data["disable-model-invocation"] !== true, userInvocable: data["user-invocable"] !== false },
    content: normalized.slice(match[0].length).trim()
  };
}
function legacy(text) {
  const record = JSON.parse(text);
  if (record.schemaVersion !== 1 || record.kind !== "skill" || !record.scope?.assistantId || !record.scope.workspaceId || !Array.isArray(record.versions) || !isSkillName("servant-" + record.skillId)) return void 0;
  const active = record.versions.find((version) => version.version === record.activeVersion && version.status === "active" && !version.bodyRetiredAt);
  if (!active || typeof active.description !== "string" || typeof active.applicability !== "string" || typeof active.body !== "string") return void 0;
  return { record, active };
}
function legacyGit(text) {
  const value = JSON.parse(text);
  if (value.version !== 1 || value.kind !== "legacy-git-skill" || typeof value.participantId !== "string" || !value.participantId || typeof value.name !== "string" || !isSkillName(value.name) || typeof value.description !== "string" || !value.description.trim() || typeof value.body !== "string" || typeof value.source?.path !== "string") return void 0;
  return value;
}
async function catalog(files, snapshot) {
  const text = await files.read(snapshot, frameworkSkillIndexPath);
  if (text === void 0) return { version: 1, entries: [] };
  const value = JSON.parse(text);
  if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error("Invalid framework skill catalog.");
  return value;
}
async function controls(files, snapshot) {
  const text = await files.read(snapshot, frameworkSkillControlsPath);
  if (text === void 0) return { version: 1, entries: {} };
  const value = JSON.parse(text);
  if (value.version !== 1 || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) throw new Error("Invalid skill controls record.");
  return value;
}
var disabled = (value, path3) => ["disabled", "retired"].includes(value.entries[path3]?.status);
async function prepareFrameworkSkillIndex(files, snapshot, changes) {
  const relevant = changes.filter((change) => change.path.startsWith("skills/") && (change.path.endsWith("/SKILL.md") || change.path.endsWith("/record.json") || change.path.endsWith("/legacy-git.json")));
  if (!relevant.length) return { changes: [], issues: [] };
  const index = await catalog(files, snapshot), entries = new Map(index.entries.map((entry) => [entry.path, entry])), issues = [];
  for (const change of relevant) {
    filePath(change.path);
    entries.delete(change.path);
    if (change.content === null) continue;
    try {
      const text = change.bytes === void 0 ? change.content : new TextDecoder("utf-8", { fatal: true }).decode(change.bytes);
      if (change.path.endsWith("/SKILL.md")) {
        const parsed = markdown(text);
        if (!parsed) {
          issues.push("Not a native skill definition: " + change.path);
          continue;
        }
        entries.set(change.path, {
          path: change.path,
          hash: hash5(text),
          name: parsed.name,
          description: parsed.description,
          invocation: parsed.invocation,
          kind: "markdown"
        });
      } else if (change.path.endsWith("/legacy-git.json")) {
        const parsed = legacyGit(text);
        if (!parsed) {
          issues.push("Invalid migrated Git skill: " + change.path);
          continue;
        }
        entries.set(change.path, {
          path: change.path,
          hash: hash5(text),
          name: parsed.name,
          description: parsed.description,
          invocation: { modelInvocable: true, userInvocable: true },
          kind: "legacy-git",
          participantId: parsed.participantId
        });
      } else {
        const parsed = legacy(text);
        if (!parsed) continue;
        const { record, active } = parsed;
        entries.set(change.path, {
          path: change.path,
          hash: hash5(text),
          name: "servant-" + record.skillId,
          description: active.description + "\n\u9002\u7528\u8303\u56F4\uFF1A" + active.applicability,
          invocation: { modelInvocable: true, userInvocable: true },
          kind: "legacy",
          scope: record.scope,
          activeVersion: active.version
        });
      }
    } catch (error) {
      issues.push(change.path + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return { changes: [{ path: frameworkSkillIndexPath, content: JSON.stringify({ version: 1, entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) }) + "\n" }], issues };
}
function installFrameworkSkillProvider(scope, agent, files, options = {}) {
  if (scopeOf(scope) !== agent) throw new Error("Framework skills must be installed in the actual Agent scope.");
  let control;
  const selectedRoots = /* @__PURE__ */ new Set();
  const stopRefresh = scope.on("agent/pre-step", (event, next) => {
    if (event.agent === agent) control?.invalidate();
    return next();
  });
  const allowed = (entry) => entry.kind === "markdown" || (entry.kind === "legacy" ? !!entry.scope && (options.legacyScopes ?? []).some((value) => sameScope(value, entry.scope)) : entry.kind === "legacy-git" && !!entry.participantId && (options.legacyGitParticipants ?? []).includes(entry.participantId));
  const fiber = scope.inject(["skills"], (child) => {
    child.effect(() => () => {
      control = void 0;
      selectedRoots.clear();
    }, "framework.skillCapability");
    child.skills.registerProvider((value) => {
      control = value;
      return {
        name: providerName,
        list: async (lookup) => {
          lookup.signal?.throwIfAborted();
          const entries = await withSnapshot(files, async (snapshot) => {
            const states = await controls(files, snapshot);
            return (await catalog(files, snapshot)).entries.filter((entry) => !disabled(states, entry.path));
          });
          lookup.signal?.throwIfAborted();
          return entries.filter(allowed).map((entry) => ({
            name: entry.name,
            description: entry.description,
            invocation: entry.invocation,
            source: "runtime",
            provider: providerName,
            rank: 250,
            resourceBase: { kind: "opaque", description: "DSS logical skill resources: " + entry.path.slice(0, entry.path.lastIndexOf("/")) + ". Read selected resources with dss_read at a fixed storage revision." },
            locator: entry
          }));
        },
        get: async (candidate, lookup) => {
          lookup.signal?.throwIfAborted();
          const entry = candidate.locator;
          if (!entry.path.startsWith("skills/") || !allowed(entry)) return void 0;
          const text = await withSnapshot(files, async (snapshot) => disabled(await controls(files, snapshot), entry.path) ? void 0 : files.read(snapshot, filePath(entry.path)));
          lookup.signal?.throwIfAborted();
          if (text === void 0 || hash5(text) !== entry.hash) {
            control?.invalidate();
            return void 0;
          }
          let content;
          if (entry.kind === "markdown") content = markdown(text)?.content;
          else if (entry.kind === "legacy-git") {
            const parsed = legacyGit(text);
            if (parsed?.participantId === entry.participantId && parsed?.name === entry.name) content = parsed.body;
          } else {
            const parsed = legacy(text);
            if (parsed && parsed.active.version === entry.activeVersion && entry.scope && sameScope(parsed.record.scope, entry.scope)) {
              const active = parsed.active;
              content = `# ${active.title}

${active.description}

## \u9002\u7528\u8303\u56F4

${active.applicability}

${active.body}
`;
            }
          }
          if (content !== void 0) selectedRoots.add(entry.path.slice(0, entry.path.lastIndexOf("/")));
          return content === void 0 ? void 0 : {
            name: candidate.name,
            description: candidate.description,
            invocation: candidate.invocation,
            source: candidate.source,
            provider: candidate.provider,
            resourceBase: candidate.resourceBase,
            content
          };
        }
      };
    });
  });
  return {
    dispose: async () => {
      stopRefresh();
      selectedRoots.clear();
      await fiber.dispose();
    },
    canReadResource: (path3) => {
      try {
        filePath(path3);
      } catch {
        return false;
      }
      return [...selectedRoots].some((root) => path3 === root || path3.startsWith(root + "/"));
    },
    invalidate: () => control?.invalidate(),
    available: () => control !== void 0,
    diagnostics: () => control ? [] : ["Native skill registry is unavailable in this Agent scope; preserved skill files are not currently discoverable by the native skill tool."]
  };
}

// src/framework/knowledge.ts
var candidateIndex = "technical/skills/candidates.json";
var hash6 = (value) => createHash16("sha256").update(value).digest("hex");
var encode = (value) => JSON.stringify(value, null, 2) + "\n";
var stable = (value) => Array.isArray(value) ? "[" + value.map(stable).join(",") + "]" : value && typeof value === "object" ? "{" + Object.entries(value).filter(([, v]) => v !== void 0).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + stable(v)).join(",") + "}" : JSON.stringify(value);
function isReadOnlyRecord(path3) {
  filePath(path3);
  return /^knowledge\/(facts|preferences)\/.+\.json$/.test(path3) || /^knowledge\/legacy-git\/[^/]+\/(knowledge|preference)\/[^/]+\.json$/.test(path3);
}
function readOnlyRecord(path3, text) {
  if (!isReadOnlyRecord(path3)) throw new Error("Select a migrated fact or preference record.");
  const value = JSON.parse(text);
  if (typeof value.text !== "string") throw new Error("Knowledge record body is invalid.");
  if (path3.startsWith("knowledge/legacy-git/")) {
    if (value.version !== 1 || !["knowledge", "preference"].includes(value.kind) || typeof value.participantId !== "string" || typeof value.source?.path !== "string") throw new Error("Migrated Git knowledge provenance is invalid.");
    return {
      kind: value.kind === "preference" ? "preference" : "project-fact",
      text: value.text,
      scope: { participantId: value.participantId },
      source: JSON.stringify(value.source)
    };
  }
  if (value.schemaVersion !== 1 || !["project-fact", "preference"].includes(value.kind) || typeof value.scope?.assistantId !== "string" || typeof value.scope.workspaceId !== "string" || typeof (value.kind === "project-fact" ? value.sourceResultId : value.userSourceRef) !== "string" || value.kind === "preference" && typeof value.applicability !== "string") throw new Error("Migrated knowledge provenance is invalid.");
  return {
    kind: value.kind,
    text: value.text,
    scope: value.scope,
    source: value.kind === "project-fact" ? value.sourceResultId : value.userSourceRef,
    ...value.kind === "preference" ? { applicability: value.applicability } : {}
  };
}
function kind(path3) {
  filePath(path3);
  if (!path3.startsWith("skills/")) throw new Error("Select a skill record inside the skills directory.");
  if (path3.endsWith("/record.json")) return "legacy";
  if (path3.endsWith("/legacy-git.json")) return "legacy-git";
  if (path3.endsWith("/SKILL.md")) return "markdown";
  throw new Error("Select the skill definition, not one of its resource files.");
}
function legacy2(text) {
  const record = JSON.parse(text);
  if (record.schemaVersion !== 1 || record.kind !== "skill" || typeof record.skillId !== "string" || typeof record.scope?.assistantId !== "string" || typeof record.scope.workspaceId !== "string" || !Number.isSafeInteger(record.revision) || !Array.isArray(record.versions) || !record.versions.length || record.versions.some((value) => !Number.isSafeInteger(value.version) || value.version < 1 || ["title", "description", "applicability", "body", "contentHash"].some((key) => typeof value[key] !== "string")))
    throw new Error("Invalid migrated skill record.");
  return record;
}
var FrameworkKnowledge = class {
  constructor(files, transactions, onChanged = () => {
  }) {
    this.files = files;
    this.transactions = transactions;
    this.onChanged = onChanged;
  }
  list() {
    return withSnapshot(this.files, async (snapshot) => {
      const controls2 = JSON.parse(await this.files.read(snapshot, frameworkSkillControlsPath) ?? '{"version":1,"entries":{}}');
      const candidates = JSON.parse(await this.files.read(snapshot, candidateIndex) ?? '{"version":1,"entries":[]}');
      const catalog2 = JSON.parse(await this.files.read(snapshot, frameworkSkillIndexPath) ?? '{"version":1,"entries":[]}');
      const items = [];
      for (const entry of await this.files.list(snapshot, "skills/")) {
        if (!["/record.json", "/legacy-git.json", "/SKILL.md"].some((suffix) => entry.path.endsWith(suffix))) continue;
        const item = { path: entry.path, kind: kind(entry.path), name: entry.path, description: "", status: controls2.entries[entry.path]?.status ?? "stored", indexed: false, candidates: candidates.entries.filter((row) => row.sourcePath === entry.path).map(({ path: path3, hash: hash13, createdAt }) => ({ path: path3, hash: hash13, createdAt })) };
        try {
          const text = await this.files.read(snapshot, entry.path);
          if (text === void 0) throw new Error("Skill definition is missing.");
          item.indexed = !controls2.entries[entry.path] && catalog2.entries.some((row) => row.path === entry.path && row.hash === hash6(text));
          if (!controls2.entries[entry.path]) item.status = item.indexed ? "active" : "unindexed";
          if (item.kind === "legacy") {
            const record = legacy2(text), selected = record.versions.find((version) => version.version === record.activeVersion) ?? record.versions.at(-1);
            item.name = selected.title;
            item.description = selected.description;
            item.activeVersion = record.activeVersion;
            item.status = controls2.entries[entry.path]?.status ?? selected.status;
            item.versions = record.versions.map(({ version, status, contentHash }) => ({ version, status, contentHash }));
          } else if (item.kind === "legacy-git") {
            const record = JSON.parse(text);
            item.name = record.name;
            item.description = record.description;
          } else {
            const header = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ""));
            if (!header) throw new Error("Skill front matter is missing.");
            const fields2 = parseYaml2(header[1]);
            item.name = typeof fields2?.name === "string" ? fields2.name : entry.path;
            item.description = typeof fields2?.description === "string" ? fields2.description : "";
          }
        } catch (error) {
          item.error = error instanceof Error ? error.message : String(error);
        }
        items.push(item);
      }
      const legacyIndex = JSON.parse(await this.files.read(snapshot, "knowledge/legacy-index.json") ?? '{"version":1,"entries":[]}');
      const recordPaths = new Set(legacyIndex.entries.filter((entry) => ["project-fact", "preference"].includes(entry.kind)).map((entry) => entry.path));
      for (const entry of await this.files.list(snapshot, "knowledge/legacy-git/")) if (isReadOnlyRecord(entry.path)) recordPaths.add(entry.path);
      for (const path3 of recordPaths) {
        const item = { path: path3, kind: "project-fact", name: path3, description: "", status: "read-only", indexed: false, candidates: [] };
        try {
          if (!isReadOnlyRecord(path3)) throw new Error("Invalid migrated knowledge record path.");
          const text = await this.files.read(snapshot, path3);
          if (text === void 0) throw new Error("Migrated knowledge record is missing.");
          const record = readOnlyRecord(path3, text);
          item.kind = record.kind;
          item.scope = record.scope;
          item.source = record.source;
          item.description = record.applicability ?? "";
        } catch (error) {
          item.error = error instanceof Error ? error.message : String(error);
        }
        items.push(item);
      }
      return { revision: snapshot.revision, items };
    });
  }
  read(path3) {
    if (isReadOnlyRecord(path3)) return withSnapshot(this.files, async (snapshot) => {
      const text = await this.files.read(snapshot, path3);
      return { revision: snapshot.revision, path: path3, text, ...text === void 0 ? {} : { record: readOnlyRecord(path3, text) } };
    });
    const selectedKind = kind(path3);
    return withSnapshot(this.files, async (snapshot) => {
      const text = await this.files.read(snapshot, path3);
      if (text === void 0) return { revision: snapshot.revision, path: path3, text };
      if (selectedKind === "legacy") {
        const value = legacy2(text).versions.at(-1);
        return { revision: snapshot.revision, path: path3, text, edit: { body: value.body, title: value.title, description: value.description, applicability: value.applicability } };
      }
      if (selectedKind === "legacy-git") {
        const value = JSON.parse(text);
        return { revision: snapshot.revision, path: path3, text, edit: { body: value.body } };
      }
      return { revision: snapshot.revision, path: path3, text, edit: { body: text } };
    });
  }
  async edit(commandId, input) {
    const selectedKind = kind(input.path);
    if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("Use the edit command\u2019s actual timestamp.");
    const receipt = await this.transactions.run("knowledge-edit:" + commandId, input, { expectedRevision: input.expectedRevision }, async (snapshot) => {
      const text = await this.files.read(snapshot, input.path);
      if (text === void 0) throw new Error("Skill definition is missing.");
      if (selectedKind === "legacy") {
        const record = legacy2(text), previous = record.versions.at(-1);
        const content = {
          title: input.title ?? previous.title,
          description: input.description ?? previous.description,
          body: input.body,
          applicability: input.applicability ?? previous.applicability,
          scope: record.scope
        };
        const contentHash = hash6(stable(content));
        if (contentHash === previous.contentHash && !previous.bodyRetiredAt) return [];
        const candidate = {
          ...content,
          skillId: record.skillId,
          version: previous.version + 1,
          contentHash,
          status: "candidate",
          createdAt: input.createdAt,
          sourceResultIds: [],
          validations: [],
          uses: [],
          feedback: [],
          supersedes: previous.version
        };
        record.versions.push(candidate);
        record.revision++;
        const change = { path: input.path, content: encode(record) };
        const index = await prepareFrameworkSkillIndex(this.files, snapshot, [change]);
        return [change, ...index.changes];
      }
      const candidates = JSON.parse(await this.files.read(snapshot, candidateIndex) ?? '{"version":1,"entries":[]}');
      const digest9 = hash6(input.body);
      if (candidates.entries.some((row) => row.sourcePath === input.path && row.hash === digest9)) return [];
      const path3 = input.path.slice(0, input.path.lastIndexOf("/")) + "/candidates/" + hash6(commandId) + ".md";
      candidates.entries.push({ sourcePath: input.path, path: path3, hash: digest9, createdAt: input.createdAt });
      return [{ path: path3, content: input.body }, { path: candidateIndex, content: encode(candidates) }];
    });
    this.onChanged();
    return receipt;
  }
  async setStatus(commandId, input) {
    const selectedKind = kind(input.path);
    if (input.status !== "disabled" && input.status !== "retired") throw new Error("Choose disable or retire for this operation.");
    const receipt = await this.transactions.run("knowledge-status:" + commandId, input, { expectedRevision: input.expectedRevision }, async (snapshot) => {
      const text = await this.files.read(snapshot, input.path);
      if (text === void 0) throw new Error("Skill definition is missing.");
      const controls2 = JSON.parse(await this.files.read(snapshot, frameworkSkillControlsPath) ?? '{"version":1,"entries":{}}');
      controls2.entries[input.path] = { status: input.status, ...input.reason === void 0 ? {} : { reason: input.reason }, ...input.updatedAt === void 0 ? {} : { updatedAt: input.updatedAt } };
      const changes = [{ path: frameworkSkillControlsPath, content: encode(controls2) }];
      if (selectedKind === "legacy") {
        let record;
        try {
          record = legacy2(text);
        } catch {
          return changes;
        }
        const selected = record.versions.find((version) => version.version === record.activeVersion) ?? record.versions.at(-1);
        selected.status = input.status;
        if (input.reason !== void 0) selected.statusReason = input.reason;
        if (record.activeVersion === selected.version) delete record.activeVersion;
        record.revision++;
        const change = { path: input.path, content: encode(record) };
        changes.push(change, ...(await prepareFrameworkSkillIndex(this.files, snapshot, [change])).changes);
      }
      return changes;
    });
    this.onChanged();
    return receipt;
  }
};

// src/framework/task-index.ts
var segment3 = (value) => {
  if (typeof value !== "string" || value.includes("/")) return false;
  try {
    filePath(value);
    return true;
  } catch {
    return false;
  }
};
var logicalPath = (value) => {
  if (typeof value !== "string") return false;
  try {
    filePath(value);
    return true;
  } catch {
    return false;
  }
};
function parseTask(path3, bytes) {
  if (bytes === void 0) throw new Error("Listed Task record is missing from its snapshot.");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task record must be an object.");
  const task = value;
  if (task.version !== 1 || !segment3(task.taskId) || path3 !== "tasks/" + task.taskId + ".json" || !["P", "O"].includes(task.route ?? "") || !["running", "complete"].includes(task.status ?? "") || !segment3(task.owner) || !logicalPath(task.sourcePath) || task.members !== void 0 && (!Array.isArray(task.members) || !task.members.every(segment3)) || task.resultPaths !== void 0 && (!Array.isArray(task.resultPaths) || !task.resultPaths.every(logicalPath))) {
    throw new Error("Invalid Task metadata or Task/file identity mismatch.");
  }
  return task;
}
var FrameworkTaskIndex = class {
  constructor(files, error, changed) {
    this.files = files;
    this.error = error;
    this.changed = changed;
  }
  cache = /* @__PURE__ */ new Map();
  visible = "[]";
  async list(snapshot, entries, signal) {
    const listed = entries ?? await this.files.listDirectory(snapshot, "tasks/");
    const direct = listed.filter((entry) => /^tasks\/[^/]+\.json$/.test(entry.path)).sort((a, b) => a.path.localeCompare(b.path));
    const present = new Set(direct.map((entry) => entry.path));
    for (const path3 of this.cache.keys()) if (!present.has(path3)) this.cache.delete(path3);
    const result = [], visible = [];
    await this.files.prefetch?.(snapshot, { signal, isolatePathErrors: true, files: direct.filter((entry) => this.cache.get(entry.path)?.version !== entry.version).map((entry) => entry.path) });
    for (const entry of direct) {
      let cached = this.cache.get(entry.path);
      if (cached?.version !== entry.version) {
        this.cache.delete(entry.path);
        let bytes;
        try {
          bytes = await this.files.readBytes(snapshot, entry.path);
        } catch (cause) {
          this.error(new Error("Cannot read Task " + entry.path, { cause }));
          continue;
        }
        cached = { version: entry.version };
        try {
          cached.value = parseTask(entry.path, bytes);
        } catch (cause) {
          this.error(new Error("Invalid Task " + entry.path, { cause }));
        }
        this.cache.set(entry.path, cached);
      }
      if (cached?.value) {
        result.push(structuredClone(cached.value));
        visible.push([entry.path, entry.version]);
      }
    }
    const signature = JSON.stringify(visible);
    if (signature !== this.visible) {
      this.visible = signature;
      this.changed?.();
    }
    return result;
  }
};

// src/framework/service.ts
import { createHash as createHash30, randomUUID as randomUUID11 } from "node:crypto";
import { z as z7 } from "zod";
import { SessionId as SessionId4 } from "@deepseek-ai/dsh-session";

// src/adapters/dsh/conversation.ts
import { deriveEventMessage, isAppendSurfaceEvent } from "@deepseek-ai/dsh-session";
var object2 = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
function assistantResultText(message) {
  if (message.role !== "assistant" || message.source.kind !== "model") return "";
  const replay = object2(message.source.replayState);
  const response = object2(replay?.response ?? replay);
  if (response?.kind === "codex-app-server" && Array.isArray(response.items)) {
    return response.items.flatMap((value) => {
      const item = object2(value);
      if (item?.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) return [];
      if (item.phase != null && item.phase !== "final_answer" && item.phase !== "final") return [];
      if (item.channel != null && item.channel !== "final") return [];
      const text = item.content.flatMap((value2) => {
        const block = object2(value2);
        if ((block?.type === "output_text" || block?.type === "text") && typeof block.text === "string") return [block.text];
        if (block?.type === "refusal" && typeof block.refusal === "string") return [block.refusal];
        return [];
      }).join("");
      return text ? [text] : [];
    }).join("\n\n");
  }
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function conversationSnapshot(events) {
  const completed = /* @__PURE__ */ new Set();
  for (const event of events) if (event.type === "turn/end" && event.data.reason.kind === "completed") completed.add(event.data.turn);
  const results = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (event.type !== "assistant/message" || !isAppendSurfaceEvent(event) || !completed.has(event.data.turn) || event.data.interrupted) continue;
    results.delete(event.data.turn);
    if (event.data.message.content.some((block) => block.type === "tool-call")) continue;
    const text = assistantResultText(event.data.message);
    if (text.trim()) results.set(event.data.turn, { event, text });
  }
  const messages = [], seen = /* @__PURE__ */ new Map();
  const turns = [];
  let current, finished = false;
  let ended;
  let unassigned = [];
  const assign = (turn) => {
    for (const message of unassigned) message.turn = turn;
    unassigned = [];
  };
  const append = (message, text, time, turn) => {
    if (!text || message.role !== "user" && message.role !== "assistant") return void 0;
    const previous = seen.get(message.id);
    if (previous) {
      if (turn !== void 0) previous.turn = turn;
      return previous;
    }
    const value = {
      id: message.id,
      role: message.source.kind === "deepseek-servant" ? "system" : message.role,
      source: message.source.kind,
      text,
      at: new Date(time).toISOString(),
      ...turn === void 0 ? {} : { turn }
    };
    seen.set(message.id, value);
    messages.push(value);
    return value;
  };
  for (const event of events) {
    if (event.type === "turn/start") {
      current = event.data.turn;
      assign(current);
      finished = false;
      ended = void 0;
    }
    if (event.type === "turn/end") {
      assign(event.data.turn);
      finished = event.data.reason.kind === "completed";
      const reason = event.data.reason;
      ended = {
        reason: reason.kind,
        at: new Date(event.time).toISOString(),
        ...reason.kind === "interrupted" || reason.kind === "aborted" && ["disposed", "parent"].includes(reason.reason.kind) ? { interrupted: true } : {},
        messageIds: messages.filter((message) => message.turn === event.data.turn).map((message) => message.id),
        ...event.data.reason.kind === "error" ? { message: event.data.reason.error.message } : {}
      };
      if (finished) turns.push({
        turn: event.data.turn,
        at: new Date(event.time).toISOString(),
        messageIds: messages.filter((message) => message.turn === event.data.turn).map((message) => message.id)
      });
      current = void 0;
    }
    if (event.type === "agent/inbox/spliced") {
      for (const message of event.data.inserted) if (message.role === "user" && ["user", "deepseek-servant"].includes(message.source.kind))
        append(message, message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), event.time);
    }
    if (!isAppendSurfaceEvent(event)) continue;
    if (event.type === "assistant/message") {
      assign(event.data.turn);
      const result = results.get(event.data.turn);
      if (result?.event === event) append(event.data.message, result.text, event.time, event.data.turn);
    } else {
      const message = deriveEventMessage(event);
      if (message?.source.kind === "deepseek-servant-resume") {
        const original = seen.get(message.source.messageId);
        if (original && current !== void 0) original.turn = current;
      }
      if (message?.role === "user" && ["user", "deepseek-servant"].includes(message.source.kind)) {
        const original = append(message, message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), event.time, current);
        if (original && current === void 0) unassigned.push(original);
      }
    }
  }
  return { messages, turns, finished, ...ended ? { ended } : {} };
}
function conversationMessages(events) {
  return conversationSnapshot(events).messages.filter((message) => message.role !== "system");
}

// src/adapters/dsh/sessions.ts
import { SessionId, SessionLogOffset, deriveEventMessage as deriveEventMessage2, isAppendSurfaceEvent as isAppendSurfaceEvent2 } from "@deepseek-ai/dsh-session";
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError } from "@deepseek-ai/dsh-session-persistence";
var DshSessionReader = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async events(sessionId) {
    const id = SessionId(sessionId);
    const live = this.ctx.sessions.get(id);
    if (live !== void 0) return live.snapshotEvents();
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0) throw new Error("Servant requires DSH Session persistence for cold-session reads.");
    if (await persistence.stat(id) === void 0) return [];
    const handle = await persistence.open(id, "read");
    try {
      return (await handle.read()).events;
    } finally {
      await handle.close();
    }
  }
  /** Current inbox and consumed history, with original bodies retained for discarded admissions. */
  async inputs(sessionId) {
    const id = SessionId(sessionId);
    const live = this.ctx.sessions.get(id);
    const liveEvents = live?.snapshotEvents();
    if (live !== void 0) await this.ctx.sessions.flush(live);
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0) throw new Error("Servant requires native persistence to inspect input admission.");
    if (live === void 0 && await persistence.stat(id) === void 0) return /* @__PURE__ */ new Map();
    const opened = live === void 0 ? await persistence.open(id, "read") : void 0;
    try {
      const events = liveEvents ?? (await opened.read()).events;
      const header = live?.header ?? opened.header;
      const inherited = live?.inheritedEventCount ?? opened.inheritedEventCount;
      const projected = this.ctx.get("sessionProjections")?.restore({}, events, SessionLogOffset(0), header, inherited);
      const inbox = projected?.checkpoint.inbox?.val;
      return deriveNativeInputs(events, inbox, this.ctx.agents.get(id)?.status === "running");
    } finally {
      await opened?.close();
    }
  }
  async hasMessage(sessionId, messageId) {
    const input = (await this.inputs(sessionId)).get(messageId);
    return input?.state === "queued" || input?.state === "consumed" || input?.state === "claimed" && input.active === true;
  }
  /** Native projection replay only: no Agent ownership, inbox wake, or model request. */
  async inspect(sessionId) {
    const id = SessionId(sessionId);
    const live = this.ctx.sessions.get(id);
    if (live !== void 0) await this.ctx.sessions.flush(live);
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0) throw new Error("Servant requires DSH Session persistence for inspection.");
    const stat2 = await persistence.stat(id);
    const base = {
      exists: stat2 !== void 0 || live !== void 0,
      sessionId,
      liveAgent: this.ctx.agents.get(id) !== void 0,
      liveSession: live !== void 0,
      eventCount: 0,
      liveJobIds: this.ctx.jobs.list(id).filter((job) => job.owner === id && (job.status === "running" || job.status === "stopping")).map((job) => job.id),
      ...stat2?.sizeBytes === void 0 ? {} : { sizeBytes: stat2.sizeBytes },
      lifecycleKnown: false,
      queuedInbox: { nextTurn: [], nextStep: [] },
      unresolvedToolCallIds: [],
      jobs: []
    };
    if (!base.exists) return base;
    const opened = live === void 0 ? await persistence.open(id, "read") : void 0;
    try {
      const events = live?.snapshotEvents() ?? (await opened.read()).events;
      const header = live?.header ?? opened.header;
      const inherited = live?.inheritedEventCount ?? opened.inheritedEventCount;
      const projected = this.ctx.get("sessionProjections")?.restore({}, events, SessionLogOffset(0), header, inherited);
      const inbox = projected?.checkpoint.inbox?.val;
      const boundary = projected?.checkpoint.turnBoundary?.val;
      base.lifecycleKnown = inbox !== void 0 && boundary !== void 0;
      base.eventCount = events.length;
      if (inbox !== void 0) base.queuedInbox = { nextTurn: inbox["next-turn"].map((message) => message.id), nextStep: inbox["next-step"].map((message) => message.id) };
      const pendingTools = /* @__PURE__ */ new Set();
      const jobs = /* @__PURE__ */ new Map();
      for (const event of events) {
        if (event.type === "turn/start") base.lastTurn = { turn: event.data.turn, closed: false, toolCallIds: [] };
        if (event.type === "turn/end") base.lastTurn = {
          turn: event.data.turn,
          closed: true,
          reason: event.data.reason.kind,
          toolCallIds: base.lastTurn?.turn === event.data.turn ? base.lastTurn.toolCallIds : [],
          ...event.data.reason.kind === "aborted" ? { abortCause: event.data.reason.reason.kind } : {},
          ...event.data.reason.kind === "error" ? { error: event.data.reason.error.message } : {}
        };
        if (event.type === "tool/call") {
          pendingTools.add(event.data.callId);
          if (base.lastTurn && !base.lastTurn.closed) base.lastTurn.toolCallIds.push(event.data.callId);
        }
        if (event.type === "tool/result") pendingTools.delete(event.data.message.toolCallId);
        if (event.type === "job/registered") jobs.set(event.data.jobId, { id: event.data.jobId, owner: event.data.owner, kind: event.data.kind, state: "registered" });
        if (event.type === "job/settled") jobs.set(event.data.jobId, { id: event.data.jobId, owner: event.data.owner, kind: event.data.kind, state: event.data.status, producerReported: event.data.producerReported });
      }
      base.unresolvedToolCallIds = [...pendingTools];
      base.jobs = [...jobs.values()];
      return base;
    } finally {
      await opened?.close();
    }
  }
  /** Metadata only. Omitted selectors list Servant-namespaced sessions for retention accounting. */
  async catalog(sessionIds) {
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0) throw new Error("Servant requires DSH Session persistence for catalog reads.");
    const selected = sessionIds === void 0 ? void 0 : new Set(sessionIds);
    const archived = new Set(this.ctx.get("workspaceRegistry")?.archivedSessionIds ?? []);
    return (await persistence.list()).filter((item) => selected === void 0 ? item.header.id.startsWith("servant-") : selected.has(item.header.id)).map((item) => ({
      sessionId: item.header.id,
      createdAt: item.header.createdAt,
      ...item.eventCount === void 0 ? {} : { eventCount: item.eventCount },
      ...item.sizeBytes === void 0 ? {} : { sizeBytes: item.sizeBytes },
      liveAgent: this.ctx.agents.get(item.header.id) !== void 0,
      liveSession: this.ctx.sessions.get(item.header.id) !== void 0,
      archived: archived.has(item.header.id)
    }));
  }
  /** Observe only real lifecycle changes of this exact unresolved native owner. */
  watchOwnership(sessionId, listener) {
    const id = SessionId(sessionId);
    const onAgent = this.ctx.on("agent/disposed", ({ agent }) => {
      if (agent.id === id) listener();
    });
    const onSession = this.ctx.on("session/disposed", (session) => {
      if (session.id === id) listener();
    });
    const onJob = this.ctx.jobs.events.subscribe({ owner: id }, (event) => {
      if ((event.type === "settled" || event.type === "removed") && event.job.owner === id) listener();
    });
    return () => {
      onAgent();
      onSession();
      onJob();
    };
  }
  /** rc.2 supports archival, not erasing/truncating its append-only Session log. */
  async probeOwnership(sessionId) {
    const id = SessionId(sessionId);
    if (this.ctx.agents.get(id) !== void 0 || this.ctx.sessions.get(id) !== void 0) return "busy";
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0) throw new Error("Servant requires DSH Session persistence for ownership probes.");
    if (await persistence.stat(id) === void 0) return "absent";
    try {
      const lease = await persistence.open(id, "write");
      try {
        return this.ctx.agents.get(id) !== void 0 || this.ctx.sessions.get(id) !== void 0 ? "busy" : "exclusive";
      } finally {
        await lease.close();
      }
    } catch (error) {
      if (error instanceof SessionAlreadyOwnedError) return "busy";
      if (error instanceof SessionPersistenceNotFoundError) return "absent";
      throw error;
    }
  }
  /** Archive only after taking native ownership; never erase append-only log bytes. */
  async retire(sessionId) {
    const id = SessionId(sessionId);
    const assertCold = () => {
      if (this.ctx.agents.get(id) !== void 0 || this.ctx.sessions.get(id) !== void 0) throw new Error(`Cannot retire a live DSH Session: ${sessionId}`);
    };
    assertCold();
    const persistence = this.ctx.get("sessionPersistence");
    const workspaces = this.ctx.get("workspaceRegistry");
    if (persistence === void 0 || workspaces === void 0) throw new Error("Native DSH Session retirement requires persistence and the workspace registry.");
    if (await persistence.stat(id) === void 0) return { sessionId, status: "absent", logRetained: false, reclaimedBytes: 0 };
    const lease = await persistence.open(id, "write");
    try {
      assertCold();
      await workspaces.archiveSession(id);
      return { sessionId, status: "archived", logRetained: true, reclaimedBytes: 0 };
    } finally {
      await lease.close();
    }
  }
  async capture(sessionId) {
    const live = this.ctx.sessions.get(SessionId(sessionId));
    if (live) await this.ctx.sessions.flush(live);
    const snapshot = conversationSnapshot(await this.events(sessionId));
    if (snapshot.finished) {
      const state = await this.inspect(sessionId);
      snapshot.finished = state.lifecycleKnown && state.queuedInbox.nextTurn.length === 0 && state.queuedInbox.nextStep.length === 0 && state.unresolvedToolCallIds.length === 0;
    }
    return snapshot;
  }
  async conversation(sessionId) {
    return conversationMessages(await this.events(sessionId));
  }
};
function deriveNativeInputs(events, inbox, liveRunning) {
  const inputs = /* @__PURE__ */ new Map();
  const pendingIds = { "next-turn": [], "next-step": [] };
  const claims = /* @__PURE__ */ new Map();
  let turn;
  const remember = (message, state) => {
    const source = message.source.kind;
    if (source !== "user" && source !== "deepseek-servant") return;
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const previous = inputs.get(message.id);
    if (previous && (previous.text !== text || previous.source !== source)) throw new Error(`Native input identity has conflicting bodies: ${message.id}`);
    inputs.set(message.id, { state: previous?.state === "consumed" ? "consumed" : state, text, source });
  };
  for (const event of events) {
    if (event.type === "turn/start") turn = event.data.turn;
    if (event.type === "turn/end") turn = void 0;
    if (event.type === "agent/inbox/spliced") {
      const splice = event.data;
      const removed = pendingIds[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted.map((message) => message.id));
      for (const id of removed) {
        const input = inputs.get(id);
        if (!input || input.state === "consumed") continue;
        input.state = splice.outcome === "canceled" ? "discarded" : "claimed";
        if (input.state === "claimed") claims.set(id, turn);
        else claims.delete(id);
      }
      for (const message of splice.inserted) {
        remember(message, "discarded");
        claims.delete(message.id);
      }
    }
    if (isAppendSurfaceEvent2(event)) {
      const message = deriveEventMessage2(event);
      if (message?.role === "user") remember(message, "consumed");
    }
  }
  if (inbox === void 0 && [...inputs.values()].some((input) => input.state !== "consumed")) {
    throw new Error("Native inbox projection is unavailable; input consumption cannot be determined.");
  }
  if (inbox) for (const message of [...inbox["next-turn"], ...inbox["next-step"]]) remember(message, "queued");
  for (const [id, input] of inputs) if (input.state === "claimed") input.active = liveRunning && turn !== void 0 && claims.get(id) === turn;
  return inputs;
}

// src/adapters/dsh/host-types.ts
var DshAgentCreationCancelled = class extends Error {
  constructor(executionStopped, reason, cleanupDetail) {
    super(cleanupDetail ?? "Native creation was cancelled.", { cause: reason });
    this.executionStopped = executionStopped;
    this.reason = reason;
    this.cleanupDetail = cleanupDetail;
    this.name = "DshAgentCreationCancelled";
  }
};

// src/framework/native-executions.ts
var nativeRole = { Foreground: "foreground", Organizer: "organizer", Planner: "planner", Worker: "worker", Recorder: "recorder", Helper: "helper" };
function pendingNativeStopJobs(owner, events, knownJobs = []) {
  const jobs = new Set(knownJobs);
  for (const event of events) {
    if (event.type === "job/registered" && event.data.owner === owner) jobs.add(event.data.jobId);
    if (event.type === "job/settled" && event.data.owner === owner) {
      if (event.data.producerReported === true) jobs.delete(event.data.jobId);
      else jobs.add(event.data.jobId);
    }
  }
  return [...jobs].sort();
}
var NativeExecutions = class {
  constructor(ctx, gateway, observations, evidence) {
    this.ctx = ctx;
    this.gateway = gateway;
    this.observations = observations;
    this.evidence = evidence;
  }
  openings = /* @__PURE__ */ new Map();
  unconfirmedOpenings = /* @__PURE__ */ new Map();
  executions = /* @__PURE__ */ new Map();
  operations = /* @__PURE__ */ new Map();
  serial(workId, operation) {
    const result = (this.operations.get(workId) ?? Promise.resolve()).catch(() => {
    }).then(operation);
    this.operations.set(workId, result);
    void result.finally(() => {
      if (this.operations.get(workId) === result) this.operations.delete(workId);
    }).catch(() => {
    });
    return result;
  }
  open(identity2, request) {
    return this.serial(identity2.workId, async () => {
      const unresolved = this.unconfirmedOpenings.get(identity2.workId);
      if (unresolved) throw new Error(unresolved.result?.status === "unconfirmed" ? unresolved.result.reason : "Prior native creation stop is unconfirmed.");
      const current = this.executions.get(identity2.workId);
      if (current) {
        if (current.unconfirmed) throw new Error(current.unconfirmed);
        if (current.identity.executionId === identity2.executionId) return current.agent;
        throw new Error("Stop the owned execution before opening its replacement.");
      }
      const controller = new AbortController();
      let finishOpening;
      const settled = new Promise((resolve2) => {
        finishOpening = resolve2;
      });
      const opening = { identity: { ...identity2 }, sessionId: request.sessionId, controller, settled };
      this.openings.set(identity2.workId, opening);
      const externalAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", externalAbort, { once: true });
      if (request.signal?.aborted) externalAbort();
      let agent;
      try {
        agent = await this.gateway.create({ ...request, signal: controller.signal, role: nativeRole[identity2.role] });
      } catch (error) {
        if (controller.signal.aborted) {
          opening.result = error instanceof DshAgentCreationCancelled && error.executionStopped ? { status: "stopped" } : { status: "unconfirmed", reason: error instanceof Error ? error.message : String(error), jobs: [] };
          opening.detail = error instanceof Error ? error.message : String(error);
          this.unconfirmedOpenings.set(identity2.workId, opening);
        }
        throw error;
      } finally {
        request.signal?.removeEventListener("abort", externalAbort);
        if (this.openings.get(identity2.workId) === opening) this.openings.delete(identity2.workId);
        finishOpening();
      }
      const execution = { identity: { ...identity2 }, agent, stopping: false, unsettled: /* @__PURE__ */ new Set() };
      this.executions.set(identity2.workId, execution);
      try {
        execution.off = this.ctx.on("session/event", (session, event) => {
          if (session !== agent.actualAgent.session) return;
          if (event.type === "job/registered" && event.data.owner === agent.actualAgent.id) {
            execution.unsettled.add(event.data.jobId);
            execution.stopEvidence?.();
          }
          if (event.type === "job/settled" && event.data.owner === agent.actualAgent.id) {
            if (event.data.producerReported === true) execution.unsettled.delete(event.data.jobId);
            else execution.unsettled.add(event.data.jobId);
            execution.stopEvidence?.();
          }
        });
        await this.observations.bind(identity2, agent);
      } catch (error) {
        const stopped = await this.stopOwned(execution);
        if (stopped.status === "unconfirmed") throw new AggregateError([error, new Error(stopped.reason)], "Execution binding and native cleanup failed");
        throw error;
      }
      return agent;
    });
  }
  get(workId) {
    return this.executions.get(workId)?.agent;
  }
  /** Abort only the matching admission out of band, then join its actual factory/cleanup. */
  cancelOpening(workId, executionId, reason = new Error("Owned native creation cancelled.")) {
    const opening = this.openings.get(workId) ?? this.unconfirmedOpenings.get(workId);
    if (!opening || opening.identity.executionId !== executionId) return Promise.resolve({ status: "superseded" });
    if (opening.cancellation) return opening.cancellation;
    const cancel = async () => {
      const evidence = (phase, detail) => this.evidence?.save({
        workId,
        executionId,
        agentId: opening.sessionId,
        sessionId: opening.sessionId,
        jobs: [],
        phase,
        ...detail ? { reason: detail } : {}
      });
      try {
        if (this.evidence) await evidence("stopping");
        opening.controller.abort(reason);
        await opening.settled;
        const current = this.executions.get(workId);
        if (current?.identity.executionId === executionId) return await this.serial(workId, () => this.stopOwned(current));
        const result2 = opening.result ?? { status: "unconfirmed", reason: "Native creation cancellation has no quiescence evidence.", jobs: [] };
        if (result2.status === "stopped") {
          if (this.evidence) await evidence("disposed", opening.detail);
          this.unconfirmedOpenings.delete(workId);
        }
        return result2;
      } catch (error) {
        const result2 = { status: "unconfirmed", reason: error instanceof Error ? error.message : String(error), jobs: [] };
        this.unconfirmedOpenings.set(workId, opening);
        return result2;
      }
    };
    const result = cancel();
    opening.cancellation = result;
    void result.finally(() => {
      if (opening.cancellation === result) opening.cancellation = void 0;
    }).catch(() => {
    });
    return result;
  }
  stop(workId, executionId, recoveryAction) {
    const opening = this.openings.get(workId) ?? this.unconfirmedOpenings.get(workId);
    if (opening?.identity.executionId === executionId) {
      if (recoveryAction) return this.observations.mayApply(recoveryAction).then((applicable) => applicable ? this.cancelOpening(workId, executionId) : { status: "superseded" });
      return this.cancelOpening(workId, executionId);
    }
    return this.serial(workId, async () => {
      const current = this.executions.get(workId);
      if (!current || current.identity.executionId !== executionId) return { status: "superseded" };
      return this.stopOwned(current, recoveryAction);
    });
  }
  async stopOwned(current, recoveryAction) {
    const { workId, executionId } = current.identity;
    if (recoveryAction && !await this.observations.mayApply(recoveryAction)) return { status: "superseded" };
    current.stopping = true;
    const agent = current.agent.actualAgent;
    const unsettled = current.unsettled;
    const reconcileHistory = () => {
      const known = [...unsettled, ...current.agent.observe().jobs.filter((job) => job.owner === agent.id && (job.status === "running" || job.status === "stopping")).map((job) => String(job.id))];
      const recovered = pendingNativeStopJobs(String(agent.id), agent.session.snapshotEvents(), known);
      unsettled.clear();
      for (const id of recovered) unsettled.add(id);
    };
    const save = (phase, reason) => this.evidence?.save({
      workId,
      executionId,
      agentId: String(agent.id),
      sessionId: current.agent.sessionId ?? String(agent.id),
      jobs: [...unsettled].sort(),
      phase,
      ...reason === void 0 ? {} : { reason }
    }) ?? Promise.resolve();
    let updates = Promise.resolve(), persistenceFailure;
    const queueEvidence = () => {
      const value = {
        workId,
        executionId,
        agentId: String(agent.id),
        sessionId: current.agent.sessionId ?? String(agent.id),
        jobs: [...unsettled].sort(),
        phase: "stopping"
      };
      updates = updates.then(async () => {
        await this.evidence?.save(value);
      }).catch((error) => {
        persistenceFailure = error;
      });
    };
    const off = () => {
      current.off?.();
      current.off = void 0;
    };
    current.stopEvidence = queueEvidence;
    try {
      reconcileHistory();
      queueEvidence();
      await updates;
      if (persistenceFailure !== void 0) throw persistenceFailure;
      await this.observations.unbind(workId, executionId);
      await current.agent.dispose();
      off();
      await updates;
      if (persistenceFailure !== void 0) throw persistenceFailure;
      reconcileHistory();
      if (unsettled.size) {
        current.unconfirmed = "Native teardown did not confirm producer settlement for owned jobs.";
        await save("stopping", current.unconfirmed);
        return { status: "unconfirmed", reason: current.unconfirmed, jobs: [...unsettled] };
      }
      await save("disposed");
      this.executions.delete(workId);
      return { status: "stopped" };
    } catch (error) {
      off();
      await updates;
      current.unconfirmed = error instanceof Error ? error.message : String(error);
      return { status: "unconfirmed", reason: current.unconfirmed, jobs: [...unsettled] };
    } finally {
      current.stopEvidence = void 0;
      off();
      current.stopping = false;
    }
  }
};

// src/adapters/dsh/workspace.ts
import { WorkspaceId } from "@deepseek-ai/dsh-workspace";
var DshWorkspaceAdapter = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  list() {
    return this.ctx.workspaceRegistry.list().map((workspace) => ({ id: workspace.id, directory: workspace.path, title: workspace.title }));
  }
  async resolve(selectedId, customDirectory) {
    const registry = this.ctx.workspaceRegistry;
    if (customDirectory !== void 0) {
      if (selectedId !== void 0) throw new Error("Select a registered workspace or a custom directory, not both.");
      const selected = await registry.create(customDirectory.trim());
      return { id: selected.id, directory: selected.path };
    }
    if (selectedId !== void 0 && selectedId.length > 0) {
      const selected = registry.get(WorkspaceId(selectedId));
      if (selected === void 0) throw new Error(`The selected Servant workspace no longer exists: ${selectedId}`);
      return { id: selected.id, directory: selected.path };
    }
    const directory = this.ctx.get("workingDirectory")?.defaultDirectory;
    const existingDefault = await registry.initializeDefault(async () => {
      if (directory === void 0) throw new Error("DSH has no default workspace or default working directory. Select a Servant workspace.");
      return directory;
    });
    if (existingDefault !== void 0) return { id: existingDefault.id, directory: existingDefault.path };
    if (directory === void 0) throw new Error("DSH has no default workspace or default working directory. Select a Servant workspace.");
    const fallback = await registry.resolveByPath(directory) ?? await registry.create(directory);
    return { id: fallback.id, directory: fallback.path };
  }
};

// src/framework/connection.ts
import { createHash as createHash19 } from "node:crypto";

// src/experimental/private-git/contracts.ts
import { z as z2 } from "zod";
import { posix } from "node:path";
var RepositoryDirectorySchema = z2.string().trim().default("dss-coop").transform((value) => posix.normalize(value.replace(/\\/g, "/")).replace(/^\/+|\/+$/g, "")).transform((value) => value === "." ? "" : value).refine((value) => !/[\0\r\n]/.test(value) && value !== ".." && !value.startsWith("../"), "Use a directory inside the Git repository.");
var CoopSettingsSchema = z2.object({
  ownerRepo: z2.string().default(""),
  repositoryDirectory: RepositoryDirectorySchema,
  remoteEnabled: z2.boolean().default(false),
  workerSeats: z2.int().positive().default(2),
  workspace: z2.string().default(""),
  presetId: z2.string().default("standard"),
  provider: z2.string().optional(),
  model: z2.string().optional(),
  reasoningEffort: z2.string().optional()
});
var ForegroundProfileSchema = z2.object({ workspace: z2.string(), presetId: z2.string(), provider: z2.string().optional(), model: z2.string().optional(), reasoningEffort: z2.string().optional() });

// src/experimental/private-git/credentials.ts
import { execFile } from "node:child_process";
async function ghToken(signal) {
  signal?.throwIfAborted();
  return new Promise((resolve2, reject) => {
    execFile("gh", ["auth", "token", "--hostname", "github.com"], { signal, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error?.name === "AbortError") {
        reject(error);
        return;
      }
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      resolve2(error ? void 0 : stdout.trim() || void 0);
    });
  });
}
var CoopCredentials = class {
  constructor(cli = ghToken) {
    this.cli = cli;
  }
  async resolve(signal) {
    signal?.throwIfAborted();
    const value = await this.cli(signal);
    signal?.throwIfAborted();
    if (!value) throw new GitHubError(401, GITHUB_CLI_SETUP_REQUIRED);
    return { value, source: "GitHub CLI" };
  }
};

// src/framework/command-transactions.ts
import { createHash as createHash17 } from "node:crypto";
var hash7 = (text) => createHash17("sha256").update(text).digest("hex");
var FrameworkTransactions = class {
  constructor(files, records, scope) {
    this.files = files;
    this.records = records;
    this.prefix = "framework-commands/" + hash7(scope) + "/";
  }
  pending = /* @__PURE__ */ new Map();
  prefix;
  /** Read only the acknowledgement this command already persisted. This does
   * not resolve an UNKNOWN operation or validate the caller's saved content. */
  async confirmed(id, request) {
    const requestHash = hash7(JSON.stringify(request)), active = this.pending.get(id);
    if (active && active.hash !== requestHash) throw new Error("A native command identity cannot be reused with different arguments.");
    const record = await this.records.get(this.prefix + hash7(id));
    if (record && record.requestHash !== requestHash) throw new Error("A native command identity cannot be reused with different arguments.");
    return record?.receipt ? { ...record.receipt } : void 0;
  }
  run(id, request, options, build) {
    const requestHash = hash7(JSON.stringify(request));
    const active = this.pending.get(id);
    if (active) return active.hash === requestHash ? active.promise : Promise.reject(new Error("A native command identity cannot be reused with different arguments."));
    const operation = this.execute(id, request, options, build);
    this.pending.set(id, { hash: requestHash, promise: operation });
    void operation.finally(() => {
      if (this.pending.get(id)?.promise === operation) this.pending.delete(id);
    }).catch(() => {
    });
    return operation;
  }
  async execute(id, request, options, build) {
    const key = this.prefix + hash7(id), requestHash = hash7(JSON.stringify(request));
    let record = await this.records.get(key);
    if (record && record.requestHash !== requestHash) throw new Error("A native command identity cannot be reused with different arguments.");
    if (record?.receipt) return { ...record.receipt, replay: true };
    if (record?.conflicted && options.reevaluate) record = void 0;
    if (record?.operationId && this.files instanceof GitFiles) {
      const resolution = await this.files.resolve(record.operationId);
      if (resolution.status === "confirmed") {
        const receipt = { revision: resolution.commit, replay: true, operationId: record.operationId };
        await this.records.set(key, { ...record, receipt: { ...receipt } });
        if (resolution.verifiedWrites) Object.defineProperty(receipt, "verifiedWrites", { value: resolution.verifiedWrites });
        return receipt;
      }
      if (resolution.status === "unknown") throw new FilesOutcomeUnknownError(record.operationId);
      if (resolution.status === "conflict") {
        await this.records.set(key, { ...record, conflicted: true });
        if (options.reevaluate) record = void 0;
        else throw new FilesConflictError(record.expectedRevision);
      }
    }
    const ownedSnapshot = !options.snapshot || !!record;
    const snapshot = record?.operationId && this.files instanceof GitFiles ? await this.files.at(record.expectedRevision) : record ? await this.files.snapshot() : options.snapshot ?? await this.files.snapshot();
    try {
      const receiptPath = "technical/transaction-receipts/" + hash7(id) + ".json";
      const existing = await this.files.read(snapshot, receiptPath);
      if (existing !== void 0) {
        const saved = JSON.parse(existing);
        if (saved.requestHash !== requestHash) throw new Error("Stored command receipt does not match its arguments.");
        const receipt2 = { revision: snapshot.revision, replay: true };
        await this.records.set(key, { ...record ?? { id, requestHash, expectedRevision: snapshot.revision }, receipt: receipt2 });
        return receipt2;
      }
      if (options.expectedRevision && snapshot.revision !== options.expectedRevision || record && snapshot.revision !== record.expectedRevision) throw new FilesConflictError(record?.expectedRevision ?? options.expectedRevision);
      if (!record) {
        record = { id, requestHash, expectedRevision: snapshot.revision };
        await this.records.set(key, record);
      }
      const changes = await build(snapshot);
      if (!changes.length) {
        const receipt2 = { revision: snapshot.revision, replay: false };
        await this.records.set(key, { ...record, receipt: receipt2 });
        return receipt2;
      }
      const combined = this.files instanceof GitFiles ? changes : [...changes, { path: receiptPath, content: JSON.stringify({ requestHash }) + "\n" }];
      const message = "DSS command " + hash7(id);
      if (this.files instanceof GitFiles && !record.operationId) {
        const prepared = await this.files.prepare(snapshot, combined, message);
        record = { ...record, operationId: prepared.id };
        await this.records.set(key, record);
      }
      const receipt = this.files instanceof GitFiles ? await this.files.commitPrepared(snapshot, combined, message, record.operationId) : await this.files.commit(snapshot, combined, message);
      const { verifiedWrites: _liveVerification, ...persistedReceipt } = receipt;
      await this.records.set(key, { ...record, receipt: persistedReceipt });
      return receipt;
    } catch (error) {
      if (error instanceof FilesConflictError && record) await this.records.set(key, { ...record, conflicted: true });
      throw error;
    } finally {
      if (ownedSnapshot) await snapshot.release();
    }
  }
};

// src/framework/instances.ts
import { createHash as createHash18, randomUUID as randomUUID6 } from "node:crypto";
var HEARTBEAT_INTERVAL_MS = 3e4;
var HEARTBEAT_OFFLINE_MS = 18e4;
var InstanceAccountError = class extends Error {
  constructor(code) {
    super(code === "account-changed" ? "account-changed: this Host instance registration belongs to a different Git account; preserve its alias, UUID and pending operations and reconnect with the original account." : "account-unverified: this existing Host instance has no saved Git account identity; preserve its records for explicit identity reconciliation rather than guessing from its alias.");
    this.code = code;
    this.name = "InstanceAccountError";
  }
};
var hash8 = (value) => createHash18("sha256").update(value).digest("hex");
var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var uuidCreations = /* @__PURE__ */ new WeakMap();
function loadOrCreateInstanceUuid(storage) {
  const existing = uuidCreations.get(storage);
  if (existing) return existing;
  const operation = (async () => {
    const key = "framework-instance-uuid";
    const saved = await storage.get(key);
    if (saved) {
      if (!uuidPattern.test(saved)) throw new Error("Stored instance UUID is invalid.");
      return saved;
    }
    const id = randomUUID6();
    await storage.set(key, id);
    return id;
  })();
  uuidCreations.set(storage, operation);
  void operation.finally(() => {
    if (uuidCreations.get(storage) === operation) uuidCreations.delete(storage);
  }).catch(() => {
  });
  return operation;
}
var validMember = (value) => value.length > 0 && !/[\\/\0\r\n]/.test(value) && value !== "." && value !== "..";
function parseInstancePath(path3) {
  const match = /^instances\/([^/]+)_Workers(\d+)_([0-9a-f-]+)\.json$/i.exec(path3);
  if (!match || !validMember(match[1]) || !uuidPattern.test(match[3])) return;
  const workerSeats = Number(match[2]);
  if (!Number.isSafeInteger(workerSeats) || workerSeats < 0) return;
  return { member: match[1], workerSeats, instanceUUID: match[3], path: path3 };
}
function heartbeat(text) {
  const value = JSON.parse(text);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isFinite(Date.parse(value.updatedAt)) || !["running", "stopped"].includes(value.status)) throw new Error("Invalid instance heartbeat.");
  return value;
}
var InstanceRegistration = class {
  constructor(files, transactions, storage, config, now = Date.now) {
    this.files = files;
    this.transactions = transactions;
    this.storage = storage;
    this.config = config;
    this.now = now;
    if (!uuidPattern.test(config.instanceUUID) || !validMember(config.login)) throw new Error("Use the actual login and complete instance UUID.");
    if (!Number.isSafeInteger(config.workerSeats) || config.workerSeats < 0) throw new Error("Worker seats must be a nonnegative integer.");
    if (config.accountId !== void 0 && (typeof config.accountId === "number" ? !Number.isSafeInteger(config.accountId) || config.accountId <= 0 : !config.accountId.trim())) throw new Error("Use the actual Git account ID.");
    this.key = "framework-instance/" + hash8(config.repositoryId + ":" + config.instanceUUID);
  }
  key;
  stopped = false;
  observations = /* @__PURE__ */ new Map();
  // Only parsed heartbeat observations, scoped to this registration. Immutable
  // file versions avoid rereading unchanged signals; elapsed time still advances.
  heartbeatObservations = /* @__PURE__ */ new Map();
  interrupted = false;
  tail = Promise.resolve();
  assertAccount(saved, remoteOwn = false, ownAliases = []) {
    if (this.config.accountId === void 0) return;
    if (saved?.accountId !== void 0) {
      if (String(saved.accountId) !== String(this.config.accountId)) throw new InstanceAccountError("account-changed");
      const owner = this.config.repositoryOwner.toLowerCase();
      if (this.config.login.toLowerCase() !== owner && [saved.member, saved.pending?.registration.member, ...ownAliases].some((member) => member?.toLowerCase() === owner)) {
        throw new Error("instance-owner-name-conflict: this authenticated invited instance already occupies the repository owner name; preserve its alias, UUID and pending operations for identity reconciliation.");
      }
    } else if (saved?.member || saved?.pending || (saved?.sequence ?? 0) > 0 || remoteOwn) {
      throw new InstanceAccountError("account-unverified");
    }
  }
  /** Read-only preflight for connection setup: must run BEFORE an empty Git
   * branch can be initialized. Known mismatches require no remote writes or
   * identity guesses; absent local binding may inspect only instance metadata. */
  async assertAccountIdentity() {
    if (this.config.accountId === void 0) return;
    const saved = await this.storage.get(this.key);
    this.assertAccount(saved);
    if (saved?.accountId !== void 0) return;
    await withSnapshot(this.files, async (snapshot) => {
      const own = (await this.files.listDirectory(snapshot, "instances/")).some((entry) => parseInstancePath(entry.path)?.instanceUUID === this.config.instanceUUID);
      this.assertAccount(saved, own);
    });
  }
  serial(operation) {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {
    }, () => {
    });
    return result;
  }
  registration(member) {
    const { instanceUUID, workerSeats, repositoryOwner, login } = this.config;
    return {
      member,
      instanceUUID,
      workerSeats,
      path: `instances/${member}_Workers${workerSeats}_${instanceUUID}.json`,
      primary: login.toLowerCase() === repositoryOwner.toLowerCase() && member.toLowerCase() === login.toLowerCase()
    };
  }
  async rows(snapshot, signal) {
    const rows = [];
    const current = /* @__PURE__ */ new Map();
    const entries = await this.files.listDirectory(snapshot, "instances/");
    await this.files.prefetch?.(snapshot, { signal, isolatePathErrors: true, files: entries.filter((entry) => parseInstancePath(entry.path) && this.heartbeatObservations.get(entry.path)?.version !== entry.version).map((entry) => entry.path) });
    for (const entry of entries) {
      const registration = parseInstancePath(entry.path);
      if (!registration) continue;
      let observed = this.heartbeatObservations.get(entry.path);
      if (observed?.version !== entry.version) {
        const body = await this.files.read(snapshot, entry.path);
        if (body === void 0) continue;
        try {
          observed = { version: entry.version, heartbeat: heartbeat(body) };
        } catch {
          observed = { version: entry.version, error: "Invalid heartbeat record: " + entry.path };
        }
      }
      current.set(entry.path, observed);
      rows.push({
        registration,
        ...observed.heartbeat ? { heartbeat: { ...observed.heartbeat } } : {},
        ...observed.error ? { error: observed.error } : {}
      });
    }
    this.heartbeatObservations = current;
    return rows;
  }
  async publishRunning(signal, reevaluateConflict = false) {
    signal?.throwIfAborted();
    await this.assertAccountIdentity();
    const prior = await this.storage.get(this.key);
    const result = await this.publish("running", signal, reevaluateConflict);
    if (prior?.pending) {
      const resolvedStop = prior.pending.heartbeat.status !== "running" && (await this.storage.get(this.key))?.sequence === prior.pending.heartbeat.sequence;
      if (resolvedStop || result.workerSeats !== this.config.workerSeats) return this.publish("running", signal, reevaluateConflict);
    }
    signal?.throwIfAborted();
    return result;
  }
  register(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.stopped = false;
    return this.serial(() => this.publishRunning(signal, true));
  }
  updateWorkerSeats(workerSeats) {
    if (!Number.isSafeInteger(workerSeats) || workerSeats < 0) return Promise.reject(new Error("Worker seats must be a nonnegative integer."));
    return this.serial(async () => {
      if (this.stopped) throw new Error("Instance registration is stopped.");
      this.config.workerSeats = workerSeats;
      return this.publishRunning();
    });
  }
  tick() {
    return this.serial(async () => {
      if (this.stopped) return;
      const saved = await this.storage.get(this.key);
      this.assertAccount(saved);
      if (!saved?.pending && saved?.lastPublishedAt !== void 0 && this.now() - saved.lastPublishedAt < HEARTBEAT_INTERVAL_MS) return;
      return this.publish("running");
    });
  }
  async disconnect() {
    this.stopped = true;
    await this.serial(async () => {
      const saved = await this.storage.get(this.key);
      this.assertAccount(saved);
      if (!saved?.member && !saved?.pending) return;
      if (saved.pending) await this.publish(saved.pending.heartbeat.status);
      await this.publish("stopped");
    });
  }
  async publish(status, signal, reevaluateConflict = false) {
    for (; ; ) {
      signal?.throwIfAborted();
      await this.assertAccountIdentity();
      signal?.throwIfAborted();
      let saved = await this.storage.get(this.key) ?? { sequence: 0 };
      signal?.throwIfAborted();
      this.assertAccount(saved);
      let publicationConflict;
      const dispatchPrepared = async (snapshot) => {
        const prepared2 = saved.pending;
        signal?.throwIfAborted();
        try {
          return await this.transactions.run(
            "heartbeat:" + prepared2.id,
            prepared2,
            { expectedRevision: prepared2.revision, ...snapshot ? { snapshot } : {} },
            async () => {
              signal?.throwIfAborted();
              const changes = prepared2.previousPaths.map((path3) => ({ path: path3, content: null }));
              changes.push({ path: prepared2.registration.path, content: JSON.stringify(prepared2.heartbeat) + "\n" });
              return changes;
            }
          );
        } catch (error) {
          if (error instanceof FilesConflictError) publicationConflict = error;
          throw error;
        }
      };
      try {
        if (!saved.pending) {
          await withSnapshot(this.files, async (snapshot) => {
            signal?.throwIfAborted();
            const entries = await this.files.listDirectory(snapshot, "instances/");
            const registrations = entries.map((entry) => parseInstancePath(entry.path)).filter((entry) => entry !== void 0);
            this.assertAccount(
              saved,
              registrations.some((row) => row.instanceUUID === this.config.instanceUUID),
              registrations.filter((row) => row.instanceUUID === this.config.instanceUUID).map((row) => row.member)
            );
            const own = [];
            for (const registration2 of registrations.filter((row) => row.instanceUUID === this.config.instanceUUID)) {
              const entry = entries.find((entry2) => entry2.path === registration2.path);
              const observed = this.heartbeatObservations.get(entry.path);
              if (observed?.version === entry.version && observed.heartbeat) {
                own.push({ registration: registration2, heartbeat: observed.heartbeat });
              } else {
                const body = await this.files.read(snapshot, registration2.path);
                if (body !== void 0) own.push({ registration: registration2, heartbeat: heartbeat(body) });
              }
            }
            const occupied = new Set(registrations.filter((row) => row.instanceUUID !== this.config.instanceUUID).map((row) => row.member.toLowerCase()));
            let member = saved.member ?? own[0]?.registration.member;
            if (member && occupied.has(member.toLowerCase())) throw new Error("The saved instance name belongs to another instance; inspect the registration.");
            if (!member) {
              member = this.config.login;
              let suffix = 0;
              const owner = this.config.repositoryOwner.toLowerCase();
              const invited = this.config.login.toLowerCase() !== owner;
              while (occupied.has(member.toLowerCase()) || invited && member.toLowerCase() === owner) {
                member = this.config.login + ++suffix;
              }
            }
            const previous = Math.max(saved.sequence, ...own.map((row) => row.heartbeat.sequence));
            if (previous >= Number.MAX_SAFE_INTEGER) throw new Error("Heartbeat sequence exceeds the supported JSON integer range.");
            const registration = this.registration(member);
            saved = { ...saved, ...this.config.accountId === void 0 ? {} : { accountId: String(this.config.accountId) }, sequence: previous + 1, pending: {
              id: randomUUID6(),
              revision: snapshot.revision,
              registration,
              heartbeat: { sequence: previous + 1, updatedAt: new Date(this.now()).toISOString(), status },
              previousPaths: own.filter((row) => row.registration.path !== registration.path).map((row) => row.registration.path)
            } };
            signal?.throwIfAborted();
            await this.storage.set(this.key, saved);
            await dispatchPrepared(snapshot);
          });
        } else {
          await dispatchPrepared();
        }
      } catch (error) {
        if (error === publicationConflict && publicationConflict !== void 0) {
          const { pending: _pending, ...rest } = saved;
          await this.storage.set(this.key, rest);
          if (reevaluateConflict) {
            signal?.throwIfAborted();
            const current = await withSnapshot(this.files, async (snapshot) => snapshot.revision);
            signal?.throwIfAborted();
            if (current !== publicationConflict.expectedRevision) continue;
          }
        }
        throw error;
      }
      const prepared = saved.pending;
      signal?.throwIfAborted();
      await withSnapshot(this.files, async (snapshot) => {
        const body = await this.files.read(snapshot, prepared.registration.path);
        const confirmed = body === void 0 ? void 0 : heartbeat(body);
        if (confirmed === void 0 || JSON.stringify(confirmed) !== JSON.stringify(prepared.heartbeat)) {
          throw new Error("Instance heartbeat read-back differs; preserve the pending publication for inspection.");
        }
        const entry = (await this.files.listDirectory(snapshot, "instances/")).find((row) => row.path === prepared.registration.path);
        if (entry) this.heartbeatObservations.set(entry.path, { version: entry.version, heartbeat: confirmed });
      });
      signal?.throwIfAborted();
      await this.storage.set(this.key, { ...saved.accountId === void 0 ? {} : { accountId: saved.accountId }, member: prepared.registration.member, sequence: saved.sequence, lastPublishedAt: this.now() });
      signal?.throwIfAborted();
      return prepared.registration;
    }
  }
  /** Losing observation continuity discards time-based claims, not remote records. */
  observationInterrupted() {
    this.interrupted = true;
  }
  async observe(borrowed, signal) {
    try {
      const inspect = async (snapshot) => {
        const rows = await this.rows(snapshot, signal), now = this.now();
        if (this.interrupted) {
          for (const [id, observed] of this.observations) this.observations.set(id, { ...observed, advancedAt: now, confirmed: false });
        }
        this.interrupted = false;
        const output = [];
        for (const row of rows) {
          const primary = row.registration.member.toLowerCase() === this.config.repositoryOwner.toLowerCase();
          if (!row.heartbeat) {
            output.push({ ...row.registration, primary, availability: "unknown", error: row.error });
            continue;
          }
          const id = row.registration.instanceUUID, prior = this.observations.get(id), current = row.heartbeat;
          let observed = prior;
          if (!prior) observed = { sequence: current.sequence, advancedAt: now, confirmed: false, status: current.status };
          else if (current.sequence > prior.sequence) observed = { sequence: current.sequence, advancedAt: now, confirmed: true, status: current.status };
          this.observations.set(id, observed);
          const availability = observed.status === "stopped" ? "stopped" : now - observed.advancedAt >= HEARTBEAT_OFFLINE_MS ? "offline" : observed.confirmed ? "online" : "unknown";
          output.push({
            ...row.registration,
            primary: row.registration.member.toLowerCase() === this.config.repositoryOwner.toLowerCase(),
            heartbeat: current,
            availability
          });
        }
        return output;
      };
      return await (borrowed ? inspect(borrowed) : withSnapshot(this.files, inspect));
    } catch (error) {
      this.interrupted = true;
      throw error;
    }
  }
};

// src/framework/connection.ts
var digest6 = (value) => createHash19("sha256").update(value).digest("hex");
function operations(storage, scope) {
  const prefix = "framework-git-operations/" + digest6(scope) + "/";
  return {
    save: (record) => storage.set(prefix + record.operation.id, record),
    get: (id) => storage.get(prefix + id),
    list: async () => (await storage.list(prefix)).map((row) => row.value)
  };
}
async function openFrameworkStorage(input, dependencies) {
  const { storage } = dependencies;
  dependencies.signal?.throwIfAborted();
  const settings = input.mode === "git" ? { ...input, repositoryDirectory: RepositoryDirectorySchema.parse(input.repositoryDirectory) } : { ...input };
  if (!Number.isSafeInteger(settings.workerSeats) || settings.workerSeats < 0) throw new Error("Worker seats must be a nonnegative integer.");
  const instanceUUID = await loadOrCreateInstanceUuid(storage);
  dependencies.signal?.throwIfAborted();
  let invite, gitMembers, gitMemberAction;
  let release;
  let cancelPending = (_reason) => {
  };
  try {
    let files, scope, login, owner, repositoryId;
    let repository;
    let initializeWrite;
    if (settings.mode === "local") {
      if (!settings.directory.trim()) throw new Error("Choose the local DSS storage directory.");
      const locations = new LocalLocationRegistry(storage);
      const canonical2 = await canonicalLocalLocation(settings.directory, true);
      await locations.resolve(canonical2);
      dependencies.signal?.throwIfAborted();
      const local = await LocalFiles.open(settings.directory);
      release = () => local.close();
      files = local;
      scope = await locations.resolve(local.directory);
      repositoryId = scope;
      const label = settings.login;
      login = owner = label && !/[\\/\0\r\n]/.test(label) && label !== "." && label !== ".." ? label : "local-" + instanceUUID;
    } else {
      const credentials = dependencies.credentials ?? new CoopCredentials();
      const client = new GitHubClient((signal) => credentials.resolve(signal), dependencies.fetch, { signal: dependencies.signal });
      let binding = { ownerRepo: settings.ownerRepo, repositoryDirectory: settings.repositoryDirectory };
      const remote = new GitHubRepository(client, () => binding);
      release = () => remote.releaseCache();
      cancelPending = (reason) => remote.cancel(reason);
      repository = await remote.connect();
      dependencies.signal?.throwIfAborted();
      binding = {
        ...binding,
        ownerRepo: repository.repository.fullName,
        repositoryId: repository.repository.id,
        participantId: repository.identity.id,
        branch: repository.repository.branch
      };
      scope = JSON.stringify(["git", repository.repository.id, repository.repository.branch, settings.repositoryDirectory]);
      const members = new GitHubMembers(client, () => binding);
      const expected = { expectedRepositoryId: repository.repository.id, expectedParticipantId: repository.identity.id };
      invite = (username) => members.invite(username, expected);
      gitMembers = async () => {
        const [invitations, collaborators] = await Promise.all([members.invitations(expected), members.collaborators(expected)]);
        return { invitations, collaborators };
      };
      gitMemberAction = (action) => action.action === "cancelInvitation" ? members.cancelInvitation(action.invitationId, expected) : members.remove(action.username, expected);
      repositoryId = scope;
      login = repository.identity.login;
      owner = repository.repository.fullName.split("/")[0];
      initializeWrite = async () => {
        await remote.ensureBranch();
      };
      files = new GitFiles(remote, operations(storage, scope));
    }
    dependencies.signal?.throwIfAborted();
    await storage.set("framework-connection-settings/" + digest6(scope), settings);
    dependencies.signal?.throwIfAborted();
    const transactions = new FrameworkTransactions(files, storage, scope);
    let closed = false, closing, preparing;
    const assertOpen = () => {
      if (closed) throw new Error("Framework storage is closed.");
    };
    return {
      files,
      transactions,
      scope,
      repository,
      invite,
      gitMembers,
      gitMemberAction,
      cancelPending,
      identity: { login, owner, instanceUUID, repositoryId },
      prepareWrite: async () => {
        assertOpen();
        if (!preparing) {
          preparing = (async () => {
            await initializeWrite?.();
            assertOpen();
          })();
          void preparing.catch(() => {
            preparing = void 0;
          });
        }
        await preparing;
      },
      close: () => {
        if (!closing) {
          closed = true;
          closing = release();
        }
        return closing;
      }
    };
  } catch (error) {
    await release?.();
    throw error;
  }
}
async function openFrameworkConnection(settings, dependencies) {
  const access = await openFrameworkStorage(settings, dependencies);
  try {
    dependencies.signal?.throwIfAborted();
    const { files, transactions, scope, repository, identity: identity2 } = access;
    const instances = new InstanceRegistration(
      files,
      transactions,
      dependencies.storage,
      {
        ...repository ? { accountId: repository.identity.id } : {},
        repositoryId: identity2.repositoryId,
        repositoryOwner: identity2.owner,
        login: identity2.login,
        instanceUUID: identity2.instanceUUID,
        workerSeats: settings.workerSeats
      },
      dependencies.now
    );
    await instances.assertAccountIdentity();
    dependencies.signal?.throwIfAborted();
    await access.prepareWrite();
    dependencies.signal?.throwIfAborted();
    const principal = (value) => settings.mode === "local" ? { ...value, primary: true } : value;
    let registration = principal(await instances.register(dependencies.signal));
    dependencies.signal?.throwIfAborted();
    let closed = false, closing;
    const assertOpen = () => {
      if (closed) throw new Error("Framework connection is closed.");
    };
    return {
      files,
      transactions,
      cancelPending: (reason) => access.cancelPending(reason),
      get registration() {
        return registration;
      },
      scope,
      repository,
      updateWorkerSeats: async (workerSeats) => {
        assertOpen();
        registration = principal(await instances.updateWorkerSeats(workerSeats));
        return registration;
      },
      members: async (snapshot) => {
        assertOpen();
        const rows = await instances.observe(snapshot);
        return settings.mode === "local" ? rows.map((row) => ({ ...row, primary: row.instanceUUID === identity2.instanceUUID })) : rows;
      },
      tick: async () => {
        assertOpen();
        try {
          const published = await instances.tick();
          if (published) registration = principal(published);
        } catch (error) {
          instances.observationInterrupted();
          throw error;
        }
      },
      observationInterrupted: () => instances.observationInterrupted(),
      close: () => {
        if (!closing) {
          closed = true;
          closing = (async () => {
            try {
              await instances.disconnect();
            } finally {
              await access.close();
            }
          })();
        }
        return closing;
      }
    };
  } catch (error) {
    await access.close();
    throw error;
  }
}

// src/framework/legacy-migration.ts
import { createHash as createHash22 } from "node:crypto";

// src/framework/conversation.ts
import { createHash as createHash20 } from "node:crypto";
var ConversationRecordError = class extends Error {
  constructor(path3, reason, message) {
    super(message);
    this.path = path3;
    this.reason = reason;
    this.name = "ConversationRecordError";
  }
};
var hash9 = (text) => createHash20("sha256").update(text, "utf8").digest("hex");
var json3 = (value) => JSON.stringify(value, null, 2) + "\n";
var segment4 = (value) => {
  filePath(value);
  if (value.includes("/")) throw new Error("Identity must be a single path segment.");
  return value;
};
var emptyIndex = () => ({ version: 1, messages: [] });
var FrameworkConversation = class {
  constructor(files, transactions, scope) {
    this.files = files;
    this.transactions = transactions;
    this.scope = scope;
    const key = encodeURIComponent(segment4(scope.collaborationId));
    this.indexPath = "conversation-index/" + scope.mode + "/" + key + "/index.json";
    this.foregroundRoot = "assistants/collaborations/" + scope.mode + "/" + key;
  }
  indexPath;
  foregroundRoot;
  async index(snapshot) {
    const value = await this.files.read(snapshot, this.indexPath);
    return value === void 0 ? emptyIndex() : JSON.parse(value);
  }
  command(id) {
    return "conversation/" + this.scope.mode + "/" + this.scope.collaborationId + "/" + id;
  }
  /** The caller retains the original draft/id until the receipt is confirmed.
   * No UI AbortSignal is accepted: closing a view does not revoke a durable send.
   */
  send(commandId, message, options = {}) {
    return this.transactions.run(this.command(commandId), { scope: this.scope, message }, options, async (snapshot) => {
      const index = await this.index(snapshot);
      const previous = index.messages.find((entry2) => entry2.id === message.id);
      if (previous) {
        const stored = await this.readAt(snapshot, previous);
        const { username: _username, timezoneOffsetMinutes: _offset, ...body } = message;
        if (json3(stored) !== json3(body)) {
          if (hash9(json3(canonical(stored))) !== hash9(json3(canonical(body)))) throw new ConversationRecordError(previous.path, "identity", "Message identity already has different content.");
        }
        return [];
      }
      const date = new Date(message.createdAt);
      if (!Number.isFinite(date.getTime())) throw new Error("Message createdAt must be a valid timestamp.");
      const root = "conversations/" + (this.scope.mode === "local" ? "local/" : "") + segment4(message.participantId) + "/" + date.toISOString().slice(0, 10) + "/" + message.createdAt.replace(/\D/g, "") + "-" + segment4(message.id);
      const textPath = root + "/text", path3 = root + "/entry.json";
      const { text, username, timezoneOffsetMinutes, ...fields2 } = message;
      if (await this.files.read(snapshot, path3) !== void 0) throw new ConversationRecordError(path3, "identity", "Message path already belongs to another indexed record.");
      const entry = { ...fields2, collaborationId: this.scope.collaborationId, textPath: this.scope.mode === "git" ? "dss-coop/" + textPath : textPath, textHash: hash9(text) };
      const changes = [...textChanges(textPath, text, this.scope.mode === "git"), { path: path3, content: json3(entry) }];
      let notification;
      if (message.role === "user" && message.recipient === "ai") {
        const base = "state/" + foregroundNotification(username ?? message.participantId, date, timezoneOffsetMinutes ?? 0);
        notification = base;
        if (await this.files.read(snapshot, base) !== void 0) notification += "-" + hash9(this.scope.mode + "\0" + this.scope.collaborationId + "\0" + message.id);
        changes.push({ path: notification, content: "" });
      }
      index.messages.push({
        id: message.id,
        path: path3,
        createdAt: message.createdAt,
        role: message.role,
        ...message.replyTo ? { replyTo: message.replyTo } : {},
        ...notification ? { notification } : {}
      });
      changes.push({ path: this.indexPath, content: json3(index) });
      return changes;
    });
  }
  async headerAt(snapshot, indexed) {
    const raw = await this.files.read(snapshot, indexed.path);
    if (raw === void 0) throw new ConversationRecordError(indexed.path, "missing", "Message entry is missing.");
    const entry = JSON.parse(raw);
    if (entry.id !== indexed.id || entry.collaborationId !== void 0 && entry.collaborationId !== this.scope.collaborationId) throw new ConversationRecordError(indexed.path, "identity", "Message reference belongs to a different conversation.");
    return entry;
  }
  async readAt(snapshot, indexed, checkedHeader, checkedText) {
    const entry = checkedHeader ?? await this.headerAt(snapshot, indexed);
    const text = checkedText ?? await readText(this.files, snapshot, entry.textPath);
    if (entry.textHash !== void 0 && hash9(text) !== entry.textHash) throw new ConversationRecordError(entry.textPath, "integrity", "Message body hash differs from entry.");
    const { collaborationId: _scope, textPath: _path, textHash: _hash, ...body } = entry;
    const writer = entry.writer;
    return { ...body, ...body.participantId ? {} : writer?.participantId ? { participantId: writer.participantId } : {}, text };
  }
  /** One-time migration receives explicitly selected legacy entry paths. It does
   * not infer collaboration membership from the currently authenticated account. */
  indexLegacy(commandId, entryPaths, options = {}) {
    return this.transactions.run(this.command(commandId), { scope: this.scope, entryPaths }, options, (snapshot) => this.planLegacyIndex(snapshot, entryPaths));
  }
  /** Composable migration plan; entry/text files may be read through an overlay. */
  async planLegacyIndex(snapshot, entryPaths) {
    const index = await this.index(snapshot);
    for (const path3 of entryPaths) {
      filePath(path3);
      const logicalPath2 = logicalReference(path3);
      const raw = await this.files.read(snapshot, logicalPath2);
      if (raw === void 0) throw new ConversationRecordError(path3, "missing", "Legacy entry is missing.");
      const entry = JSON.parse(raw);
      if (entry.collaborationId !== void 0 && entry.collaborationId !== this.scope.collaborationId) throw new ConversationRecordError(path3, "identity", "Legacy entry belongs to another collaboration.");
      const previous = index.messages.find((item) => item.id === entry.id);
      if (previous && previous.path !== logicalPath2) throw new ConversationRecordError(path3, "identity", "Legacy message identity is ambiguous.");
      if (!previous) {
        const indexed = { id: entry.id, path: logicalPath2 };
        await this.readAt(snapshot, indexed);
        index.messages.push(indexed);
      }
    }
    return [{ path: this.indexPath, content: json3(index) }];
  }
  read(messageId) {
    return withSnapshot(this.files, async (snapshot) => {
      const entry = (await this.index(snapshot)).messages.find((entry2) => entry2.id === messageId);
      return entry ? this.readAt(snapshot, entry) : void 0;
    });
  }
  /** Read only one authoritative message. The known send layout is a demand
   * hint, never the result: index, entry, manifest and original bytes are checked.
   * A fresh snapshot also respects a conversation cleared after a send/replay. */
  readback(messageId, hint, signal) {
    let hinted = [];
    if (hint) {
      const date = new Date(hint.createdAt);
      if (!Number.isFinite(date.getTime())) throw new Error("Message createdAt must be a valid timestamp.");
      const root = "conversations/" + (this.scope.mode === "local" ? "local/" : "") + segment4(hint.participantId) + "/" + date.toISOString().slice(0, 10) + "/" + hint.createdAt.replace(/\D/g, "") + "-" + segment4(messageId);
      hinted = [root + "/entry.json", ...textChanges(root + "/text", hint.text, this.scope.mode === "git").map((change) => change.path)];
    }
    return withSnapshot(this.files, async (snapshot) => {
      signal?.throwIfAborted();
      const index = await this.index(snapshot), entry = index.messages.find((value) => value.id === messageId);
      signal?.throwIfAborted();
      const result = { revision: snapshot.revision, order: index.messages.map((value) => value.id) };
      if (!entry) return result;
      if (this.files.prefetch) await this.files.prefetch(snapshot, { signal, files: [entry.path] });
      signal?.throwIfAborted();
      const header = await this.headerAt(snapshot, entry);
      if (this.files.prefetch) await this.files.prefetch(snapshot, { signal, files: [logicalReference(header.textPath) + "/manifest.json"] });
      const manifest = await readManifest2(this.files, snapshot, header.textPath);
      if (this.files.prefetch) await this.files.prefetch(snapshot, { signal, files: manifest.chunks });
      signal?.throwIfAborted();
      return { ...result, message: await this.readAt(snapshot, entry, header, await readText(this.files, snapshot, header.textPath, manifest)) };
    }, { signal, files: [this.indexPath, ...hinted] });
  }
  /** Explicit search over full originals; excerpts and page sizes do not truncate storage. */
  search(query, cursor = 0, limit = 10) {
    if (!query.trim() || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      return Promise.reject(new Error("Enter a search phrase and valid page size."));
    return withSnapshot(this.files, async (snapshot) => {
      const entries = (await this.index(snapshot)).messages;
      const matches = [];
      let next = cursor;
      for (; next < entries.length && matches.length < limit; next++) {
        const { text, ...header } = await this.readAt(snapshot, entries[next]);
        const found = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
        if (found >= 0) matches.push({ message: { ...header, ref: header.id }, excerpt: text.slice(Math.max(0, found - 100), found + query.length + 160) });
      }
      return { matches, revision: snapshot.revision, ...next < entries.length ? { nextCursor: next } : {} };
    });
  }
  /** Character pagination is opt-in; ordinary message reads still return the full original. */
  readText(ref, cursor = 0, limit = 32768) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 262144)
      return Promise.reject(new Error("Invalid text cursor or page size."));
    return withSnapshot(this.files, async (snapshot) => {
      const entry = (await this.index(snapshot)).messages.find((value) => value.id === ref);
      if (!entry) throw new ConversationRecordError(this.indexPath, "identity", "Conversation reference is absent.");
      const { text, ...header } = await this.readAt(snapshot, entry);
      if (cursor > text.length) throw new Error("Invalid text cursor.");
      const end = Math.min(text.length, cursor + limit);
      return {
        ref,
        message: header,
        text: text.slice(cursor, end),
        cursor,
        characters: text.length,
        revision: snapshot.revision,
        ...end < text.length ? { nextCursor: end } : {}
      };
    });
  }
  /** Caller chooses page size; no product message-length or history limit. */
  page(limit, beforeId, query = {}, borrowed, signal) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Page size must be a positive integer.");
    if (beforeId && query.afterId) throw new Error("Choose one pagination direction.");
    if (query.date && !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) throw new Error("Saved date must use YYYY-MM-DD.");
    const inspect = async (snapshot) => {
      signal?.throwIfAborted();
      const allEntries = (await this.index(snapshot)).messages;
      signal?.throwIfAborted();
      let entries = allEntries;
      if (query.date && (this.scope.mode === "local" || !beforeId && !query.afterId)) {
        const matching = [];
        for (const entry of entries) {
          const at = entry.createdAt ?? (await this.headerAt(snapshot, entry)).createdAt;
          const day = new Date(at).toISOString().slice(0, 10);
          if (this.scope.mode === "local" ? day === query.date : day <= query.date) matching.push(entry);
        }
        entries = matching;
      }
      let start, end;
      if (query.afterId) {
        const index = entries.findIndex((entry) => entry.id === query.afterId);
        if (index < 0) throw new ConversationRecordError(this.indexPath, "identity", "Pagination reference is absent.");
        start = index + 1;
        end = Math.min(entries.length, start + limit);
      } else {
        end = beforeId === void 0 ? entries.length : entries.findIndex((entry) => entry.id === beforeId);
        if (end < 0) throw new ConversationRecordError(this.indexPath, "identity", "Pagination reference is absent.");
        start = Math.max(0, end - limit);
      }
      const selected = entries.slice(start, end);
      let messages;
      if (this.files.prefetch && selected.length) {
        signal?.throwIfAborted();
        await this.files.prefetch(snapshot, { signal, files: selected.map((entry) => entry.path) });
        signal?.throwIfAborted();
        const headers = await Promise.all(selected.map((entry) => this.headerAt(snapshot, entry)));
        signal?.throwIfAborted();
        await this.files.prefetch(snapshot, { signal, files: headers.map((entry) => logicalReference(entry.textPath) + "/manifest.json") });
        signal?.throwIfAborted();
        const manifests = await Promise.all(headers.map((entry) => readManifest2(this.files, snapshot, entry.textPath)));
        signal?.throwIfAborted();
        await this.files.prefetch(snapshot, { signal, files: manifests.flatMap((manifest) => manifest.chunks) });
        signal?.throwIfAborted();
        messages = await Promise.all(selected.map(async (entry, i) => this.readAt(
          snapshot,
          entry,
          headers[i],
          await readText(this.files, snapshot, headers[i].textPath, manifests[i])
        )));
      } else messages = await Promise.all(selected.map((entry) => this.readAt(snapshot, entry)));
      return {
        messages,
        ...start && selected.length ? { moreBefore: selected[0].id } : {},
        ...selected.length && (this.scope.mode === "git" ? allEntries.findIndex((entry) => entry.id === selected[selected.length - 1].id) < allEntries.length - 1 : end < entries.length) ? { moreAfter: selected[selected.length - 1].id } : {},
        revision: snapshot.revision
      };
    };
    return borrowed ? inspect(borrowed) : withSnapshot(this.files, inspect);
  }
  /** Only explicit assistant replies complete an exchange; human discussion and
   * unanswered inputs do not consume the six-exchange context budget. */
  recentExchanges() {
    return withSnapshot(this.files, async (snapshot) => {
      const index = await this.index(snapshot), result = [];
      const selected = /* @__PURE__ */ new Map();
      const byId = new Map(index.messages.map((entry) => [entry.id, entry]));
      for (const indexed of [...index.messages].reverse()) {
        const message = indexed.role ? indexed : await this.headerAt(snapshot, indexed);
        if (message.role !== "assistant" || !message.replyTo) continue;
        const existing = selected.get(message.replyTo);
        if (existing) {
          existing.assistants.unshift(await this.readAt(snapshot, indexed));
          continue;
        }
        if (result.length === 6) continue;
        const humanIndex = byId.get(message.replyTo);
        if (!humanIndex) continue;
        const humanHeader = await this.headerAt(snapshot, humanIndex);
        if (humanHeader.role !== "user") continue;
        const human = await this.readAt(snapshot, humanIndex, humanHeader);
        const assistant = await this.readAt(snapshot, indexed);
        const exchange = { human, assistant, assistants: [assistant] };
        result.unshift(exchange);
        selected.set(human.id, exchange);
      }
      return result;
    });
  }
  readForeground() {
    return withSnapshot(this.files, async (snapshot) => ({
      list: await this.files.read(snapshot, this.foregroundRoot + "/Foreground_List.md") ?? "",
      cache: await this.files.read(snapshot, this.foregroundRoot + "/Foreground_Cache.md") ?? ""
    }));
  }
  memoryChanges(memory) {
    return [{ path: this.foregroundRoot + "/Foreground_List.md", content: memory.list }, { path: this.foregroundRoot + "/Foreground_Cache.md", content: memory.cache }];
  }
  writeForeground(commandId, memory, options = {}) {
    return this.transactions.run(this.command(commandId), { scope: this.scope, memory }, options, async () => this.memoryChanges(memory));
  }
  /** Metadata-only routing prevents generic notification claims from consuming chat. */
  async notificationPaths(snapshot) {
    return (await this.index(snapshot)).messages.filter((entry) => entry.notification && !entry.consumed).map((entry) => entry.notification);
  }
  pendingForeground() {
    return withSnapshot(this.files, async (snapshot) => ({ revision: snapshot.revision, messages: await Promise.all((await this.index(snapshot)).messages.filter((entry) => entry.notification && !entry.consumed).map((entry) => this.readAt(snapshot, entry))) }));
  }
  /** Claim only the reviewed revision, persisting the consumed range and memory
   * atomically with removal of its exact empty notification files. */
  claimForeground(commandId, messageIds, memory, options) {
    if (!options.expectedRevision && !options.snapshot) return Promise.reject(new Error("Foreground claims require the reviewed snapshot revision."));
    return this.transactions.run(this.command(commandId), { scope: this.scope, messageIds, memory }, options, async (snapshot) => {
      const index = await this.index(snapshot), changes = this.memoryChanges(memory);
      for (const id of messageIds) {
        const entry = index.messages.find((entry2) => entry2.id === id);
        if (!entry?.notification) throw new ConversationRecordError(this.indexPath, "identity", "Cannot claim a message without a Foreground notification.");
        if (!entry.consumed) {
          changes.push({ path: entry.notification, content: null });
          entry.consumed = true;
        }
      }
      changes.push({ path: this.indexPath, content: json3(index) });
      return changes;
    });
  }
};
function canonical(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== void 0).sort(([a], [b]) => a.localeCompare(b)));
}
function foregroundNotification(username, date, offsetMinutes) {
  if (!Number.isInteger(offsetMinutes)) throw new Error("Timezone offset is expressed in whole minutes.");
  const local = new Date(date.getTime() + offsetMinutes * 6e4).toISOString();
  const hours = Math.floor(Math.abs(offsetMinutes) / 60), minutes = Math.abs(offsetMinutes) % 60;
  const zone = "GMT" + (offsetMinutes < 0 ? "-" : "") + hours + (minutes ? String(minutes).padStart(2, "0").replace(/^/, "m") : "");
  return "Foreground_" + segment4(username) + "-" + zone + "-" + local.slice(0, 10).replaceAll("-", "") + "-" + local.slice(11, 23).replaceAll(":", "").replace(".", "");
}
function textChanges(path3, text, git) {
  const chunks = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + 65536, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 55296 && last <= 56319) end--;
    chunks.push({ path: path3 + "/parts/" + chunks.length.toString().padStart(6, "0") + ".txt", content: text.slice(start, end) });
    start = end;
  }
  return [...chunks, { path: path3 + "/manifest.json", content: json3({ version: 1, sha256: hash9(text), characters: text.length, chunks: chunks.map((chunk) => git ? "dss-coop/" + chunk.path : chunk.path) }) }];
}
async function readManifest2(files, snapshot, path3) {
  path3 = logicalReference(path3);
  filePath(path3);
  const raw = await files.read(snapshot, path3 + "/manifest.json");
  if (raw === void 0) throw new ConversationRecordError(path3, "missing", "Text manifest is missing.");
  const manifest = JSON.parse(raw);
  if (manifest.version !== 1 || !Array.isArray(manifest.chunks)) throw new ConversationRecordError(path3, "integrity", "Unsupported text manifest.");
  const chunks = manifest.chunks.map((reference) => {
    const chunk = logicalReference(reference);
    filePath(chunk);
    if (!chunk.startsWith(path3 + "/parts/")) throw new ConversationRecordError(chunk, "integrity", "Text chunk is outside its referenced record.");
    return chunk;
  });
  return { ...manifest, chunks };
}
async function readText(files, snapshot, path3, checked) {
  path3 = logicalReference(path3);
  const manifest = checked ?? await readManifest2(files, snapshot, path3);
  const parts = [];
  for (const chunk of manifest.chunks) {
    const part = await files.read(snapshot, chunk);
    if (part === void 0) throw new ConversationRecordError(chunk, "missing", "Text chunk is missing.");
    parts.push(part);
  }
  const text = parts.join("");
  if (text.length !== manifest.characters || hash9(text) !== manifest.sha256) throw new ConversationRecordError(path3, "integrity", "Text manifest integrity mismatch.");
  return text;
}
function logicalReference(path3) {
  return path3.startsWith("dss-coop/") ? path3.slice("dss-coop/".length) : path3;
}

// src/contracts/foreground-memory.ts
import { z as z3 } from "zod";
var ForegroundDocument = z3.enum(["Foreground_List", "Foreground_Cache"]);
var foregroundMemoryGuide = (list, cache, access) => `## Foreground working memory
Two persistent, optional-to-read documents are available:
- Foreground_List: ${list}. A concise index of important user assignments and consequential conversation information. Keep what was asked, its current state, and quick task/conversation/artifact paths with the original source or evidence. Ordinary casual chat does not belong here. Maintain unresolved important commitments across the six-exchange recent-history window. Keep completed items with their final status. Remove entries only when the user requests cleanup. For open items keep useful dates such as last substantive progress or user confirmation, last reminder and next review. During an ordinary Foreground turn, briefly remind about items with no progress for 7 days, at most once per 7 days. At 30 days without substantive progress or user confirmation, explicitly ask whether to continue, keep pending, pause tracking or end it. Honor a user-specified waiting/review date instead. After their answer, update the status and review date accordingly; a reminder alone does not reset the inactivity clock or count as progress. Do not silently cancel or restart an abandoned-looking task. No extra polling or scheduled wake is needed for these conversational reviews.
- Foreground_Cache: ${cache}. Freely editable scratch space for a brief sense of what we have been discussing and what has happened across recent-history rotation. You may revise wording and consolidate duplicate notes while preserving remembered facts and their sources. Keep memory by default. Completion, age, inactivity or a change of topic is not permission to delete it. Remove or clear memory only when the user requests cleanup. There is no word or character quota.
${access}
Only these purposes and references are supplied automatically. Read either document when useful; its body is not preloaded. These notes preserve context, not new user authorization. Keep the user's original records available through their references.`;

// src/framework/role-tools.ts
import { createHash as createHash21, randomUUID as randomUUID7 } from "node:crypto";
import { z as z5 } from "zod";

// src/contracts/schemas.ts
import { z as z4 } from "zod";
var ModelRouteSchema = z4.strictObject({ provider: z4.string().optional(), model: z4.string().optional(), reasoningEffort: z4.string().optional() });
function toolParameters(schema) {
  const json4 = z4.toJSONSchema(schema, { target: "draft-7" });
  const { $schema: _schema, ...parameters } = json4;
  return parameters;
}

// src/framework/role-prompts.ts
var shared = `You are a native DeepSeek Servant role. Use the bound task/member/child identities and the authoritative storage mode supplied by the Host. Task, child, execution and generation identify different things. Preserve original requirements, evidence, long records and source references. Native tools remain available under the user's actual permissions; collaboration access does not grant another computer's tool access.
Use dss_snapshot for a fixed storage view, then read relevant files and pending notifications through that snapshot. Claim ordinary notifications with a meaningful takeover record in the same transaction. Persist current facts and results before checking for later notifications. Before final handoff, consume and process pending work, then recheck. A version conflict requires fresh reads and business re-evaluation, not simply a new commit parent. An uncertain write retains its operation identity; do not create a replacement operation or clear recovery notes on uncertainty.
Read tool results accurately. Submitted, accepted, executing, waiting, failed and complete are distinct. A signal is a pending notification, not proof of business completion. Records describe actual findings and outcomes, not hidden chain-of-thought. Save useful progress at available execution boundaries, approximately every five minutes when there is something meaningful to record; do not fabricate activity, pad notes, interrupt tools merely to write, or treat that suggestion as a deadline.
If a fault needs help, preserve facts and records and request Helper. Ordinary warnings do not themselves establish failure. Follow user-authorized channels and scope. When a task is globally complete it stays closed; new improvements or corrections use its durable results as references in a new task. Member rework before global completion keeps the same task identity.`;
var mechanical = `# Shared runtime rules (AGENTS)
The Host observes this execution's actual native output and tool progress locally. After the first 5 minutes without effective progress it sends a probe; after the next 5 minutes it sends a warning; after a further 30 minutes still without effective progress it stops the old execution, confirms settlement and restarts from the preserved work. Connection keep-alives are not work progress. These are inactivity stages, not a task-duration deadline. Routine probe, warning and restart are Host responsibilities, not reasons to summon another Helper.
When you actually receive a native Host probe or warning, first call dss_reset_observation({probeId}) using the probeId in that input. No text reply is required. This resets only your own current execution's observation cycle; it does not consume or reset the member/Task recovery marker or its check interval. A queued input has not yet been received. Replaying an old reset cannot reset a later cycle or another execution.
After resetting, organize current work, progress, completed actions, blockers and next steps in your own existing Note or bound continuation record, then continue the original work. Do not create an additional proof-of-life file. On restart, read the preserved work and restart reason, check the current state, and continue rather than discarding records or repeating completed effects.
When the Host actually restarts a Planner or Worker in a member/Task chain, it maintains the existing recovery marker at that member/Task location. Further incidents use the same marker, not numbered incident files or per-Worker ACK sets. Only the corresponding Planner consumes it at normal-chain continuation. A direct short task without that member chain does not gain a new tree merely for recovery.`;
var prompts = {
  Foreground: `You are the shared Foreground provided by the principal instance. Read the unified Conversation in its collaboration scope, including sender, device, reply and intent. Base context on six complete human/AI exchanges, retaining all associated reply originals. If that context starts mid-discussion, retrieve earlier originals with dss_conversation_read mode page and beforeId, or mode message and a known message-id reference, until the relevant beginning is clear within the available context window. Do not use a fixed number of extra rounds. Historical text supplies context, not fresh authorization to act. Human-to-human discussion may require no AI reply and is not automatic execution authorization. A message can be stored even while the desktop Host is offline.
When a new user input needs inspection or other substantive handling, first use the actual pending read and revision-bound conversation claim to take responsibility for that input. Before substantive work, give a brief, natural visible response saying you have seen the request and what you will check or do next. Persist that response immediately with dss_conversation_send using a stable id, intent "human" and replyTo set to the actual user message ID. Native model text alone is not an early visible response because it may only be captured after the turn finishes. Continue the same responsibility after this short response and preserve the final findings or result as a further reply to the same original input. This response is not Task completion, a reason to end Foreground, or a substitute for the final answer. Answer a simple question directly when no substantive work is needed; do not add a repetitive receipt or duplicate the answer. Do not acknowledge human-to-human discussion as an instruction to act.
Discuss the requirement, choose an informative task name and initial P or O route, then submit the original task to tasks/<name>_P.md or tasks/<name>_O.md. Do not allocate its Task UUID, construct the member tree, or invent a Foreground-to-Inbox admission signal; the principal Host initializes it. Supplement an open task through its normal role notification path; after global completion create a new task with references to the old durable results.
Keep Foreground_List and Foreground_Cache for important assignments and durable notes. No separate proof-of-life notebook is required. On completion notification, independently inspect durable results and inform the user. Recorder runs in parallel; do not introduce an acknowledgement handshake or wait for its model turn. Keep conversation sources and recipient intent accurate.
Use dss_submit_direct for an explicitly selected short Planner/Worker task, providing a new stable item identity, target member, original requirement, result location and recipient signal. It writes the input and existing direct notification together without creating a full Task tree.
Use dss_supplement_task to append an open Task requirement and notify its P/O acceptance role atomically at the reviewed revision. If total completion has committed, submit a new task with the prior durable result references instead.
Use dss_conversation_read mode pending to read unconsumed shared inputs and their revision. Save the interpreted List/Cache and consume those exact message IDs with dss_conversation_claim at that revision. Other task-result notifications use dss_claim; do not bypass the conversation consumed index with generic file deletion. Conversation read modes page/message/recent/memory select history or saved memory explicitly. Search older full originals with mode search, query and optional numeric cursor (10 results by default, at most 50); each match gives an exact message reference and excerpt. Use mode text with reference, cursor and optional limit for character pages (32768 by default, at most 262144); follow nextCursor until the needed original is read. These are retrieval page sizes, never storage limits. Read existing memory before replacing List/Cache, preserve completed items and remembered facts/sources unless the user requests cleanup, and read back before claiming an update. The authenticated Host supplies the speaker identity; do not invent a human identity.`,
  Organizer: `You are the principal instance's Organizer. Handle O tasks one at a time while keeping each Task's Organizer_Note and Dispatch record separate. Read the overall requirement and available registered member/seat information. Split work among participating members; a single-member O task still uses Organizer rather than silently becoming P.
Dispatch member work to the fixed member Inbox under the original Task ID. The member Host discovers the delivery and wakes its Planner. When member complete notifications arrive, first claim them atomically with the Task's takeover record, then read and evaluate the associated results. Member Inbox complete is a persistent fact and remains after notification consumption.
Record acceptance, outstanding members and next steps in that Task's Note. If a result needs rework, append your review and deliver corrected work to that same member Inbox and Task ID, retaining history. When all required results are ready, perform the overall business acceptance, persist evidence, process any later notifications, and conditionally mark the O task complete. Host will independently notify Foreground and Recorder.`,
  Planner: `You are the Planner for your bound Task and member, or the explicit direct short task supplied at startup. Read the Inbox, Memory, Plan_Note, formal Plan and available execution resources. Plan work and create child contracts; preserve child identity across execution generations. Record decisions, reviews, evidence, unsuccessful approaches and remaining work in Memory; use Plan_Note for the editable current plan and progress.
Claim notifications with your takeover record. Assign Workers using their contracts and actual resources. Review delivered results against requirements. Save facts before the final pending-notification check. For a P route the principal Planner performs overall acceptance and total completion; for an O route you complete only your member portion, atomically saving results, persistent Inbox complete and the member complete notification. Do not mistake member completion for global completion.
Only you may consume your own member/Task recovery marker after a normal recovered Worker report reaches you and you confirm continuation, or after your own recovery self-check reaches a continuable position. Do not wait for every Worker ACK, business quality completion or total completion merely to consume recovery; do not clear another member's marker.
Every recovery means the task chain has been interrupted or restored. When reviewing and accepting results after recovery, pay extra attention to completeness, consistency and omissions against the original requirements and preserved evidence. This additional result review is not a prerequisite for consuming recovery: keep the existing ownership and normal-chain continuation rules for marker consumption.
A direct short task does not require constructing a full P/O tree. Its root signal is Planner_<encoded-member>_Direct_<encoded-id> or Worker_<encoded-member>_Direct_<encoded-id>, with input direct/<id>.md and takeover record direct/<id>/takeover.md. Read its header for the result location and recipient notification; supply those references to the delivery tool when they are not already bound. Use its supplied input/result/recipient paths, deliver to the designated recipient and finish that item; unrelated notifications remain independently processable.`,
  Worker: `You are the Worker for a bound child and actual execution, or the supplied direct short task. Read the child contract, current-round Worker Note (notes.md), long Reply and thin handoff.json references. Start the current-round Worker Note only when you actually take over. Save useful actions, findings, failed attempts, progress, remaining work, next steps and evidence as you execute. Preserve those notes after interruption.
At delivery, use the current-round Worker Note as factual input to the long Reply and any structured report/evidence. Save the long result and notify the Planner or explicit direct recipient atomically; clear the Worker Note to zero bytes only in the successful handoff. Never clear first or clear after an uncertain result. The next new round starts empty while long Reply retains cross-generation facts. Keep handoff pointers short and the actual details in Reply/notes.
Recovery does not give you permission to consume the member recovery marker. Self-check preserved work, continue, and report normally to the corresponding Planner. Direct short work need not create a member tree; a separately submitted request to terminate a nonresponsive Worker is just another explicit task, not an automatic new workflow.`,
  Recorder: `You are the principal instance's Recorder for a globally complete Task. Your processing state is independent of business completion and of Foreground's user notification. Read original materials through this Task's Recorder Cache links, not a mechanically concatenated substitute. Understand the requirement, contracts, plans, decisions, work records, results, acceptance and evidence yourself.
Use the capacity query for material estimates and the current session/window reference when available. Unknown window is unknown, not a reason to block. For large material, read and summarize in segments and persist continuation progress rather than accumulating a huge final write. Produce useful long-term records and preserve acceptance, necessary evidence, durable deliverables and references under archives/<TaskID>/. Save skills only for methods actually validated and worth reuse, with applicability and evidence.
Use dss_preserve_artifact when available to retain selected authorized native artifacts as original bytes in this Task archive; do not replace binaries with textual descriptions or base64 pasted into notes. Use dss_recorder_save to save the archive and its retention references; its successful read-back publishes this Task\u2019s Cleaner signal automatically. Do not manually create that signal or assume that merely finishing your turn invokes Cleaner. Before requesting Cleaner, save and read back the outputs, determine which original resources still need independent retention, and ensure retained links remain accessible after cleanup. Only successful saved/read-back output permits the fixed Cleaner notification in the principal member/Task state directory. Do not replace the AI summary with Host string concatenation. On interruption keep your independent progress and continue.`,
  Helper: `You diagnose faults, repair or restore a continuable state, and preserve recovery responsibility in dated debug records. Host owns normal scheduling and routine inactivity probes, warnings and restarts. Handle explicit AI help, Host errors, overall restoration and periodic checks of unconsumed recovery markers. Do not turn routine inactivity probes into a separate Helper inspection loop. Use actual execution, relevant records read on demand, and past interventions. File silence or elapsed task time alone is not proof that a healthy heavy job failed.
When a 45-second native-admission diagnostic arrives, inspect its exact wakeId, role, taskId when present, workId, executionId when present, phase and eligibleSince. This is a pending admission diagnostic, not an AI execution deadline. If its real context.target is present and restoration is warranted, pass that exact identity to dss_restore({target, facts, hypotheses, actionsTaken, continuation}); preserve its original Task and wake responsibility. If context.target is absent, do not invent an execution identity. For the real still-pending context.wakeId, use dss_restore({wakeId, facts, hypotheses, actionsTaken, continuation}) to recover that existing admission responsibility without creating an execution or another Task. Supply exactly one selector, target or wakeId. If neither is available, investigate the existing wake and execution facts rather than inventing an identity. If the original wake already completed admission, do not restart it merely because an older diagnostic arrived; inspect any separate current fault on its own actual evidence. The tool result arranged: true means the request was arranged, not that restoration completed. Check real stop and continuation evidence before reporting recovery success; an unknown stop or write is not confirmation. Preserve original records and pending responsibility rather than deleting them or starting a duplicate replacement.
Actual restoration first preserves Plan, Memory, Reply, Worker Note and diagnostic evidence, then stops the old native execution and confirms it stopped before replacement. A stop request, disappearance from a registry, or a failed producer teardown is not confirmation. Explain confirmed facts, hypotheses, actions already taken and continuation advice in every recovery input.
For actual Planner/Worker member restoration, inspect relevant Task/member Inboxes: include nonempty running or pending work, exclude empty and persistent complete without rework. Use the one fixed recovery marker per member/Task. Notify a recovered Worker and its Planner; Planner self-recovery notifies that Planner. Only the corresponding Planner consumes the marker at normal-chain continuation. One recovered report may end the shared marker; another actual recovery uses the same path, without per-incident ACK sets.
Foreground recovery does not create a recovery marker; continue from its own records and preserve debug evidence. Actual Organizer or Recorder restoration also preserves its own records and debug evidence, and maintains the resolved Task owner's fixed recovery marker for that Task. Use the real associated Task, not a fabricated member or Task identity. Running-chain recovery remains for the corresponding Planner to consume under the existing continuation rules; a finally sealed Task's remaining recovery marker is reclaimed by Cleaner as part of its state cleanup, not by Helper or the recovering role. While a recovery marker remains under observation, the Host asks you to check it every 30 minutes. Inspect the actual situation; when there is no anomaly, preserve the observation and end your turn normally. The Host can request another check after the next interval. A long-lived marker alone is not a kill criterion. This marker schedule is separate from each execution's inactivity timer and is not cleared by an AI resetting its own timer.
Your own inactivity follows the shared Host-managed rules. If the Host restarts you after the final stage, enter the existing overall-restoration mode rather than resuming the same deep rescue route or spawning another Helper. Use dss_restore_host with preserved facts, hypotheses, actions and continuation advice to restore a continuable Host/scheduling state and have relevant managers inspect preserved work. Keep diagnostic progress in your existing debug/Helper Memory and return to the original recovery responsibility. Host errors and explicit AI requests remain valid immediate Helper entries. No additional retry count or policy after another overall-restoration failure is introduced.`
};
function frameworkRolePrompt(role) {
  return shared + "\n\n" + (role === "Foreground" ? "" : mechanical + "\n\n") + prompts[role];
}

// src/framework/role-tools.ts
function workerPaths(taskId, member, childId) {
  filePath(childId);
  if (childId.includes("/")) throw new Error("Child identity must occupy one path segment.");
  const root = paths.member(taskId, member) + "/workers/" + childId;
  return { root, contract: root + "/contract.md", notes: root + "/notes.md", reply: root + "/reply.md", handoff: root + "/handoff.json", records: root + "/records/" };
}
var workerWakeSignal = (childId) => "Worker_" + encodeURIComponent(childId) + "_Planner";
function signalWorkerId(name2) {
  const match = /^Worker_(.+)_Planner$/.exec(name2);
  if (!match) return;
  try {
    const child = decodeURIComponent(match[1]);
    filePath(child);
    return child.includes("/") ? void 0 : child;
  } catch {
    return void 0;
  }
}
var signalPart = (value) => encodeURIComponent(value).replace(/_/g, "%5F");
function buildDirectSignal(role, member, id) {
  for (const part of [member, id]) {
    filePath(part);
    if (part.includes("/")) throw new Error("Direct identity occupies one path segment.");
  }
  return role + "_" + signalPart(member) + "_Direct_" + signalPart(id);
}
function parseDirectSignal(name2) {
  const match = /^(Planner|Worker)_([^_]+)_Direct_(.+)$/.exec(name2);
  if (!match) return;
  try {
    const role = match[1], member = decodeURIComponent(match[2]), id = decodeURIComponent(match[3]);
    buildDirectSignal(role, member, id);
    return { role, member, id, inputPath: "direct/" + id + ".md", recordPath: "direct/" + id + "/takeover.md" };
  } catch {
    return void 0;
  }
}
var workerReplySignal = (childId, generation) => "Planner_" + encodeURIComponent(childId) + "-Worker-G" + generation;
var snapshotInput = { snapshotId: z5.string() };
var archiveRecordsPath = (taskId) => paths.archive(taskId) + "/records.md";
var outputFiles = z5.array(z5.object({ path: z5.string(), text: z5.string() }));
function installFrameworkRoleTools(ctx, agent, binding, services) {
  const views = /* @__PURE__ */ new Map();
  const files = services.files;
  const close = async (id) => {
    const view2 = views.get(id);
    if (view2) {
      views.delete(id);
      await view2.snapshot.release();
    }
  };
  const closeAll = async () => {
    for (const id of [...views.keys()]) await close(id);
  };
  const offTurn = ctx.on("session/event", (session, event) => {
    if (session === agent.session && event.type === "turn/end") void closeAll().catch(services.onError);
  });
  ctx.effect(() => async () => {
    offTurn();
    await closeAll();
  }, "servant.framework.role-tools");
  ctx.systemPrompt.section({ name: "deepseek-servant:framework-role", order: 100, interpolate: false, text: frameworkRolePrompt(binding.role) });
  ctx.systemPrompt.section({
    name: "deepseek-servant:framework-binding",
    order: 101,
    interpolate: false,
    text: "Current role and source locations: " + JSON.stringify(binding)
  });
  if (binding.role === "Foreground" && services.conversation) ctx.systemPrompt.section({
    name: "deepseek-servant:foreground-memory-guide",
    order: 102,
    interpolate: false,
    text: foregroundMemoryGuide(
      services.conversation.foregroundRoot + "/Foreground_List.md",
      services.conversation.foregroundRoot + "/Foreground_Cache.md",
      "Use dss_conversation_read mode memory to read both documents before replacing them. Preserve their existing contents and sources in dss_conversation_claim, then read memory back before reporting an update. Never use empty replacement text merely because you have not read the old memory. Use dss_record at a reviewed snapshot for authorized document maintenance."
    )
  });
  const register = (name2, description, schema, execute) => {
    ctx.tools.register({
      name: name2,
      description,
      parameters: toolParameters(schema),
      output: { schema: {}, render: (_args, result) => [{ type: "text", text: JSON.stringify(result) }] },
      execute: async (raw, exec) => {
        if (exec.agent !== agent) throw new Error("Tool execution does not belong to this scoped Agent.");
        exec.signal.throwIfAborted();
        const result = await execute(schema.parse(raw), exec);
        return result === void 0 ? null : JSON.parse(JSON.stringify(result));
      }
    });
  };
  const registerRead = (name2, description, schema, execute) => register(name2, description, schema, (input, exec) => withReadOperation(files, () => execute(input, exec)));
  const view = (id) => {
    const value = views.get(id);
    if (!value) throw new Error("Snapshot is released; open and read a current snapshot.");
    return value;
  };
  const taskId = (value) => {
    const id = binding.taskId ?? value.taskId;
    if (!id) throw new Error("Select the task being processed.");
    return id;
  };
  const task = async (value) => {
    const current = await readJson(files, value.snapshot, paths.task(taskId(value)));
    if (!current) throw new Error("Task metadata does not exist; use the supplied direct-task paths for a short task.");
    if (files instanceof LocalFiles) {
      const cleanup = await readJson(files, value.snapshot, cleanupRecordPath(current.taskId));
      if (cleanup?.version === 1 && cleanup.taskId === current.taskId && cleanup.phase === "released" && cleanup.historyCleared === true)
        throw new Error("This Task history was explicitly cleared; submit a new Task instead of reopening the old business flow.");
    }
    return current;
  };
  const reference = (id) => {
    const value = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
    if (typeof value.revision !== "string" || typeof value.nonce !== "string" || value.taskId !== void 0 && typeof value.taskId !== "string") throw new Error("Invalid snapshot reference.");
    if (binding.taskId && value.taskId && binding.taskId !== value.taskId) throw new Error("Snapshot belongs to another task.");
    return value;
  };
  const mutationView = (id) => {
    const current = views.get(id);
    if (current) return current;
    const saved = reference(id);
    return { snapshot: { revision: saved.revision, release: async () => {
    } }, taskId: saved.taskId };
  };
  const command = (exec) => String(agent.id) + ":" + String(exec.callId);
  const mutate = async (id, request, exec, build, suffix = "") => {
    const current = mutationView(id), held = views.get(id);
    try {
      return await services.transact(command(exec) + suffix, request, { expectedRevision: current.snapshot.revision, ...held ? { snapshot: held.snapshot } : {} }, async (snapshot) => {
        if (snapshot.revision !== current.snapshot.revision) throw new FilesConflictError(current.snapshot.revision);
        return build(snapshot, { ...current, snapshot });
      });
    } finally {
      await close(id);
    }
  };
  const pending = (value) => services.notifications(value.snapshot, binding, value.taskId ?? binding.taskId);
  const requireDrained = async (value) => {
    if ((await pending(value)).length) throw new Error("Pending notifications remain; claim and process them before final handoff.");
  };
  const writableRecord = (path3, value) => {
    filePath(path3);
    if ([binding.recordPath, binding.notePath, binding.replyPath].includes(path3)) return true;
    if (binding.direct) return path3 === binding.direct.resultPath;
    if (binding.role === "Foreground" && services.conversation) return ["Foreground_List.md", "Foreground_Cache.md"].some((name2) => path3 === services.conversation.foregroundRoot + "/" + name2);
    if (binding.role === "Helper") return /^debug\/\d{4}-\d{2}-\d{2}\.md$/.test(path3);
    const id = taskId(value), run = paths.run(id);
    if (binding.role === "Organizer") return path3 === run + "/Organizer_Note.md" || path3 === run + "/Dispatch.md";
    if (binding.role === "Planner" && binding.member) return ["Planner_Memory.md", "Plan_Note.md", "Plan.md", "Reply.md"].some((name2) => path3 === paths.member(id, binding.member) + "/" + name2);
    if (binding.role === "Worker" && binding.member && binding.workerId) {
      const worker = workerPaths(id, binding.member, binding.workerId);
      return [worker.notes, worker.reply, worker.handoff].includes(path3) || path3.startsWith(worker.records);
    }
    if (binding.role === "Recorder") return path3 === run + "/Recorder_Note.md";
    return false;
  };
  const record = async (value, path3, text, append = true) => {
    if (!writableRecord(path3, value)) throw new Error("Choose a record owned by this role and work item.");
    const selectedId = binding.taskId ?? value.taskId;
    if (binding.role === "Organizer" && selectedId && ["Organizer_Note.md", "Dispatch.md"].some((name2) => path3 === paths.run(selectedId) + "/" + name2)) {
      const selected = await task(value);
      if (selected.owner !== binding.owner || selected.route !== "O") throw new Error("Organizer records belong to this principal\u2019s O task.");
    }
    if (!binding.direct && ["Organizer", "Planner", "Worker", "Recorder"].includes(binding.role)) {
      const id = taskId(value);
      const cleanup = path3.startsWith(paths.run(id) + "/") ? await readJson(files, value.snapshot, cleanupRecordPath(id)) : void 0;
      if (cleanup?.phase === "files-cleaned" || cleanup?.phase === "released") throw new Error("This Task runtime namespace is already cleaned; the old execution cannot recreate it.");
    }
    return { path: path3, content: append ? (await files.read(value.snapshot, path3) ?? "") + text : text };
  };
  const recorderReadable = async (value, path3) => {
    if (binding.role !== "Recorder") return;
    const id = taskId(value);
    if (services.skillResourceAllowed?.(binding, path3)) return;
    if (path3 === paths.cache(id) || path3.startsWith(paths.archive(id) + "/") || path3 === paths.run(id) + "/Recorder_Note.md") return;
    const links = await readJson(files, value.snapshot, paths.cache(id));
    if (!links?.links.some((link) => link.kind === "file" ? path3 === link.path : path3.startsWith(link.path))) throw new Error("Read original Recorder material through this Task\u2019s Cache links.");
  };
  registerRead("dss_snapshot", "Open one fixed storage revision for business reads and conditional writes. Release it after use.", z5.object({ taskId: z5.string().optional() }), async (input) => {
    if (binding.taskId && input.taskId && input.taskId !== binding.taskId) throw new Error("This execution is bound to another task.");
    const snapshot = await files.snapshot(), selected = input.taskId ?? binding.taskId;
    const id = Buffer.from(JSON.stringify({ revision: snapshot.revision, taskId: selected, nonce: randomUUID7() })).toString("base64url");
    const current = { snapshot, taskId: selected };
    views.set(id, current);
    try {
      return { snapshotId: id, revision: snapshot.revision, taskId: selected, notifications: await pending(current), binding };
    } catch (error) {
      await close(id);
      throw error;
    }
  });
  register("dss_snapshot_release", "Release a fixed view when no longer needed.", z5.object(snapshotInput), async (input) => {
    await close(input.snapshotId);
    return { released: true };
  });
  registerRead("dss_read", "Read exact logical file content at the opened revision.", z5.object({ ...snapshotInput, path: z5.string() }), async (input) => {
    const current = view(input.snapshotId);
    await recorderReadable(current, input.path);
    const bytes = await files.readBytes(current.snapshot, input.path);
    if (bytes === void 0) return { path: input.path, revision: current.snapshot.revision, exists: false };
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!text.includes("\0")) return { path: input.path, revision: current.snapshot.revision, exists: true, text };
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    return {
      path: input.path,
      revision: current.snapshot.revision,
      exists: true,
      binary: true,
      bytes: bytes.byteLength,
      sha256: createHash21("sha256").update(bytes).digest("hex"),
      hint: "Use the artifact download interface for the original bytes."
    };
  });
  registerRead("dss_list", "List direct file metadata at one directory, without loading business bodies.", z5.object({ ...snapshotInput, directory: z5.string() }), async (input) => {
    const current = view(input.snapshotId);
    await recorderReadable(current, input.directory);
    return { revision: current.snapshot.revision, files: await files.listDirectory(current.snapshot, input.directory) };
  });
  register(
    "dss_record",
    "Persist actual progress or results in this role\u2019s record. Append preserves earlier facts.",
    z5.object({ ...snapshotInput, path: z5.string(), text: z5.string(), append: z5.boolean().default(true) }),
    (input, exec) => mutate(input.snapshotId, input, exec, async (_snapshot, current) => [await record(current, input.path, input.text, input.append)])
  );
  register(
    "dss_claim",
    "Atomically write your takeover record and consume selected ordinary notifications. Recovery is not an ordinary notification.",
    z5.object({ ...snapshotInput, signals: z5.array(z5.string()), recordPath: z5.string(), text: z5.string() }),
    (input, exec) => mutate(input.snapshotId, input, exec, async (snapshot, current) => {
      const available = new Set(await pending(current));
      if (input.signals.some((signal) => !available.has(signal))) throw new Error("Select pending notifications addressed to this role.");
      let takeover = binding.recordPath;
      if (!binding.direct && binding.role === "Planner" && binding.member) takeover = paths.member(taskId(current), binding.member) + "/Planner_Memory.md";
      if (!binding.direct && binding.role === "Worker" && binding.member && binding.workerId) takeover = workerPaths(taskId(current), binding.member, binding.workerId).notes;
      if (binding.role === "Organizer") takeover = paths.run(taskId(current)) + "/Organizer_Note.md";
      if (binding.role === "Recorder") takeover = paths.run(taskId(current)) + "/Recorder_Note.md";
      if (binding.role === "Foreground" && services.conversation) takeover ??= services.conversation.foregroundRoot + "/Foreground_Cache.md";
      if (takeover && input.recordPath !== takeover) throw new Error("Takeover belongs in this role\u2019s current continuation record: " + takeover);
      return claimSignals(files, snapshot, input.signals, [await record(current, input.recordPath, input.text)]);
    })
  );
  if (binding.role === "Foreground") {
    register(
      "dss_submit_task",
      "Submit an original named P/O task. Host assigns its UUID and initializes routing.",
      z5.object({ ...snapshotInput, name: z5.string(), route: z5.enum(["P", "O"]), text: z5.string() }),
      (input, exec) => mutate(input.snapshotId, input, exec, async (snapshot) => {
        filePath(input.name);
        if (input.name.includes("/")) throw new Error("Task name occupies one filename segment.");
        const path3 = "tasks/" + input.name + "_" + input.route + ".md";
        if (await files.read(snapshot, path3) !== void 0) throw new Error("This task filename already exists; select a distinct task name.");
        return [{ path: path3, content: input.text }];
      })
    );
    register(
      "dss_submit_direct",
      "Submit an explicit short Planner/Worker task with its result and recipient references, without creating a full Task tree.",
      z5.object({ ...snapshotInput, id: z5.string(), member: z5.string(), role: z5.enum(["Planner", "Worker"]), text: z5.string(), resultPath: z5.string(), recipientSignal: z5.string() }),
      (input, exec) => mutate(input.snapshotId, input, exec, async (snapshot) => {
        const signalPath = "state/" + buildDirectSignal(input.role, input.member, input.id);
        const inputPath = "direct/" + input.id + ".md";
        filePath(input.resultPath);
        filePath(input.recipientSignal);
        if ([inputPath, signalPath, input.recipientSignal].includes(input.resultPath)) throw new Error("The direct result must not overwrite its original input or notification files.");
        if (input.recipientSignal === signalPath) throw new Error("The result notification must not recreate this same pending direct-task signal.");
        if (!input.recipientSignal.startsWith("state/")) throw new Error("A direct recipient notification belongs in the state directory.");
        if (await files.read(snapshot, inputPath) !== void 0 || await files.read(snapshot, signalPath) !== void 0) throw new Error("This direct task identity already exists; preserve it and choose a new identity for new work.");
        const header = { type: "direct", id: input.id, role: input.role, member: input.member, resultPath: input.resultPath, recipientSignal: input.recipientSignal };
        return [
          { path: inputPath, content: "# Direct task\n\n" + encodeJson(header) + "\n" + input.text },
          { path: signalPath, content: "" }
        ];
      })
    );
    register(
      "dss_supplement_task",
      "Append a supplement to an open Task and notify its acceptance role in the same conditional transaction. A closed Task requires a new Task.",
      z5.object({ ...snapshotInput, text: z5.string() }),
      (input, exec) => mutate(input.snapshotId, input, exec, async (snapshot, current) => {
        const selected = await task(current);
        if (selected.status === "complete") throw new Error("The total task is closed; submit a new Task referencing its durable results and this new requirement.");
        const original = await files.read(snapshot, selected.sourcePath);
        if (original === void 0) throw new Error("The original task requirement is missing.");
        const recipient = selected.route === "P" ? "Planner" : "Organizer";
        return [
          { path: selected.sourcePath, content: original + "\n\n" + input.text },
          { path: paths.state(selected.owner, selected.taskId) + "/" + recipient + "_Foreground", content: "" }
        ];
      })
    );
    if (services.conversation) {
      register("dss_conversation_read", "Read confirmed shared conversation history in this collaboration scope.", z5.object({ mode: z5.enum(["page", "message", "recent", "pending", "memory", "search", "text"]), limit: z5.number().int().positive().optional(), beforeId: z5.string().optional(), reference: z5.string().optional(), query: z5.string().optional(), cursor: z5.number().int().nonnegative().optional() }).superRefine((input, ctx2) => {
        if (input.mode === "search" && (!input.query?.trim() || input.limit !== void 0 && input.limit > 50)) ctx2.addIssue({ code: "custom", message: "Search requires a phrase and at most 50 results per page." });
        if (input.mode === "text" && (!input.reference || input.limit !== void 0 && input.limit > 262144)) ctx2.addIssue({ code: "custom", message: "Text requires a reference and at most 262144 characters per page." });
      }), (input) => services.conversation.read(input, binding));
      register(
        "dss_conversation_send",
        "Write a scoped conversation message with explicit human or AI intent, retaining supplied identity and reply references.",
        z5.object({ id: z5.string(), text: z5.string(), intent: z5.enum(["human", "ai"]), replyTo: z5.string().optional() }),
        (input, exec) => services.conversation.send(input, binding, command(exec))
      );
      register(
        "dss_conversation_claim",
        "Consume reviewed conversation messages and save Foreground List/Cache at the exact revision returned by pending. Task-result notifications use dss_claim instead.",
        z5.object({ expectedRevision: z5.string(), messageIds: z5.array(z5.string()), list: z5.string(), cache: z5.string() }),
        (input, exec) => services.conversation.claim(input, binding, command(exec))
      );
    }
  }
  if (binding.role === "Organizer") register(
    "dss_member_dispatch",
    "Dispatch or return work to the same Task/member Inbox with your recorded decision.",
    z5.object({ ...snapshotInput, member: z5.string(), plan: z5.string(), decision: z5.string() }),
    (input, exec) => mutate(input.snapshotId, input, exec, async (snapshot, current) => {
      const selected = await task(current);
      if (selected.owner !== binding.owner || selected.route !== "O") throw new Error("Organizer dispatch belongs to this principal\u2019s O task.");
      if (selected.status === "complete") throw new Error("The total task is closed; create a new task with durable result references.");
      return deliverMember(
        files,
        snapshot,
        selected,
        input.member,
        input.plan,
        [await record(current, paths.run(selected.taskId) + "/Dispatch.md", input.decision)],
        command(exec)
      );
    })
  );
  if (binding.role === "Planner" && !binding.direct) {
    register(
      "dss_worker_assign",
      "Save a child contract and notify its Worker; existing long records are retained.",
      z5.object({ ...snapshotInput, childId: z5.string(), contract: z5.string(), decision: z5.string() }),
      (input, exec) => mutate(input.snapshotId, input, exec, async (snapshot, current) => {
        const selected = await task(current);
        if (selected.status === "complete") throw new Error("The total task is closed.");
        if (!binding.member) throw new Error("Member ownership is missing from this Planner binding.");
        const worker = workerPaths(selected.taskId, binding.member, input.childId);
        const changes = [
          { path: worker.contract, content: input.contract },
          await record(current, paths.member(selected.taskId, binding.member) + "/Planner_Memory.md", input.decision),
          { path: paths.state(binding.member, selected.taskId) + "/" + workerWakeSignal(input.childId), content: "" }
        ];
        for (const path3 of [worker.notes, worker.reply]) if (await files.read(snapshot, path3) === void 0) changes.push({ path: path3, content: "" });
        return changes;
      })
    );
  }
  if (binding.role === "Planner" && binding.taskId && binding.member) {
    register(
      "dss_recovery_consume",
      "Confirm normal-chain continuation and consume only your member/Task recovery marker; quality acceptance remains separate.",
      z5.object({ ...snapshotInput, continuation: z5.string() }),
      async (input, exec) => {
        const current = mutationView(input.snapshotId), id = taskId(current);
        if (!binding.member) throw new Error("Member ownership is missing from this Planner binding.");
        const member = { taskId: id, member: binding.member };
        const receipt = await mutate(input.snapshotId, input, exec, async (snapshot, checked) => {
          const marker = paths.state(binding.member, id) + "/recovery";
          if (await files.read(snapshot, marker) === void 0) throw new Error("This member has no pending recovery marker.");
          return [await record(checked, paths.member(id, binding.member) + "/Planner_Memory.md", input.continuation), { path: marker, content: null }];
        });
        await services.afterRecoveryConsumed(binding, member, receipt);
        return receipt;
      }
    );
  }
  if (binding.direct && (binding.role === "Worker" || binding.role === "Planner")) {
    register(
      "dss_direct_deliver",
      "Deliver the explicit short-task result and notify its designated recipient without constructing a member tree.",
      z5.object({ ...snapshotInput, text: z5.string(), resultPath: z5.string().optional(), recipientSignal: z5.string().optional() }),
      async (input, exec) => {
        const resultPath = input.resultPath ?? binding.direct.resultPath, recipientSignal = input.recipientSignal ?? binding.direct.recipientSignal;
        if (!resultPath || !recipientSignal) throw new Error("Supply the result and recipient references from the direct task input.");
        filePath(resultPath);
        filePath(recipientSignal);
        if ([binding.direct.inputPath, binding.direct.signalPath, recipientSignal].includes(resultPath)) throw new Error("The direct result must not overwrite its original input or notification files.");
        if (recipientSignal === binding.direct.signalPath) throw new Error("The result notification must not recreate this same pending direct-task signal.");
        if (!recipientSignal.startsWith("state/")) throw new Error("A direct recipient notification belongs in the state directory.");
        let skillIssues = [];
        const receipt = await mutate(input.snapshotId, input, exec, async (_snapshot, current) => {
          await requireDrained(current);
          return [{ path: resultPath, content: input.text }, { path: recipientSignal, content: "" }];
        });
        exec.concludeTurn();
        return receipt;
      }
    );
  }
  if (binding.role === "Worker" && !binding.direct) register(
    "dss_worker_deliver",
    "Atomically append long Reply/report references, notify the Planner, and clear the current-round Worker Note (notes.md) to zero bytes only on committed delivery.",
    z5.object({ ...snapshotInput, reply: z5.string(), records: outputFiles.default([]), handoff: z5.string().optional() }),
    async (input, exec) => {
      const receipt = await mutate(input.snapshotId, input, exec, async (_snapshot, current) => {
        await requireDrained(current);
        if (!binding.member || !binding.workerId) throw new Error("Worker ownership is missing from the execution binding.");
        if ((await task(current)).status === "complete") throw new Error("The total task is closed; preserve late work as records rather than reopening its business flow.");
        const worker = workerPaths(taskId(current), binding.member, binding.workerId);
        const changes = [
          await record(current, worker.reply, input.reply),
          { path: paths.state(binding.member, taskId(current)) + "/" + workerReplySignal(binding.workerId, binding.generation ?? 1), content: "" },
          { path: worker.notes, content: "" }
        ];
        for (const item of input.records) {
          filePath(item.path);
          if (!item.path.startsWith(worker.records)) throw new Error("Execution records belong under this Worker\u2019s records directory.");
          changes.push({ path: item.path, content: item.text });
        }
        if (input.handoff !== void 0) changes.push({ path: worker.handoff, content: input.handoff });
        return changes;
      });
      exec.concludeTurn();
      return receipt;
    }
  );
  if (binding.role === "Planner" && !binding.direct || binding.role === "Organizer") register(
    "dss_complete",
    "Record your actual acceptance and complete the P total, O member portion, or O total after checking your pending notifications at this revision.",
    z5.object({ ...snapshotInput, acceptance: z5.string(), resultPaths: z5.array(z5.string()) }),
    async (input, exec) => {
      const current = mutationView(input.snapshotId), id = taskId(current);
      const consumptionPath = binding.role === "Planner" && binding.member ? "technical/recovery-consumptions/" + paths.member(id, binding.member).slice("task-runs/".length) + "/" + createHash21("sha256").update(command(exec)).digest("hex") + ".json" : void 0;
      const receipt = await mutate(input.snapshotId, input, exec, async (snapshot, current2) => {
        await requireDrained(current2);
        const selected = await task(current2);
        if (selected.status === "complete") throw new Error("The total task is already closed; use its durable results for a new task.");
        for (const path3 of input.resultPaths) if (await files.readBytes(snapshot, filePath(path3)) === void 0) throw new Error("Result reference is missing: " + path3);
        const acceptancePath = binding.role === "Organizer" ? paths.run(selected.taskId) + "/Organizer_Note.md" : paths.member(selected.taskId, binding.member) + "/Planner_Memory.md";
        const recoveryChanges = [];
        if (consumptionPath && binding.member) {
          const marker = paths.state(binding.member, selected.taskId) + "/recovery";
          if (await files.read(snapshot, marker) !== void 0) recoveryChanges.push(
            { path: marker, content: null },
            { path: consumptionPath, content: encodeJson({ commandId: command(exec) }) }
          );
        }
        const acceptance = await record(current2, acceptancePath, input.acceptance + (recoveryChanges.length ? "\nNormal continuation reached this Planner; its member recovery marker was consumed with this accepted handoff.\n" : ""));
        if (binding.role === "Planner" && selected.route === "O") {
          if (!binding.member) throw new Error("Member ownership is missing.");
          return completeMember(files, snapshot, selected.taskId, binding.member, [
            acceptance,
            ...recoveryChanges,
            await record(current2, paths.member(selected.taskId, binding.member) + "/Reply.md", "\n## Delivered result references\n" + encodeJson(input.resultPaths))
          ]);
        }
        if (selected.owner !== binding.owner || (binding.role === "Organizer" ? selected.route !== "O" : selected.route !== "P" || binding.member !== selected.owner)) {
          throw new Error("This role is not the total-task acceptance owner.");
        }
        return [acceptance, ...recoveryChanges, { path: paths.task(selected.taskId), content: encodeJson({ ...selected, status: "complete", resultPaths: input.resultPaths }) }];
      });
      if (consumptionPath && binding.member) {
        const check = await files.snapshot();
        try {
          if (await files.read(check, consumptionPath) !== void 0) await services.afterRecoveryConsumed(binding, { taskId: id, member: binding.member }, receipt);
        } finally {
          await check.release();
        }
      }
      exec.concludeTurn();
      return receipt;
    }
  );
  if (binding.role === "Recorder") {
    if (services.capacity) register(
      "dss_recorder_capacity",
      "Get current session/material estimates and optional window reference; unknown window does not block work.",
      z5.object({ ...snapshotInput, paths: z5.array(z5.string()) }),
      async (input) => {
        const current = view(input.snapshotId);
        for (const path3 of input.paths) await recorderReadable(current, path3);
        return services.capacity(agent, { taskId: taskId(current), paths: input.paths });
      }
    );
    register(
      "dss_recorder_save",
      "Save AI-authored archives/validated skills, verify their exact read-back and retained references, then request fixed Cleaner. This tool does not summarize for you.",
      z5.object({ ...snapshotInput, outputs: outputFiles.min(1), retainedPaths: z5.array(z5.string()).default([]) }),
      async (input, exec) => {
        const original = mutationView(input.snapshotId), id = taskId(original);
        const outputs = input.outputs.map((item) => ({ path: filePath(item.path), content: item.text }));
        if (!outputs.some((item) => item.path === archiveRecordsPath(id))) throw new Error("Save the AI-authored Task records at " + archiveRecordsPath(id) + " before requesting Cleaner.");
        if (outputs.some((item) => item.path === paths.archive(id) + "/retention.json")) throw new Error("retention.json is the cleanup reference manifest, not an AI-authored output path.");
        if (outputs.some((item) => !item.path.startsWith(paths.archive(id) + "/") && !item.path.startsWith("skills/"))) throw new Error("Recorder outputs belong in this Task archive or long-term skills.");
        let skillIssues = [];
        const receipt = await mutate(input.snapshotId, input, exec, async (_snapshot, current) => {
          const selected = await task(current);
          if (selected.owner !== binding.owner || selected.status !== "complete") throw new Error("Recorder finalization belongs to the principal\u2019s globally complete task.");
          const index = await prepareFrameworkSkillIndex(files, current.snapshot, outputs);
          skillIssues = index.issues;
          const originalRetention = {
            outputs: outputs.map((output) => output.path),
            retainedPaths: input.retainedPaths,
            recorderCommand: command(exec),
            inputs: await captureCleanupInputs(files, current.snapshot, selected),
            verifiedReferences: await captureCleanupReferences(files, current.snapshot, [...outputs.map((output) => output.path), ...input.retainedPaths], outputs)
          };
          const archival = await prepareRecorderRetention(files, current.snapshot, selected, originalRetention, outputs);
          return [
            ...archival.changes,
            ...index.changes,
            { path: paths.archive(id) + "/retention.json", content: encodeJson(archival.retention) },
            { path: paths.state(binding.owner, id) + "/Cleaner", content: null }
          ];
        });
        services.skillsChanged?.();
        const check = await files.snapshot();
        try {
          const cleaner = await services.transact(
            command(exec) + ":cleaner",
            { taskId: id, outputs: input.outputs, retainedPaths: input.retainedPaths },
            { expectedRevision: check.revision, snapshot: check },
            async (snapshot) => {
              for (const output of outputs) {
                const saved = await files.readBytes(snapshot, output.path);
                if (saved === void 0 || !Buffer.from(saved).equals(Buffer.from(output.content, "utf8"))) throw new Error("Saved archive read-back differs: " + output.path);
              }
              const retention = await readJson(files, snapshot, paths.archive(id) + "/retention.json");
              if (retention?.recorderCommand !== command(exec)) throw new Error("Recorder retention belongs to a different save operation; reread the current archive.");
              const references = [...retention.outputs, ...retention.retainedPaths];
              for (const path3 of references) if (await files.readBytes(snapshot, path3) === void 0) throw new Error("Retained reference is not accessible: " + path3);
              const referenceHashes = await captureCleanupReferences(files, snapshot, references);
              for (const path3 of references) {
                if (!retention.verifiedReferences?.[path3] || referenceHashes[path3] !== retention.verifiedReferences[path3]) throw new Error("Saved retained reference differs from its evaluated bytes: " + path3);
              }
              return [{ path: paths.state(binding.owner, id) + "/Cleaner", content: "" }];
            }
          );
          exec.concludeTurn();
          return { archive: receipt, cleaner, ...skillIssues.length ? { skillIssues } : {} };
        } finally {
          await check.release();
        }
      }
    );
  }
  if (services.artifacts) register(
    "dss_preserve_artifact",
    "Preserve an authorized native source artifact byte-for-byte in this Task archive and verify the saved bytes. This does not judge business quality.",
    z5.object({ ...snapshotInput, sourcePath: z5.string(), destinationPath: z5.string() }),
    async (input, exec) => {
      const current = mutationView(input.snapshotId), id = taskId(current), held = views.get(input.snapshotId);
      filePath(input.destinationPath);
      if (!input.destinationPath.startsWith(paths.archive(id) + "/")) throw new Error("Preserved artifacts belong in this Task archive.");
      try {
        return await services.artifacts.preserve(
          agent,
          { sourcePath: input.sourcePath, destinationPath: input.destinationPath, taskId: id },
          binding,
          command(exec),
          { expectedRevision: current.snapshot.revision, signal: exec.signal, ...held ? { snapshot: held.snapshot } : {} }
        );
      } finally {
        await close(input.snapshotId);
      }
    }
  );
  if (binding.role !== "Foreground" && services.observation) register(
    "dss_reset_observation",
    "After actually receiving a native Host probe or warning, reset only this execution\u2019s inactivity cycle using that input\u2019s probeId. This does not consume recovery or send a text reply.",
    z5.object({ probeId: z5.string() }),
    (input, exec) => services.observation.reset(binding, input, command(exec), exec.signal)
  );
  if (services.helper) {
    register(
      "dss_help",
      "Report an actual fault and ask Helper to inspect preserved facts; this is not an automatic restart.",
      z5.object({ facts: z5.string() }),
      (input, exec) => services.helper.request(binding, input.facts, command(exec))
    );
    if (binding.role === "Helper") {
      const identity2 = z5.object({
        workId: z5.string(),
        executionId: z5.string(),
        role: z5.enum(["Foreground", "Organizer", "Planner", "Worker", "Recorder", "Helper"]),
        taskId: z5.string().optional(),
        member: z5.string().optional(),
        workerId: z5.string().optional()
      });
      const restoreFacts = { facts: z5.string(), hypotheses: z5.string(), actionsTaken: z5.string(), continuation: z5.string() };
      register(
        "dss_restore",
        "Request restoration of an exact execution target or a real pending wake after preserving business records. Supply exactly one selector; native admission and stop confirmation remain Host responsibilities.",
        z5.object({ ...restoreFacts, target: identity2.optional(), wakeId: z5.string().min(1).optional() }).refine((input) => input.target !== void 0 !== (input.wakeId !== void 0), "Supply exactly one selector: target or wakeId."),
        (input, exec) => {
          const { target, wakeId, ...facts } = input;
          if (target !== void 0) return services.helper.restore(binding, { ...facts, target }, command(exec));
          if (wakeId !== void 0) return services.helper.restore(binding, { ...facts, wakeId }, command(exec));
          throw new Error("Restoration requires an execution target or a pending wake.");
        }
      );
      register(
        "dss_restore_host",
        "Request overall restoration after preserving facts: restore Host scheduling/error state, scan Task/member eligibility and notify the relevant managers. This does not stop all Agents.",
        z5.object({ facts: z5.string(), hypotheses: z5.string(), actionsTaken: z5.string(), continuation: z5.string() }),
        (input, exec) => services.helper.restoreHost(binding, input, command(exec))
      );
    }
  }
}

// src/framework/legacy-migration.ts
var legacyRoots = [
  "tasks/",
  "foreground/",
  "participants/",
  "instances/",
  "assistants/",
  "conversations/",
  "intents/",
  "inputs/",
  "history/",
  "records/",
  "origins/",
  "events/",
  "incidents/",
  "status/",
  "knowledge/",
  "inbox/"
];
function legacySeed(path3) {
  return /^(participants\/[^/]+\/profile|instances\/[^/]+\/(?:status|watch)|assistants\/[^/]+\/[^/]+\/identity)\.json$/.test(path3) || /^assistants\/[^/]+\/[^/]+\/Foreground_(List|Cache)\.md$/.test(path3) || /^conversations\/[^/]+\/[^/]+\/[^/]+\/entry\.json$/.test(path3) || /^(?:intents|inputs|events)\/[^/]+\/[^/]+\.json$/.test(path3) || /^history\/[^/]+\.json$/.test(path3) || /^records\/[^/]+\/(?:manifest\.json|records\.md)$/.test(path3) || /^inbox\/[^/]+\.md$/.test(path3) || /^tasks\/[^/]+\/(?:contract|plan|acceptance)\.json$/.test(path3) || /^tasks\/[^/]+\/initial-plan\/manifest\.json$/.test(path3) || /^tasks\/[^/]+\/assignments\/[^/]+\.json$/.test(path3) || /^tasks\/[^/]+\/requests\/[^/]+\/[^/]+\/[^/]+\.json$/.test(path3) || /^tasks\/[^/]+\/participants\/[^/]+\/instances\/[^/]+\/(?:(?:join|plan)\.json|(?:claims|reports|proposals|reviews)\/[^/]+\.json)$/.test(path3) || /^(?:tasks\/[^/]+|foreground)\/actions\/[^/]+\/[^/]+\/[^/]+\.json$/.test(path3) || /^(?:tasks\/[^/]+|foreground)\/executions\/[^/]+\/[^/]+\/(?:(?:binding|outcome|physical-result|incident)\.json|entries\/[^/]+\/(?:operation\.json|(?:[^/]+\/)?(?:manifest|source)\.json))$/.test(path3) || /^(?:tasks\/[^/]+|foreground)\/executions\/[^/]+\/[^/]+\/(?:transcript|output\/text)\/manifest\.json$/.test(path3) || /^origins\/[^/]+\/(?:request|goal\/[^/]+)\/manifest\.json$/.test(path3) || /^knowledge\/[^/]+\/(?:skill|knowledge|preference)\/[^/]+\/(?:manifest|source)\.json$/.test(path3) || /^incidents\/[^/]+\/[^/]+\/[^/]+\/(?:incident\.json|command\/manifest\.json)$/.test(path3) || /^status\/(?:tasks\/[^/]+|foreground)\/[^/]+\/[^/]+\/[^/]+\/(?:started|completed|closed|replaced)\.json$/.test(path3);
}
var hash10 = (data) => createHash22("sha256").update(data).digest("hex");
var utf8 = (text) => Buffer.from(text, "utf8");
var decode = (data) => new TextDecoder("utf-8", { fatal: true }).decode(data);
var identity = (value) => {
  filePath(value);
  if (value.includes("/")) throw new Error("Migration identity must occupy one path segment.");
  return value;
};
function localContinuation(task) {
  if (task.control === "cancelled" || task.phase === "cancelled") return "cancelled";
  if (task.phase === "completed") return "complete";
  if (task.control === "paused") return "paused";
  const waits = Object.values(task.waits).filter((wait) => wait.state === "waiting");
  if (waits.some((wait) => ["user", "configuration", "resource"].includes(wait.kind))) return "wait-user";
  if (task.phase !== "waiting") return "running";
  return waits.length && waits.every((wait) => wait.kind === "job" || wait.kind === "recovery") ? "wait-result" : "unresolved";
}
async function readLegacyLocalProfile(storage, assistantId = "default") {
  const assistant = await storage.get("assistant/" + assistantId);
  return assistant === void 0 ? void 0 : legacyProfileFields(structuredClone(assistant), assistantId);
}
function legacyProfileFields(value, assistantId) {
  const assistant = value;
  if (assistant.schemaVersion !== 1 || assistant.id !== assistantId || !assistant.settings || !assistant.workspace) throw new Error("Invalid legacy assistant profile.");
  return {
    settings: assistant.settings,
    workspace: assistant.workspace,
    sessionId: assistant.sessionId,
    priorSessionIds: assistant.priorSessionIds ?? [],
    sessionWorkspaces: assistant.sessionWorkspaces ?? {}
  };
}
async function readLegacyCoopSettings(ctx) {
  const [{ defineDomain: defineDomain2, domainTable: domainTable2 }, { z: z10 }] = await Promise.all([import("@deepseek-ai/dsh-storage-domain"), import("zod")]);
  const spec = defineDomain2({
    name: "deepseek_servant_coop",
    version: 1,
    layout: "per-record",
    global: { schema: z10.object({ instanceId: z10.string(), settings: CoopSettingsSchema }), initial: { instanceId: "", settings: CoopSettingsSchema.parse({}) } },
    tables: { cache: domainTable2(z10.unknown()) }
  });
  const domain = await ctx.storageDomain.open(spec);
  try {
    return structuredClone(domain.global.get());
  } finally {
    await domain.close();
  }
}
var localLegacyPrefixes = [
  "task:",
  "task-staging/",
  "task-runtime/",
  "task-origin/",
  "goal-origin/",
  "handoff/",
  "task-turn/",
  "records-staging/",
  "conversation/",
  "planner-memory/",
  "planner-note/",
  "worker-reply/",
  "execution/",
  "recovery/",
  "records/",
  "record-archive/",
  "task-history/",
  "tombstone/",
  "assistant/",
  "assistant-history/",
  "foreground-memory/",
  "conversations/",
  "conversation-index/",
  "conversation-exchanges/",
  "conversation-staging/",
  "conversation-cleanup/",
  "knowledge/skills/",
  "knowledge/facts/",
  "knowledge/preferences/",
  "retention/",
  "settings/"
];
var isLocalLegacyKey = (key) => localLegacyPrefixes.some((prefix) => key.startsWith(prefix));
async function captureLocalLegacy(source) {
  const rows = (await source.list("")).filter((row) => isLocalLegacyKey(row.key));
  const serialized2 = rows.map((row) => ({ key: row.key, bytes: utf8(JSON.stringify(row.value)) })).sort((a, b) => a.key.localeCompare(b.key));
  const revisionOf = (items) => hash10(JSON.stringify(items.map((item) => [item.key, hash10(item.bytes)])));
  const revision = revisionOf(serialized2);
  const map = new Map(rows.map((row) => [row.key, structuredClone(row.value)]));
  const captured = {
    get: async (key) => structuredClone(map.get(key)),
    set: async (key, value) => {
      map.set(key, structuredClone(value));
    },
    list: async (prefix) => [...map].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) }))
  };
  const journal = new RecordJournal(captured), records = new TaskRecords(journal);
  const archivedTask = async (id) => {
    const index = await captured.get("task-history/" + encodeURIComponent(id));
    if (index?.deleting) return void 0;
    const manifest = await captured.get("records/" + encodeURIComponent(id) + "/manifest");
    if (!manifest) return void 0;
    const task = await decodeLegacySealedTask(manifest, id, (key) => captured.get(key));
    if (task.delivery && index?.deliveryReadAt) task.delivery.readAt = index.deliveryReadAt;
    return task;
  };
  for (const [key, value] of [...map]) if (key.startsWith("task-staging/") && key.endsWith("/commit")) {
    const prepared = value, root = map.get("task:" + prepared.root?.id);
    if (prepared.schemaVersion !== 1 || !prepared.root?.id) throw new Error("Invalid legacy pending task record: " + key);
    if ((root?.revision ?? 0) < prepared.root.revision) {
      if ((root?.revision ?? 0) !== prepared.expectedRevision) throw new Error("Legacy task staging revision differs: " + key);
      await records.write(prepared);
      map.set("task:" + prepared.root.id, prepared.root);
    }
  }
  const texts = [];
  for (const value of map.values()) if (value?.kind === "servant-record-entry") {
    const entry = value;
    texts.push({ ref: entry.ref, text: await journal.fullText(entry.ref) });
  }
  for (const [key, value] of map) if (/^records\/[^/]+\/manifest$/.test(key)) {
    const id = decodeURIComponent(key.split("/")[1]);
    if (key !== "records/" + encodeURIComponent(id) + "/manifest") throw new Error("Invalid legacy records identity: " + key);
    if (map.get("task-history/" + encodeURIComponent(id))?.deleting) continue;
    texts.push({ ref: legacyLocalRecordsReference(id), text: await decodeLegacySealedRecords(value, id, async (part) => map.get(part)) });
  }
  const tasks = [], issues = [];
  for (const [key, value] of map) if (key.startsWith("task:")) {
    const task = value?.kind === "task-tombstone" ? await archivedTask(key.slice(5)) : isSeparatedTask(value) ? await records.hydrate(value) : value;
    if (!task || task.schemaVersion !== 1 || !task.goal || !task.children || !task.executions || !task.reports || !task.waits) {
      issues.push("Task cannot yet be reconstructed: " + key);
      continue;
    }
    const continuation = localContinuation(task);
    if (continuation === "unresolved") issues.push("Waiting dependency needs an existing continuation adapter: " + task.id);
    tasks.push({
      id: task.id,
      original: task,
      continuation,
      request: task.goal.request,
      waits: Object.values(task.waits).filter((wait) => wait.state === "waiting").map((wait) => ({
        id: wait.id,
        memberIdentity: task.assistantId,
        question: wait.question ?? (["user", "configuration", "resource"].includes(wait.kind) ? wait.reason : void 0),
        original: wait
      })),
      participants: [{
        identity: task.assistantId,
        nativeExecutions: Object.values(task.executions).map((execution) => ({
          executionId: execution.executionId,
          sessionId: execution.sessionId,
          agentId: execution.agentId,
          role: execution.role,
          generation: execution.generation,
          actionId: execution.actionId,
          ownedJobIds: [...execution.ownedJobIds],
          originalState: execution.state,
          physicalState: execution.physicalState,
          recordedSettled: execution.physicalState === "stopped" && execution.ownedJobIds.length === 0,
          original: execution
        })),
        original: { assistantId: task.assistantId, workspace: task.workspace, waits: task.waits },
        plan: task.plan,
        children: Object.values(task.children).map((child) => ({
          id: child.id,
          contract: child,
          reports: Object.values(task.reports).filter((report) => report.childId === child.id),
          executions: Object.values(task.executions).filter((execution) => execution.childId === child.id)
        }))
      }]
    });
  }
  for (const [key, value] of map) if (key.startsWith("task-history/")) {
    const index = value;
    if (index.deleting) continue;
    const id = decodeURIComponent(key.slice("task-history/".length));
    if (index.schemaVersion !== 1 || index.taskId !== id || key !== "task-history/" + encodeURIComponent(id)) throw new Error("Invalid legacy task history: " + key);
    if (map.has("task:" + id)) continue;
    const task = await archivedTask(id);
    if (!task || task.id !== id || task.schemaVersion !== 1 || !task.goal || !task.reports) throw new Error("Legacy archived Task is missing or corrupt: " + id);
    const continuation = localContinuation(task);
    if (continuation !== "complete" && continuation !== "cancelled") {
      issues.push("Historical Task has no terminal continuation: " + id);
      continue;
    }
    tasks.push({ id, original: task, continuation, request: task.goal.request, participants: [] });
  }
  const after = (await source.list("")).filter((row) => isLocalLegacyKey(row.key)).map((row) => ({ key: row.key, bytes: utf8(JSON.stringify(row.value)) })).sort((a, b) => a.key.localeCompare(b.key));
  if (revisionOf(after) !== revision) throw new Error("Legacy Local source changed during capture; no migration was prepared.");
  return { mode: "local", baseline: LEGACY_BASELINE, revision, records: serialized2, texts, tasks, issues };
}
async function captureGitLegacy(files, snapshot, history = {}) {
  const records = [];
  const versions = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Set(), requested = /* @__PURE__ */ new Set(), selected = /* @__PURE__ */ new Set(), issues = [];
  for (const prefix of legacyRoots) for (const entry of await files.list(snapshot, prefix)) {
    versions.set(entry.path, entry.version);
    if (legacySeed(entry.path)) {
      pending.add(entry.path);
      selected.add(entry.path);
    }
  }
  const pathFields = /* @__PURE__ */ new Set([
    "textPath",
    "contextPath",
    "originPath",
    "goalPath",
    "sourcePath",
    "memoryPath",
    "notePath",
    "replyPath",
    "resultPath",
    "manifestPath",
    "recordsPath",
    "outcomePath",
    "outputPath",
    "inputPath",
    "chunks",
    "prerequisitePaths",
    "refs"
  ]);
  const references = (value, field) => {
    if (typeof value === "string" && field && pathFields.has(field) && value.startsWith("dss-coop/")) {
      const path3 = filePath(value.slice("dss-coop/".length));
      if (!requested.has(path3)) pending.add(path3);
    } else if (Array.isArray(value)) value.forEach((item) => references(item, field));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) references(item, key);
  };
  while (pending.size) {
    const path3 = pending.values().next().value;
    pending.delete(path3);
    if (requested.has(path3)) continue;
    requested.add(path3);
    const bytes = await files.readBytes(snapshot, path3);
    if (bytes === void 0) {
      if (selected.has(path3)) throw new Error("Legacy Git snapshot lost a listed record: " + path3);
      if (!path3.endsWith(".json") && !path3.endsWith(".txt") && !path3.endsWith(".md")) {
        const manifest = path3 + "/manifest.json";
        if (!requested.has(manifest)) pending.add(manifest);
      } else issues.push("Legacy reference requires its historical revision: dss-coop/" + path3);
      continue;
    }
    records.push({ key: path3, bytes });
    if (path3.endsWith(".json")) references(JSON.parse(decode(bytes)));
  }
  const map = new Map(records.map((record) => [record.key, record.bytes]));
  const read = (path3) => {
    const bytes = map.get(path3.replace(/^dss-coop\//, ""));
    return bytes === void 0 ? void 0 : decode(bytes);
  };
  const json4 = (path3) => {
    const value = read(path3);
    return value === void 0 ? void 0 : JSON.parse(value);
  };
  const texts = [];
  for (const record of records.filter((record2) => record2.key.endsWith("/manifest.json"))) {
    const manifest = json4(record.key);
    if (!Array.isArray(manifest.chunks)) continue;
    const root = record.key.slice(0, -"/manifest.json".length);
    const text = manifest.chunks.map((chunk) => {
      const path3 = chunk.replace(/^dss-coop\//, "");
      if (!path3.startsWith(root + "/parts/")) throw new Error("Legacy text chunk escapes its record: " + chunk);
      filePath(path3);
      const part = read(path3);
      if (part === void 0) throw new Error("Legacy text part is missing: " + chunk);
      return part;
    }).join("");
    if (manifest.version !== 1 || hash10(text) !== manifest.sha256 || text.length !== manifest.characters) throw new Error("Legacy text integrity mismatch: " + root);
    texts.push({ ref: "dss-coop/" + root, text });
  }
  const same2 = (a, b) => !!a && !!b && [
    "participantId",
    "instanceId",
    "taskId",
    "role",
    "actionId",
    "executionId",
    "sessionId",
    "generation",
    "epoch",
    "fence",
    "assignmentVersion",
    "childId",
    "childRevision",
    "sourceIntentId",
    "outputPath"
  ].every((key) => a[key] === b[key]);
  const actionKey = (b) => (b.taskId ? "tasks/" + b.taskId : "foreground") + "/actions/" + b.participantId + "/" + b.instanceId + "/" + b.actionId + ".json";
  const outputKey = (b) => "dss-coop/" + (b.taskId ? "tasks/" + b.taskId : "foreground") + "/executions/" + b.participantId + "/" + b.executionId + "/outcome.json";
  const status = (b, kind2) => {
    const value = json4("status/" + (b.taskId ? "tasks/" + b.taskId : "foreground") + "/" + b.participantId + "/" + b.instanceId + "/" + b.executionId + "/" + kind2 + ".json");
    return value?.version === 1 && value.kind === kind2 && same2(value.binding, b) ? value : void 0;
  };
  const disposition = (role, signal) => role === "foreground" ? ["respond", "handoff_planner"].includes(signal) ? signal : void 0 : role === "worker" ? signal === "continue" ? "continue" : ["complete", "blocked", "error"].includes(signal) ? "result" : void 0 : ["done", "rework"].includes(signal) ? "plan_ready" : signal === "complete" ? "complete" : signal === "handoff" ? "continue" : ["wait", "need_user", "error"].includes(signal) ? "wait" : void 0;
  const outcomeAt = (path3) => {
    const value = json4(path3), b = value?.binding;
    if (!b || b.outputPath !== "dss-coop/" + path3.replace(/^dss-coop\//, "") || b.outputPath !== outputKey(b)) return void 0;
    const action = json4(actionKey(b));
    if (!same2(action?.binding, b)) return void 0;
    const completed = action.stateProtocol === 1 ? status(b, "completed") : void 0;
    if (action.stateProtocol === 1 && (!completed?.turn_signal || completed.outcomePath !== b.outputPath || completed.turn_signal !== value.turn_signal)) return void 0;
    const legacy3 = b.role === "planner" ? { plan_ready: "done", continue: "handoff", complete: "complete", wait: value.question ? "need_user" : "wait" }[value.kind] : b.role === "foreground" ? value.kind : value.kind === "continue" || value.resultStatus === "handoff" ? "continue" : value.resultStatus === "failed" ? "error" : value.kind === "result" ? "complete" : void 0;
    const signal = completed?.turn_signal ?? value.turn_signal ?? legacy3, kind2 = disposition(b.role, signal);
    return kind2 ? { ...value, kind: kind2, turn_signal: signal, observedTrigger: value.observedTrigger ?? (b.role === "planner" ? status(b, "closed")?.observedTrigger : void 0) } : void 0;
  };
  const published = (writer, taskId) => {
    if (!writer) return true;
    const action = json4(actionKey(writer)), started = status(writer, "started"), completed = status(writer, "completed");
    if (!started && action?.stateProtocol !== 1) return true;
    if (completed?.turn_signal && completed.outcomePath === writer.outputPath && disposition(writer.role, completed.turn_signal)) return true;
    const current = action?.binding;
    if (writer.role === "foreground" && current?.role === "foreground" && current.generation > writer.generation && current.sourceIntentId === writer.sourceIntentId && actionKey(current) === actionKey(writer)) {
      const result = outcomeAt(current.outputPath);
      return result?.kind === "handoff_planner" && result.taskId === taskId;
    }
    return false;
  };
  const trigger = (taskId, participantId) => {
    const prefix = "tasks/" + taskId + "/", selected2 = [];
    for (const [path3, version] of versions) {
      if (!path3.startsWith(prefix)) continue;
      if (path3 === prefix + "contract.json" || path3 === prefix + "plan.json" || path3.endsWith("/join.json") || /\/(proposals|reports)\/[^/]+\.json$/.test(path3) || path3.startsWith(prefix + "requests/" + participantId + "/") && path3.endsWith(".json")) {
        if (published(json4(path3)?.writer, taskId)) selected2.push(["dss-coop/" + path3, version]);
      } else if (path3.startsWith(prefix + "executions/" + participantId + "/") && path3.endsWith("/outcome.json")) {
        const result = outcomeAt(path3);
        if (result?.binding.role === "worker" && result.kind === "result") selected2.push(["dss-coop/" + path3, version]);
      }
    }
    return hash10(encodeJson(selected2.sort(([a], [b]) => a.localeCompare(b))));
  };
  const tasks = [];
  for (const record of records.filter((record2) => /^tasks\/[^/]+\/contract.json$/.test(record2.key))) {
    const task = json4(record.key), root = record.key.slice(0, -"/contract.json".length);
    const joins = records.filter((record2) => record2.key.startsWith(root + "/participants/") && record2.key.endsWith("/join.json")).map((record2) => json4(record2.key));
    const actions = records.filter((record2) => record2.key.startsWith(root + "/actions/") && record2.key.endsWith(".json")).map((record2) => json4(record2.key));
    const outcomes = records.filter((record2) => record2.key.startsWith(root + "/executions/") && record2.key.endsWith("/outcome.json")).map((record2) => json4(record2.key));
    const currentWaits = joins.flatMap((join6) => {
      const observed = trigger(task.id, join6.participantId);
      const outcome = outcomes.map((value) => value?.binding?.outputPath && outcomeAt(value.binding.outputPath)).filter((value) => value?.binding?.role === "planner" && value.binding.participantId === join6.participantId && value.binding.instanceId === join6.instanceId && value.kind === "wait" && value.observedTrigger === observed).at(-1);
      return outcome ? [{ join: join6, outcome }] : [];
    });
    let continuation = task.status === "accepted" ? "complete" : task.status === "cancelled" ? "cancelled" : joins.length && joins.every((join6) => join6.state === "paused" || join6.state === "left") ? "paused" : currentWaits.length === joins.length && currentWaits.some((wait) => wait.outcome.question) ? "wait-user" : currentWaits.length ? "wait-result" : task.status === "waiting" ? "unresolved" : "running";
    if (continuation === "unresolved") issues.push("Current waiting outcome cannot be established: " + task.id);
    const request = texts.find((text) => text.ref === task.originPath)?.text;
    if (request === void 0) {
      issues.push("Task original request is unresolved: " + task.id);
      continuation = "unresolved";
    }
    tasks.push({
      id: task.id,
      original: task,
      continuation,
      request: request ?? "",
      waits: currentWaits.filter((wait) => wait.outcome.question).map(({ join: join6, outcome }) => ({ id: outcome.binding.executionId, memberIdentity: join6.participantId + "/" + join6.instanceId, question: outcome.question, original: outcome })),
      participants: joins.map((join6) => {
        const base = root + "/participants/" + join6.participantId + "/instances/" + join6.instanceId;
        const plan = json4(base + "/plan.json");
        const bindings = /* @__PURE__ */ new Map();
        for (const record2 of records.filter((record3) => record3.key.startsWith(root + "/executions/") && record3.key.endsWith("/binding.json"))) {
          const binding = json4(record2.key);
          if (binding) bindings.set(binding.executionId + ":" + binding.generation, binding);
        }
        for (const value of [...actions, ...outcomes]) if (value?.binding) bindings.set(value.binding.executionId + ":" + value.binding.generation, value.binding);
        const nativeExecutions = [...bindings.values()].filter((binding) => binding.participantId === join6.participantId && binding.instanceId === join6.instanceId).map((binding) => {
          const physical = json4(outputKey(binding).replace(/outcome.json$/, "physical-result.json"));
          const action = actions.find((action2) => same2(action2?.binding, binding));
          return {
            executionId: binding.executionId,
            sessionId: binding.sessionId,
            role: binding.role,
            generation: binding.generation,
            actionId: binding.actionId,
            ownedJobIds: (physical?.jobs ?? []).map((job) => job.id),
            originalState: action?.state,
            recordedSettled: physical?.settled === true,
            original: { binding, physical, action, closed: status(binding, "closed"), completed: status(binding, "completed") }
          };
        });
        return {
          identity: join6.participantId + "/" + join6.instanceId,
          nativeExecutions,
          continuation: join6.state === "paused" ? "paused" : join6.state === "left" ? "cancelled" : currentWaits.find((wait) => wait.join === join6)?.outcome.question ? "wait-user" : ["complete", "cancelled", "unresolved"].includes(continuation) ? continuation : "running",
          original: join6,
          plan,
          children: (plan?.children ?? []).map((child) => ({
            id: child.id,
            contract: child,
            reports: outcomes.filter((outcome) => outcome?.binding?.participantId === join6.participantId && outcome?.binding?.instanceId === join6.instanceId && outcome?.binding?.childId === child.id),
            executions: records.filter((record2) => record2.key.startsWith(root + "/actions/") && record2.key.endsWith(".json")).map((record2) => json4(record2.key)).filter((action) => action?.binding?.participantId === join6.participantId && action?.binding?.instanceId === join6.instanceId && action?.binding?.childId === child.id)
          }))
        };
      })
    });
  }
  for (const record of records.filter((record2) => /^history\/[^/]+\.json$/.test(record2.key))) {
    const entry = json4(record.key);
    if (!entry?.id || tasks.some((task) => task.id === entry.id)) continue;
    const archive = entry.manifestPath && json4(entry.manifestPath);
    const assembled = texts.find((text) => text.ref === entry.recordsPath)?.text;
    if (!archive || !Array.isArray(archive.sources) || !entry.sourceHead || archive.sourceHead !== entry.sourceHead || assembled === void 0 || hash10(assembled) !== archive.recordsSha256) {
      issues.push("Legacy completed archive is unresolved: " + record.key);
      continue;
    }
    const restored = /* @__PURE__ */ new Map();
    if (!history.at) issues.push("Historical source commit reader is unavailable: " + entry.sourceHead + ":" + entry.id);
    else {
      const historical = await history.at(entry.sourceHead);
      try {
        for (const source of archive.sources) {
          const path3 = filePath(source.path.replace(/^dss-coop\//, ""));
          if (!path3.startsWith("tasks/" + entry.id + "/") && !path3.startsWith("status/tasks/" + entry.id + "/")) throw new Error("Archive source escapes its Task: " + path3);
          const bytes = await files.readBytes(historical, path3);
          if (bytes === void 0 || hash10(bytes) !== source.sha256) throw new Error("Historical archive source integrity mismatch: " + source.path);
          restored.set(path3, bytes);
          records.push({
            key: "historical/" + entry.sourceHead + "/" + path3,
            bytes,
            reference: "dss-coop/" + path3 + "?revision=" + entry.sourceHead
          });
          if (!map.has(path3)) {
            records.push({ key: path3, bytes });
            map.set(path3, bytes);
          }
        }
      } finally {
        await historical.release();
      }
    }
    for (const [path3, bytes] of restored) if (path3.endsWith("/manifest.json")) {
      const manifest = JSON.parse(decode(bytes));
      if (!Array.isArray(manifest.chunks)) continue;
      const root = path3.slice(0, -"/manifest.json".length);
      const text = manifest.chunks.map((reference) => {
        const chunk = reference.replace(/^dss-coop\//, "");
        if (!chunk.startsWith(root + "/parts/")) throw new Error("Historical text chunk escapes its record.");
        const value = restored.get(chunk);
        if (!value) throw new Error("Historical text part is missing: " + reference);
        return decode(value);
      }).join("");
      if (manifest.version !== 1 || hash10(text) !== manifest.sha256 || text.length !== manifest.characters) throw new Error("Historical text integrity mismatch: " + root);
      texts.push({ ref: "dss-coop/" + root + "?revision=" + entry.sourceHead, text });
      if (!texts.some((item) => item.ref === "dss-coop/" + root)) texts.push({ ref: "dss-coop/" + root, text });
    }
    const contractBytes = restored.get("tasks/" + entry.id + "/contract.json");
    const contract = contractBytes ? JSON.parse(decode(contractBytes)) : void 0;
    tasks.push({
      id: entry.id,
      original: { history: entry, manifest: archive, contract },
      continuation: entry.status === "accepted" ? "complete" : entry.status === "cancelled" ? "cancelled" : "unresolved",
      request: contract ? texts.find((text) => text.ref === contract.originPath)?.text ?? assembled : assembled,
      participants: []
    });
  }
  return { mode: "git", baseline: LEGACY_BASELINE, revision: snapshot.revision, records, texts, tasks, issues };
}
async function prepareLegacyMigration(source, files, snapshot, options, transactions) {
  const root = "technical/legacy-migrations/" + identity(options.id), changes = /* @__PURE__ */ new Map();
  const add = (change) => changes.set(change.path, change);
  const ambiguousArtifactReferences = /* @__PURE__ */ new Set(), legacySkillBodyPaths = /* @__PURE__ */ new Set();
  const manifest = {
    version: 1,
    id: options.id,
    baseline: source.baseline,
    source: { mode: source.mode, revision: source.revision },
    owner: options.owner,
    members: { ...options.members },
    records: [],
    references: {},
    referenceHashes: {},
    tasks: [],
    issues: [...source.issues],
    pendingAdapters: [],
    messages: []
  };
  const declared = /* @__PURE__ */ new Map();
  if (source.mode === "local") for (const task of source.tasks) {
    try {
      declared.set(task.id, legacyDeclaredArtifacts(task.original));
    } catch (error) {
      manifest.issues.push(error instanceof Error ? error.message : String(error));
      manifest.pendingAdapters.push("artifact-declarations:" + task.id);
    }
  }
  if (source.records.some((record) => /^(conversations?\/|conversation-index\/|conversation:)/.test(record.key))) manifest.pendingAdapters.push("conversation-index");
  if (source.records.some((record) => /^(assistants?\/|assistant:|work-planning\/)/.test(record.key))) manifest.pendingAdapters.push("assistant-and-foreground-memory");
  if (source.records.some((record) => /^(skills?\/|knowledge\/|settings\/|setting:)/.test(record.key))) manifest.pendingAdapters.push("knowledge-and-settings");
  for (const record of source.records) {
    const path3 = root + "/source/" + hash10(record.key) + ".bin";
    add({ path: path3, bytes: record.bytes.slice() });
    manifest.records.push({ key: record.key, path: path3, sha256: hash10(record.bytes) });
    manifest.references[record.key] = path3;
    manifest.referenceHashes[record.key] = hash10(record.bytes);
    if (record.reference) {
      manifest.references[record.reference] = path3;
      manifest.referenceHashes[record.reference] = hash10(record.bytes);
    }
    if (source.mode === "git") {
      manifest.references["dss-coop/" + record.key] = path3;
      manifest.referenceHashes["dss-coop/" + record.key] = hash10(record.bytes);
    }
  }
  for (const entry of source.texts) {
    const path3 = root + "/text/" + hash10(entry.ref) + ".md";
    add({ path: path3, content: entry.text });
    manifest.references[entry.ref] = path3;
    manifest.referenceHashes[entry.ref] = hash10(entry.text);
  }
  if (source.mode === "local") {
    const entries = [];
    for (const record of source.records.filter((record2) => /^knowledge\/(skills|facts|preferences)\//.test(record2.key))) {
      const value = JSON.parse(decode(record.bytes));
      if (value.schemaVersion !== 1 || !value.scope?.assistantId || !value.scope.workspaceId || !["skill", "project-fact", "preference"].includes(value.kind)) {
        manifest.issues.push("Legacy knowledge schema is unresolved: " + record.key);
        continue;
      }
      const scopePath = encodeURIComponent(value.scope.assistantId) + "/" + encodeURIComponent(value.scope.workspaceId);
      const path3 = value.kind === "skill" ? "skills/" + scopePath + "/" + encodeURIComponent(value.skillId) + "/record.json" : record.key + ".json";
      add({ path: path3, bytes: record.bytes.slice() });
      let activeBodyPath;
      if (value.kind === "skill") {
        const active = value.versions.find((version) => version.version === value.activeVersion && version.status === "active" && !version.bodyRetiredAt);
        if (active) {
          activeBodyPath = path3.replace(/record.json$/, "SKILL.md");
          legacySkillBodyPaths.add(activeBodyPath);
          add({ path: activeBodyPath, content: `# ${active.title}

${active.description}

## \u9002\u7528\u8303\u56F4

${active.applicability}

${active.body}
` });
        }
      }
      entries.push({ sourceKey: record.key, path: path3, kind: value.kind, scope: value.scope, revision: value.revision, ...activeBodyPath ? { activeBodyPath } : {} });
    }
    if (entries.length) {
      const indexPath2 = "knowledge/legacy-index.json", prior = await files.read(snapshot, indexPath2);
      const index2 = prior ? JSON.parse(prior) : { version: 1, entries: [] };
      for (const entry of entries) {
        const existing = index2.entries.find((item) => item.sourceKey === entry.sourceKey);
        if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error("Legacy knowledge scope already has different migration metadata.");
        if (!existing) index2.entries.push(entry);
      }
      add({ path: indexPath2, content: encodeJson(index2) });
      manifest.pendingAdapters.push("native-knowledge-provider-registration");
    }
  }
  if (source.mode === "git") {
    for (const record of source.records.filter((record2) => /^knowledge\/[^/]+\/(skill|knowledge|preference)\/[^/]+\/source.json$/.test(record2.key))) {
      const [, participantId, kind2, entryId] = record.key.split("/");
      const sourcePath = "dss-coop/" + record.key.slice(0, -"/source.json".length), text = source.texts.find((item) => item.ref === sourcePath)?.text;
      if (text === void 0) {
        manifest.issues.push("Legacy Git knowledge body is unresolved: " + sourcePath);
        continue;
      }
      const metadata = JSON.parse(decode(record.bytes));
      if (kind2 === "skill") {
        const path3 = "skills/legacy-git/" + participantId + "/" + entryId + "/legacy-git.json";
        add({ path: path3, content: encodeJson({
          version: 1,
          kind: "legacy-git-skill",
          participantId,
          name: "coop-" + hash10(sourcePath).slice(0, 16),
          description: text.split("\n").find((line) => line.trim())?.slice(0, 180) || "Coop skill",
          body: text,
          source: { path: sourcePath, metadata }
        }) });
      } else add({
        path: "knowledge/legacy-git/" + participantId + "/" + kind2 + "/" + entryId + ".json",
        content: encodeJson({ version: 1, kind: kind2, participantId, text, source: { path: sourcePath, metadata } })
      });
    }
  }
  const overlay = {
    ...files,
    snapshot: () => files.snapshot(),
    list: (s, p) => files.list(s, p),
    listDirectory: (s, p) => files.listDirectory(s, p),
    commit: (s, c, m) => files.commit(s, c, m),
    read: async (s, path3) => {
      const change = changes.get(path3);
      return change ? change.content ?? (change.bytes ? decode(change.bytes) : void 0) : files.read(s, path3);
    },
    readBytes: async (s, path3) => {
      const change = changes.get(path3);
      return change ? change.bytes ?? (typeof change.content === "string" ? utf8(change.content) : void 0) : files.readBytes(s, path3);
    }
  };
  if (options.conversations?.length) {
    if (!transactions) throw new Error("Conversation migration requires the current transaction coordinator for its read-only index planner.");
    const imported = /* @__PURE__ */ new Set(), local = (key) => {
      const record = source.records.find((record2) => record2.key === key);
      return record ? JSON.parse(decode(record.bytes)) : void 0;
    };
    const texts = new Map(source.texts.map((text) => [text.ref, text.text]));
    const textFiles = (path3, text) => {
      const chunks = [];
      for (let start = 0; start < text.length; ) {
        let end = Math.min(start + 65536, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        const chunk = path3 + "/parts/" + chunks.length.toString().padStart(6, "0") + ".txt";
        chunks.push(chunk);
        add({ path: chunk, content: text.slice(start, end) });
        start = end;
      }
      add({ path: path3 + "/manifest.json", content: encodeJson({ version: 1, characters: text.length, sha256: hash10(text), chunks }) });
    };
    for (const selection of options.conversations) {
      const conversation = new FrameworkConversation(overlay, transactions, selection.scope);
      const entries = [];
      if (source.mode === "local") {
        if (!selection.assistantId || !selection.participantId) throw new Error("Map the actual legacy assistant and local participant before importing its conversation.");
        for (const record of source.records.filter((record2) => record2.key.startsWith("conversation-index/" + encodeURIComponent(selection.assistantId) + "/"))) {
          const value = local(record.key), text = texts.get(value.ref);
          if (text === void 0) throw new Error("Legacy conversation body is unresolved: " + value.ref);
          entries.push({ key: record.key, id: value.id, participantId: selection.participantId, role: value.role, at: value.at, ref: value.ref, text, original: value });
        }
        entries.sort((a, b) => a.at.localeCompare(b.at) || a.original.order - b.original.order || a.ref.localeCompare(b.ref));
      } else for (const selected of selection.entryPaths ?? []) {
        const key = selected.replace(/^dss-coop\//, ""), value = local(key);
        if (!value || !["user", "assistant", "system"].includes(value.role)) throw new Error("Selected legacy conversation entry is missing or invalid: " + selected);
        const text = texts.get(value.textPath), participantId = value.participantId ?? value.writer?.participantId;
        if (text === void 0 || !participantId) throw new Error("Legacy message body or participant is unresolved: " + selected);
        entries.push({ key, id: value.id, participantId, role: value.role, at: value.createdAt, ref: selected, text, original: value });
      }
      const ids = new Map(entries.map((entry) => [entry.ref, entries.filter((other) => other.id === entry.id).length === 1 ? entry.id : "legacy-" + hash10(entry.ref)]));
      const replies = /* @__PURE__ */ new Map();
      if (selection.assistantId) for (const record of source.records.filter((record2) => record2.key.startsWith("conversation-exchanges/" + encodeURIComponent(selection.assistantId) + "/"))) {
        const exchange = local(record.key);
        let user;
        for (const ref of exchange.refs) {
          const message = entries.find((entry) => entry.ref === ref);
          if (message?.role === "user") user = ids.get(ref);
          else if (message?.role === "assistant" && user) replies.set(ref, user);
        }
      }
      const entryPaths = [];
      for (const entry of entries) {
        const id = ids.get(entry.ref), date = new Date(entry.at);
        if (!Number.isFinite(date.getTime())) throw new Error("Legacy message timestamp is invalid: " + entry.ref);
        const path3 = "conversations/" + (selection.scope.mode === "local" ? "local/" : "") + encodeURIComponent(entry.participantId) + "/" + date.toISOString().slice(0, 10) + "/legacy-" + hash10(entry.ref) + "/entry.json";
        const textPath = path3.replace(/entry.json$/, "text");
        textFiles(textPath, entry.text);
        const explicitSource = entry.original.replyTo ?? entry.original.writer?.sourceIntentId;
        const explicitReply = explicitSource && entries.find((other) => other.id === explicitSource && other.role === "user");
        const replyTo = replies.get(entry.ref) ?? (explicitReply ? ids.get(explicitReply.ref) : void 0);
        add({ path: path3, content: encodeJson({
          id,
          role: entry.role,
          participantId: entry.participantId,
          createdAt: entry.at,
          collaborationId: selection.scope.collaborationId,
          textPath,
          textHash: hash10(entry.text),
          source: entry.original.source,
          ...replyTo ? { replyTo } : {},
          ...entry.original.recipient ? { recipient: entry.original.recipient } : {},
          ...entry.original.mentions ? { mentions: entry.original.mentions } : {},
          legacy: { id: entry.id, reference: entry.ref, sessionId: entry.original.sessionId, date: entry.original.date, timeZone: entry.original.timeZone }
        }) });
        entryPaths.push(path3);
        imported.add(entry.key);
        manifest.messages.push({ reference: entry.ref, id, path: path3, collaborationId: selection.scope.collaborationId });
      }
      for (const change of await conversation.planLegacyIndex(snapshot, entryPaths)) add(change);
      for (const name2 of ["Foreground_List", "Foreground_Cache"]) {
        const oldKey = source.mode === "local" ? "foreground-memory/" + encodeURIComponent(selection.assistantId) + "/" + name2 : selection.foregroundIdentity ? "assistants/" + selection.foregroundIdentity.participantId + "/" + selection.foregroundIdentity.instanceId + "/" + name2 + ".md" : void 0;
        const sourceRecord = oldKey && source.records.find((record) => record.key === oldKey);
        if (sourceRecord) {
          const text = source.mode === "local" ? JSON.parse(decode(sourceRecord.bytes)).text : decode(sourceRecord.bytes);
          add({ path: conversation.foregroundRoot + "/" + name2 + ".md", content: text });
        }
      }
    }
    const allEntries = source.records.filter((record) => source.mode === "local" ? record.key.startsWith("conversation-index/") : /^conversations\/.+\/entry.json$/.test(record.key));
    if (allEntries.every((entry) => imported.has(entry.key))) manifest.pendingAdapters = manifest.pendingAdapters.filter((item) => item !== "conversation-index");
  }
  for (const capturedTask of source.tasks) {
    const task = structuredClone(capturedTask);
    for (const participant of task.participants) {
      const pending = (participant.nativeExecutions ?? []).some((execution) => !options.nativeOwnershipReconciled?.[participant.identity]?.some((result) => result.executionId === execution.executionId && result.generation === execution.generation && result.settled));
      if (pending) {
        manifest.pendingAdapters.push("native-ownership:" + task.id + ":" + participant.identity);
        if (["running", "wait-result"].includes(participant.continuation ?? task.continuation)) participant.continuation = "unresolved";
      }
    }
    if (["running", "wait-result"].includes(task.continuation) && task.participants.length && task.participants.every((participant) => participant.continuation === "unresolved")) task.continuation = "unresolved";
    const id = legacyMigratedTaskId(options.id, task.id), recordPath = paths.archive(id) + "/legacy/task.json";
    add({ path: recordPath, content: encodeJson(task.original) });
    if (source.mode === "local") for (const artifact of declared.get(task.id) ?? []) {
      const captured = options.artifacts?.find((item) => item.taskId === task.id && item.sourcePath === artifact.path && (item.artifactId === artifact.id || item.artifactId === void 0 && (declared.get(task.id) ?? []).filter((ref) => ref.path === artifact.path).length === 1)) ?? options.artifacts?.find((item) => item.taskId === void 0 && item.sourcePath === artifact.path && [...declared.values()].flat().filter((ref) => ref.path === artifact.path).length === 1);
      if (!captured) {
        manifest.pendingAdapters.push("artifact-bytes:" + task.id + ":" + artifact.id);
        continue;
      }
      const bytes = captured.bytes.slice(), digest9 = hash10(bytes);
      if (artifact.sha256 && artifact.sha256 !== digest9) throw new Error("Legacy artifact bytes differ from the recorded hash: " + artifact.id);
      const name2 = artifact.path.split(/[\\/]/).at(-1) || artifact.id;
      const path3 = paths.archive(id) + "/legacy/artifacts/" + hash10(artifact.path) + "/" + encodeURIComponent(name2);
      const manifestPath3 = "technical/artifacts/manifests/" + hash10(path3) + ".json";
      add({ path: path3, bytes });
      add({ path: manifestPath3, content: encodeJson({ version: 1, taskId: id, path: path3, manifestPath: manifestPath3, name: name2, sha256: digest9, bytes: bytes.byteLength }) });
      for (const reference of [artifact.path, artifact.id]) {
        const qualified = "legacy-task/" + task.id + "/" + reference;
        manifest.references[qualified] = path3;
        manifest.referenceHashes[qualified] = digest9;
        if (ambiguousArtifactReferences.has(reference)) continue;
        if (manifest.references[reference] && manifest.referenceHashes[reference] !== digest9) {
          delete manifest.references[reference];
          delete manifest.referenceHashes[reference];
          ambiguousArtifactReferences.add(reference);
          manifest.issues.push("Legacy artifact reference is task-scoped and ambiguous without its Task: " + reference);
        } else {
          manifest.references[reference] = path3;
          manifest.referenceHashes[reference] = digest9;
        }
      }
    }
    const members = task.participants.map((participant) => options.members[participant.identity]);
    let continuation = task.continuation;
    if (members.some((member) => !member)) {
      manifest.issues.push("Registered member mapping is unresolved: " + task.id);
      continuation = "unresolved";
    }
    const mapped = [...new Set(members.filter((member) => !!member))];
    const continuationPath = paths.archive(id) + "/legacy/continuation.json";
    add({ path: continuationPath, content: encodeJson(task) });
    manifest.tasks.push({
      oldId: task.id,
      taskId: id,
      continuation,
      members: mapped,
      recordPath,
      continuationPath,
      memberContinuations: task.participants.filter((participant) => options.members[participant.identity]).map((participant) => ({
        member: options.members[participant.identity],
        identity: participant.identity,
        continuation: ["complete", "cancelled"].includes(continuation) ? continuation : participant.continuation ?? continuation,
        waits: (task.waits ?? []).filter((wait) => wait.memberIdentity === participant.identity && typeof wait.question === "string").map((wait) => ({ id: wait.id, question: wait.question }))
      }))
    });
    if (continuation !== "running" && continuation !== "wait-result") {
      if (continuation !== "complete") manifest.pendingAdapters.push("original-control-and-input:" + task.id);
      continue;
    }
    const route = (/* @__PURE__ */ new Set([options.owner, ...mapped])).size > 1 ? "O" : "P", sourcePath = "tasks/migrated-" + id + "_" + route + ".md";
    add({ path: sourcePath, content: task.request });
    const initialized = await initializeTask(overlay, snapshot, sourcePath, options.owner, mapped, id);
    for (const change of initialized.changes) add(change);
    if (route === "O") add({ path: paths.run(id) + "/Organizer_Note.md", content: encodeJson({ legacyTask: task.original, participants: task.participants, referenceIndex: root + "/manifest.json" }) });
    for (const participant of task.participants) {
      const member = options.members[participant.identity], memberRoot = paths.member(id, member);
      const context2 = {
        legacyTaskId: task.id,
        taskId: id,
        continuation,
        originalTask: recordPath,
        referenceIndex: root + "/manifest.json",
        participant: participant.original,
        plan: participant.plan,
        references: manifest.references,
        children: participant.children
      };
      const body = encodeJson(context2);
      const held = participant.continuation && !["running", "wait-result"].includes(participant.continuation);
      if (held) {
        add({ path: paths.inbox(id, member), content: "" });
        if (member === options.owner) changes.delete(paths.state(options.owner, id) + "/Organizer_Task");
        manifest.pendingAdapters.push("original-control-and-input:" + task.id + ":" + participant.identity);
      } else add({ path: paths.inbox(id, member), content: body });
      add({ path: memberRoot + "/Planner_Memory.md", content: body });
      add({ path: memberRoot + "/Plan.md", content: encodeJson(participant.plan) });
      add({ path: memberRoot + "/Plan_Note.md", content: source.mode === "local" ? task.original.plannerNote?.body ?? "" : "" });
      for (const child of participant.children) {
        const worker = workerPaths(id, member, child.id);
        add({ path: worker.contract, content: encodeJson(child.contract) });
        add({ path: worker.reply, content: encodeJson({ reports: child.reports, references: manifest.references }) });
        add({ path: worker.handoff, content: encodeJson({ legacyExecutions: child.executions, reports: child.reports }) });
        add({ path: worker.notes, content: "" });
      }
    }
  }
  for (const task of manifest.tasks) add({ path: task.recordPath.replace(/task.json$/, "references.json"), content: encodeJson(manifest.references) });
  const skillIndex = await prepareFrameworkSkillIndex(files, snapshot, [...changes.values()]);
  for (const change of skillIndex.changes) add(change);
  manifest.issues.push(...skillIndex.issues.filter((issue2) => ![...legacySkillBodyPaths].some((path3) => issue2 === "Not a native skill definition: " + path3)));
  const manifestPath2 = root + "/manifest.json";
  add({ path: manifestPath2, content: encodeJson(manifest) });
  const indexPath = "technical/legacy-migrations/index.json";
  const previousIndex = await files.read(snapshot, indexPath);
  const index = previousIndex ? JSON.parse(previousIndex) : { version: 1, migrations: [] };
  const previous = index.migrations.find((item) => item.id === options.id);
  if (previous && JSON.stringify(previous.source) !== JSON.stringify(manifest.source)) throw new Error("Migration identity refers to a different legacy source.");
  if (!previous) index.migrations.push({ id: options.id, manifestPath: manifestPath2, source: manifest.source });
  add({ path: indexPath, content: encodeJson(index) });
  for (const change of changes.values()) {
    const old = await files.readBytes(snapshot, change.path), bytes = change.bytes ?? utf8(change.content);
    if (change.path !== indexPath && change.path !== "knowledge/legacy-index.json" && change.path !== frameworkSkillIndexPath && old !== void 0 && hash10(old) !== hash10(bytes)) throw new Error("Migration destination already contains different data: " + change.path);
  }
  return { expectedRevision: snapshot.revision, manifestPath: manifestPath2, manifest, changes: [...changes.values()] };
}
async function applyLegacyMigration(files, transactions, plan) {
  const changes = plan.changes.map((change) => change.bytes === void 0 ? { ...change } : { path: change.path, bytes: change.bytes.slice() });
  const evidence = changes.map((change) => ({ path: change.path, sha256: hash10(change.bytes ?? utf8(change.content)) }));
  const receipt = await transactions.run("legacy-migration:" + plan.manifest.id, { manifest: structuredClone(plan.manifest), evidence }, { expectedRevision: plan.expectedRevision }, async () => changes);
  await withSnapshot(files, async (snapshot) => {
    if (files instanceof GitFiles && files.matchesVerifiedWrites(snapshot, receipt, evidence)) return;
    for (const expected of evidence) {
      const actual = await files.readBytes(snapshot, expected.path);
      if (actual === void 0 || hash10(actual) !== expected.sha256) throw new Error("Migration read-back differs; retain the original source and same operation: " + expected.path);
    }
  });
  return {
    manifest: plan.manifest,
    verified: true,
    complete: plan.manifest.issues.length === 0 && plan.manifest.pendingAdapters.length === 0 && plan.manifest.tasks.every((task) => ["running", "wait-result", "complete"].includes(task.continuation))
  };
}
function resumeLegacyTask(files, transactions, commandId, input) {
  return controlLegacyTask(files, transactions, commandId, input, "resume");
}
function answerLegacyTask(files, transactions, commandId, input) {
  return controlLegacyTask(files, transactions, commandId, input, "answer");
}
async function controlLegacyTask(files, transactions, commandId, input, action) {
  filePath(input.manifestPath);
  const receipt = await transactions.run("legacy-control:" + commandId, { action, input }, {}, async (snapshot) => {
    const raw = await files.read(snapshot, input.manifestPath);
    if (!raw) throw new Error("Migration manifest is missing.");
    const manifest = JSON.parse(raw);
    const mapped = manifest.tasks.find((task) => task.oldId === input.oldTaskId);
    if (!mapped) throw new Error("Legacy task is not in this migration.");
    if (mapped.continuation === "cancelled" || mapped.continuation === "complete") throw new Error("Ended legacy work cannot be reopened by migration control.");
    const body = await files.read(snapshot, mapped.continuationPath);
    if (!body) throw new Error("Original continuation data is missing.");
    const original = JSON.parse(body);
    const participant = original.participants.find((participant2) => manifest.members[participant2.identity] === input.member);
    if (!participant) throw new Error("Legacy control belongs to a mapped participating instance.");
    const current = participant.continuation ?? original.continuation;
    const summary2 = mapped.memberContinuations?.find((item) => item.member === input.member && item.identity === participant.identity);
    if (action === "resume" && current !== "paused") throw new Error("This legacy task is not awaiting resume.");
    if (action === "answer") {
      const answer = input;
      if (current !== "wait-user" || summary2?.waits && !summary2.waits.some((wait) => wait.id === answer.waitId) || !original.waits?.some((wait) => wait.id === answer.waitId && wait.memberIdentity === participant.identity && wait.question)) throw new Error("The original user question is not pending for this instance.");
      if (typeof answer.answer !== "string" || !answer.answer.trim()) throw new Error("Answer the original pending question.");
    }
    const controlPath = input.manifestPath.replace(/manifest.json$/, "controls/" + hash10(input.oldTaskId + "\0" + input.member + (action === "answer" ? "\0answer\0" + input.waitId : "\0resume")) + ".json");
    if (await files.read(snapshot, controlPath) !== void 0) throw new Error("This migrated continuation has already been resumed.");
    const existing = await files.read(snapshot, paths.task(mapped.taskId));
    if (existing && JSON.parse(existing).status === "complete") throw new Error("The current task is already complete.");
    const technicalAction = { commandId, action, ...input, taskId: mapped.taskId };
    const updateSummary = () => {
      mapped.continuation = "running";
      if (summary2) {
        summary2.continuation = "running";
        if (action === "answer") summary2.waits = summary2.waits?.filter((wait) => wait.id !== input.waitId);
      }
      if (!summary2?.waits?.length) manifest.pendingAdapters = manifest.pendingAdapters.filter((item) => item !== "original-control-and-input:" + original.id && item !== "original-control-and-input:" + original.id + ":" + participant.identity);
    };
    if (existing) {
      const task = JSON.parse(existing), source = await files.read(snapshot, task.sourcePath);
      if (task.taskId !== mapped.taskId || source === void 0) throw new Error("The current Task source cannot be established.");
      updateSummary();
      const recipient = task.route === "P" ? "Planner" : "Organizer";
      return [
        { path: task.sourcePath, content: source + "\n\n" + encodeJson({ legacyUserAction: technicalAction, originalTask: mapped.recordPath, referenceIndex: input.manifestPath }) },
        { path: paths.state(task.owner, task.taskId) + "/" + recipient + "_Foreground", content: "" },
        { path: controlPath, content: encodeJson(technicalAction) },
        { path: input.manifestPath, content: encodeJson(manifest) }
      ];
    }
    const route = (/* @__PURE__ */ new Set([manifest.owner, ...mapped.members])).size > 1 ? "O" : "P";
    const sourcePath = "tasks/migrated-" + mapped.taskId + "_" + route + ".md";
    const changes = [];
    if (await files.read(snapshot, sourcePath) === void 0) changes.push({ path: sourcePath, content: original.request });
    const overlay = Object.create(files);
    overlay.read = (s, path3) => path3 === sourcePath ? Promise.resolve(original.request) : files.read(s, path3);
    changes.push(...(await initializeTask(overlay, snapshot, sourcePath, manifest.owner, mapped.members, mapped.taskId)).changes);
    const context2 = encodeJson({
      originalTask: mapped.recordPath,
      referenceIndex: input.manifestPath,
      original: participant,
      waits: original.waits,
      userAction: { commandId, action, ...input }
    });
    const memberRoot = paths.member(mapped.taskId, input.member);
    changes.push(
      { path: paths.inbox(mapped.taskId, input.member), content: context2 },
      { path: memberRoot + "/Planner_Memory.md", content: context2 },
      { path: memberRoot + "/Plan.md", content: encodeJson(participant.plan) },
      { path: controlPath, content: encodeJson({ commandId, action, ...input, taskId: mapped.taskId }) }
    );
    for (const child of participant.children) {
      const worker = workerPaths(mapped.taskId, input.member, child.id);
      for (const [path3, content] of [
        [worker.contract, encodeJson(child.contract)],
        [worker.reply, encodeJson(child.reports)],
        [worker.handoff, encodeJson({ reports: child.reports, legacyExecutions: child.executions })],
        [worker.notes, ""]
      ]) {
        if (await files.read(snapshot, path3) === void 0) changes.push({ path: path3, content });
      }
    }
    updateSummary();
    changes.push({ path: input.manifestPath, content: encodeJson(manifest) });
    return [...new Map(changes.map((change) => [change.path, change])).values()];
  });
  return withSnapshot(files, async (snapshot) => {
    const manifest = JSON.parse(await files.read(snapshot, input.manifestPath));
    const mapped = manifest.tasks.find((task) => task.oldId === input.oldTaskId);
    if (await files.read(snapshot, paths.task(mapped.taskId)) === void 0) throw new Error("Restored task identity read-back is missing.");
    return { taskId: mapped.taskId, revision: receipt.revision };
  });
}

// src/framework/execution-control.ts
import { createHash as createHash23 } from "node:crypto";
var hash11 = (value) => createHash23("sha256").update(value).digest("hex");
var ExecutionControls = class {
  constructor(storage, scope, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
    this.storage = storage;
    this.now = now;
    this.key = "framework-user-controls/" + hash11(scope);
  }
  key;
  tail = Promise.resolve();
  async load() {
    const saved = await this.storage.get(this.key);
    return saved ? structuredClone(saved) : { version: 1, tasks: {}, executions: {}, commands: {} };
  }
  serial(operation) {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {
    }, () => {
    });
    return result;
  }
  /** Use only for the authenticated user's explicit action. Caller checks scope. */
  setTask(commandId, taskId, intent) {
    return this.serial(async () => {
      const state = await this.load(), key = hash11(commandId), signature = JSON.stringify(["task", taskId, intent]);
      const old = state.commands[key];
      if (old) {
        if (old.signature !== signature) throw new Error("Control command identity has different arguments.");
        return old.value;
      }
      const value = { taskId, intent, commandId, requestedAt: this.now() };
      state.tasks[hash11(taskId)] = value;
      state.commands[key] = { signature, value };
      await this.storage.set(this.key, state);
      return value;
    });
  }
  requestExecutionStop(commandId, target) {
    return this.serial(async () => {
      const state = await this.load(), key = hash11(commandId);
      const signature = JSON.stringify(["execution-stop", target.workId, target.executionId, target.taskId ?? null]);
      const old = state.commands[key];
      if (old) {
        if (old.signature !== signature) throw new Error("Control command identity has different arguments.");
        return old.value;
      }
      const value = { ...target, commandId, requestedAt: this.now() };
      state.executions[hash11(target.executionId)] = value;
      state.commands[key] = { signature, value };
      await this.storage.set(this.key, state);
      return value;
    });
  }
  /** Records the real native outcome; requesting a stop is never proof it stopped. */
  settleExecution(commandId, executionId, result) {
    return this.serial(async () => {
      const state = await this.load(), key = hash11(executionId), current = state.executions[key];
      if (!current || current.commandId !== commandId) return current;
      const value = { ...current, result: structuredClone(result) };
      state.executions[key] = value;
      const receipt = state.commands[hash11(commandId)];
      if (receipt) receipt.value = value;
      await this.storage.set(this.key, state);
      return value;
    });
  }
  task(taskId) {
    return this.serial(async () => (await this.load()).tasks[hash11(taskId)]);
  }
  /** One view's local control document; never retained across refreshes. */
  taskStates(taskIds) {
    return this.serial(async () => {
      const state = await this.load();
      return new Map(taskIds.map((id) => [id, state.tasks[hash11(id)]]));
    });
  }
  execution(executionId) {
    return this.serial(async () => (await this.load()).executions[hash11(executionId)]);
  }
  /** Only undispatched requests; unconfirmed results stay visible for diagnosis. */
  pendingStops() {
    return this.serial(async () => Object.values((await this.load()).executions).filter((value) => value.result === void 0));
  }
  async taskHeld(taskId) {
    if (!taskId) return false;
    const value = await this.task(taskId);
    return value?.intent === "paused" || value?.intent === "cancelled";
  }
  /** Cleanup removes active associations; old command receipts cannot reopen work. */
  releaseTask(taskId) {
    return this.serial(async () => {
      const state = await this.load();
      delete state.tasks[hash11(taskId)];
      for (const [key, value] of Object.entries(state.executions)) if (value.taskId === taskId) delete state.executions[key];
      await this.storage.set(this.key, state);
    });
  }
};

// src/framework/migration-lifecycle.ts
import { createHash as createHash24, randomUUID as randomUUID8 } from "node:crypto";
var digest7 = (value) => createHash24("sha256").update(value).digest("hex");
async function migrateFrameworkStorage(input) {
  const key = "framework-cutovers/" + digest7(input.scope);
  let saved = await input.records.get(key);
  if (saved?.verified) return { manifestPath: saved.manifestPath, verified: true, complete: !!saved.complete };
  let snapshot;
  if (saved && input.mode === "git") {
    if (!(input.files instanceof GitFiles)) throw new Error("Git cutover requires immutable remote snapshot access.");
    snapshot = await input.files.at(saved.expectedRevision);
  } else snapshot = await input.files.snapshot();
  try {
    let plan;
    if (saved?.localPlan) {
      plan = { ...saved.localPlan, changes: saved.localPlan.changes.map((change) => change.base64 === void 0 ? { path: change.path, content: change.content } : { path: change.path, bytes: Uint8Array.from(Buffer.from(change.base64, "base64")) }) };
    } else {
      const capture = input.mode === "local" ? await captureLocalLegacy(input.localSource ?? input.records) : await captureGitLegacy(input.files, snapshot, input.files instanceof GitFiles ? { at: (revision) => input.files.at(revision) } : void 0);
      if (!capture.records.length && !saved) {
        await input.records.set(key, {
          id: randomUUID8(),
          expectedRevision: snapshot.revision,
          sourceRevision: capture.revision,
          options: { id: "", owner: "", members: {} },
          verified: true,
          complete: true
        });
        return { verified: true, complete: true };
      }
      if (saved && capture.revision !== saved.sourceRevision) throw new Error("Original migration source changed; preserve its pending operation rather than replacing the plan.");
      const id = saved?.id ?? randomUUID8();
      const supplied = await input.options(capture, id);
      const options = saved ? { ...saved.options, artifacts: supplied.artifacts } : supplied;
      const artifacts = options.artifacts?.map((artifact) => ({ sourcePath: artifact.sourcePath, sha256: createHash24("sha256").update(artifact.bytes).digest("hex") }));
      if (saved && JSON.stringify(saved.artifacts) !== JSON.stringify(artifacts)) throw new Error("Original migration artifact bytes are unavailable or changed; retain the same pending operation.");
      plan = await prepareLegacyMigration(capture, input.files, snapshot, options, input.transactions);
      if (!saved) {
        const { artifacts: _bytes, ...metadataOptions } = options;
        saved = { id, expectedRevision: snapshot.revision, sourceRevision: capture.revision, options: metadataOptions, artifacts };
        if (input.mode === "local") saved.localPlan = { ...plan, changes: plan.changes.map((change) => change.bytes === void 0 ? { path: change.path, content: change.content } : { path: change.path, base64: Buffer.from(change.bytes).toString("base64") }) };
        await input.records.set(key, saved);
      }
    }
    const result = await applyLegacyMigration(input.files, input.transactions, plan);
    await input.records.set(key, { ...saved, localPlan: void 0, manifestPath: plan.manifestPath, verified: true, complete: result.complete });
    return { manifestPath: plan.manifestPath, verified: true, complete: result.complete };
  } finally {
    await snapshot.release();
  }
}

// src/adapters/dsh/foreground-activity.ts
import { z as z6 } from "zod";
var foregroundActivityProjectionKey = "deepseek-servant/foreground-activity";
var foregroundActivityProjection = {
  key: foregroundActivityProjectionKey,
  stateVersion: 1,
  // End reasons are an official merge-extensible sum type; do not freeze its current list here.
  stateSchema: z6.object({
    turn: z6.number().int().nonnegative(),
    startSeq: z6.number().int().nonnegative(),
    startedAt: z6.number().finite(),
    end: z6.string().optional()
  }).nullable(),
  init: () => null,
  apply(state, event) {
    if (event.type === "turn/start") return { turn: event.data.turn, startSeq: event.seq, startedAt: event.time };
    if (event.type === "turn/end" && state?.turn === event.data.turn) return { ...state, end: event.data.reason.kind };
    return state;
  }
};
function ensureForegroundActivity(ctx) {
  let registry;
  let disposed = false;
  const fiber = ctx.inject(["sessionProjections"], (scope) => {
    const active = scope.sessionProjections;
    const unregister = active.register(foregroundActivityProjection);
    registry = active;
    return () => {
      if (registry === active) registry = void 0;
      unregister();
    };
  });
  return {
    read: (session) => disposed ? void 0 : registry?.stateOf(session, foregroundActivityProjectionKey),
    available: () => !disposed && registry !== void 0,
    async dispose() {
      if (disposed) return;
      disposed = true;
      registry = void 0;
      await fiber.dispose();
    }
  };
}

// src/framework/foreground-capture.ts
import { isAppendSurfaceEvent as isAppendSurfaceEvent3 } from "@deepseek-ai/dsh-session";
var object3 = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
function captureForegroundTurns(events) {
  const snapshot = conversationSnapshot(events);
  const turns = /* @__PURE__ */ new Map();
  for (const event of events) if (event.type === "turn/end" && event.data.reason.kind === "completed") {
    turns.set(event.data.turn, { turn: event.data.turn, completedAt: event.time, readMessageIds: [], claimedMessageIds: [], claims: [], sends: [] });
  }
  const finalMessages = new Map(snapshot.messages.filter((message) => message.role === "assistant" && message.turn !== void 0).map((message) => [message.turn, message]));
  const calls = /* @__PURE__ */ new Map();
  const successful = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (event.type === "assistant/message" && isAppendSurfaceEvent3(event)) {
      const turn2 = turns.get(event.data.turn), selected = finalMessages.get(event.data.turn);
      const source = event.data.message.source;
      if (turn2 && selected?.id === event.data.message.id && source.kind === "model") {
        turn2.final = { id: selected.id, text: selected.text, time: event.time, at: new Date(event.time).toISOString(), provider: source.provider, model: source.model };
      }
    }
    if (event.type === "tool/call") {
      let entries = calls.get(event.data.turn);
      if (!entries) calls.set(event.data.turn, entries = /* @__PURE__ */ new Map());
      entries.set(event.data.callId, event.data);
    }
    if (event.type !== "tool/result" || !isAppendSurfaceEvent3(event) || event.data.message.isError) continue;
    const turn = turns.get(event.data.turn), callId = event.data.message.toolCallId;
    const call = calls.get(event.data.turn)?.get(callId);
    if (!turn || !call || successful.get(event.data.turn)?.has(callId)) continue;
    if (call.name !== "dss_conversation_claim" && call.name !== "dss_conversation_send" && call.name !== "dss_conversation_read") continue;
    let args;
    try {
      args = object3(JSON.parse(call.arguments));
    } catch {
      continue;
    }
    if (!args) continue;
    const evidence = { callId, resultMessageId: event.data.message.id, time: event.time };
    if (call.name === "dss_conversation_read") {
      if (args.mode !== "message" && args.mode !== "pending" && args.mode !== "page" && args.mode !== "text") continue;
      const content = event.data.message.content;
      if (content.length !== 1 || content[0]?.type !== "text") continue;
      let value;
      try {
        value = object3(JSON.parse(content[0].text));
      } catch {
        continue;
      }
      if (!value) continue;
      const messages = args.mode === "message" ? [value] : args.mode === "text" && typeof value.text === "string" ? [{ ...object3(value.message), text: value.text }] : value.messages;
      if (!Array.isArray(messages)) continue;
      for (const candidate of messages) {
        const message = object3(candidate);
        if (message?.role === "user" && typeof message.id === "string" && typeof message.text === "string" && !turn.readMessageIds.includes(message.id)) turn.readMessageIds.push(message.id);
      }
    } else if (call.name === "dss_conversation_claim") {
      if (!Array.isArray(args.messageIds) || !args.messageIds.every((id) => typeof id === "string")) continue;
      turn.claims.push({ ...evidence, messageIds: [...args.messageIds] });
      for (const id of args.messageIds) if (!turn.claimedMessageIds.includes(id)) turn.claimedMessageIds.push(id);
    } else {
      if (typeof args.id !== "string" || typeof args.text !== "string" || args.intent !== "human" && args.intent !== "ai" || args.replyTo !== void 0 && typeof args.replyTo !== "string") continue;
      turn.sends.push({
        ...evidence,
        id: args.id,
        text: args.text,
        intent: args.intent,
        ...args.replyTo === void 0 ? {} : { replyTo: args.replyTo }
      });
    }
    let ids = successful.get(event.data.turn);
    if (!ids) successful.set(event.data.turn, ids = /* @__PURE__ */ new Set());
    ids.add(callId);
  }
  return [...turns.values()];
}

// src/framework/native-recovery-input.ts
import { createHash as createHash25 } from "node:crypto";
function resolveNativeRecoveryInput(delivery, lastRequest, inputs) {
  if (!delivery) return lastRequest === void 0 ? void 0 : { request: lastRequest, state: "unknown", active: false };
  const evidence = inputs.get(delivery.messageId);
  if (evidence && delivery.text !== void 0 && evidence.text !== delivery.text) {
    throw new Error("Saved native delivery body differs from its original input identity.");
  }
  return {
    request: delivery.request,
    state: evidence?.state ?? (delivery.confirmed ? "unknown" : "unadmitted"),
    active: evidence?.active === true,
    messageId: delivery.messageId,
    ...evidence?.text !== void 0 || delivery.text !== void 0 ? { text: evidence?.text ?? delivery.text } : {},
    ...evidence ? { source: evidence.source } : {}
  };
}
function nativeRecoveryWakeId(sessionId, turn, originalIdentity, pendingExplanation) {
  if (pendingExplanation && pendingExplanation.state !== "consumed") return pendingExplanation.id;
  return "native-continuation:" + createHash25("sha256").update(JSON.stringify([sessionId, turn ?? null, originalIdentity])).digest("hex");
}

// src/framework/role-runtime.ts
import { createHash as createHash29, randomUUID as randomUUID10 } from "node:crypto";
import { SessionId as SessionId3 } from "@deepseek-ai/dsh-session";

// src/adapters/dsh/agents.ts
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { MessageId, freezeMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { SessionId as SessionId2, deriveEventMessage as deriveEventMessage3, isAppendSurfaceEvent as isAppendSurfaceEvent4 } from "@deepseek-ai/dsh-session";

// src/adapters/dsh/progress.ts
function streamProgress(frame) {
  if (frame.type !== "chunk") return;
  const chunk = frame.chunk;
  if (chunk.type === "text-delta" && chunk.text.length) return "model-text";
  if (chunk.type === "reasoning-delta" && chunk.text.length) return "reasoning";
  if (chunk.type === "tool-call-delta" && (chunk.argumentsDelta.length || chunk.name?.length)) return "tool-progress";
}
var JobProgressTracker = class {
  constructor(owner, initial = []) {
    this.owner = owner;
    for (const job of initial) if (job.owner === owner && (job.status === "running" || job.status === "stopping")) {
      this.jobs.set(job.id, { total: job.output.total, progress: job.progress });
    }
  }
  jobs = /* @__PURE__ */ new Map();
  accept(event) {
    const owner = event.type === "output" ? event.owner : event.job.owner;
    if (owner !== this.owner) return;
    const id = event.type === "output" ? event.id : event.job.id;
    if (event.type === "removed" || event.type === "settled") {
      this.jobs.delete(id);
      return;
    }
    const previous = this.jobs.get(id);
    if (event.type === "output") {
      const total = previous?.total ?? 0;
      this.jobs.set(id, { ...previous, total: Math.max(total, event.total) });
      return event.total > total ? { source: "jobs/output", jobId: id } : void 0;
    }
    this.jobs.set(id, { total: Math.max(previous?.total ?? 0, event.job.output.total), progress: event.job.progress });
    if (event.type === "progress" && event.job.progress && event.job.progress !== previous?.progress) {
      return { source: "jobs/progress", jobId: id };
    }
  }
};
function observeDshProgress(agent, listener, now = Date.now) {
  const registry = agent.ctx.get("jobs");
  const tracker = new JobProgressTracker(agent.id, registry?.list(agent.id));
  const stream = agent.ctx.on("agent/assistant-stream", (event) => {
    if (event.agent !== agent) return;
    const kind2 = streamProgress(event.frame);
    if (kind2) listener({ kind: kind2, source: "assistant-stream", observedAt: now() });
  });
  const tool = agent.ctx.on("tools/result", (exec) => {
    if (exec.agent === agent) listener({ kind: "tool-progress", source: "tools/result", observedAt: now() });
    return void 0;
  });
  const jobs = registry?.events.subscribe({ owner: agent.id }, (event) => {
    const progress = tracker.accept(event);
    if (progress) listener({ kind: "tool-progress", ...progress, observedAt: now() });
  });
  return () => {
    stream();
    tool();
    jobs?.();
  };
}

// src/adapters/dsh/agents.ts
var DshAgentGateway = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  owned = /* @__PURE__ */ new Map();
  opening = /* @__PURE__ */ new Map();
  create(request) {
    const current = this.owned.get(request.sessionId);
    if (current !== void 0) return Promise.resolve(current);
    const pending = this.opening.get(request.sessionId);
    if (pending !== void 0) return pending;
    const operation = this.createOwned(request).finally(() => this.opening.delete(request.sessionId));
    this.opening.set(request.sessionId, operation);
    return operation;
  }
  get(sessionId) {
    return this.owned.get(sessionId);
  }
  hasLiveOwner(sessionId) {
    const id = SessionId2(sessionId);
    return this.ctx.agents.get(id) !== void 0 || (this.ctx.get("jobs")?.list(id).some((job) => job.owner === id && (job.status === "running" || job.status === "stopping")) ?? false);
  }
  async exists(sessionId) {
    const id = SessionId2(sessionId);
    if (this.ctx.agents.get(id) !== void 0) return true;
    const persistence = this.ctx.get("sessionPersistence");
    return persistence !== void 0 && await persistence.stat(id) !== void 0;
  }
  async createOwned(request) {
    const checkBeforeNative = () => {
      if (request.signal?.aborted) throw new DshAgentCreationCancelled(true, request.signal.reason);
    };
    checkBeforeNative();
    const sessionId = SessionId2(request.sessionId);
    if (this.ctx.agents.get(sessionId) !== void 0) {
      throw new Error(`Servant cannot acquire an Agent already owned by another runtime: ${sessionId}`);
    }
    const presets = this.ctx.get("agentPresets");
    if (request.presetId !== void 0 && presets === void 0) {
      throw new Error("The selected Servant preset requires the DSH agent preset registry.");
    }
    let presetId;
    try {
      presetId = presets === void 0 ? void 0 : (await presets.resolve(request.presetId)).id;
    } catch (error) {
      checkBeforeNative();
      throw error;
    }
    checkBeforeNative();
    const route = request.model ?? this.ctx.get("agentDefaultModel")?.currentSelection();
    const agentOptions = {
      ...route?.provider === void 0 ? {} : { provider: route.provider },
      ...route?.model === void 0 ? {} : { model: route.model },
      ...route?.reasoningEffort === void 0 ? {} : { reasoningEffort: route.reasoningEffort },
      ...route?.maxTokens === void 0 ? {} : { maxTokens: route.maxTokens }
    };
    let lastError;
    let setupEntered = false, setupReturned = false;
    const setup = async (agentCtx, agent2) => {
      setupEntered = true;
      request.signal?.throwIfAborted();
      agentCtx.on("agent/error", (event) => {
        if (event.agent === agent2) lastError = { message: errorChain(event.error), turn: event.turn, step: event.step };
      });
      if (presets !== void 0 && presetId !== void 0) await presets.mount(agentCtx, presetId);
      request.signal?.throwIfAborted();
      const loggedHeader = request.resume && request.model === void 0 ? agent2.session.requestHeader() : void 0;
      const selected = loggedHeader?.config ?? route;
      const reasoningEffort = loggedHeader?.adapterDefaults?.reasoningEffort === true ? void 0 : selected?.reasoningEffort;
      const provider = selected?.provider, model2 = selected?.model;
      if (provider && model2) agentCtx.effect(() => installModelSelection(agentCtx, {
        current: { provider, model: model2, ...reasoningEffort === void 0 ? {} : {
          reasoningEffort
        } },
        assembled: void 0
      }));
      const commit = await request.setup?.(agentCtx, agent2);
      request.signal?.throwIfAborted();
      setupReturned = true;
      return commit;
    };
    let native;
    try {
      native = request.resume ? await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup, signal: request.signal }) : await this.ctx.agents.create({
        sessionId,
        signal: request.signal,
        agentOptions,
        meta: { cwd: request.cwd, ...presetId === void 0 ? {} : { agentPreset: presetId } },
        setup
      });
    } catch (error) {
      if (request.signal?.aborted) throw new DshAgentCreationCancelled(
        setupEntered && !setupReturned && !this.hasLiveOwner(request.sessionId),
        request.signal.reason,
        setupEntered && !setupReturned ? "Creation was cancelled before setup returned: publication is fenced. Native rollback resource cleanup is not independently acknowledged." : "Native creation was cancelled before a handle was returned; native execution cleanup has not been confirmed."
      );
      throw error;
    }
    const agent = native.agent;
    const cancelAfterNative = async () => {
      if (!request.signal?.aborted) return;
      try {
        await native.dispose();
      } catch (error) {
        throw new DshAgentCreationCancelled(
          false,
          request.signal.reason,
          "Native creation cancellation cleanup failed: " + errorChain(error)
        );
      }
      throw new DshAgentCreationCancelled(true, request.signal.reason);
    };
    await cancelAfterNative();
    if (!request.resume && request.recentExchanges?.length) {
      try {
        agent.inject(freezeMessage({
          id: MessageId("servant-history:" + request.sessionId),
          role: "user",
          source: { kind: "deepseek-servant-history" },
          content: [{ type: "text", text: "Recent completed conversation exchanges, verbatim and chronological. These are historical originals for context; the next actual user input supplies the current request. Use dss_conversation_read with mode page and beforeId to page through earlier originals, or mode message and reference set to a known message id for one original.\n" + JSON.stringify(request.recentExchanges) }]
        }));
        await this.ctx.sessions.flush(agent.session);
      } catch (error) {
        try {
          await native.dispose();
        } catch (cleanup) {
          if (request.signal?.aborted) throw new DshAgentCreationCancelled(false, request.signal.reason, errorChain(cleanup));
          throw new AggregateError([error, cleanup], "Native history admission and cleanup failed");
        }
        if (request.signal?.aborted) throw new DshAgentCreationCancelled(true, request.signal.reason);
        throw error;
      }
    }
    await cancelAfterNative();
    let disposed = false, closing = false;
    let disposal;
    const admissions = /* @__PURE__ */ new Set();
    const messageAdmissions = /* @__PURE__ */ new Map();
    const progressSubscriptions = /* @__PURE__ */ new Set();
    const admit = (operation) => {
      const pending = Promise.resolve().then(operation);
      admissions.add(pending);
      void pending.then(() => admissions.delete(pending), () => admissions.delete(pending));
      return pending;
    };
    const jobs = () => agent.ctx.get("jobs")?.list(agent.id).filter((job) => job.owner === agent.id) ?? [];
    const handle = {
      sessionId: request.sessionId,
      actualAgent: agent,
      send: async (text, messageId, mode = "followup", source = request.role === "foreground" ? "user" : "deepseek-servant", recovery) => {
        if (closing || disposed) throw new Error(`Servant Agent is closing or disposed: ${request.sessionId}`);
        const predecessor = messageAdmissions.get(messageId);
        const operation = admit(async () => {
          await predecessor?.catch(() => void 0);
          if (closing || disposed) throw new Error(`Servant Agent is closing or disposed: ${request.sessionId}`);
          if (recovery) {
            if (source !== "deepseek-servant" || mode !== "followup" && mode !== "steer") throw new Error("Recovery delivery must be a waking plugin followup or steer input.");
            const input = deriveNativeInputs(agent.session.snapshotEvents(), {
              "next-turn": agent.inbox.nextTurn,
              "next-step": agent.inbox.nextStep
            }, agent.status === "running").get(messageId);
            if (input && (input.text !== text || input.source !== source)) throw new Error("Recovery input differs from its persisted native identity.");
            if (input?.state === "claimed" && !input.active && !recovery.replayInactiveClaim) {
              throw new Error("Inactive claimed recovery input requires confirmed prior execution stop.");
            }
            if (input?.state === "queued" && agent.status === "idle") {
              if (!agent.inbox.remove(MessageId(messageId))) throw new Error("Recovery inbox input changed before withdrawal.");
              await this.ctx.sessions.flush(agent.session);
              if (closing || disposed) throw new Error(`Servant Agent closed before recovery readmission: ${request.sessionId}`);
            }
          }
          if (handle.hasMessage(messageId)) {
            await this.ctx.sessions.flush(agent.session);
            return;
          }
          lastError = void 0;
          const message = freezeMessage({
            id: MessageId(messageId),
            role: "user",
            content: [{ type: "text", text }],
            source: source === "user" ? { kind: "user" } : { kind: "deepseek-servant" }
          });
          this.ctx.agents.withInitiator(agent, () => agent[mode](message));
          await this.ctx.sessions.flush(agent.session);
        });
        messageAdmissions.set(messageId, operation);
        void operation.finally(() => {
          if (messageAdmissions.get(messageId) === operation) messageAdmissions.delete(messageId);
        }).catch(() => void 0);
        return operation;
      },
      cancel: async () => {
        if (disposed) return;
        if (closing) return handle.dispose();
        return admit(async () => {
          agent.cancel({ kind: "user" });
          const registry = agent.ctx.get("jobs");
          for (const job of jobs()) {
            if (job.status === "running" || job.status === "stopping") registry?.kill(job.id, agent.id, "Servant execution stop requested");
          }
          await this.ctx.sessions.flush(agent.session);
        });
      },
      whenIdle: () => agent.whenIdle(),
      dispose: async () => {
        if (disposed) return;
        if (disposal) return disposal;
        closing = true;
        for (const unsubscribe of progressSubscriptions) unsubscribe();
        const pending = Promise.resolve().then(async () => {
          await Promise.allSettled([...admissions]);
          await native.dispose();
          disposed = true;
          if (this.owned.get(request.sessionId) === handle) this.owned.delete(request.sessionId);
        });
        disposal = pending;
        try {
          await pending;
        } finally {
          if (disposal === pending) disposal = void 0;
        }
      },
      observe: () => {
        if (disposed) return { state: "stopped", jobs: [] };
        const ownedJobs = jobs();
        return {
          state: agent.status === "running" ? "running" : ownedJobs.some((job) => job.status === "running" || job.status === "stopping") ? "waiting" : "idle",
          jobs: ownedJobs,
          ...lastError === void 0 ? {} : { error: { ...lastError } }
        };
      },
      getMessages: () => agent.session.deriveMessages(),
      hasMessage: (messageId) => {
        if (agent.inbox.nextTurn.some((message) => message.id === messageId) || agent.inbox.nextStep.some((message) => message.id === messageId)) return true;
        const events = agent.session.snapshotEvents();
        if (events.some((event) => isAppendSurfaceEvent4(event) && deriveEventMessage3(event)?.id === messageId)) return true;
        const input = deriveNativeInputs(events, { "next-turn": agent.inbox.nextTurn, "next-step": agent.inbox.nextStep }, agent.status === "running").get(messageId);
        return input?.state === "claimed" && input.active === true;
      },
      subscribeProgress: (listener) => {
        if (closing || disposed) return () => {
        };
        const stop = observeDshProgress(agent, (event) => {
          if (!closing && !disposed) listener(event);
        });
        const unsubscribe = () => {
          stop();
          progressSubscriptions.delete(unsubscribe);
        };
        progressSubscriptions.add(unsubscribe);
        return unsubscribe;
      },
      subscribe: (listener, terminalOnly = false) => {
        const onEvent = agent.ctx.on("session/event", (_session, event) => {
          if (!terminalOnly || event.type === "turn/end") listener();
        });
        const onStatus = agent.ctx.on("agent/status", () => listener());
        const onError = agent.ctx.on("agent/error", () => listener());
        const onJob = agent.ctx.get("jobs")?.events.subscribe({ owner: agent.id }, (event) => {
          const owner = event.type === "output" ? event.owner : event.job.owner;
          if (owner === agent.id) listener();
        });
        return () => {
          onEvent();
          onStatus();
          onError();
          onJob?.();
        };
      }
    };
    this.owned.set(request.sessionId, handle);
    return handle;
  }
};

// src/framework/observation-store.ts
import { createHash as createHash26 } from "node:crypto";
var DurableObservationStore = class {
  constructor(storage, scope) {
    this.storage = storage;
    this.prefix = "framework-observations/" + createHash26("sha256").update(scope).digest("hex") + "/";
  }
  prefix;
  key(workId) {
    return this.prefix + createHash26("sha256").update(workId).digest("hex");
  }
  get(workId) {
    return this.storage.get(this.key(workId));
  }
  set(workId, value) {
    return this.storage.set(this.key(workId), value);
  }
  async list() {
    return (await this.storage.list(this.prefix)).map((row) => row.value);
  }
};

// src/framework/recovery.ts
var OBSERVATION_INTERVALS_MS = [5 * 6e4, 5 * 6e4, 30 * 6e4];
var OBSERVATION_CYCLE_MS = OBSERVATION_INTERVALS_MS.reduce((sum, value) => sum + value, 0);
function createObservation(identity2, now) {
  return { identity: { ...identity2 }, cycleStartedAt: now, stageStartedAt: now, lastProgressAt: now, stage: 0 };
}
function recordProgress(state, kind2, now) {
  return kind2 === "connection-heartbeat" ? state : { ...state, lastProgressAt: Math.max(state.lastProgressAt, now) };
}
function dueObservation(state, now) {
  if (state.identity.role === "Foreground" || state.stage === 3) return { state };
  const since = Math.max(state.stageStartedAt, state.lastProgressAt);
  if (now - since < OBSERVATION_INTERVALS_MS[state.stage]) return { state };
  const stage = state.stage + 1;
  const kind2 = state.identity.role === "Helper" ? stage === 1 ? "probe-helper" : stage === 2 ? "warn-helper" : "restore-helper" : stage === 1 ? "probe-role" : stage === 2 ? "warn-role" : "restart-role";
  return { state: { ...state, stage, stageStartedAt: now }, action: {
    kind: kind2,
    identity: { ...state.identity },
    stage,
    elapsedMs: now - state.cycleStartedAt,
    silentMs: now - state.lastProgressAt
  } };
}
function rebindObservation(state, executionId, resumedAt) {
  if (state.identity.executionId !== executionId) return createObservation({ ...state.identity, executionId }, resumedAt);
  return { ...state, stageStartedAt: Math.max(state.stageStartedAt, resumedAt) };
}
function createRecoveryWatch(identity2, now) {
  return { ...identity2, cycleStartedAt: now, stageStartedAt: now, stage: 0 };
}
function dueRecoveryWatch(state, now) {
  if (now - state.stageStartedAt < 30 * 6e4) return { state };
  const stage = state.stage + 1;
  return { state: { ...state, stage, stageStartedAt: now }, action: {
    kind: "recovery-check",
    taskId: state.taskId,
    member: state.member,
    stage,
    elapsedMs: now - state.cycleStartedAt
  } };
}
function memberRecoveryEligible(member) {
  return member.inboxBodyBytes > 0 && (member.status === "running" || member.pendingBusiness);
}
function recoveryTargetKey(target) {
  return JSON.stringify([target.taskId, target.member, target.role, target.workerId ?? null]);
}
function scanMemberRecovery(members, scheduled = []) {
  const seen = new Set(scheduled.map(recoveryTargetKey)), targets = [];
  for (const member of members) {
    if (!memberRecoveryEligible(member) || !member.needsRecovery || member.workers.some((worker) => worker.executing)) continue;
    const notes = member.workers.filter((worker) => worker.noteBodyBytes > 0);
    const candidates = notes.length ? notes.map((worker) => ({
      role: "Worker",
      taskId: member.taskId,
      member: member.member,
      executionId: worker.executionId,
      workerId: worker.workerId,
      taskPath: member.taskPath,
      recordPath: worker.notePath,
      pendingSignals: [...member.pendingSignals]
    })) : member.plannerExecuting ? [] : [{
      role: "Planner",
      taskId: member.taskId,
      member: member.member,
      executionId: member.plannerExecutionId,
      taskPath: member.taskPath,
      recordPath: member.plannerMemoryPath,
      pendingSignals: [...member.pendingSignals]
    }];
    for (const target of candidates) {
      const key = recoveryTargetKey(target);
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(target);
      }
    }
  }
  return targets;
}

// src/framework/execution-observation.ts
var ExecutionObservations = class {
  constructor(store, scheduler, onError, now = Date.now) {
    this.store = store;
    this.scheduler = scheduler;
    this.onError = onError;
    this.now = now;
  }
  bindings = /* @__PURE__ */ new Map();
  tail = Promise.resolve();
  queue(operation) {
    const result = this.tail.then(operation);
    this.tail = result.then(() => void 0, () => void 0);
    return result;
  }
  active(binding) {
    const state = binding.agent.observe().state;
    return state === "running" || state === "waiting";
  }
  current(binding) {
    return this.bindings.get(binding.identity.workId) === binding;
  }
  async bind(identity2, agent) {
    if (identity2.role === "Foreground") {
      const prior = this.bindings.get(identity2.workId);
      if (prior) await this.unbind(identity2.workId, prior.identity.executionId);
      await this.queue(async () => {
        const saved = await this.store.get(identity2.workId);
        if (saved?.observation.identity.role === "Foreground" && saved.executing) await this.store.set(identity2.workId, { ...saved, executing: false });
      });
      return;
    }
    const old = this.bindings.get(identity2.workId);
    old?.unsubscribe();
    const binding = { identity: { ...identity2 }, agent, unsubscribe: () => {
    }, active: false };
    this.bindings.set(identity2.workId, binding);
    try {
      await this.queue(async () => {
        if (!this.current(binding)) return;
        const saved = await this.store.get(identity2.workId);
        if (!this.current(binding)) return;
        const previous = saved && old?.progress && saved.observation.identity.executionId === old.identity.executionId ? recordProgress(saved.observation, old.progress.kind, old.progress.observedAt) : saved?.observation;
        const observation = !previous ? createObservation(identity2, this.now()) : previous.identity.executionId !== identity2.executionId || !saved?.executing && this.active(binding) ? rebindObservation(previous, identity2.executionId, this.now()) : previous;
        const next = { ...saved, observation, executing: this.active(binding) };
        if (saved?.observation.identity.executionId !== identity2.executionId) {
          delete next.pending;
          delete next.resetInputs;
        }
        await this.store.set(identity2.workId, next);
      });
      if (!this.current(binding)) return;
      binding.active = this.active(binding);
      const progress = agent.subscribeProgress((event) => {
        if (!this.current(binding) || !this.active(binding)) return;
        if (!binding.progress || event.observedAt >= binding.progress.observedAt) binding.progress = event;
      });
      const status = agent.subscribe(() => {
        if (!this.current(binding)) return;
        const active = this.active(binding);
        if (active === binding.active) return;
        binding.active = active;
        void this.queue(() => this.synchronize(binding)).catch(this.onError);
      }, true);
      binding.unsubscribe = () => {
        progress();
        status();
      };
    } catch (error) {
      if (this.current(binding)) this.bindings.delete(identity2.workId);
      binding.unsubscribe();
      throw error;
    }
  }
  async synchronize(binding) {
    if (!this.current(binding)) return;
    const saved = await this.store.get(binding.identity.workId);
    if (!this.current(binding) || !saved || saved.observation.identity.executionId !== binding.identity.executionId) return;
    const executing = this.active(binding);
    const progress = binding.progress;
    if (executing === saved.executing && !progress) return;
    let observation = progress ? recordProgress(saved.observation, progress.kind, progress.observedAt) : saved.observation;
    if (executing && !saved.executing) observation = rebindObservation(observation, binding.identity.executionId, this.now());
    await this.store.set(binding.identity.workId, { ...saved, executing, observation });
    if (binding.progress === progress) binding.progress = void 0;
  }
  /** Invalidate synchronously before native cancellation/disposal; stale callbacks cannot cross executions. */
  async unbind(workId, executionId) {
    const binding = this.bindings.get(workId);
    if (!binding || binding.identity.executionId !== executionId) return;
    this.bindings.delete(workId);
    binding.unsubscribe();
    await this.queue(async () => {
      const saved = await this.store.get(workId);
      if (saved?.observation.identity.executionId === executionId) await this.store.set(workId, {
        ...saved,
        executing: false,
        observation: binding.progress ? recordProgress(saved.observation, binding.progress.kind, binding.progress.observedAt) : saved.observation
      });
    });
  }
  async tick() {
    await this.queue(async () => {
      const errors = [];
      for (const binding of this.bindings.values()) {
        try {
          await this.synchronize(binding);
          const saved = await this.store.get(binding.identity.workId);
          if (binding.identity.role === "Foreground" || !this.current(binding) || !saved?.executing || saved.observation.identity.executionId !== binding.identity.executionId) continue;
          const due = saved.pending ? void 0 : dueObservation(saved.observation, this.now());
          const pending = saved.pending ?? (due?.action ? {
            id: JSON.stringify([binding.identity.workId, binding.identity.executionId, due.state.cycleStartedAt, due.action.stage, due.state.lastProgressAt]),
            action: due.action,
            cycleStartedAt: due.state.cycleStartedAt,
            checkedAt: due.state.cycleStartedAt + due.action.elapsedMs,
            progressAt: due.state.lastProgressAt
          } : void 0);
          if (!pending) continue;
          const next = { ...saved, observation: due?.state ?? saved.observation, pending };
          await this.store.set(binding.identity.workId, next);
          if (!this.current(binding) || !this.active(binding)) continue;
          await this.scheduler.arrange(pending);
          delete next.pending;
          await this.store.set(binding.identity.workId, next);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Observation arrangements failed");
    });
  }
  /** Re-check queued recovery against current execution and progress immediately before acting. */
  async mayApply(pending) {
    const { action } = pending;
    const binding = this.bindings.get(action.identity.workId);
    if (action.identity.role === "Foreground" || !binding || binding.identity.executionId !== action.identity.executionId) return false;
    const saved = await this.store.get(action.identity.workId);
    if (!this.current(binding) || !this.active(binding) || !saved || saved.observation.identity.executionId !== action.identity.executionId) return false;
    const progressAt = Math.max(saved.observation.lastProgressAt, binding.progress?.observedAt ?? -Infinity);
    return saved.observation.cycleStartedAt === pending.cycleStartedAt && saved.observation.stage === action.stage && progressAt <= pending.progressAt;
  }
  /** Only the runtime which proved that this action was not performed may defer it.
   * New native progress postpones the same phase; it is not an explicit cycle reset. */
  async deferUnperformed(pending) {
    await this.queue(async () => {
      const identity2 = pending.action.identity;
      const binding = this.bindings.get(identity2.workId);
      const current = () => binding && this.current(binding) && this.active(binding) && ["workId", "executionId", "role", "taskId", "member", "workerId"].every((key) => binding.identity[key] === identity2[key]);
      if (identity2.role === "Foreground" || !current()) return;
      await this.synchronize(binding);
      const saved = await this.store.get(identity2.workId);
      if (!current() || !saved || saved.observation.identity.executionId !== identity2.executionId || saved.observation.cycleStartedAt !== pending.cycleStartedAt || saved.observation.stage !== pending.action.stage || saved.observation.stageStartedAt !== pending.checkedAt || saved.pending && saved.pending.id !== pending.id) return;
      const progress = binding.progress;
      const observation = progress ? recordProgress(saved.observation, progress.kind, progress.observedAt) : saved.observation;
      if (observation.lastProgressAt <= pending.progressAt) return;
      const next = { ...saved, observation: {
        ...observation,
        stage: pending.action.stage - 1
      } };
      delete next.pending;
      await this.store.set(identity2.workId, next);
      if (binding.progress === progress) binding.progress = void 0;
    });
  }
  /** Runtime proves this native probe was consumed by this exact execution before
   * calling. Queued delivery is not that proof. Receipt and reset share one write,
   * so retrying a lost acknowledgement cannot reset a later observation cycle. */
  async reset(identity2, probeInputId, cycleStartedAt) {
    await this.queue(async () => {
      const binding = this.bindings.get(identity2.workId);
      const current = () => binding && this.current(binding) && this.active(binding) && ["workId", "executionId", "role", "taskId", "member", "workerId"].every((key) => binding.identity[key] === identity2[key]);
      if (identity2.role === "Foreground" || !probeInputId || !current()) throw new Error("Observation reset requires the current active execution.");
      await this.synchronize(binding);
      const saved = await this.store.get(identity2.workId);
      if (!current() || !saved || saved.observation.identity.executionId !== identity2.executionId) throw new Error("Observation reset requires the current active execution.");
      if (saved.resetInputs?.includes(probeInputId)) return;
      if (saved.observation.cycleStartedAt !== cycleStartedAt) throw new Error("Observation reset belongs to an obsolete cycle.");
      const next = {
        ...saved,
        observation: createObservation(identity2, this.now()),
        resetInputs: [...saved.resetInputs ?? [], probeInputId]
      };
      delete next.pending;
      await this.store.set(identity2.workId, next);
    });
  }
  async flush() {
    await this.queue(async () => {
      for (const binding of this.bindings.values()) await this.synchronize(binding);
    });
  }
  async dispose() {
    for (const binding of [...this.bindings.values()]) await this.unbind(binding.identity.workId, binding.identity.executionId);
    await this.flush();
  }
};

// src/framework/artifacts.ts
import { createHash as createHash27 } from "node:crypto";
var sha2562 = (value) => createHash27("sha256").update(value).digest("hex");
var manifestPath = (path3) => "technical/artifacts/manifests/" + sha2562(path3) + ".json";
var encode2 = (value) => JSON.stringify(value) + "\n";
var WINDOW2 = 1024 * 1024;
var FrameworkArtifacts = class {
  constructor(ctx, files, transactions, workspace) {
    this.ctx = ctx;
    this.files = files;
    this.transactions = transactions;
    this.workspace = workspace;
  }
  async preserve(commandId, input, options = {}) {
    const destination2 = filePath(input.destinationPath);
    const archive = paths.archive(input.taskId);
    if (!destination2.startsWith(archive + "/")) throw new Error("An artifact destination must be inside its task archive.");
    if (destination2 === archive + "/records.md" || destination2 === archive + "/retention.json") throw new Error("This archive path is reserved for task records, not artifact bytes.");
    if (!input.sourcePath.trim()) throw new Error("An artifact source path is required.");
    const name2 = input.name ?? destination2.slice(destination2.lastIndexOf("/") + 1);
    const request = { taskId: input.taskId, sourcePath: input.sourcePath, destinationPath: destination2, name: name2, cwd: options.cwd ?? this.workspace };
    const requestHash = sha2562(JSON.stringify(request));
    const receiptPath = "technical/artifacts/commands/" + sha2562(commandId) + ".json";
    await this.transactions.run(commandId, request, options, async (snapshot) => {
      const old = await this.files.read(snapshot, receiptPath);
      if (old !== void 0) {
        const receipt = JSON.parse(old);
        if (receipt.requestHash !== requestHash) throw new Error("Artifact command arguments changed.");
        await this.readAt(snapshot, receipt.artifact.path);
        return [];
      }
      const data = await this.capture(input.sourcePath, request.cwd, options.signal);
      const artifact = { path: destination2, manifestPath: manifestPath(destination2), name: name2, sha256: sha2562(data), bytes: data.byteLength };
      const existing = await this.files.readBytes(snapshot, destination2);
      if (existing !== void 0) {
        const prior = await this.readAt(snapshot, destination2);
        if (prior.artifact.sha256 !== artifact.sha256 || prior.artifact.name !== name2) throw new Error("An archived artifact reference cannot be overwritten with different content or identity.");
      }
      const manifest = { version: 1, taskId: input.taskId, ...artifact };
      return [
        { path: destination2, bytes: data },
        { path: artifact.manifestPath, content: encode2(manifest) },
        { path: receiptPath, content: encode2({ version: 1, requestHash, artifact }) }
      ];
    });
    return withSnapshot(this.files, async (snapshot) => {
      const raw = await this.files.read(snapshot, receiptPath);
      if (raw === void 0) throw new Error("Committed artifact receipt is missing.");
      const receipt = JSON.parse(raw);
      if (receipt.version !== 1 || receipt.requestHash !== requestHash) throw new Error("Artifact receipt does not match the command.");
      const result = await this.readAt(snapshot, receipt.artifact.path);
      if (JSON.stringify(result.artifact) !== JSON.stringify(receipt.artifact)) throw new Error("Artifact receipt and manifest disagree.");
      return result.artifact;
    });
  }
  /** For the download endpoint: returns original bytes only after complete verification. */
  read(path3) {
    return withSnapshot(this.files, (snapshot) => this.readAt(snapshot, filePath(path3)));
  }
  async readAt(snapshot, path3) {
    const index = manifestPath(filePath(path3)), raw = await this.files.read(snapshot, index);
    if (raw === void 0) throw new Error("Artifact manifest is missing: " + path3);
    const manifest = JSON.parse(raw);
    if (manifest.version !== 1 || manifest.path !== path3 || manifest.manifestPath !== index || !path3.startsWith(paths.archive(manifest.taskId) + "/") || typeof manifest.name !== "string" || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("Invalid artifact manifest: " + path3);
    const data = await this.files.readBytes(snapshot, path3);
    if (data === void 0 || data.byteLength !== manifest.bytes || sha2562(data) !== manifest.sha256) throw new Error("Artifact integrity verification failed: " + path3);
    const artifact = { path: path3, manifestPath: index, name: manifest.name, sha256: manifest.sha256, bytes: manifest.bytes };
    return { artifact, data };
  }
  async capture(sourcePath, cwd, signal) {
    signal?.throwIfAborted();
    const target = await this.ctx.fs.resolve(sourcePath, { cwd, signal });
    const before = await this.ctx.fs.stat(target, signal);
    if (!before || before.type !== "file") throw new Error("Artifact source must be an existing regular file.");
    const chunks = [];
    let offset = 0;
    for (; ; ) {
      signal?.throwIfAborted();
      const chunk = await this.ctx.fs.readByteRange(target, { offset, length: WINDOW2 }, signal);
      if (chunk.byteLength > WINDOW2) throw new Error("Filesystem returned more bytes than the requested window.");
      if (chunk.byteLength === 0) break;
      chunks.push(chunk.slice());
      offset += chunk.byteLength;
    }
    const after = await this.ctx.fs.stat(target, signal);
    if (!after || after.type !== "file" || after.version !== before.version || after.size !== before.size || after.size !== void 0 && after.size !== offset) throw new Error("Artifact source changed while being captured; no archive was written.");
    signal?.throwIfAborted();
    return Buffer.concat(chunks, offset);
  }
};

// src/framework/host-loop.ts
import { randomUUID as randomUUID9, createHash as createHash28 } from "node:crypto";
var digest8 = (value) => createHash28("sha256").update(value).digest("hex");
var singleton = (role) => role === "Foreground" || role === "Organizer" || role === "Helper";
var FrameworkHostLoop = class {
  constructor(files, transactions, storage, identity2, members, actions) {
    this.files = files;
    this.transactions = transactions;
    this.storage = storage;
    this.identity = identity2;
    this.members = members;
    this.actions = actions;
    this.key = "framework-host/" + digest8(identity2.scope);
    this.metadata = new FrameworkTaskIndex(files, (error) => actions.error(error), () => actions.changed?.());
  }
  metadata;
  seenSources = /* @__PURE__ */ new Map();
  record = { initial: {}, completed: {} };
  timer;
  running;
  observing;
  connected = false;
  stopping = false;
  key;
  async start() {
    if (this.connected) return;
    this.stopping = false;
    this.record = await this.storage.get(this.key) ?? { initial: {}, completed: {} };
    if (this.stopping) return;
    await this.actions.startup();
    if (this.stopping) return;
    this.connected = true;
    const first = this.poll();
    this.schedule();
    try {
      await first;
    } catch (error) {
      this.actions.error(error);
    }
  }
  schedule() {
    if (!this.connected) return;
    this.timer = setTimeout(() => {
      this.timer = void 0;
      void this.drive().catch(this.actions.error).finally(() => this.schedule());
    }, 1e3);
  }
  async stop() {
    this.stopping = true;
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = void 0;
    const settled = await Promise.allSettled([this.observing, this.running]);
    const failures = settled.filter((item) => item.status === "rejected").map((item) => item.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Host loop operations did not settle successfully");
  }
  observeLocal() {
    if (this.stopping) return Promise.resolve();
    if (this.observing) return this.observing;
    const operation = Promise.resolve().then(() => {
      if (!this.stopping) return this.actions.observeLocal?.();
    }).catch((error) => this.actions.error(error));
    this.observing = operation;
    void operation.finally(() => {
      if (this.observing === operation) this.observing = void 0;
    }).catch(() => {
    });
    return operation;
  }
  /** Timer driver never queues another remote poll behind an unresolved one. */
  async drive() {
    await this.observeLocal();
    if (this.stopping || this.running) return;
    const owned = this.remotePoll();
    void owned.catch((error) => this.actions.error(error));
  }
  /** Explicit callers still await the actual remote poll, not just admission. */
  async poll() {
    await this.observeLocal();
    await this.remotePoll();
  }
  remotePoll() {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    const operation = Promise.resolve().then(() => {
      if (!this.stopping) return this.runPoll();
    });
    this.running = operation;
    void operation.finally(() => {
      if (this.running === operation) this.running = void 0;
    }).catch(() => {
    });
    return operation;
  }
  async save() {
    await this.storage.set(this.key, this.record);
  }
  async wake(role, snapshot, sources, taskId, workerId) {
    if (this.stopping || !sources.length || this.actions.executing(role, singleton(role) ? void 0 : taskId, workerId)) return false;
    return await this.actions.wake({
      id: digest8(JSON.stringify([role, taskId, workerId, snapshot.revision, sources.map((source) => source.path)])),
      role,
      taskId,
      workerId,
      sources: sources.map(({ path: path3, version }) => ({ path: path3, version })),
      reason: "notification"
    }) !== false;
  }
  async runPoll() {
    try {
      await this.actions.observe();
    } catch (error) {
      this.actions.error(error);
    }
    if (this.stopping) return;
    const snapshot = await this.files.snapshot().catch((error) => {
      this.actions.discoveryInterrupted?.();
      throw error;
    });
    let scheduled = false;
    try {
      try {
        await this.actions.discover?.(snapshot);
      } catch (error) {
        this.actions.error(error);
      }
      if (this.stopping) return;
      const entries = await this.files.listDirectory(snapshot, "tasks/");
      const tasks = await this.metadata.list(snapshot, entries);
      if (this.stopping) return;
      const locallyReleased = new Set(Object.entries(this.record.completed).filter(([, value]) => value.released).map(([id]) => id));
      const manuallyCleared = /* @__PURE__ */ new Set(), unreadableCleanup = /* @__PURE__ */ new Set();
      if (this.files instanceof LocalFiles) for (const task of tasks) {
        if (this.record.completed[task.taskId]?.released) continue;
        try {
          const cleanup = await readJson(this.files, snapshot, cleanupRecordPath(task.taskId));
          if (cleanup?.version === 1 && cleanup.taskId === task.taskId && cleanup.phase === "released" && cleanup.historyCleared === true) manuallyCleared.add(task.taskId);
        } catch (error) {
          this.actions.error(error);
          unreadableCleanup.add(task.taskId);
        }
      }
      if (this.identity.primary) {
        for (const entry of entries.filter((entry2) => /_(P|O)\.md$/.test(entry2.path))) {
          if (this.seenSources.get(entry.path) === entry.version) continue;
          if (manuallyCleared.size || unreadableCleanup.size || locallyReleased.size) {
            const sourceTask = taskIdentity(await this.files.read(snapshot, entry.path) ?? "");
            if (sourceTask && (manuallyCleared.has(sourceTask) || unreadableCleanup.has(sourceTask) || locallyReleased.has(sourceTask))) {
              this.seenSources.set(entry.path, entry.version);
              continue;
            }
          }
          const command = "initialize:" + digest8(entry.path + ":" + entry.version);
          let assignment = this.record.initial[command];
          if (!assignment) {
            assignment = { taskId: randomUUID9(), owner: this.identity.member, members: [...this.members()] };
            this.record.initial[command] = assignment;
            await this.save();
          }
          if (this.stopping) return;
          let mutated;
          try {
            await this.transactions.run(
              command,
              { source: entry.path, ...assignment },
              { snapshot, expectedRevision: snapshot.revision, reevaluate: true },
              async (checked) => {
                const changes = (await initializeTask(this.files, checked, entry.path, assignment.owner, assignment.members, assignment.taskId)).changes;
                mutated = changes.length > 0;
                return changes;
              }
            );
          } catch (error) {
            if (error instanceof FilesConflictError) return;
            throw error;
          }
          this.seenSources.set(entry.path, entry.version);
          if (mutated === false) continue;
          return;
        }
      }
      const global = await this.files.listDirectory(snapshot, "state/");
      if (this.identity.primary) scheduled = await this.wake("Foreground", snapshot, global.filter((entry) => entry.path.split("/").at(-1).startsWith("Foreground_"))) || scheduled;
      for (const source of global) {
        const direct = parseDirectSignal(source.path.split("/").at(-1));
        if (!direct || direct.member !== this.identity.member) continue;
        scheduled = await this.wake(direct.role, snapshot, [source], void 0, direct.role === "Worker" ? direct.id : void 0) || scheduled;
      }
      for (const task of tasks) {
        if (this.stopping) return;
        try {
          if (this.record.completed[task.taskId]?.released || unreadableCleanup.has(task.taskId)) continue;
          if (manuallyCleared.has(task.taskId)) {
            await this.actions.releaseTask(task.taskId);
            const completion = this.record.completed[task.taskId] ??= {};
            completion.released = true;
            await this.save();
            continue;
          }
          if (task.status === "complete") {
            const completion = this.record.completed[task.taskId] ??= {};
            if (completion.released) continue;
            if (!completion.sealed) {
              try {
                await this.actions.sealBusiness(task);
                completion.sealed = true;
                await this.save();
              } catch (error) {
                this.actions.error(error);
              }
            }
            if (this.identity.primary && task.owner === this.identity.member) {
              for (const role of ["Foreground", "Recorder"]) if (!completion[role]) {
                try {
                  const created = await this.actions.wake({
                    id: "complete:" + task.taskId + ":" + role,
                    role,
                    taskId: task.taskId,
                    sources: [{ path: paths.task(task.taskId), version: entries.find((entry) => entry.path === paths.task(task.taskId)).version }],
                    reason: "business-complete"
                  });
                  scheduled = created !== false || scheduled;
                  completion[role] = true;
                  await this.save();
                } catch (error) {
                  this.actions.error(error);
                }
              }
              if (await this.actions.clean(task, snapshot)) {
                completion.released = true;
                await this.save();
              }
            } else {
              try {
                const cleanup = await readJson(this.files, snapshot, cleanupRecordPath(task.taskId));
                if (cleanup?.version === 1 && cleanup.taskId === task.taskId && (cleanup.phase === "files-cleaned" || cleanup.phase === "released")) {
                  await this.actions.releaseTask(task.taskId);
                  completion.released = true;
                  await this.save();
                }
              } catch (error) {
                this.actions.error(error);
              }
            }
            continue;
          }
          if (task.status !== "running") continue;
          const changes = await discoverInbox(this.files, snapshot, task.taskId, this.identity.member);
          if (changes.length) {
            try {
              await this.transactions.run(
                "inbox:" + task.taskId + ":" + digest8(JSON.stringify(changes)),
                changes.map(({ path: path3, content }) => ({ path: path3, hash: digest8(content ?? "") })),
                { snapshot, expectedRevision: snapshot.revision, reevaluate: true },
                async () => changes
              );
            } catch (error) {
              if (error instanceof FilesConflictError) return;
              throw error;
            }
            return;
          }
          const signals = await this.files.listDirectory(snapshot, paths.state(this.identity.member, task.taskId));
          scheduled = await this.wake("Planner", snapshot, signals.filter((entry) => entry.path.split("/").at(-1).startsWith("Planner_")), task.taskId) || scheduled;
          for (const source of signals.filter((entry) => entry.path.split("/").at(-1).startsWith("Worker_"))) {
            const child = signalWorkerId(source.path.split("/").at(-1));
            if (!child) continue;
            scheduled = await this.wake("Worker", snapshot, [source], task.taskId, child) || scheduled;
          }
          if (this.identity.primary && task.owner === this.identity.member && task.route === "O") {
            const organizer = signals.filter((entry) => entry.path.split("/").at(-1).startsWith("Organizer_"));
            for (const member of task.members ?? this.members()) {
              const path3 = paths.state(member, task.taskId) + "/complete";
              const memberSignals = member === this.identity.member ? signals : await this.files.listDirectory(snapshot, paths.state(member, task.taskId));
              const completion = memberSignals.find((entry) => entry.path === path3);
              if (completion) organizer.push(completion);
            }
            scheduled = await this.wake("Organizer", snapshot, organizer, task.taskId) || scheduled;
          }
        } catch (error) {
          this.actions.error(error);
        }
      }
    } finally {
      await snapshot.release();
      if (scheduled && !this.stopping) await this.actions.admitDiscovered?.();
    }
  }
};

// src/framework/role-runtime.ts
var hash12 = (value) => createHash29("sha256").update(value).digest("hex");
var FrameworkRoleRuntime = class {
  constructor(ctx, files, records, config, environment) {
    this.ctx = ctx;
    this.files = files;
    this.records = records;
    this.config = config;
    this.environment = environment;
    this.foregroundActivity = typeof ctx.inject === "function" ? ensureForegroundActivity(ctx) : void 0;
    this.prefix = "framework-runtime/" + hash12(config.scope) + "/";
    this.controls = new ExecutionControls(records, config.scope);
    this.transactions = new FrameworkTransactions(files, records, config.scope);
    this.conversation = new FrameworkConversation(files, this.transactions, { mode: config.mode, collaborationId: config.collaborationId });
    this.gateway = new DshAgentGateway(ctx);
    this.observationStore = new DurableObservationStore(records, config.scope);
    this.observations = new ExecutionObservations(this.observationStore, { arrange: (pending) => this.enqueueObservation(pending) }, (error) => this.error(error));
    this.native = new NativeExecutions(ctx, this.gateway, this.observations, { save: async (evidence) => {
      const record = this.roleRecords.get(evidence.workId);
      if (!record || record.identity.executionId !== evidence.executionId) throw new Error("Stop evidence no longer matches its execution.");
      await this.saveRole({ ...record, stopIntent: evidence }, true);
    } });
    this.cleaner = new FrameworkCleaner(files, this.transactions, (task) => this.releaseTask(task));
    this.loop = new FrameworkHostLoop(files, this.transactions, records, config, () => environment.members(), {
      wake: (request) => this.wake(request),
      admitDiscovered: async () => {
        this.startOwnedPump();
      },
      executing: (role, task, worker) => this.executing(role, task, worker),
      changed: () => environment.changed?.(),
      startup: () => this.startup(),
      observeLocal: async () => {
        await this.checkWakeAdmissions();
        if (!this.closed) void this.restorePending().catch((error) => this.error(error));
        await this.observations.tick();
        if (!this.closed) await this.processObservations(false, "native");
      },
      observe: () => this.observe(),
      discover: (snapshot) => this.discover(snapshot),
      discoveryInterrupted: () => environment.observationInterrupted?.(),
      error: (error) => this.error(error),
      sealBusiness: (task) => this.sealBusiness(task.taskId),
      clean: (task, snapshot) => this.clean(task, snapshot),
      releaseTask: (taskId) => this.releaseLocalTask(taskId)
    });
  }
  controls;
  transactions;
  conversation;
  observations;
  native;
  loop;
  cleaner;
  foregroundActivity;
  foregroundVisibility;
  foregroundFinal;
  gateway;
  observationStore;
  prefix;
  roleRecords = /* @__PURE__ */ new Map();
  stopOperations;
  pumping;
  helperPumping;
  restoring;
  targetedPumps = /* @__PURE__ */ new Map();
  admissionCancellations = /* @__PURE__ */ new Map();
  wakeWrites = /* @__PURE__ */ new Map();
  admissionNow = () => Date.now();
  closed = false;
  bootId = randomUUID10();
  taskMetadataIndex;
  skillProviders = /* @__PURE__ */ new Map();
  workOperations;
  pendingForegroundResets;
  roleWrites;
  recoveryWatchWrites;
  errorTail = Promise.resolve();
  disposing;
  shutdownReason;
  rateLimitDiagnostics;
  /** An explicitly confirmed Local history operation owns only Foreground.
   * Its fixed prior execution cannot be replaced by a later session on retry. */
  async withForegroundReset(commandId, action) {
    if (this.config.mode !== "local" || !commandId) throw new Error("Foreground history reset requires an explicit Local command.");
    const workId = this.roleKey("Foreground"), key = this.prefix + "foreground-resets/" + hash12(commandId);
    return this.serialWork(workId, async () => {
      let reset = await this.records.get(key);
      if (!reset) {
        const stored = await this.records.get(this.prefix + "roles/" + hash12(workId));
        const target = this.roleRecords.get(workId) ?? (stored?.released ? void 0 : stored);
        const wakes = (await this.records.list(this.prefix + "wakes/")).filter((row) => this.requestKey(row.value.request) === workId);
        const pendingTasks = /* @__PURE__ */ new Map();
        for (const row of wakes) if (!row.value.delivered && row.value.request.taskId) pendingTasks.set(row.value.request.taskId, row.value.request);
        const prior = target?.delivery?.request ?? target?.lastWake;
        if (prior?.taskId && !target?.completedRound) pendingTasks.set(prior.taskId, prior);
        reset = { commandId, phase: "planned", ...target ? { target } : {}, wakeKeys: wakes.map((row) => row.key), pendingTasks: [...pendingTasks.values()] };
        await this.records.set(key, reset);
      }
      const pendingResets = this.pendingForegroundResets ??= /* @__PURE__ */ new Set();
      if (reset.phase !== "complete") pendingResets.add(commandId);
      else pendingResets.delete(commandId);
      if (reset.phase === "planned") {
        if (reset.target) {
          const stored = await this.records.get(this.prefix + "roles/" + hash12(workId));
          const current = this.roleRecords.get(workId) ?? stored;
          if (current && current.identity.executionId !== reset.target.identity.executionId) throw new Error("The Foreground reset target changed before its retirement was confirmed.");
          if (current && !current.released) {
            this.roleRecords.set(workId, current);
            if (!current.stopped) {
              await this.finishForegroundRound(current);
              const result2 = await this.stopOwnedRecord(this.roleRecords.get(workId) ?? current);
              if (result2.status !== "stopped") throw new Error(result2.status === "unconfirmed" ? result2.reason : "Foreground ownership changed while clearing its history.");
            }
            const stopped = this.roleRecords.get(workId) ?? current;
            const capturedMessageIds = [];
            for (const [id, signature] of Object.entries(stopped.foregroundMessages ?? {})) {
              const message = await this.conversation.read(id);
              if (!message) continue;
              if (message.role !== "assistant" || this.foregroundMessageSignature(message) !== signature) throw new Error("An old Foreground output identity no longer matches its saved message.");
              capturedMessageIds.push(id);
            }
            reset = { ...reset, capturedMessageIds };
            await this.records.set(key, reset);
            await this.saveRole({ ...stopped, stopped: true, released: true });
            this.roleRecords.delete(workId);
          }
        }
        for (const wakeKey of reset.wakeKeys) {
          const wake = await this.records.get(wakeKey);
          if (wake) await this.updateWake(wakeKey, (current) => current ? { ...current, delivered: true, admission: void 0 } : void 0);
        }
        for (const prior of reset.pendingTasks) await this.wake({
          id: "history-reset-delivery:" + hash12(commandId + "\0" + prior.taskId),
          role: "Foreground",
          taskId: prior.taskId,
          reason: "business-complete",
          sources: [],
          context: { facts: "Conversation history was explicitly cleared. Inspect this completed Task and deliver its still-pending result in the new conversation." }
        });
        reset = { ...reset, phase: "retired" };
        await this.records.set(key, reset);
      }
      const result = await action(reset.capturedMessageIds ?? []);
      if (reset.phase !== "complete") await this.records.set(key, { ...reset, phase: "complete" });
      pendingResets.delete(commandId);
      return result;
    });
  }
  async manuallyCleared(taskId, snapshot) {
    if (!taskId || this.config.mode !== "local") return false;
    const read = async (view) => {
      const value = await readJson(this.files, view, cleanupRecordPath(taskId));
      return value?.version === 1 && value.taskId === taskId && value.phase === "released" && value.historyCleared === true;
    };
    return snapshot ? read(snapshot) : withSnapshot(this.files, read);
  }
  /** Read-only evidence, not a request to stop anything. An intent alone, idle
   * native registry or an unknown producer never establishes safe deletion. */
  async cancelledTaskCleanupEvidence(taskId) {
    if (this.config.mode !== "local") return void 0;
    const intent = await this.controls.task(taskId);
    if (intent?.intent !== "cancelled") return void 0;
    const task = await withSnapshot(this.files, (snapshot) => readJson(this.files, snapshot, paths.task(taskId)));
    if (!task || task.status !== "running") return void 0;
    const records = new Map((await this.records.list(this.prefix + "roles/")).map((row) => [row.value.identity.workId, row.value]));
    for (const [key, value] of this.roleRecords) records.set(key, value);
    const settled = [];
    for (const record of [...records.values()].sort((a, b) => a.identity.workId.localeCompare(b.identity.workId))) {
      const related = record.identity.taskId === taskId || record.identity.role === "Organizer" && task.route === "O" && await this.currentTask(record) === taskId;
      if (!related) continue;
      if (!record.stopped && !record.released || this.active(record)) return void 0;
      settled.push([record.identity.workId, record.identity.executionId, record.sessionId, record.generation, !!record.stopped, !!record.released]);
    }
    const current = await this.controls.task(taskId);
    if (current?.commandId !== intent.commandId || current.intent !== "cancelled") return void 0;
    return { commandId: intent.commandId, signature: hash12(JSON.stringify([taskId, intent.commandId, settled])) };
  }
  /** Manual history deletion follows real task cleanup; it never substitutes a
   * user intent bit for producer settlement or marks running work complete. */
  async prepareTaskCleanup(taskId) {
    if (this.config.mode !== "local") throw new Error("Manual task history cleanup is Local only.");
    const currentTask = await withSnapshot(this.files, async (snapshot) => {
      const task = await readJson(this.files, snapshot, paths.task(taskId));
      if (!task) return false;
      if (await this.manuallyCleared(taskId, snapshot)) return "released";
      if (task.status === "running" && await this.cancelledTaskCleanupEvidence(taskId)) return "cancelled";
      const cleanup = await readJson(this.files, snapshot, cleanupRecordPath(taskId));
      if (task.status !== "complete" || cleanup?.version !== 1 || cleanup.taskId !== taskId || cleanup.phase !== "released") {
        throw new Error("Task history cleanup requires its actual completed and released task.");
      }
      return true;
    });
    if (currentTask === "cancelled") return;
    if (!currentTask) {
      const records = await this.records.list(this.prefix + "roles/");
      if (records.some((row) => row.value.identity.taskId === taskId && !row.value.released) || [...this.roleRecords.values()].some((record) => record.identity.taskId === taskId && !record.released)) {
        throw new Error("Retained legacy history still has an owned execution responsibility.");
      }
      return;
    }
    for (const row of await this.records.list(this.prefix + "roles/")) {
      if (row.value.identity.taskId === taskId && !row.value.released && !this.roleRecords.has(row.value.identity.workId)) {
        this.roleRecords.set(row.value.identity.workId, row.value);
      }
    }
    for (const record of this.roleRecords.values()) if (currentTask === "released" && record.identity.role === "Organizer" && await this.currentTask(record) === taskId) {
      if (!record.stopped || this.active(record)) throw new Error("Organizer producer is not confirmed stopped for this Task.");
      await this.observations.unbind(record.identity.workId, record.identity.executionId);
    }
    await this.releaseLocalTask(taskId);
  }
  updateWorkerSeats(workerSeats) {
    if (!Number.isSafeInteger(workerSeats) || workerSeats < 0) throw new Error("Worker seats must be a nonnegative integer.");
    this.config.workerSeats = workerSeats;
  }
  async start() {
    if (this.closed) throw new Error("Framework runtime is disposed.");
    for (const row of await this.records.list(this.prefix + "roles/")) if (!row.value.released) this.roleRecords.set(row.value.identity.workId, row.value);
    this.pendingForegroundResets = new Set((await this.records.list(this.prefix + "foreground-resets/")).filter((row) => row.value.phase !== "complete").map((row) => row.value.commandId));
    if (this.closed) throw new Error("Framework runtime is disposed.");
    await this.loop.start();
  }
  roleKey(role, taskId, workerId, directId) {
    return JSON.stringify([role, role === "Foreground" || role === "Organizer" || role === "Helper" ? null : taskId ?? null, workerId ?? null, directId ?? null]);
  }
  requestKey(request) {
    const direct = request.sources.map((source) => parseDirectSignal(source.path.split("/").at(-1))).find(Boolean);
    return this.roleKey(request.role, request.taskId, request.workerId, direct?.id);
  }
  saveRole(record, evidenceUpdate = false, deliveryUpdate) {
    this.roleWrites ??= /* @__PURE__ */ new Map();
    const workId = record.identity.workId;
    const operation = (this.roleWrites.get(workId) ?? Promise.resolve()).catch(() => {
    }).then(async () => {
      const latest = this.roleRecords.get(workId), incomingDelivery = record.delivery;
      if (!latest && record.identity.role === "Organizer") {
        const previous = await this.records.get(this.prefix + "roles/" + hash12(workId));
        if (previous?.released && previous.identity.executionId === record.identity.executionId) return;
      }
      if (!latest && record.identity.taskId && (await this.records.get(this.prefix + "sealed/" + hash12(record.identity.taskId)))?.released) return;
      if (evidenceUpdate) {
        if (!latest || latest.identity.executionId !== record.identity.executionId) throw new Error("Stop evidence execution was replaced before persistence.");
        record = { ...latest, stopIntent: record.stopIntent };
      } else if (latest && latest.identity.executionId !== record.identity.executionId) {
        if (record.generation <= latest.generation) throw new Error("A superseded execution cannot overwrite its replacement.");
      } else if (latest) record = {
        ...record,
        ...latest.stopIntent ? { stopIntent: latest.stopIntent } : {},
        foregroundMessages: { ...latest.foregroundMessages, ...record.foregroundMessages },
        completedRound: record.completedRound || latest.completedRound,
        stopped: record.stopped || latest.stopped,
        released: record.released || latest.released,
        stopUnknown: record.stopUnknown ?? latest.stopUnknown,
        delivery: latest.delivery ?? record.delivery,
        lastWake: latest.lastWake ?? record.lastWake
      };
      if (deliveryUpdate && incomingDelivery) {
        if (deliveryUpdate === "confirm") {
          if (latest?.delivery?.messageId !== incomingDelivery.messageId) throw new Error("A superseded delivery cannot confirm another input.");
          record = { ...record, lastWake: latest.delivery.request, delivery: { ...latest.delivery, confirmed: true } };
        } else record = { ...record, delivery: latest?.delivery?.messageId === incomingDelivery.messageId ? { ...latest.delivery, text: latest.delivery.text ?? incomingDelivery.text } : { ...incomingDelivery, sequence: (latest?.delivery?.sequence ?? 0) + 1 } };
      }
      if (record.stopped) record = { ...record, stopUnknown: void 0 };
      if (record.released && (record.identity.taskId || record.identity.role === "Organizer")) record = {
        identity: record.identity,
        sessionId: record.sessionId,
        generation: record.generation,
        stopped: record.stopped,
        released: true,
        ...record.stopIntent ? { stopIntent: record.stopIntent } : {}
      };
      await this.records.set(this.prefix + "roles/" + hash12(workId), record);
      this.roleRecords.set(workId, record);
      const stopping = this.stopOperations?.get(JSON.stringify([workId, record.identity.executionId]));
      if (stopping && record.stopped) {
        stopping.persistedStopped = true;
        if (stopping.settled) stopping.result = { status: "stopped" };
      }
    });
    this.roleWrites.set(workId, operation);
    void operation.finally(() => {
      if (this.roleWrites?.get(workId) === operation) this.roleWrites.delete(workId);
    }).catch(() => {
    });
    return operation;
  }
  active(record) {
    const owned = this.native.get(record.identity.workId);
    if (owned) {
      const state = owned.observe().state;
      return state === "running" || state === "waiting";
    }
    const agent = this.ctx.agents.get(SessionId3(record.sessionId));
    return agent?.status === "running" || (this.ctx.get("jobs")?.list(SessionId3(record.sessionId)).some((job) => job.owner === record.sessionId && (job.status === "running" || job.status === "stopping")) ?? false);
  }
  workerSeatOccupied(record) {
    if (record.identity.role !== "Worker" || record.stopped) return false;
    if (this.active(record) || record.stopUnknown) return true;
    const intent = record.stopIntent;
    return intent?.workId === record.identity.workId && intent.executionId === record.identity.executionId && intent.phase === "stopping";
  }
  /** Optional local display evidence, never a shared scheduling or completion signal. */
  async foregroundProcessing() {
    const record = [...this.roleRecords.values()].find((row) => row.identity.role === "Foreground");
    if (this.closed || !record || record.released || record.stopped || record.stopIntent || record.stopUnknown || record.completedRound) return;
    const agent = this.native.get(record.identity.workId)?.actualAgent;
    if (!agent) return;
    const turn = this.foregroundActivity?.read(agent.session);
    if (!turn || turn.end && turn.end !== "completed" || !turn.end && !this.active(record)) return;
    const executionId = record.identity.executionId, turnId = JSON.stringify([record.sessionId, turn.turn, turn.startSeq]);
    if (this.foregroundFinal?.executionId === executionId && this.foregroundFinal.turn === turn.turn) return;
    if (this.foregroundVisibility?.executionId !== executionId || this.foregroundVisibility.turnId !== turnId) {
      let visible = false;
      for (const [id, signature] of Object.entries(record.foregroundMessages ?? {})) {
        const message = await this.conversation.read(id);
        if (message?.role === "assistant" && message.recipient === "human" && message.source !== "model" && this.foregroundMessageSignature(message) === signature) {
          visible = true;
          break;
        }
      }
      if (!visible) return;
      this.foregroundVisibility = { executionId, turnId };
    }
    const current = this.roleRecords.get(record.identity.workId), latest = this.foregroundActivity?.read(agent.session);
    if (this.closed || current?.identity.executionId !== executionId || current.completedRound || current.released || current.stopped || current.stopIntent || current.stopUnknown || latest?.startSeq !== turn.startSeq || latest.end && latest.end !== "completed" || this.foregroundFinal?.executionId === executionId && this.foregroundFinal.turn === turn.turn) return;
    return { executionId, turnId, startedAt: turn.startedAt };
  }
  executionViews(taskId) {
    return [...this.roleRecords.values()].filter((record) => !taskId || record.identity.taskId === taskId || record.lastWake?.taskId === taskId).map((record) => ({
      workId: record.identity.workId,
      executionId: record.identity.executionId,
      role: record.identity.role,
      state: record.stopUnknown ? "unconfirmed" : record.stopped ? "stopped" : this.active(record) ? "running" : "idle",
      member: record.identity.member,
      workerId: record.identity.workerId,
      detail: record.stopUnknown?.reason
    }));
  }
  executing(role, taskId, workerId) {
    return [...this.roleRecords.values()].some((record) => record.identity.role === role && (taskId === void 0 || record.identity.taskId === taskId) && (workerId === void 0 || record.identity.workerId === workerId) && this.active(record));
  }
  async wake(request, recovery) {
    if (request.taskId && request.role !== "Foreground" && (await this.records.get(this.prefix + "sealed/" + hash12(request.taskId)))?.released) return false;
    const key = this.prefix + "wakes/" + hash12(request.id);
    const saved = await this.records.get(key);
    if (saved) {
      if (recovery) await this.updateWake(key, (current) => current ? { ...current, recovery: current.recovery ?? recovery, delivered: false } : void 0);
      return false;
    }
    if (request.reason === "notification") {
      const existing = (await this.records.list(this.prefix + "wakes/")).some((row) => !row.value.delivered && row.value.request.reason === "notification" && row.value.request.taskId === request.taskId && this.requestKey(row.value.request) === this.requestKey(request));
      if (existing) return false;
    }
    let created = false, stored = false;
    await this.updateWake(key, (current) => {
      if (current) return current;
      created = true;
      return { request, ...recovery ? { recovery } : {} };
    }, () => {
      stored = true;
    });
    return created && stored;
  }
  releasedWake(record) {
    const { id, role, taskId, workerId, reason } = record.request;
    return { request: { id, role, reason, sources: [], ...taskId ? { taskId } : {}, ...workerId ? { workerId } : {} }, delivered: true };
  }
  /** Existing wake receipts also own admission diagnostics; no business marker is added. */
  updateWake(key, update, stored) {
    const operation = (this.wakeWrites.get(key) ?? Promise.resolve()).catch(() => void 0).then(async () => {
      const previous = await this.records.get(key);
      let next = update(previous);
      if (next?.request.taskId && next.request.role !== "Foreground" && (await this.records.get(this.prefix + "sealed/" + hash12(next.request.taskId)))?.released) {
        if (!previous) return;
        next = this.releasedWake(next);
      }
      if (next) {
        await this.records.set(key, next);
        stored?.();
      }
    });
    this.wakeWrites.set(key, operation);
    void operation.finally(() => {
      if (this.wakeWrites.get(key) === operation) this.wakeWrites.delete(key);
    }).catch(() => {
    });
    return operation;
  }
  async checkWakeAdmissions() {
    if (this.closed) return;
    const rows = await this.records.list(this.prefix + "wakes/");
    let pendingHelper = rows.some((row) => row.value.request.role === "Helper" && !row.value.delivered);
    const continuationOwners = new Set(rows.filter((row) => !row.value.delivered && row.value.recovery).map((row) => this.requestKey(row.value.request)));
    const adopted = new Set(rows.filter((row) => !row.value.delivered && row.value.recovery?.replacesUnadmittedWake).map((row) => JSON.stringify([this.requestKey(row.value.request), row.value.recovery.replacesUnadmittedWake])));
    const firstPending = /* @__PURE__ */ new Map();
    for (const { value } of rows) {
      const key = this.requestKey(value.request);
      if (value.delivered || adopted.has(JSON.stringify([key, value.request.id])) || !value.recovery && continuationOwners.has(key)) continue;
      if (!firstPending.has(key)) firstPending.set(key, value.request.id);
    }
    for (const row of rows) {
      if (this.closed) return;
      const wake = row.value, request = wake.request, key = this.requestKey(request);
      if (wake.delivered) continue;
      const taskHeld = ["Planner", "Worker", "Organizer"].includes(request.role) && await this.controls.taskHeld(request.taskId);
      const now = this.admissionNow();
      let report, retained;
      await this.updateWake(row.key, (current) => {
        if (this.closed || !current || current.delivered) return;
        const record = this.roleRecords.get(key);
        const ownAdmission = record && current.admission?.executionId === record.identity.executionId;
        const held = request.role === "Foreground" && !!this.pendingForegroundResets?.size || taskHeld || firstPending.get(key) !== current.request.id || !current.recovery && continuationOwners.has(key) || !!record && !ownAdmission && this.active(record) || request.role === "Worker" && [...this.roleRecords.values()].filter((item) => !(ownAdmission && item.identity.executionId === record.identity.executionId) && this.workerSeatOccupied(item)).length >= this.config.workerSeats;
        const confirmed = record?.delivery?.request.id === request.id && record.delivery.confirmed;
        if (held || confirmed) return current.admission?.eligibleSince !== void 0 ? {
          ...current,
          admission: current.admission.reportedAt === void 0 ? void 0 : { reportedAt: current.admission.reportedAt }
        } : void 0;
        if (current.admission?.reportedAt !== void 0) retained = current.admission;
        const admission = { ...current.admission, eligibleSince: current.admission?.eligibleSince ?? now, phase: current.admission?.phase ?? "queued" };
        if (admission.reportedAt === void 0 && now - admission.eligibleSince >= 45e3) {
          report = { ...admission, reportedAt: now };
          return { ...current, admission: report };
        }
        return current.admission?.eligibleSince !== void 0 ? void 0 : { ...current, admission };
      });
      const diagnostic = report ?? retained;
      if (!diagnostic || this.closed) continue;
      const target = this.roleRecords.get(key);
      const context2 = {
        kind: "admission-timeout",
        wakeId: request.id,
        role: request.role,
        taskId: request.taskId,
        ...target && diagnostic.executionId === target.identity.executionId ? { target: { ...target.identity } } : {},
        workId: key,
        executionId: diagnostic.executionId,
        phase: diagnostic.phase ?? "queued",
        eligibleSince: diagnostic.eligibleSince,
        facts: "An eligible Host wake has not completed native admission within 45 seconds. Inspect this exact pending wake; this is not an AI execution time limit."
      };
      const error = new Error(context2.facts + " " + JSON.stringify(context2));
      if (report) {
        this.ctx.logger("deepseek-servant").error(error);
        this.environment.error(error);
      }
      if (request.role !== "Helper") pendingHelper = await this.wake({ id: "admission-timeout:" + request.id, role: "Helper", reason: "helper", sources: [], context: context2 }) || pendingHelper;
    }
    if (!this.closed && pendingHelper) this.startHelperAdmission();
  }
  startHelperAdmission() {
    if (this.closed || this.helperPumping) return;
    const operation = Promise.resolve().then(() => {
      if (!this.closed) return this.runQueue(true);
    });
    this.helperPumping = operation;
    void operation.catch((error) => this.error(error, { role: "Helper", stage: "admission" })).finally(() => {
      if (this.helperPumping === operation) this.helperPumping = void 0;
    });
  }
  /** Discovery admits one owned native queue without joining unrelated open/send work.
   * The original pump promise remains available to explicit waiting callers and disposal. */
  startOwnedPump() {
    if (this.closed || this.pumping) return;
    const operation = this.pump();
    void operation.catch((error) => this.error(error));
  }
  pump() {
    if (this.closed) return Promise.resolve();
    if (this.pumping) return this.pumping;
    const operation = Promise.resolve().then(() => {
      if (!this.closed) return this.runQueue();
    });
    this.pumping = operation;
    void operation.finally(() => {
      if (this.pumping === operation) this.pumping = void 0;
    }).catch(() => {
    });
    return operation;
  }
  async serialWork(workId, operation) {
    const operations2 = this.workOperations ??= /* @__PURE__ */ new Map();
    const pending = (operations2.get(workId) ?? Promise.resolve()).catch(() => void 0).then(operation);
    operations2.set(workId, pending);
    try {
      return await pending;
    } finally {
      if (operations2.get(workId) === pending) operations2.delete(workId);
    }
  }
  async confirmAdoptedWakes(request, recovery) {
    const adoptedIds = /* @__PURE__ */ new Set([request.id]);
    let adoptedId = recovery?.replacesUnadmittedWake;
    while (adoptedId && !adoptedIds.has(adoptedId)) {
      adoptedIds.add(adoptedId);
      let parentId;
      await this.updateWake(this.prefix + "wakes/" + hash12(adoptedId), (current) => {
        if (!current || this.requestKey(current.request) !== this.requestKey(request)) return void 0;
        parentId = current.recovery?.replacesUnadmittedWake;
        return { ...current, delivered: true, admission: void 0 };
      });
      adoptedId = parentId;
    }
  }
  async runQueue(helperOnly = false, onlyWakeId) {
    const queued = await this.records.list(this.prefix + "wakes/");
    const continuationOwners = new Set(queued.filter((row) => !row.value.delivered && row.value.recovery).map((row) => this.requestKey(row.value.request)));
    const continuedInputs = new Set(queued.filter((row) => !row.value.delivered && row.value.recovery).flatMap((row) => [row.value.recovery?.original?.request.id, row.value.recovery?.replacesUnadmittedWake].filter((id) => id !== void 0 && id !== row.value.request.id).map((id) => JSON.stringify([this.requestKey(row.value.request), id]))));
    for (const row of queued) {
      if (helperOnly && row.value.request.role !== "Helper" || onlyWakeId && row.value.request.id !== onlyWakeId) continue;
      if (continuedInputs.has(JSON.stringify([this.requestKey(row.value.request), row.value.request.id]))) continue;
      if (this.closed) return;
      if (row.value.delivered) continue;
      const workId = this.requestKey(row.value.request);
      if (!row.value.recovery && continuationOwners.has(workId)) continue;
      if (this.workOperations?.has(workId)) continue;
      await this.serialWork(workId, async () => {
        if (this.closed) return;
        const currentWake = await this.records.get(row.key);
        if (this.closed || !currentWake || currentWake.delivered) return;
        row.value = currentWake;
        if ((await this.records.list(this.prefix + "wakes/")).some((item) => !item.value.delivered && this.requestKey(item.value.request) === workId && item.value.recovery?.replacesUnadmittedWake === currentWake.request.id)) return;
        const confirmedInput = this.roleRecords.get(workId)?.delivery;
        if (currentWake.recovery && confirmedInput?.confirmed && confirmedInput.request.id === currentWake.request.id) {
          await this.confirmAdoptedWakes(currentWake.request, currentWake.recovery);
          await this.updateWake(row.key, (current) => current ? { ...current, delivered: true, admission: void 0 } : void 0);
          return;
        }
        if (currentWake.recovery?.replacesUnadmittedWake) {
          const original = await this.records.get(this.prefix + "wakes/" + hash12(currentWake.recovery.replacesUnadmittedWake));
          if (original?.delivered) {
            await this.confirmAdoptedWakes(currentWake.request, currentWake.recovery);
            await this.updateWake(row.key, (current) => current ? { ...current, delivered: true, admission: void 0 } : void 0);
            return;
          }
        }
        if (this.closed) return;
        try {
          const request = row.value.request, key = this.requestKey(request);
          if (request.role === "Foreground" && this.pendingForegroundResets?.size) return;
          if (["Planner", "Worker", "Organizer"].includes(request.role) && await this.controls.taskHeld(request.taskId)) return;
          let record = this.roleRecords.get(key);
          if (record && this.active(record)) return;
          if (record?.identity.role === "Foreground" && !row.value.recovery) {
            await this.finishForegroundRound(record);
            record = this.roleRecords.get(key);
            if (record?.completedRound && !record.stopped) return;
            if (record?.completedRound && record.delivery?.request.id === request.id) {
              await this.updateWake(row.key, (current) => current ? { ...current, delivered: true, admission: void 0 } : void 0);
              return;
            }
          }
          const checkSources = request.reason === "notification" && request.sources.length > 0;
          const checkTask = request.taskId && ["Planner", "Worker", "Organizer", "Recorder"].includes(request.role);
          if (checkSources || checkTask) {
            const retired = await withSnapshot(this.files, async (snapshot) => {
              if (checkSources) {
                const wanted = new Set(request.sources.map((source) => source.path));
                const directories = new Set(request.sources.map((source) => source.path.slice(0, source.path.lastIndexOf("/") + 1)));
                let present = false;
                for (const directory of directories) {
                  if ((await this.files.listDirectory(snapshot, directory)).some((entry) => wanted.has(entry.path))) {
                    present = true;
                    break;
                  }
                }
                if (!present) return true;
              }
              if (!checkTask) return false;
              if (await this.manuallyCleared(request.taskId, snapshot)) return true;
              if (request.role === "Recorder") return false;
              const task = await readJson(this.files, snapshot, paths.task(request.taskId));
              if (task?.status === "complete") return true;
              if (request.role === "Organizer") return false;
              const member = await readMemberStatus(this.files, snapshot, paths.memberStatus(request.taskId, this.config.member));
              return member?.state === "complete";
            });
            if (retired) {
              await this.updateWake(row.key, (current) => current ? { ...current, delivered: true, admission: void 0 } : void 0);
              return;
            }
          }
          if (record && !record.stopped && this.stopOperations?.has(JSON.stringify([key, record.identity.executionId]))) {
            if (!this.trackedStop(record)) return;
            record = this.roleRecords.get(key);
          }
          if (record && (record.stopIntent || record.stopUnknown) && !record.stopped) {
            const result = await this.stopOwnedRecord(record);
            if (result.status === "superseded") return;
            if (result.status === "unconfirmed") {
              await this.saveRole({ ...record, stopUnknown: result });
              throw new Error(result.reason);
            }
            await this.saveRole({ ...record, stopped: true });
            record = this.roleRecords.get(key);
          }
          if (row.value.recovery && record && !row.value.recovery.confirmedStoppedExecutions?.includes(record.identity.executionId)) {
            const stopped = record.stopped ? { status: "stopped" } : await this.stopOwnedRecord(record);
            if (stopped.status === "superseded") return;
            if (stopped.status === "unconfirmed") {
              await this.saveRole({ ...record, stopUnknown: stopped });
              throw new Error(stopped.reason);
            }
            row.value.recovery = {
              ...row.value.recovery,
              confirmedStoppedExecutions: [...row.value.recovery.confirmedStoppedExecutions ?? [], record.identity.executionId]
            };
            await this.updateWake(row.key, (current) => current && !current.delivered ? { ...current, recovery: row.value.recovery } : void 0);
            await this.saveRole({ ...record, stopped: true });
            record = this.roleRecords.get(key);
          }
          if (request.role === "Worker" && [...this.roleRecords.values()].filter((item) => this.workerSeatOccupied(item)).length >= this.config.workerSeats) return;
          if (record?.stopped && (await this.records.list(this.prefix + "observations/")).some((row2) => !row2.value.complete && row2.value.stopStarted && row2.value.pending.action.identity.workId === key && row2.value.pending.action.identity.executionId === record.identity.executionId)) return;
          if (!record || record.stopped) {
            record = { identity: {
              workId: key,
              executionId: randomUUID10(),
              role: request.role,
              ...request.taskId && !["Foreground", "Organizer", "Helper"].includes(request.role) ? { taskId: request.taskId } : {},
              ...request.taskId && (request.role === "Planner" || request.role === "Worker") ? { member: this.config.member } : {},
              ...request.workerId ? { workerId: request.workerId } : {}
            }, sessionId: record?.completedRound ? "dss-" + randomUUID10() : record?.sessionId ?? "dss-" + randomUUID10(), generation: (record?.generation ?? 0) + 1 };
            await this.saveRole(record);
          }
          if (record.stopUnknown) throw new Error("Native producer stop is unconfirmed: " + record.stopUnknown.reason);
          await this.updateWake(row.key, (current) => current && !current.delivered ? {
            ...current,
            admission: { ...current.admission, eligibleSince: current.admission?.eligibleSince ?? this.admissionNow(), phase: "opening", executionId: record.identity.executionId }
          } : void 0);
          const binding = this.binding(record, request);
          const agent = await this.native.open(record.identity, {
            sessionId: record.sessionId,
            cwd: this.config.workspace,
            presetId: this.config.presetId,
            model: (request.role === "Foreground" ? this.config.foreground : this.config.background ?? this.config.foreground) ?? this.config.model,
            resume: await this.gateway.exists(record.sessionId),
            ...request.role === "Foreground" ? { recentExchanges: (await this.conversation.recentExchanges()).map((exchange) => [exchange.human, ...exchange.assistants].map((message) => ({ id: message.id, role: message.role, text: message.text, at: message.createdAt, source: message.participantId }))) } : {},
            setup: (scope, actual) => {
              if (row.value.recovery) scope.systemPrompt.section({
                name: "deepseek-servant:recovery-input",
                order: 102,
                interpolate: false,
                text: "This owned execution is resuming after interruption. Before continuing, inspect the existing native inputs and saved Task material. Preserve original input identities; do not repeat already completed effects. Recovery facts: " + JSON.stringify(request.context ?? {})
              });
              scope.on("agent/status", (event) => {
                if (event.agent !== actual) return;
                this.environment.changed?.();
                if (request.role === "Foreground" && actual.status === "idle" && !this.closed) {
                  void this.serialWork(key, async () => {
                    if (this.closed) return;
                    const stop = this.stopOperations?.get(JSON.stringify([key, record.identity.executionId]));
                    if (stop && !stop.settled) await stop.promise;
                    const current = this.roleRecords.get(key);
                    if (!this.closed && current?.identity.executionId === record.identity.executionId) await this.finishForegroundRound(current);
                  }).catch((error) => this.error(error, { identity: record.identity, stage: "foreground-round-capture" }));
                }
              });
              scope.on("agent/error", (event) => {
                if (event.agent === actual) this.error(event.error, { identity: record.identity, turn: event.turn, step: event.step });
              });
              const skills = installFrameworkSkillProvider(scope, actual, this.files, { legacyScopes: this.config.legacySkillScopes, legacyGitParticipants: this.config.legacyGitSkillParticipants });
              this.skillProviders.set(record.identity.executionId, skills);
              scope.effect(() => async () => {
                this.skillProviders.delete(record.identity.executionId);
                await skills.dispose();
              }, "dss.framework.skills");
              return installFrameworkRoleTools(scope, actual, binding, this.services());
            }
          });
          let recoveryInput;
          if (request.taskId && request.sources.some((source) => source.path.split("/").at(-1)?.endsWith("_Helper"))) {
            const path3 = this.recoveryInputPath(request.taskId, this.config.member, request.role);
            try {
              recoveryInput = await withSnapshot(this.files, (snapshot) => readJson(this.files, snapshot, path3));
              if (recoveryInput === void 0) recoveryInput = { path: path3, unavailable: "Diagnostic input is absent; inspect the known notification sources and current task facts." };
            } catch (error) {
              recoveryInput = { path: path3, unavailable: error instanceof Error ? error.message : String(error) };
            }
          }
          const messageId = "dss-wake-" + hash12(request.id);
          const previousDelivery = this.roleRecords.get(key)?.delivery;
          const text = row.value.recovery?.explanationText ?? (previousDelivery?.messageId === messageId && previousDelivery.text !== void 0 ? previousDelivery.text : JSON.stringify({
            taskId: request.taskId,
            reason: request.reason,
            sources: request.sources,
            context: request.context,
            ...recoveryInput ? { recoveryInput } : {},
            availableMembers: this.environment.members(),
            resources: this.environment.resources(),
            workerSeats: this.config.workerSeats
          }));
          if (row.value.recovery && row.value.recovery.explanationText === void 0) {
            row.value.recovery = { ...row.value.recovery, explanationText: text };
            await this.updateWake(row.key, (current) => current && !current.delivered ? { ...current, recovery: row.value.recovery } : void 0);
          }
          await this.saveRole({ ...record, delivery: { request, messageId, text, confirmed: false } }, false, "prepare");
          const recovery = row.value.recovery;
          if (recovery?.original && recovery.original.messageId !== messageId) {
            const original = recovery.original;
            const evidence = (await new DshSessionReader(this.ctx).inputs(record.sessionId)).get(original.messageId);
            if (!(original.confirmed && evidence === void 0) && evidence?.state !== "consumed" && evidence?.state !== "queued" && !(evidence?.state === "claimed" && evidence.active)) {
              if (!(recovery.targetExecutionId !== void 0 && recovery.confirmedStoppedExecutions?.includes(recovery.targetExecutionId))) throw new Error("Original recovery input has no confirmed prior execution stop.");
              const originalText = evidence?.text ?? original.text;
              if (originalText === void 0) throw new Error("Original native recovery input body is unavailable; preserve its responsibility for diagnosis.");
              if (evidence && original.text !== void 0 && original.text !== evidence.text) throw new Error("Original recovery input body conflicts with its saved identity.");
              await agent.send(originalText, original.messageId, "followup", "deepseek-servant");
            }
            const originalKey = this.prefix + "wakes/" + hash12(original.request.id);
            const originalWake = await this.records.get(originalKey);
            if (originalWake) await this.updateWake(originalKey, (current) => current ? { ...current, delivered: true, admission: void 0 } : void 0);
          }
          await this.updateWake(row.key, (current) => current && !current.delivered ? {
            ...current,
            admission: { ...current.admission, eligibleSince: current.admission?.eligibleSince ?? this.admissionNow(), phase: "sending", executionId: record.identity.executionId }
          } : void 0);
          await agent.send(text, messageId, recovery ? "steer" : "followup", "deepseek-servant", recovery ? {
            replayInactiveClaim: (recovery.targetExecutionId !== void 0 && recovery.confirmedStoppedExecutions?.includes(recovery.targetExecutionId)) === true
          } : void 0);
          await this.saveRole({ ...record, lastWake: request, delivery: { request, messageId, confirmed: true } }, false, "confirm");
          await this.confirmAdoptedWakes(request, recovery);
          await this.updateWake(row.key, (current) => current ? { ...current, delivered: true, admission: void 0 } : void 0);
        } catch (error) {
          const executionId = row.value.admission?.executionId ?? this.roleRecords.get(workId)?.identity.executionId;
          const cancellation = executionId && this.admissionCancellations.get(executionId);
          if (cancellation === void 0 || error !== cancellation && !(error instanceof Error && error.name === "AbortError" && error.cause === cancellation) && !(error instanceof DshAgentCreationCancelled && error.executionStopped && error.reason === cancellation))
            this.error(error, { wakeId: row.value.request.id, role: row.value.request.role });
        }
      });
    }
  }
  /** Persist completed visible originals before retiring their native context.
   * Interrupted turns remain owned by the existing recovery responsibility. */
  foregroundMessageSignature(message) {
    return hash12(JSON.stringify(Object.fromEntries(Object.entries(message).filter(([, value]) => value !== void 0).sort(([a], [b]) => a.localeCompare(b)))));
  }
  async ownForegroundMessage(record, message) {
    if (record.identity.role !== "Foreground") return;
    const current = this.roleRecords.get(record.identity.workId);
    if (!current || current.identity.executionId !== record.identity.executionId || current.released) throw new Error("Foreground output execution was replaced before saving its message.");
    const signature = this.foregroundMessageSignature(message), previous = current.foregroundMessages?.[message.id];
    if (previous && previous !== signature) throw new Error("Foreground output identity was reused for different content.");
    await this.saveRole({ ...current, foregroundMessages: { ...current.foregroundMessages, [message.id]: signature } });
  }
  async finishForegroundRound(record) {
    if (record.identity.role !== "Foreground" || this.active(record)) return;
    const stop = this.stopOperations?.get(JSON.stringify([record.identity.workId, record.identity.executionId]));
    if (stop && (!stop.settled || stop.result?.status !== "stopped")) return;
    const current = this.roleRecords.get(record.identity.workId);
    if (current?.identity.executionId !== record.identity.executionId) return;
    if (!record.completedRound) {
      const sessions = new DshSessionReader(this.ctx);
      const capture = await sessions.capture(record.sessionId);
      if (!capture.finished) return;
      if (record.delivery) {
        const input = (await sessions.inputs(record.sessionId)).get(record.delivery.messageId);
        if (input?.state !== "consumed") return;
      }
      const turns = captureForegroundTurns(await sessions.events(record.sessionId));
      for (const turn of turns) {
        if (!turn.final) continue;
        const final = turn.final;
        let alreadySaved = false;
        for (const send of turn.sends) {
          if (send.text !== final.text) continue;
          const saved = await this.conversation.read(send.id);
          if (saved?.role === "assistant" && saved.text === final.text) alreadySaved = true;
        }
        if (alreadySaved) {
          this.foregroundFinal = { executionId: record.identity.executionId, turn: turn.turn };
          this.environment.changed?.();
          continue;
        }
        const sourceIds = turn.claimedMessageIds.length ? turn.claimedMessageIds : turn.readMessageIds;
        const replyTo = sourceIds.length === 1 ? sourceIds[0] : void 0;
        if (replyTo) {
          const original = await this.conversation.read(replyTo);
          if (original?.role !== "user") throw new Error("Foreground claimed reply source is not a human message.");
        }
        const id = "native-" + hash12(JSON.stringify([record.sessionId, final.id]));
        const message = {
          id,
          role: "assistant",
          participantId: this.config.member,
          createdAt: final.at,
          text: final.text,
          source: "model",
          recipient: "human",
          ...final.model ? { model: final.model } : {},
          ...replyTo ? { replyTo } : {}
        };
        await this.ownForegroundMessage(record, message);
        for (; ; ) {
          try {
            await this.conversation.send("native-capture/" + id, message, { reevaluate: true });
            break;
          } catch (error) {
            if (!(error instanceof FilesConflictError) || this.closed) throw error;
            const fresh = await this.files.snapshot();
            let changed;
            try {
              changed = fresh.revision !== error.expectedRevision;
            } finally {
              await fresh.release();
            }
            if (!changed || this.closed || this.roleRecords.get(record.identity.workId)?.identity.executionId !== record.identity.executionId) throw error;
          }
        }
        this.foregroundFinal = { executionId: record.identity.executionId, turn: turn.turn };
        this.environment.changed?.();
      }
      await this.saveRole({ ...record, completedRound: true });
      record = this.roleRecords.get(record.identity.workId);
      this.environment.changed?.();
    }
    this.trackedStop(record);
  }
  binding(record, request) {
    const identity2 = record.identity, base = { ...identity2, owner: this.config.member, collaborationId: this.config.collaborationId };
    const direct = request.sources.map((source) => ({ source, direct: parseDirectSignal(source.path.split("/").at(-1)) })).find((value) => value.direct);
    if (direct?.direct) return { ...base, direct: { inputPath: direct.direct.inputPath, signalPath: direct.source.path }, recordPath: direct.direct.recordPath };
    if (identity2.taskId && identity2.member) {
      base.stateDirectory = paths.state(identity2.member, identity2.taskId);
      base.recordPath = paths.member(identity2.taskId, identity2.member) + "/Planner_Memory.md";
      if (identity2.role === "Worker" && identity2.workerId) {
        const child = workerPaths(identity2.taskId, identity2.member, identity2.workerId);
        base.recordPath = child.notes;
        base.notePath = child.notes;
        base.replyPath = child.reply;
        base.generation = record.generation;
      }
    }
    if (identity2.role === "Foreground") base.recordPath = this.conversation.foregroundRoot + "/Foreground_Cache.md";
    if (identity2.role === "Helper") base.recordPath = "debug/" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) + ".md";
    return base;
  }
  async notifications(snapshot, binding, selectedTaskId) {
    if (binding.direct) return await this.files.read(snapshot, binding.direct.signalPath) === void 0 ? [] : [binding.direct.signalPath];
    const taskId = binding.taskId ?? selectedTaskId;
    if (binding.role === "Foreground") {
      const indexed = new Set(await this.conversation.notificationPaths(snapshot));
      return (await this.files.listDirectory(snapshot, "state/")).filter((entry) => entry.path.split("/").at(-1).startsWith("Foreground_") && !indexed.has(entry.path)).map((entry) => entry.path);
    }
    if (!taskId) return [];
    if (binding.role === "Organizer") {
      const task = await readJson(this.files, snapshot, paths.task(taskId));
      if (!task || task.owner !== this.config.member) return [];
      const signals = await this.files.listDirectory(snapshot, paths.state(this.config.member, taskId));
      const result = signals.filter((entry) => entry.path.split("/").at(-1).startsWith("Organizer_")).map((entry) => entry.path);
      for (const member of task.members ?? this.environment.members()) {
        const path3 = paths.state(member, taskId) + "/complete";
        const memberSignals = member === this.config.member ? signals : await this.files.listDirectory(snapshot, paths.state(member, taskId));
        if (memberSignals.some((entry) => entry.path === path3)) result.push(path3);
      }
      return result;
    }
    const entries = await this.files.listDirectory(snapshot, paths.state(this.config.member, taskId));
    return entries.filter((entry) => binding.role === "Worker" ? signalWorkerId(entry.path.split("/").at(-1)) === binding.workerId : entry.path.split("/").at(-1).startsWith(binding.role + "_")).map((entry) => entry.path);
  }
  services() {
    return {
      files: this.files,
      transact: async (id, request, options, build) => {
        const receipt = await this.transactions.run(id, request, options, build);
        if (!receipt.replay) this.environment.changed?.();
        return receipt;
      },
      skillsChanged: () => this.invalidateSkills(),
      skillResourceAllowed: (binding, path3) => this.skillProviders.get(binding.executionId)?.canReadResource(path3) ?? false,
      notifications: (snapshot, binding, taskId) => this.notifications(snapshot, binding, taskId),
      onError: (error) => this.error(error),
      afterRecoveryConsumed: async (binding, member, receipt) => {
        const receiptId = receipt.operationId ?? receipt.revision;
        const doneKey = this.prefix + "recovery-consumed/" + hash12(JSON.stringify([member, receiptId]));
        if (await this.records.get(doneKey)) return;
        await this.serialRecoveryWatch(member.taskId, member.member, async (key) => {
          const prior = await this.records.get(key);
          if (!prior?.consumedReceipts?.includes(receiptId)) await this.records.set(key, {
            ...prior,
            watch: void 0,
            consumedReceipts: [...prior?.consumedReceipts ?? [], receiptId]
          });
        });
        await this.records.set(doneKey, true);
      },
      conversation: {
        foregroundRoot: this.conversation.foregroundRoot,
        read: async (input) => {
          if (input.mode === "search") return this.conversation.search(input.query ?? "", input.cursor, input.limit);
          if (input.mode === "text") return this.conversation.readText(input.reference ?? "", input.cursor, input.limit);
          if (input.mode === "message") return this.conversation.read(input.reference ?? "");
          if (input.mode === "recent") return this.conversation.recentExchanges();
          if (input.mode === "pending") return this.conversation.pendingForeground();
          if (input.mode === "memory") return this.conversation.readForeground();
          return this.conversation.page(input.limit ?? 20, input.beforeId);
        },
        send: async (input, binding, commandId) => {
          const key = this.prefix + "message-source/" + hash12(commandId);
          let source = await this.records.get(key);
          if (!source) {
            const actual = this.native.get(binding.workId)?.actualAgent;
            const context2 = actual?.session.requestContext();
            source = { createdAt: (/* @__PURE__ */ new Date()).toISOString(), ...context2?.model ? { model: context2.model } : {} };
            await this.records.set(key, source);
          }
          const message = {
            id: input.id,
            text: input.text,
            role: "assistant",
            participantId: this.config.member,
            ...source,
            recipient: input.intent,
            ...input.replyTo ? { replyTo: input.replyTo } : {}
          };
          if (binding.role === "Foreground") {
            const owner = this.roleRecords.get(binding.workId);
            if (!owner || owner.identity.executionId !== binding.executionId) throw new Error("Foreground message belongs to a replaced execution.");
            await this.ownForegroundMessage(owner, message);
          }
          const receipt = await this.conversation.send(commandId, message);
          if (binding.role === "Foreground" && message.recipient === "human") {
            const owner = this.roleRecords.get(binding.workId), agent = this.native.get(binding.workId)?.actualAgent;
            const turn = agent && this.foregroundActivity?.read(agent.session);
            if (owner?.identity.executionId === binding.executionId && turn && !turn.end)
              this.foregroundVisibility = { executionId: binding.executionId, turnId: JSON.stringify([owner.sessionId, turn.turn, turn.startSeq]) };
          }
          if (!receipt.replay) this.environment.changed?.();
          return receipt;
        },
        claim: (input, _binding, commandId) => this.conversation.claimForeground(
          commandId,
          input.messageIds,
          { list: input.list, cache: input.cache },
          { expectedRevision: input.expectedRevision }
        )
      },
      artifacts: { preserve: async (agent, input, _binding, commandId, options) => {
        const cwd = await this.ctx.workingDirectory.ensure(agent, options.signal);
        return new FrameworkArtifacts(this.ctx, this.files, this.transactions, this.config.workspace).preserve(commandId, input, { ...options, cwd });
      } },
      ...this.environment.capacity ? { capacity: this.environment.capacity } : {},
      observation: { reset: (binding, input, commandId, signal) => this.resetObservation(binding, input.probeId, commandId, signal) },
      helper: {
        request: async (binding, facts, commandId) => {
          await this.wake({ id: "help:" + commandId, role: "Helper", reason: "helper", sources: [], context: { target: binding, facts } });
          return { arranged: true };
        },
        restore: async (binding, input, commandId) => {
          const key = this.prefix + "restores/" + hash12(commandId);
          const caller = this.roleRecords.get(binding.workId);
          const diagnostic = caller?.identity.executionId === binding.executionId ? (caller.delivery?.request ?? caller.lastWake)?.context : void 0;
          const admissionWakeId = diagnostic?.kind === "admission-timeout" && typeof diagnostic.wakeId === "string" && (input.wakeId === diagnostic.wakeId || input.target && input.target.workId === diagnostic.workId && input.target.executionId === diagnostic.executionId) ? diagnostic.wakeId : void 0;
          if (!await this.records.get(key)) await this.records.set(key, { commandId, requester: binding, input, ...admissionWakeId ? { admissionWakeId } : {}, createdAt: (/* @__PURE__ */ new Date()).toISOString(), complete: false });
          return { arranged: true };
        },
        restoreHost: async (binding, input, commandId) => {
          const key = this.prefix + "host-restores/" + hash12(commandId);
          if (!await this.records.get(key)) await this.records.set(key, { commandId, requester: binding, input, createdAt: (/* @__PURE__ */ new Date()).toISOString(), complete: false });
          return { arranged: true };
        }
      }
    };
  }
  async resetObservation(binding, probeId, commandId, signal) {
    if (binding.role === "Foreground") throw new Error("Foreground does not use the DSS inactivity timer.");
    const record = this.roleRecords.get(binding.workId), agent = this.native.get(binding.workId);
    const current = () => !this.closed && record && agent && this.roleRecords.get(binding.workId) === record && record.identity.executionId === binding.executionId && record.identity.role === binding.role && !record.stopped && !record.released && !record.stopIntent && !record.stopUnknown && !this.stopOperations?.has(JSON.stringify([binding.workId, binding.executionId])) && this.native.get(binding.workId) === agent && agent.sessionId === record.sessionId;
    signal.throwIfAborted();
    if (!current() || await this.controls.execution(binding.executionId) || await this.controls.taskHeld(await this.currentTask(record)) || !current()) throw new Error("Observation reset belongs to an unavailable execution.");
    const original = (await new DshSessionReader(this.ctx).inputs(record.sessionId)).get(probeId);
    const issued = await this.records.get(this.prefix + "observations/" + hash12(probeId));
    if (original?.state !== "consumed" || original.source !== "deepseek-servant" || issued?.pending.id !== probeId || issued.pending.action.identity.workId !== binding.workId || issued.pending.action.identity.executionId !== binding.executionId || issued.pending.action.stage === 3)
      throw new Error("Reset requires an actually received Host probe or warning for this execution.");
    const envelope = JSON.parse(original.text);
    if (!["probe-role", "warn-role", "probe-helper", "warn-helper"].includes(envelope.kind ?? ""))
      throw new Error("Native input is not a Host inactivity probe or warning.");
    const prefix = String(agent.actualAgent.id) + ":";
    if (!commandId.startsWith(prefix)) throw new Error("Reset command does not belong to its native caller.");
    const callId = commandId.slice(prefix.length);
    const call = agent.getMessages().flatMap((message) => message.role === "assistant" && typeof message.content !== "string" ? message.content : []).find((block) => block.type === "tool-call" && String(block.id) === callId && block.name === "dss_reset_observation");
    if (!call || call.type !== "tool-call" || JSON.parse(call.arguments).probeId !== probeId) throw new Error("Reset differs from its original native tool call.");
    signal.throwIfAborted();
    if (!current() || await this.controls.execution(binding.executionId) || await this.controls.taskHeld(await this.currentTask(record)) || !current()) throw new Error("Execution changed before observation reset.");
    signal.throwIfAborted();
    await this.observations.reset(record.identity, probeId, issued.pending.cycleStartedAt);
    return { reset: true, probeId };
  }
  /** Applies to the next Foreground admission; never rewrites a running native turn. */
  setForegroundModel(model2) {
    this.config.foreground = model2 ? { ...model2 } : void 0;
  }
  invalidateSkills() {
    for (const provider of this.skillProviders.values()) provider.invalidate();
  }
  watchKey(taskId, member) {
    return this.prefix + "recovery-watch/" + hash12(JSON.stringify([taskId, member]));
  }
  async serialRecoveryWatch(taskId, member, operation) {
    const key = this.watchKey(taskId, member);
    const writes = this.recoveryWatchWrites ??= /* @__PURE__ */ new Map();
    const pending = (writes.get(key) ?? Promise.resolve()).catch(() => void 0).then(() => operation(key));
    writes.set(key, pending);
    try {
      return await pending;
    } finally {
      if (writes.get(key) === pending) writes.delete(key);
    }
  }
  async taskMetadata(snapshot) {
    this.taskMetadataIndex ??= new FrameworkTaskIndex(this.files, (error) => this.error(error));
    return this.taskMetadataIndex.list(snapshot);
  }
  async scanMembers(snapshot) {
    const result = [];
    for (const task of await this.taskMetadata(snapshot)) {
      try {
        if (task.status !== "running" || await this.manuallyCleared(task.taskId, snapshot)) continue;
        const member = this.config.member, inbox = paths.inbox(task.taskId, member);
        const entries = await this.files.listDirectory(snapshot, inbox.slice(0, inbox.lastIndexOf("/")));
        const entry = entries.find((item) => item.path === inbox);
        if (!entry) continue;
        const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(task.taskId, member));
        const eligibility = {
          inboxBodyBytes: entry.bytes ?? (entry.empty ? 0 : Buffer.byteLength(await this.files.read(snapshot, inbox) ?? "", "utf8")),
          status: status?.state ?? "running",
          pendingBusiness: status?.state !== "complete"
        };
        if (!memberRecoveryEligible(eligibility)) continue;
        if ([...this.roleRecords.values()].some((record) => record.identity.role === "Worker" && record.identity.taskId === task.taskId && this.active(record))) continue;
        const planner = this.roleRecords.get(this.roleKey("Planner", task.taskId));
        const workers = [];
        const root = paths.member(task.taskId, member) + "/workers/";
        for (const note of await this.files.list(snapshot, root)) {
          if (!note.path.endsWith("/notes.md")) continue;
          const workerId = note.path.slice(root.length).split("/")[0];
          const record = this.roleRecords.get(this.roleKey("Worker", task.taskId, workerId));
          workers.push({
            workerId,
            executionId: record?.identity.executionId ?? "",
            notePath: note.path,
            noteBodyBytes: note.bytes ?? (note.empty ? 0 : Buffer.byteLength(await this.files.read(snapshot, note.path) ?? "", "utf8")),
            executing: record ? this.active(record) : false
          });
        }
        result.push({
          taskId: task.taskId,
          member,
          taskPath: task.sourcePath,
          inboxPath: inbox,
          ...eligibility,
          needsRecovery: true,
          plannerExecutionId: planner?.identity.executionId ?? "",
          plannerMemoryPath: paths.member(task.taskId, member) + "/Planner_Memory.md",
          plannerExecuting: planner ? this.active(planner) : false,
          workers,
          pendingSignals: (await this.files.listDirectory(snapshot, paths.state(member, task.taskId))).map((signal) => signal.path)
        });
      } catch (error) {
        this.error(error);
      }
    }
    return result;
  }
  async arrangeNativeContinuation(record, context2, inspection, explicitId, fallback, replacement) {
    if (record.released || await this.controls.execution(record.identity.executionId)) return void 0;
    if (["Planner", "Worker", "Organizer", "Recorder"].includes(record.identity.role) && await this.manuallyCleared(await this.currentTask(record))) return void 0;
    if (!replacement) {
      const pending = (await this.records.list(this.prefix + "wakes/")).find((row) => !row.value.delivered && row.value.request.id !== record.delivery?.request.id && row.value.recovery?.targetExecutionId === record.identity.executionId && this.requestKey(row.value.request) === record.identity.workId);
      if (pending) return pending.value.request;
    }
    const inputs = record.delivery ? await new DshSessionReader(this.ctx).inputs(record.sessionId) : /* @__PURE__ */ new Map();
    const resolved = resolveNativeRecoveryInput(record.delivery, record.lastWake ?? fallback, inputs);
    if (!resolved || resolved.active) return void 0;
    const prior = await this.records.get(this.prefix + "wakes/" + hash12(resolved.request.id));
    if (prior?.recovery && resolved.state === "unknown") throw new Error("Confirmed recovery input has no available native consumption evidence; preserve it for diagnosis.");
    const reuse = prior?.recovery && resolved.state !== "consumed" && !replacement;
    const request = reuse ? prior.request : {
      ...replacement ?? resolved.request,
      id: replacement?.id ?? explicitId ?? nativeRecoveryWakeId(
        record.sessionId,
        inspection?.lastTurn?.turn,
        resolved.messageId ?? resolved.request.id
      ),
      reason: replacement?.reason ?? "startup-recovery",
      context: {
        ...context2,
        originalMessageId: resolved.messageId,
        nativeInputState: resolved.state,
        interruptedTurn: inspection?.lastTurn
      }
    };
    const recovery = reuse ? { ...prior.recovery, explanationText: prior.recovery.explanationText ?? resolved.text } : {
      targetExecutionId: record.identity.executionId,
      ...!record.delivery && fallback && resolved.request.id === fallback.id ? { replacesUnadmittedWake: fallback.id } : {},
      ...record.delivery ? { original: { ...record.delivery, text: resolved.text } } : {}
    };
    await this.wake(request, recovery);
    return request;
  }
  async startup() {
    try {
      await this.processObservations(true);
    } catch (error) {
      this.error(error);
    }
    const restoring = new Set((await this.records.list(this.prefix + "observations/")).filter((row) => !row.value.complete && row.value.stopStarted).map((row) => row.value.pending.action.identity.executionId));
    const members = await withSnapshot(this.files, (snapshot) => this.scanMembers(snapshot));
    const targets = scanMemberRecovery(members);
    const continuations = [];
    const sessions = new DshSessionReader(this.ctx);
    for (const record of this.roleRecords.values()) {
      if (record.identity.role === "Foreground" && this.pendingForegroundResets?.size) continue;
      if (record.completedRound) {
        try {
          await this.serialWork(record.identity.workId, () => this.finishForegroundRound(record));
        } catch (error) {
          this.error(error, { identity: record.identity, stage: "startup-foreground-retirement" });
        }
        continue;
      }
      if (restoring.has(record.identity.executionId) || !["Foreground", "Organizer", "Recorder", "Helper"].includes(record.identity.role) || this.active(record) || !record.lastWake && !record.delivery) continue;
      if (["Organizer", "Recorder"].includes(record.identity.role) && await this.manuallyCleared(await this.currentTask(record))) continue;
      let inspection;
      try {
        inspection = await sessions.inspect(record.sessionId);
      } catch (error) {
        this.error(error, { identity: record.identity, sessionId: record.sessionId, stage: "startup-session-inspection" });
        continue;
      }
      if (!inspection.exists || !inspection.lifecycleKnown) continue;
      if (record.identity.role === "Foreground" && inspection.lastTurn?.reason === "completed") {
        try {
          await this.serialWork(record.identity.workId, () => this.finishForegroundRound(record));
        } catch (error) {
          this.error(error, { identity: record.identity, stage: "startup-foreground-capture" });
          continue;
        }
        if (this.roleRecords.get(record.identity.workId)?.completedRound) continue;
      }
      const hostDisposed = inspection.lastTurn?.reason === "aborted" && inspection.lastTurn.abortCause === "disposed";
      if (record.stopped && !hostDisposed) continue;
      if (await this.controls.execution(record.identity.executionId)) continue;
      const interrupted = inspection.lastTurn && (!inspection.lastTurn.closed || inspection.lastTurn.reason === "interrupted" || hostDisposed);
      if (!interrupted && !inspection.unresolvedToolCallIds.length && !inspection.queuedInbox.nextTurn.length && !inspection.queuedInbox.nextStep.length) continue;
      try {
        const continuation = await this.arrangeNativeContinuation(record, {
          facts: "Persisted native execution did not finish. Inspect existing inputs and saved work before continuing the original responsibility."
        }, inspection);
        if (continuation) continuations.push(continuation);
      } catch (error) {
        this.error(error, { identity: record.identity, sessionId: record.sessionId, stage: "startup-input-inspection" });
      }
    }
    for (const target of targets) {
      const request = {
        id: "startup:" + this.bootId + ":" + hash12(JSON.stringify([target.taskId, target.role, target.workerId, target.executionId])),
        role: target.role,
        taskId: target.taskId,
        workerId: target.workerId,
        reason: "startup-recovery",
        sources: [{ path: target.recordPath, version: "startup" }],
        context: { taskPath: target.taskPath, pendingSignals: target.pendingSignals }
      };
      const record = this.roleRecords.get(this.roleKey(target.role, target.taskId, target.workerId));
      if (!record) {
        await this.wake(request);
        continue;
      }
      try {
        const inspection = await sessions.inspect(record.sessionId);
        const continuation = await this.arrangeNativeContinuation(
          record,
          {
            ...request.context,
            recordPath: target.recordPath,
            facts: "Saved member material requires continuation. Inspect original native inputs and current notes before acting."
          },
          inspection,
          void 0,
          { ...request, id: "member-material:" + record.identity.executionId }
        );
        if (continuation) continuations.push(continuation);
      } catch (error) {
        this.error(error, { identity: record.identity, sessionId: record.sessionId, stage: "startup-member-input-inspection" });
      }
    }
    if (targets.length || continuations.length) await this.wake({ id: "startup-helper:" + randomUUID10(), role: "Helper", reason: "startup-recovery", sources: [], context: { targets, continuations } });
    await this.pump();
  }
  async currentTask(record) {
    if (record.identity.taskId) return record.identity.taskId;
    const delivery = record.delivery;
    if (!delivery || delivery.confirmed) return (delivery?.request ?? record.lastWake)?.taskId;
    const owned = this.native.get(record.identity.workId);
    const admitted = owned ? owned.hasMessage(delivery.messageId) : await new DshSessionReader(this.ctx).hasMessage(record.sessionId, delivery.messageId);
    return admitted ? delivery.request.taskId : record.lastWake?.taskId;
  }
  async applyUserControls(waitForStops = true, waitTarget) {
    let changed = false;
    const operations2 = [], waiting = /* @__PURE__ */ new Set();
    const busyAtEntry = new Set(this.workOperations?.keys() ?? []);
    const requestStop = (record, taskId, commandId) => {
      if (record.stopped) return { status: "stopped" };
      const key = JSON.stringify([record.identity.workId, record.identity.executionId]);
      const existing = this.stopOperations?.get(key);
      if (existing?.settled && existing.result && (existing.result.status === "stopped" || commandId === void 0 || existing.controlCommands?.has(commandId))) return existing.result;
      if (this.trackedStop(record)) return { status: "stopped" };
      const stop = this.stopOperations?.get(key);
      if (stop && commandId !== void 0) (stop.controlCommands ??= /* @__PURE__ */ new Set()).add(commandId);
      if (stop && (!waitTarget || waitTarget.workId === record.identity.workId && waitTarget.executionId === record.identity.executionId || waitTarget.taskId !== void 0 && waitTarget.taskId === taskId)) waiting.add(stop);
      return void 0;
    };
    for (const candidate of [...this.roleRecords.values()]) {
      if (!["Planner", "Worker", "Organizer"].includes(candidate.identity.role)) continue;
      if (!waitForStops && busyAtEntry.has(candidate.identity.workId)) continue;
      operations2.push(this.serialWork(candidate.identity.workId, async () => {
        const record = this.roleRecords.get(candidate.identity.workId);
        if (!record || !["Planner", "Worker", "Organizer"].includes(record.identity.role) || record.stopped || record.stopUnknown) return;
        let taskId;
        try {
          taskId = await this.currentTask(record);
        } catch (error) {
          this.error(error, { identity: record.identity, delivery: record.delivery });
          return;
        }
        if (!await this.controls.taskHeld(taskId)) return;
        changed = true;
        requestStop(record, taskId);
      }));
    }
    for (const request of await this.controls.pendingStops()) {
      if (!waitForStops && busyAtEntry.has(request.workId)) continue;
      operations2.push(this.serialWork(request.workId, async () => {
        changed = true;
        const record = this.roleRecords.get(request.workId);
        const result = !record || record.identity.executionId !== request.executionId ? { status: "superseded" } : requestStop(record, record.identity.taskId, request.commandId);
        if (!result) return;
        await this.controls.settleExecution(request.commandId, request.executionId, {
          state: result.status,
          ...result.status === "unconfirmed" ? { detail: result.reason, jobs: result.jobs } : {}
        });
      }));
    }
    const outcomes = await Promise.allSettled(operations2);
    if (changed) this.environment.changed?.();
    const failures = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);
    if (waitForStops && waiting.size) {
      await Promise.all([...waiting].map((stop) => stop.promise));
      failures.push(...[...waiting].filter((stop) => stop.failure !== void 0).map((stop) => stop.failure));
      if (!failures.length) await this.applyUserControls(false);
    }
    if (failures.length) throw new AggregateError(failures, "Native execution controls failed");
  }
  async requestExecutionStop(commandId, workId, executionId) {
    const record = this.roleRecords.get(workId);
    if (!record || record.identity.executionId !== executionId) throw new Error("The selected native execution is no longer owned by this Host.");
    await this.controls.requestExecutionStop(commandId, { workId, executionId, taskId: record.identity.taskId });
    await this.applyUserControls(true, { workId, executionId });
  }
  async resumeTask(taskId, commandId) {
    if (await this.manuallyCleared(taskId)) throw new Error("This Task history was explicitly cleared. Create a new Task.");
    const members = await withSnapshot(this.files, (snapshot) => this.scanMembers(snapshot));
    for (const target of scanMemberRecovery(members.filter((member) => member.taskId === taskId))) {
      const request = {
        id: "user-resume:" + commandId + ":" + target.role + ":" + (target.workerId ?? ""),
        role: target.role,
        taskId,
        workerId: target.workerId,
        reason: "user-resume",
        sources: [{ path: target.recordPath, version: "user-resume" }],
        context: { userRequestedResume: true, taskPath: target.taskPath, recordPath: target.recordPath }
      };
      await this.serialWork(this.requestKey(request), async () => {
        const record = this.roleRecords.get(this.requestKey(request));
        if (!record) {
          await this.wake(request);
          return;
        }
        const inspection = await new DshSessionReader(this.ctx).inspect(record.sessionId);
        await this.arrangeNativeContinuation(record, request.context, inspection, request.id, request, request);
      });
    }
    await this.serialWork(this.roleKey("Organizer"), async () => {
      const organizer = this.roleRecords.get(this.roleKey("Organizer"));
      if (!organizer?.stopped || await this.currentTask(organizer) !== taskId) return;
      const current = organizer.delivery?.request.taskId !== taskId ? { ...organizer, delivery: void 0 } : organizer;
      const request = {
        ...current.delivery?.request ?? current.lastWake,
        id: "user-resume:" + commandId + ":Organizer",
        role: "Organizer",
        taskId,
        reason: "user-resume",
        sources: (current.delivery?.request ?? current.lastWake)?.sources ?? [],
        context: { userRequestedResume: true }
      };
      const inspection = await new DshSessionReader(this.ctx).inspect(organizer.sessionId);
      await this.arrangeNativeContinuation(current, request.context, inspection, request.id, request, request);
    });
    await this.pump();
  }
  async observe() {
    if (this.closed) return;
    try {
      await this.environment.heartbeat();
    } catch (error) {
      this.error(error);
    }
    if (this.closed) return;
    try {
      await this.applyUserControls(false);
    } catch (error) {
      this.error(error);
    }
    if (this.closed) return;
    try {
      await this.processObservations(false, "settle");
    } catch (error) {
      this.error(error);
    }
    if (this.closed) return;
    try {
      await this.restorePending();
    } catch (error) {
      this.error(error);
    }
    if (this.closed) return;
    await this.processSealedBusiness();
    if (this.closed) return;
    await this.errorTail;
    this.startOwnedPump();
  }
  async discover(snapshot) {
    if (this.closed) return;
    try {
      await this.environment.observeResources?.(snapshot);
    } catch (error) {
      this.error(error);
    }
    if (!this.closed) await this.observeRecoveryMarkers(snapshot);
  }
  async ownerRecoveryChanges(snapshot, taskId) {
    if (await readJson(this.files, snapshot, cleanupRecordPath(taskId))) return [];
    const task = await readJson(this.files, snapshot, paths.task(taskId));
    return task ? [{ path: paths.state(task.owner, taskId) + "/recovery", content: "" }] : [];
  }
  async publishOwnerRecovery(commandId, record) {
    if (record.identity.role !== "Organizer" && record.identity.role !== "Recorder") return;
    const taskId = await this.currentTask(record);
    if (!taskId) return;
    await this.transactions.run(
      commandId,
      { taskId, role: record.identity.role, executionId: record.identity.executionId },
      { reevaluate: true },
      (snapshot) => this.ownerRecoveryChanges(snapshot, taskId)
    );
  }
  async observeRecoveryMarkers(borrowed) {
    const inspect = async (snapshot) => {
      for (const task of await this.taskMetadata(snapshot)) {
        if (this.closed) return;
        if (await readJson(this.files, snapshot, cleanupRecordPath(task.taskId)) || await this.manuallyCleared(task.taskId, snapshot)) continue;
        const marker = paths.state(this.config.member, task.taskId) + "/recovery";
        const entries = await this.files.listDirectory(snapshot, paths.state(this.config.member, task.taskId));
        if (!entries.some((entry) => entry.path === marker)) continue;
        await this.serialRecoveryWatch(task.taskId, this.config.member, async (key) => {
          if (this.closed) return;
          const record = await this.records.get(key);
          if (this.closed || record?.released) return;
          await withSnapshot(this.files, async (current) => {
            const marker2 = paths.state(this.config.member, task.taskId) + "/recovery";
            if (await this.files.read(current, marker2) === void 0) return;
            const watch = record?.watch ?? createRecoveryWatch({ taskId: task.taskId, member: this.config.member }, Date.now());
            const due = dueRecoveryWatch(watch, Date.now());
            if (!record?.watch || due.state !== record.watch) await this.records.set(key, { ...record, watch: due.state });
            if (due.action) await this.wake({
              id: "recovery-check:" + hash12(JSON.stringify([watch.taskId, watch.member, watch.cycleStartedAt, due.action.stage])),
              role: "Helper",
              taskId: task.taskId,
              reason: "observation",
              sources: [{ path: marker2, version: current.revision }],
              context: { observation: due.action }
            });
          });
        });
      }
    };
    await (borrowed ? inspect(borrowed) : withSnapshot(this.files, inspect));
  }
  async enqueueObservation(pending) {
    const key = this.prefix + "observations/" + hash12(pending.id);
    if (!await this.records.get(key)) await this.records.set(key, { pending, complete: false });
  }
  async processObservations(startedOnly = false, lane = "all") {
    const errors = [];
    for (const row of await this.records.list(this.prefix + "observations/")) {
      if (row.value.complete || startedOnly && !row.value.stopStarted) continue;
      if (lane === "settle" && (row.value.pending.action.stage !== 3 || !row.value.stopStarted)) continue;
      try {
        if (this.closed) return;
        if (await this.arrangeObservation(row.value.pending, lane) === false) continue;
        if (this.closed) return;
        await this.records.set(row.key, { ...await this.records.get(row.key) ?? row.value, complete: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Native observation arrangements failed");
  }
  async arrangeObservation(pending, lane = "all") {
    const action = pending.action;
    if (action.identity.role === "Foreground" || this.closed) return;
    const key = this.prefix + "observations/" + hash12(pending.id);
    const saved = await this.records.get(key);
    if (saved?.complete) return;
    if (!saved?.stopStarted && !await this.observations.mayApply(pending)) {
      await this.observations.deferUnperformed(pending);
      return;
    }
    const workId = action.identity.workId;
    const current = () => {
      const record2 = this.roleRecords.get(workId);
      return record2?.identity.executionId === action.identity.executionId && !record2.released ? record2 : void 0;
    };
    let record = current();
    if (!record || this.closed || await this.controls.execution(action.identity.executionId) || await this.controls.taskHeld(await this.currentTask(record)) || this.closed) return;
    if (action.stage !== 3) {
      if (record.stopped || record.stopIntent || record.stopUnknown) return;
      const agent = this.native.get(workId);
      if (!agent || agent.sessionId !== record.sessionId || this.closed) return;
      if (!await this.observations.mayApply(pending)) {
        await this.observations.deferUnperformed(pending);
        return;
      }
      const kind2 = action.identity.role === "Helper" ? action.stage === 1 ? "probe-helper" : "warn-helper" : action.stage === 1 ? "probe-role" : "warn-role";
      await agent.send(
        JSON.stringify({
          kind: kind2,
          probeId: pending.id,
          identity: action.identity,
          elapsedMs: action.elapsedMs,
          silentMs: action.silentMs,
          instruction: "If you receive this Host inactivity notice, call dss_reset_observation with this probeId, organize your current status in your existing role records, then continue the original work. Queued delivery alone is not a response."
        }),
        pending.id,
        "steer",
        "deepseek-servant"
      );
      return;
    }
    if (this.workOperations?.has(workId)) return false;
    return this.serialWork(workId, async () => {
      if (this.closed) return false;
      record = current();
      if (!record || await this.controls.execution(action.identity.executionId) || await this.controls.taskHeld(await this.currentTask(record)) || this.closed) return;
      if (!saved?.stopStarted) {
        if (!await this.observations.mayApply(pending)) {
          await this.observations.deferUnperformed(pending);
          return;
        }
        await this.records.set(key, { pending, complete: false, stopStarted: true });
      }
      if (this.closed) return false;
      if (lane === "settle" && !record.stopped) return false;
      if (!record.stopped && !record.stopIntent && !record.stopUnknown && !this.stopOperations?.has(JSON.stringify([workId, record.identity.executionId])) && this.native.get(workId) && !await this.observations.mayApply(pending)) {
        await this.observations.deferUnperformed(pending);
        return;
      }
      const priorStop = this.stopOperations?.get(JSON.stringify([workId, record.identity.executionId]));
      if (priorStop?.settled && priorStop.result?.status === "superseded" && !record.stopIntent && !record.stopUnknown) {
        await this.observations.deferUnperformed(pending);
        return;
      }
      if (!this.trackedStop(record, record.stopIntent || record.stopUnknown ? void 0 : pending)) return false;
      if (lane === "native") return false;
      record = current();
      if (!record || !record.stopped || this.closed) return false;
      if (await this.controls.execution(action.identity.executionId) || await this.controls.taskHeld(await this.currentTask(record)) || this.closed) return;
      const context2 = {
        facts: "The Host observed no effective native output/tool progress through the 5/5/30 inactivity sequence and confirmed the old execution stopped. Preserve the original records and inspect the original work before continuing.",
        previousIntervention: action,
        elapsedMs: action.elapsedMs
      };
      if (action.identity.role === "Helper") {
        const request = {
          id: "overall-restore:" + pending.id,
          role: "Helper",
          reason: "observation",
          sources: [],
          context: { ...context2, overallRestoration: true }
        };
        const inspection2 = await new DshSessionReader(this.ctx).inspect(record.sessionId);
        if (this.closed) return false;
        await this.arrangeNativeContinuation(record, request.context, inspection2, request.id, request, request);
        return;
      }
      if (record.identity.taskId && record.identity.member && (record.identity.role === "Planner" || record.identity.role === "Worker")) {
        const taskId = record.identity.taskId, member = record.identity.member;
        await this.transactions.run("observation-recovery:" + pending.id, { taskId, member, executionId: record.identity.executionId }, { reevaluate: true }, async (snapshot) => {
          if (await this.manuallyCleared(taskId, snapshot) || await readJson(this.files, snapshot, cleanupRecordPath(taskId))) return [];
          const task = await readJson(this.files, snapshot, paths.task(taskId));
          const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(taskId, member));
          const inbox = await this.files.read(snapshot, paths.inbox(taskId, member));
          if (task?.status !== "running" || status?.state === "complete" || !inbox?.length) return [];
          return [{ path: paths.state(member, taskId) + "/recovery", content: "" }];
        });
        if (this.closed) return false;
        if (record.identity.role === "Worker") await this.wake({
          id: "observation-planner:" + pending.id,
          role: "Planner",
          taskId,
          reason: "startup-recovery",
          sources: [],
          context: context2
        });
      }
      if (this.closed) return false;
      await this.publishOwnerRecovery("observation-owner-recovery:" + pending.id, record);
      if (this.closed) return false;
      const inspection = await new DshSessionReader(this.ctx).inspect(record.sessionId);
      if (this.closed) return false;
      await this.arrangeNativeContinuation(record, context2, inspection, "observation-restart:" + pending.id);
    });
  }
  async clean(task, snapshot) {
    let current = snapshot, owned;
    try {
      for (; ; ) {
        try {
          return await this.cleanAt(task, current);
        } catch (error) {
          if (!(error instanceof FilesConflictError) || this.closed) throw error;
          const fresh = await this.files.snapshot();
          if (this.closed || fresh.revision === error.expectedRevision) {
            await fresh.release();
            throw error;
          }
          const previous = owned;
          owned = fresh;
          current = fresh;
          await previous?.release();
          if (this.closed) throw error;
        }
      }
    } finally {
      await owned?.release();
    }
  }
  async cleanAt(task, snapshot) {
    const marker = paths.state(task.owner, task.taskId) + "/Cleaner";
    if (await this.files.read(snapshot, marker) === void 0 && await this.files.read(snapshot, cleanupRecordPath(task.taskId)) === void 0) return false;
    if (!this.businessStopped(task.taskId) || !await this.settleTaskOrganizer(task.taskId)) return false;
    const retentionRaw = await this.files.read(snapshot, paths.archive(task.taskId) + "/retention.json");
    if (retentionRaw !== void 0 && [...this.roleRecords.values()].some((record) => record.identity.taskId === task.taskId && record.identity.role === "Recorder" && this.active(record)) && await changedCleanupMaterials(this.files, snapshot, task, JSON.parse(retentionRaw), retentionRaw)) {
      return false;
    }
    for (const record of this.roleRecords.values()) if (record.identity.taskId === task.taskId && record.identity.role === "Recorder" && !record.stopped) {
      if (!this.trackedStop(record)) return false;
    }
    try {
      return (await this.cleaner.clean(task, snapshot)).status === "released";
    } catch (error) {
      if (!(error instanceof CleanupMaterialsChangedError)) throw error;
      await this.wake({
        id: "recorder-materials:" + task.taskId + ":" + error.signature,
        role: "Recorder",
        taskId: task.taskId,
        sources: [],
        reason: "business-complete",
        context: {
          changedOriginalPaths: error.paths,
          facts: "Original material changed after the previous archive snapshot, or that snapshot was not recorded. The originals are preserved. Read and review them, then save/read back the archive before requesting cleanup again."
        }
      });
      return false;
    }
  }
  async releaseLocalTask(taskId) {
    const task = await withSnapshot(this.files, (snapshot) => readJson(this.files, snapshot, paths.task(taskId)));
    if (!task) throw new Error("Released task metadata is unavailable: " + taskId);
    for (const record of this.roleRecords.values()) if (record.identity.taskId === taskId && !record.stopped) {
      const result = await this.stopOwnedRecord(record);
      if (result.status !== "stopped") throw new Error(result.status === "unconfirmed" ? result.reason : "Task execution changed during local release.");
      await this.saveRole({ ...record, stopped: true });
    }
    await this.releaseTask(task);
  }
  async settleTaskOrganizer(taskId, release = false) {
    for (const candidate of [...this.roleRecords.values()]) {
      if (candidate.identity.role !== "Organizer" || candidate.released) continue;
      if (![candidate.delivery?.request.taskId, candidate.lastWake?.taskId].includes(taskId)) continue;
      const workId = candidate.identity.workId;
      if (this.workOperations?.has(workId)) return false;
      let settled = true;
      await this.serialWork(workId, async () => {
        const current = this.roleRecords.get(workId);
        if (!current || current.identity.executionId !== candidate.identity.executionId || current.released) return;
        if (await this.currentTask(current) !== taskId) return;
        if (this.roleRecords.get(workId) !== current) {
          settled = false;
          return;
        }
        const associations = [current.delivery?.request.taskId, current.lastWake?.taskId].filter((id) => id !== void 0);
        if (associations.some((id) => id !== taskId)) {
          settled = false;
          return;
        }
        const stop = this.stopOperations?.get(JSON.stringify([workId, current.identity.executionId]));
        if (stop && !stop.settled || !this.trackedStop(current)) {
          settled = false;
          return;
        }
        if (release) {
          await this.observations.unbind(workId, current.identity.executionId);
          await this.saveRole({ ...current, stopped: true, released: true });
          this.stopOperations?.delete(JSON.stringify([workId, current.identity.executionId]));
        }
      });
      if (!settled) return false;
    }
    return true;
  }
  async releaseTask(task) {
    if (!await this.settleTaskOrganizer(task.taskId, true)) throw new Error("Task Organizer ownership has not settled for final release.");
    clearInboxDiscoveryCache(this.files, task.taskId);
    clearCleanupReferenceCache(this.files, task.taskId);
    for (const [workId, stop] of this.stopOperations ?? []) if (stop.taskId === task.taskId && stop.settled) this.stopOperations.delete(workId);
    for (const record of [...this.roleRecords.values()]) if (record.identity.taskId === task.taskId) {
      await this.observations.unbind(record.identity.workId, record.identity.executionId);
      await this.saveRole({ ...record, stopped: true, released: true });
    }
    await this.controls.releaseTask(task.taskId);
    await this.records.set(this.prefix + "sealed/" + hash12(task.taskId), { taskId: task.taskId, released: true });
    for (const [key, record] of this.roleRecords) if (record.identity.taskId === task.taskId && record.released) this.roleRecords.delete(key);
    for (const row of await this.records.list(this.prefix + "wakes/")) {
      if (row.value.request.taskId === task.taskId && row.value.request.role !== "Foreground") await this.updateWake(row.key, (current) => current ? this.releasedWake(current) : void 0);
    }
    for (const member of task.members ?? [task.owner]) await this.serialRecoveryWatch(task.taskId, member, async (key) => {
      const saved = await this.records.get(key);
      await this.records.set(key, { ...saved, watch: void 0, released: true });
    });
  }
  async sealBusiness(taskId) {
    const key = this.prefix + "sealed/" + hash12(taskId);
    if ((await this.records.get(key))?.released) return;
    await this.records.set(key, { taskId });
  }
  async processSealedBusiness() {
    for (const row of await this.records.list(this.prefix + "sealed/")) {
      if (row.value.released) continue;
      this.businessStopped(row.value.taskId);
    }
  }
  /** A pending producer owns its stop promise, not the discovery loop. Only
   * confirmed, persisted completion for this exact execution permits cleanup. */
  trackedStop(record, observation) {
    if (record.stopped) return true;
    const operations2 = this.stopOperations ??= /* @__PURE__ */ new Map();
    const { workId, executionId, taskId } = record.identity;
    const stopKey = JSON.stringify([workId, executionId]);
    const existing = operations2.get(stopKey);
    if (existing?.executionId === executionId) {
      if (!existing.settled) return false;
      if (existing.result?.status === "stopped") return true;
    }
    const stop = {
      executionId,
      taskId,
      promise: Promise.resolve(),
      settled: false,
      persistedStopped: existing?.persistedStopped,
      reportedFailure: existing?.reportedFailure
    };
    const report = (error, signature) => {
      if (stop.reportedFailure === signature) return;
      stop.reportedFailure = signature;
      this.error(error);
    };
    operations2.set(stopKey, stop);
    stop.promise = Promise.resolve().then(async () => {
      try {
        const result = await this.stopOwnedRecord(record, observation);
        const current = this.roleRecords.get(workId);
        if (current?.identity.executionId === executionId) {
          if (result.status === "stopped") await this.saveRole({ ...current, stopped: true, stopUnknown: void 0 });
          else if (result.status === "unconfirmed") await this.saveRole({ ...current, stopUnknown: result });
        }
        stop.result = stop.persistedStopped ? { status: "stopped" } : result;
        if (stop.result.status === "unconfirmed") report(
          new Error(stop.result.reason),
          JSON.stringify(["unconfirmed", stop.result.reason, [...stop.result.jobs].sort()])
        );
      } catch (error) {
        stop.failure = error;
        report(error, JSON.stringify(["failure", error instanceof Error ? error.message : String(error)]));
      } finally {
        if (stop.persistedStopped) stop.result = { status: "stopped" };
        stop.settled = true;
      }
    });
    return false;
  }
  businessStopped(taskId) {
    let stopped = true;
    for (const record of this.roleRecords.values()) if (record.identity.taskId === taskId && (record.identity.role === "Planner" || record.identity.role === "Worker")) {
      if (!this.trackedStop(record)) stopped = false;
    }
    if ([...this.stopOperations?.values() ?? []].some((stop) => stop.taskId === taskId && (!stop.settled || stop.result?.status !== "stopped"))) stopped = false;
    return stopped;
  }
  async stopOwnedRecord(record, observation) {
    const result = await this.native.stop(record.identity.workId, record.identity.executionId, observation);
    if (result.status !== "superseded") return result;
    if (observation && this.native.get(record.identity.workId)) return result;
    const current = this.roleRecords.get(record.identity.workId);
    if (current?.identity.executionId !== record.identity.executionId) return { status: "superseded" };
    const agent = this.ctx.agents.get(SessionId3(record.sessionId));
    const jobs = this.ctx.jobs.list(SessionId3(record.sessionId)).filter((job) => job.owner === record.sessionId && (job.status === "running" || job.status === "stopping")).map((job) => String(job.id));
    const intent = current.stopIntent;
    const known = [.../* @__PURE__ */ new Set([...jobs, ...intent?.jobs ?? [], ...current.stopUnknown?.jobs ?? []])];
    if (agent) return { status: "unconfirmed", reason: "A native Agent survives without its owned stop handle.", jobs: known };
    let events;
    try {
      events = await new DshSessionReader(this.ctx).events(record.sessionId);
    } catch (error) {
      return { status: "unconfirmed", reason: "Native stop history is unavailable: " + (error instanceof Error ? error.message : String(error)), jobs: known };
    }
    const pending = pendingNativeStopJobs(intent?.agentId ?? record.sessionId, events, known);
    if (agent || jobs.length || pending.length) return {
      status: "unconfirmed",
      reason: current.stopUnknown?.reason ?? "A native owner or producer still lacks confirmed settlement.",
      jobs: [.../* @__PURE__ */ new Set([...jobs, ...pending])]
    };
    if ((intent?.phase === "stopping" || current.stopUnknown) && !known.length) return {
      status: "unconfirmed",
      reason: "Stop was not durably confirmed and no producer identity is available to verify; inspect the original session.",
      jobs: []
    };
    if (intent || current.stopUnknown) await this.saveRole({ ...current, stopped: true, stopUnknown: void 0 });
    return { status: "stopped" };
  }
  recoveryInputPath(taskId, member, role) {
    return "technical/recovery-inputs/" + paths.member(taskId, member).slice("task-runs/".length) + "/" + role + ".json";
  }
  async processHostRestores(onError) {
    for (const row of await this.records.list(this.prefix + "host-restores/")) {
      if (this.closed) return;
      if (row.value.complete) continue;
      const { commandId, input, createdAt } = row.value;
      let phase = "targets";
      let activeTarget;
      const report = (error) => {
        if (!onError) throw error;
        onError(error, {
          hostRestorationCommandId: commandId,
          phase,
          ...error instanceof Error ? { errorName: error.name } : {},
          ...error instanceof FilesOutcomeUnknownError ? { operationId: error.operationId } : {},
          ...activeTarget ? { activeTarget } : {},
          targets: structuredClone(row.value.targets ?? [])
        });
      };
      try {
        if (!row.value.targets) {
          row.value.targets = [...this.roleRecords.values()].filter((record) => !record.released && !record.stopped && (record.stopUnknown || record.stopIntent)).map((record) => ({ identity: record.identity, sessionId: record.sessionId }));
          await this.records.set(row.key, row.value);
        }
        phase = "publication";
        await this.transactions.run("host-restore:" + commandId, { input, createdAt }, { reevaluate: true }, async (snapshot) => {
          const writes = /* @__PURE__ */ new Map();
          for (const task of await this.taskMetadata(snapshot)) {
            if (task.status !== "running" || await this.manuallyCleared(task.taskId, snapshot)) continue;
            let relevant = false;
            for (const member of (task.members ?? [task.owner]).filter((member2) => this.config.primary || member2 === this.config.member)) {
              const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(task.taskId, member));
              const inbox = await this.files.read(snapshot, paths.inbox(task.taskId, member));
              if (status?.state === "complete" || !inbox?.length) continue;
              relevant = true;
              writes.set(paths.state(member, task.taskId) + "/recovery", "");
              writes.set(paths.state(member, task.taskId) + "/Planner_Helper", "");
              writes.set(this.recoveryInputPath(task.taskId, member, "Planner"), JSON.stringify({ ...input, at: createdAt, debugPath: "debug/" + createdAt.slice(0, 10) + ".md" }));
            }
            if (relevant && task.route === "O" && this.config.primary) {
              writes.set(paths.state(task.owner, task.taskId) + "/Organizer_Helper", "");
              writes.set(this.recoveryInputPath(task.taskId, task.owner, "Organizer"), JSON.stringify({ ...input, at: createdAt, debugPath: "debug/" + createdAt.slice(0, 10) + ".md" }));
            }
          }
          const debug = "debug/" + createdAt.slice(0, 10) + ".md";
          writes.set(debug, (await this.files.read(snapshot, debug) ?? "") + "\n" + JSON.stringify({ at: createdAt, mode: "host-restoration", ...input, managers: [...writes.keys()] }) + "\n");
          return [...writes].map(([path3, content]) => ({ path: path3, content }));
        });
        const unresolved = [];
        phase = "continuations";
        let targetFailed = false;
        for (const target of row.value.targets) {
          if (this.closed) return;
          if (target.complete) continue;
          activeTarget = target.identity.executionId;
          const pending = (record, reason) => unresolved.push({
            identity: target.identity,
            sessionId: target.sessionId,
            reason,
            jobs: record?.stopUnknown?.jobs ?? record?.stopIntent?.jobs ?? []
          });
          if (this.workOperations?.has(target.identity.workId)) {
            pending(this.roleRecords.get(target.identity.workId), "This execution still owns an in-progress operation.");
            continue;
          }
          try {
            await this.serialWork(target.identity.workId, async () => {
              if (this.closed) return;
              let record = this.roleRecords.get(target.identity.workId);
              if (!record || record.released || record.identity.executionId !== target.identity.executionId) {
                target.outcome = record?.released ? "released" : "superseded";
                target.complete = true;
                await this.records.set(row.key, row.value);
                return;
              }
              if (!this.trackedStop(record)) {
                pending(record, record.stopUnknown?.reason ?? "Native stop confirmation is pending.");
                return;
              }
              record = this.roleRecords.get(target.identity.workId);
              if (!record || record.identity.executionId !== target.identity.executionId || !record.stopped) {
                pending(record, "The exact stopped execution changed before continuation could be checked.");
                return;
              }
              if (await this.controls.execution(record.identity.executionId)) target.outcome = "user-stopped";
              else {
                await this.publishOwnerRecovery("host-restore-owner:" + commandId + ":" + target.identity.executionId, record);
                if (this.closed) return;
                const continuation = await this.arrangeNativeContinuation(
                  record,
                  { ...input, facts: input.facts },
                  void 0,
                  "host-restored:" + commandId + ":" + target.identity.executionId
                );
                target.outcome = continuation ? "arranged" : "no-continuation";
              }
              target.complete = true;
              await this.records.set(row.key, row.value);
            });
            if (this.closed) return;
          } catch (error) {
            targetFailed = true;
            report(error);
          }
        }
        phase = "settlement";
        activeTarget = void 0;
        if (unresolved.length) {
          await this.records.set(row.key, { ...row.value, unresolved, complete: false });
          await this.wake({ id: "host-restoration-unresolved:" + commandId + ":" + hash12(JSON.stringify(unresolved)), role: "Helper", reason: "helper", sources: [], context: { hostRestoration: "unconfirmed", unresolved } });
          continue;
        }
        if (targetFailed) continue;
        await this.records.set(row.key, { ...row.value, complete: true });
        this.environment.restored?.();
      } catch (error) {
        report(error);
      }
    }
  }
  /** Independent owned recovery settlement, shared with the normal poll. A
   * hung admission must not prevent its Helper's persisted repair from running. */
  restorePending() {
    if (this.closed) return Promise.resolve();
    if (this.restoring) return this.restoring;
    const operation = Promise.resolve().then(async () => {
      if (this.closed) return;
      await this.processHostRestores((error, context2) => this.error(error, context2));
      if (!this.closed) await this.processRestores();
    });
    this.restoring = operation;
    void operation.finally(() => {
      if (this.restoring === operation) this.restoring = void 0;
    }).catch(() => {
    });
    return operation;
  }
  startTargetedAdmission(wakeId) {
    if (this.closed || this.targetedPumps.has(wakeId)) return;
    const operation = Promise.resolve().then(() => {
      if (!this.closed) return this.runQueue(false, wakeId);
    });
    this.targetedPumps.set(wakeId, operation);
    void operation.catch((error) => this.error(error)).finally(() => {
      if (this.targetedPumps.get(wakeId) === operation) this.targetedPumps.delete(wakeId);
    });
  }
  async restoreUnadmittedWake(row, original) {
    const { input, commandId } = row.value, workId = this.requestKey(original.request);
    if (row.value.continuationId) {
      const continuation = await this.records.get(this.prefix + "wakes/" + hash12(row.value.continuationId));
      const current = await this.records.get(this.prefix + "wakes/" + hash12(original.request.id));
      if (continuation?.delivered && current?.delivered) {
        await this.records.set(row.key, { ...row.value, complete: true, outcome: "arranged" });
      } else if (continuation) this.startTargetedAdmission(continuation.request.id);
      return;
    }
    if (this.workOperations?.has(workId)) return;
    let launch;
    await this.serialWork(workId, async () => {
      if (this.closed) return;
      const current = await this.records.get(this.prefix + "wakes/" + hash12(original.request.id));
      if (!current) throw new Error("The exact pending Host wake is unavailable.");
      if (current.delivered) {
        await this.records.set(row.key, { ...row.value, complete: true, outcome: "already-admitted" });
        return;
      }
      if (current.admission?.reportedAt === void 0) throw new Error("Wake restoration requires its recorded admission-timeout responsibility.");
      const record = this.roleRecords.get(workId);
      if (record && (!record.stopped || this.active(record))) return;
      if (["Planner", "Worker", "Organizer"].includes(current.request.role) && await this.controls.taskHeld(current.request.taskId)) return;
      if (this.closed) return;
      await this.transactions.run("restore-debug:" + commandId, input, { reevaluate: true }, async (snapshot) => {
        const path3 = "debug/" + row.value.createdAt.slice(0, 10) + ".md";
        return [{ path: path3, content: (await this.files.read(snapshot, path3) ?? "") + "\n" + JSON.stringify(input) + "\n" }];
      });
      const { taskId, role } = current.request;
      if (taskId && ["Planner", "Worker", "Organizer", "Recorder"].includes(role)) {
        await this.transactions.run("restore-wake-marker:" + commandId, { taskId, role }, { reevaluate: true }, async (snapshot) => {
          if (await this.manuallyCleared(taskId, snapshot) || await readJson(this.files, snapshot, cleanupRecordPath(taskId))) return [];
          const task = await readJson(this.files, snapshot, paths.task(taskId));
          if (!task) return [];
          const member = role === "Planner" || role === "Worker" ? this.config.member : task.owner;
          if (role === "Planner" || role === "Worker") {
            const status = await readMemberStatus(this.files, snapshot, paths.memberStatus(taskId, member));
            const inbox = await this.files.read(snapshot, paths.inbox(taskId, member));
            if (task.status !== "running" || status?.state === "complete" || !inbox?.length) return [];
          }
          return [{ path: paths.state(member, taskId) + "/recovery", content: "" }];
        });
      }
      if (this.closed) return;
      const continuationId = "restore-wake:" + commandId;
      await this.wake(
        {
          ...current.request,
          id: continuationId,
          reason: "startup-recovery",
          context: { ...current.request.context, admissionRestoration: input, originalWakeId: current.request.id }
        },
        { replacesUnadmittedWake: current.request.id }
      );
      await this.records.set(row.key, { ...row.value, continuationId });
      launch = continuationId;
    });
    if (launch) this.startTargetedAdmission(launch);
  }
  async processRestores() {
    for (const row of await this.records.list(this.prefix + "restores/")) {
      if (this.closed) return;
      if (row.value.complete) continue;
      const admissionId = row.value.admissionWakeId ?? row.value.input.wakeId;
      if (admissionId && !row.value.continuationId) {
        const original = await this.records.get(this.prefix + "wakes/" + hash12(admissionId));
        const owner = original && this.roleRecords.get(this.requestKey(original.request));
        if (original?.delivered || owner?.delivery?.request.id === admissionId && owner.delivery.confirmed) {
          if (original && !original.delivered) await this.updateWake(this.prefix + "wakes/" + hash12(admissionId), (current) => current ? { ...current, delivered: true, admission: void 0 } : void 0);
          await this.records.set(row.key, { ...row.value, complete: true, outcome: "already-admitted" });
          continue;
        }
      }
      if (!row.value.input.target && !row.value.resolvedTarget) {
        const wakeId = row.value.input.wakeId;
        const original = await this.records.get(this.prefix + "wakes/" + hash12(wakeId));
        if (!original) throw new Error("The requested Host wake does not exist.");
        if (original.delivered && !row.value.continuationId) {
          await this.records.set(row.key, { ...row.value, complete: true, outcome: "already-admitted" });
          continue;
        }
        const current = this.roleRecords.get(this.requestKey(original.request));
        if (!row.value.continuationId && current && original.admission?.executionId === current.identity.executionId) {
          row.value.resolvedTarget = { ...current.identity };
          await this.records.set(row.key, row.value);
        } else {
          await this.restoreUnadmittedWake(row, original);
          continue;
        }
      }
      const input = { ...row.value.input, target: row.value.resolvedTarget ?? row.value.input.target };
      const busy = this.workOperations?.get(input.target.workId);
      if (busy) {
        const current = this.roleRecords.get(input.target.workId);
        if (!current || current.identity.executionId !== input.target.executionId) continue;
        const cancellation = new DOMException("Helper is recovering this exact pending native admission.", "AbortError");
        this.admissionCancellations.set(input.target.executionId, cancellation);
        try {
          const stopped = this.native.get(input.target.workId) ? await this.native.stop(input.target.workId, input.target.executionId) : await this.native.cancelOpening(input.target.workId, input.target.executionId, cancellation);
          if (stopped.status !== "stopped") {
            if (stopped.status === "unconfirmed") {
              const latest = this.roleRecords.get(input.target.workId);
              if (latest?.identity.executionId === input.target.executionId && latest.stopUnknown?.reason !== stopped.reason) {
                await this.saveRole({ ...latest, stopUnknown: stopped });
                this.error(new Error(stopped.reason), { restoreCommandId: row.value.commandId, identity: latest.identity });
              }
            }
            continue;
          }
          await busy;
          const settled = this.roleRecords.get(input.target.workId);
          if (this.closed) return;
          if (settled?.identity.executionId === input.target.executionId) await this.saveRole({ ...settled, stopped: true });
        } finally {
          this.admissionCancellations.delete(input.target.executionId);
        }
      }
      if (this.closed) return;
      await this.serialWork(input.target.workId, async () => {
        if (this.closed) return;
        let record = this.roleRecords.get(input.target.workId);
        if (!record || record.identity.executionId !== input.target.executionId) {
          await this.records.set(row.key, { ...row.value, complete: true });
          return;
        }
        if (["Planner", "Worker", "Organizer", "Recorder"].includes(record.identity.role) && await this.manuallyCleared(await this.currentTask(record))) {
          await this.records.set(row.key, { ...row.value, complete: true });
          return;
        }
        const date = row.value.createdAt.slice(0, 10);
        await this.transactions.run("restore-debug:" + row.value.commandId, input, { reevaluate: true }, async (snapshot) => {
          const path3 = "debug/" + date + ".md";
          return [{ path: path3, content: (await this.files.read(snapshot, path3) ?? "") + "\n" + JSON.stringify(input) + "\n" }];
        });
        record = this.roleRecords.get(input.target.workId);
        if (!record || record.identity.executionId !== input.target.executionId || !this.trackedStop(record)) return;
        record = this.roleRecords.get(input.target.workId);
        if (!record || record.identity.executionId !== input.target.executionId || !record.stopped) return;
        if (record.identity.taskId && record.identity.member && (record.identity.role === "Planner" || record.identity.role === "Worker")) {
          const taskId2 = record.identity.taskId, member = record.identity.member;
          await this.transactions.run("restore-marker:" + row.value.commandId, { taskId: taskId2, member }, { reevaluate: true }, async (checked) => {
            if (await this.manuallyCleared(taskId2, checked)) return [];
            const task = await readJson(this.files, checked, paths.task(taskId2));
            const status = await readMemberStatus(this.files, checked, paths.memberStatus(taskId2, member));
            const inbox = await this.files.read(checked, paths.inbox(taskId2, member));
            if (task?.status !== "running" || status?.state === "complete" || !inbox?.length) return [];
            return [{ path: paths.state(member, taskId2) + "/recovery", content: "" }];
          });
          if (record.identity.role === "Worker") await this.wake({
            id: "restore-planner:" + row.value.commandId,
            role: "Planner",
            taskId: taskId2,
            reason: "startup-recovery",
            sources: [],
            context: input
          });
        }
        const pending = (await this.records.list(this.prefix + "wakes/")).find((wake) => !wake.value.delivered && this.requestKey(wake.value.request) === record.identity.workId && !wake.value.recovery);
        const taskId = await this.currentTask(record) ?? pending?.value.request.taskId;
        if (taskId && (record.identity.role === "Organizer" || record.identity.role === "Recorder")) {
          await this.transactions.run("restore-role-marker:" + row.value.commandId, { taskId, role: record.identity.role }, { reevaluate: true }, async (snapshot) => {
            return this.ownerRecoveryChanges(snapshot, taskId);
          });
        }
        const neverSent = pending && pending.value.admission?.executionId === record.identity.executionId && record.delivery?.request.id !== pending.value.request.id;
        const owner = neverSent ? { ...record, delivery: void 0, lastWake: void 0 } : record;
        const continuation = await this.arrangeNativeContinuation(owner, input, void 0, "restore-role:" + row.value.commandId, pending?.value.request);
        const terminal = !continuation && !pending && !record.delivery && !record.lastWake && record.identity.taskId && ["Planner", "Worker"].includes(record.identity.role) && await withSnapshot(this.files, async (snapshot) => {
          const task = await readJson(this.files, snapshot, paths.task(record.identity.taskId));
          if (task?.status === "complete") return true;
          const status = record.identity.member && await readMemberStatus(this.files, snapshot, paths.memberStatus(record.identity.taskId, record.identity.member));
          return !!status && status.state === "complete";
        });
        if (continuation || terminal) await this.records.set(row.key, { ...row.value, complete: true, outcome: continuation ? "arranged" : "terminal" });
      });
    }
  }
  cancelledByShutdown(error) {
    return this.shutdownReason !== void 0 && (error === this.shutdownReason || error instanceof Error && error.name === "AbortError" && error.cause === this.shutdownReason || error instanceof DshAgentCreationCancelled && error.executionStopped && error.reason === this.shutdownReason);
  }
  error(error, context2) {
    if (this.cancelledByShutdown(error)) return;
    this.environment.error(error);
    if (this.closed) return;
    const rateLimit = error instanceof GitHubError ? error.rateLimit : void 0;
    if (rateLimit) {
      this.rateLimitDiagnostics ??= /* @__PURE__ */ new WeakMap();
      if (this.rateLimitDiagnostics.has(rateLimit)) return;
      this.rateLimitDiagnostics.set(rateLimit, "pending");
    }
    const facts = error instanceof Error ? error.message : String(error);
    this.errorTail = this.errorTail.then(async () => {
      const diagnosticContext = typeof context2?.hostRestorationCommandId === "string" && typeof context2.activeTarget === "string" && Array.isArray(context2.targets) ? { ...context2, targets: context2.targets.filter((target) => target?.identity?.executionId === context2.activeTarget) } : context2;
      const signature = hash12(JSON.stringify([facts, diagnosticContext]));
      if (context2?.identity?.role === "Helper" || context2?.role === "Helper") {
        await this.records.set(this.prefix + "helper-errors/" + signature, { facts, context: context2 });
        return;
      }
      const pending = (await this.records.list(this.prefix + "wakes/")).some((row) => !row.value.delivered && row.value.request.context?.errorSignature === signature);
      const diagnosticId = typeof context2?.hostRestorationCommandId === "string" ? "host-restore-error:" + signature : "host-error:" + randomUUID10();
      if (!pending) await this.wake({
        id: diagnosticId,
        role: "Helper",
        reason: "helper",
        sources: [],
        context: { errorSignature: signature, facts, ...context2 ?? {} }
      });
    }).then(() => {
      if (rateLimit) this.rateLimitDiagnostics.set(rateLimit, "recorded");
    }).catch((failure) => {
      if (rateLimit) this.rateLimitDiagnostics.delete(rateLimit);
      this.environment.error(failure);
    });
  }
  /** Moving the owned storage is stricter than closing its UI: no producer may
   * still own a write into the directory being copied. Preserve unknown native
   * settlement instead of treating an empty registry as stopped. */
  async settleForStorageMove() {
    await this.dispose();
    for (const row of await this.records.list(this.prefix + "roles/")) {
      if (row.value.released || row.value.stopped) continue;
      const current = this.roleRecords.get(row.value.identity.workId);
      if (current && current.identity.executionId !== row.value.identity.executionId) throw new Error("Storage move encountered a replaced execution identity.");
      this.roleRecords.set(row.value.identity.workId, row.value);
      const result = await this.stopOwnedRecord(row.value);
      if (result.status !== "stopped") throw new Error(result.status === "unconfirmed" ? "Storage has an unconfirmed native producer: " + result.reason : "Storage execution ownership changed before its move.");
      await this.saveRole({ ...row.value, stopped: true });
    }
  }
  dispose() {
    return this.disposing ??= this.disposeOwned();
  }
  async disposeOwned() {
    this.closed = true;
    const failures = [];
    try {
      const cancellation = this.shutdownReason = new DOMException("Framework runtime is closing its owned requests.", "AbortError");
      const openingStops = [...this.roleRecords.values()].map(async (record) => {
        const result = await this.native.cancelOpening(record.identity.workId, record.identity.executionId, cancellation);
        const current = this.roleRecords.get(record.identity.workId);
        if (result.status === "stopped" && current?.identity.executionId === record.identity.executionId)
          await this.saveRole({ ...current, stopped: true });
        return result;
      });
      const loopStopped = this.loop.stop();
      try {
        this.environment.cancelPending?.(cancellation);
      } catch (error) {
        failures.push(error);
      }
      try {
        await loopStopped;
      } catch (error) {
        if (!this.cancelledByShutdown(error)) failures.push(error);
      }
      for (const settled of await Promise.allSettled(openingStops)) {
        if (settled.status === "rejected") failures.push(settled.reason);
        else if (settled.value.status === "unconfirmed") failures.push(new Error(settled.value.reason));
      }
      try {
        await this.pumping;
      } catch (error) {
        if (!this.cancelledByShutdown(error)) failures.push(error);
      }
      try {
        await this.restoring;
      } catch (error) {
        if (!this.cancelledByShutdown(error)) failures.push(error);
      }
      try {
        await this.helperPumping;
      } catch (error) {
        if (!this.cancelledByShutdown(error)) failures.push(error);
      }
      for (const settled of await Promise.allSettled([...this.targetedPumps.values()]))
        if (settled.status === "rejected" && !this.cancelledByShutdown(settled.reason)) failures.push(settled.reason);
      while ([...this.stopOperations?.values() ?? []].some((stop) => !stop.settled)) {
        await Promise.all([...this.stopOperations.values()].filter((stop) => !stop.settled).map((stop) => stop.promise));
      }
      for (const record of this.roleRecords.values()) {
        if (record.stopped) continue;
        try {
          const result = await this.stopOwnedRecord(record);
          if (result.status === "unconfirmed") {
            failures.push(new Error(result.reason));
            await this.saveRole({ ...record, stopUnknown: result });
          }
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await this.observations.dispose();
      } catch (error) {
        failures.push(error);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      while (this.workOperations?.size) {
        const settled = await Promise.allSettled([...this.workOperations.values()]);
        for (const result of settled) if (result.status === "rejected" && !this.cancelledByShutdown(result.reason)) failures.push(result.reason);
      }
      try {
        await this.errorTail;
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.foregroundActivity?.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Runtime disposal and diagnostic persistence failed");
  }
};

// src/framework/capacity.ts
import { MessageId as MessageId2 } from "@deepseek-ai/dsh-llm";
function createRecorderCapacity(files) {
  return async (agent, input) => {
    const services = agent.ctx;
    const meter = services.get("tokenMeter");
    const projections = services.get("sessionProjections");
    const measurement = typeof meter?.measure === "function" ? meter.measure(agent.session) : void 0;
    const estimate = typeof meter?.estimateMessage === "function" ? meter.estimateMessage.bind(meter) : void 0;
    const values2 = projections?.snapshot(agent.session, ["contextPressure", "tokenUsage"]).values;
    const pressure = values2?.contextPressure;
    const usage = values2?.tokenUsage;
    const contextWindow = agent.session.requestContext()?.contextWindow ?? pressure?.contextWindow ?? null;
    return withSnapshot(files, async (snapshot) => {
      const materials = [];
      for (const path3 of new Set(input.paths)) {
        const bytes = await files.readBytes(snapshot, path3);
        if (bytes === void 0) {
          materials.push({ path: path3, status: "missing", bytes: null, estimatedTokens: null });
          continue;
        }
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (text.includes("\0")) text = void 0;
        } catch {
        }
        const estimatedTokens = text === void 0 || !estimate ? null : estimate({
          id: MessageId2("dss-capacity:" + input.taskId + ":" + path3),
          role: "user",
          source: { kind: "deepseek-servant" },
          content: [{ type: "text", text }]
        });
        materials.push({ path: path3, status: text === void 0 ? "binary" : "text", bytes: bytes.byteLength, estimatedTokens });
      }
      return {
        revision: snapshot.revision,
        materials,
        textEstimateTotal: estimate ? materials.reduce((total, item) => total + (item.estimatedTokens ?? 0), 0) : null,
        containsUnestimatedMaterials: materials.some((item) => item.estimatedTokens === null),
        estimateBasis: estimate ? "native-token-meter-per-message" : "unavailable",
        session: {
          measuredTokens: measurement?.totalTokens ?? null,
          measurementBasis: measurement?.baseline.kind ?? null,
          pressureTokens: pressure?.pressureTokens ?? null,
          projectedTokens: pressure?.projectedTokens ?? null,
          contextWindow,
          cumulativeUsage: usage ?? null
        }
      };
    });
  };
}

// src/framework/service.ts
var model = z7.object({ provider: z7.string(), model: z7.string(), reasoningEffort: z7.string().optional() });
var settingsSchema = z7.object({
  name: z7.string(),
  userName: z7.string(),
  localDirectory: z7.string(),
  ownerRepo: z7.string(),
  repositoryDirectory: z7.string(),
  collaborationId: z7.string().min(1),
  workerSeats: z7.number().int().nonnegative(),
  workspace: z7.string(),
  presetId: z7.string().optional(),
  foreground: model.optional(),
  background: model.optional(),
  showCornerCharacter: z7.boolean().optional(),
  swapPageIllustrations: z7.boolean().optional()
});
function abortedBy(signal, error) {
  return !!signal?.aborted && (error === signal.reason || error instanceof Error && error.name === "AbortError" && error.cause === signal.reason);
}
var FrameworkService = class {
  constructor(ctx, storage, defaults) {
    this.ctx = ctx;
    this.storage = storage;
    this.defaults = defaults;
  }
  accessTransitions = /* @__PURE__ */ new Map();
  accesses = /* @__PURE__ */ new Map();
  stopping = /* @__PURE__ */ new WeakMap();
  running = /* @__PURE__ */ new Map();
  configurationOwners = /* @__PURE__ */ new Set();
  accessOpening = /* @__PURE__ */ new Map();
  backgroundOpening = /* @__PURE__ */ new Map();
  opening = /* @__PURE__ */ new Map();
  archiveViews = /* @__PURE__ */ new Map();
  errors = /* @__PURE__ */ new Map();
  configurationErrors = /* @__PURE__ */ new Map();
  reportedErrors = /* @__PURE__ */ new Map();
  saved = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  activeMode = "local";
  legacyCoop;
  // Only physical record relocation owns both mode lanes.
  configuration = Promise.resolve();
  modeConfiguration = /* @__PURE__ */ new Map();
  settingsCommands = /* @__PURE__ */ new Map();
  serialMode(mode, action, commandId) {
    try {
      mode = z7.enum(["local", "git"]).parse(mode);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.closed) return Promise.reject(new Error("Framework service is disposed."));
    const predecessors = [this.configuration, this.modeConfiguration.get(mode), commandId === void 0 ? void 0 : this.settingsCommands.get(commandId)];
    const operation = Promise.all(predecessors).then(() => {
      this.assertOpen();
      return action();
    });
    const settled = operation.then(() => void 0, () => void 0);
    this.modeConfiguration.set(mode, settled);
    if (commandId !== void 0) {
      this.settingsCommands.set(commandId, settled);
      void settled.then(() => {
        if (this.settingsCommands.get(commandId) === settled) this.settingsCommands.delete(commandId);
      });
    }
    return operation;
  }
  serialRecords(action) {
    if (this.closed) return Promise.reject(new Error("Framework service is disposed."));
    const operation = Promise.all([this.configuration, ...this.modeConfiguration.values()]).then(() => {
      this.assertOpen();
      return action();
    });
    this.configuration = operation.then(() => void 0, () => void 0);
    return operation;
  }
  closed = false;
  recordMoving;
  recordMoveController;
  recordMover;
  pendingRecordMove;
  relocationOwners = /* @__PURE__ */ new Map();
  disposal;
  initializing;
  starting;
  modeStarting = /* @__PURE__ */ new Map();
  startupState = /* @__PURE__ */ new Map();
  disposalErrors = [];
  assertOpen() {
    if (this.closed) throw new Error("Framework service is disposed.");
  }
  cleanupFailure(mode, error) {
    this.disposalErrors.push(error);
    this.report(mode, error);
  }
  subscribeChanged = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  changed() {
    for (const listener of this.listeners)
      listener();
  }
  diagnosticScope(mode, settings = this.saved.get(mode)?.settings) {
    if (!settings) return mode + " (storage scope unavailable)";
    return mode === "local" ? settings.localDirectory : settings.ownerRepo + "/" + settings.repositoryDirectory;
  }
  refreshErrors(mode) {
    const messages = this.reportedErrors.get(mode);
    if (messages?.size) this.errors.set(mode, [...messages.keys()].join("\n"));
    else {
      this.errors.delete(mode);
      this.reportedErrors.delete(mode);
    }
  }
  clearResolvedErrors(mode, commandId) {
    const messages = this.reportedErrors.get(mode);
    for (const [message, record] of messages ?? []) {
      if (commandId === void 0 ? !record.operationId : record.commandId === commandId) messages.delete(message);
    }
    this.refreshErrors(mode);
  }
  report(mode, error, scope, commandId) {
    const raw = error instanceof Error ? error.message : String(error);
    const operationId = error instanceof FilesOutcomeUnknownError ? error.operationId : void 0;
    const message = operationId ? `Unresolved storage operation ${operationId} in ${scope ?? this.diagnosticScope(mode)}: ${raw}` : raw;
    let messages = this.reportedErrors.get(mode);
    if (!messages) this.reportedErrors.set(mode, messages = /* @__PURE__ */ new Map());
    if (!messages.has(message)) {
      messages.set(message, { operationId, commandId });
      this.refreshErrors(mode);
      this.changed();
    } else if (commandId !== void 0) messages.get(message).commandId = commandId;
    return message;
  }
  /** Host registration waits for settings, not remote migration or model admission. */
  initialize() {
    if (this.closed) return Promise.reject(new Error("Framework service is disposed."));
    return this.initializing ??= this.initializeOwned();
  }
  /** Explicit lifecycle callers may still await every owned startup responsibility. */
  async start() {
    await this.initialize();
    await this.starting;
    this.assertOpen();
  }
  async initializeOwned() {
    this.activeMode = await this.storage.get("framework-active-mode") ?? "local";
    for (const mode of ["local", "git"]) {
      this.assertOpen();
      const key = "framework-settings/" + mode;
      let saved = await this.storage.get(key);
      if (!saved) {
        let settings = { ...this.defaults };
        if (mode === "local") {
          const legacyRuntime = await this.storage.get("settings/runtime");
          if (legacyRuntime?.schemaVersion === 1 && Number.isSafeInteger(legacyRuntime.workerSeats) && legacyRuntime.workerSeats >= 0) {
            settings.workerSeats = legacyRuntime.workerSeats;
          }
          const profile = await readLegacyLocalProfile(this.storage);
          if (profile) {
            const route = (value) => value.provider && value.model ? { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort } : void 0;
            settings = {
              ...settings,
              name: profile.settings.name,
              userName: profile.settings.userName ?? "",
              presetId: profile.settings.presetId,
              workspace: profile.settings.workspaceDirectory ?? profile.workspace.directory,
              foreground: route(profile.settings.foreground),
              background: route(profile.settings.background),
              showCornerCharacter: profile.settings.showCornerCharacter,
              swapPageIllustrations: profile.settings.swapPageIllustrations
            };
          }
        } else {
          this.legacyCoop = await readLegacyCoopSettings(this.ctx);
          const old = this.legacyCoop.settings;
          settings = {
            ...settings,
            ownerRepo: old.ownerRepo,
            repositoryDirectory: old.repositoryDirectory,
            workerSeats: old.workerSeats,
            workspace: old.workspace,
            presetId: old.presetId,
            background: old.provider && old.model ? { provider: old.provider, model: old.model, reasoningEffort: old.reasoningEffort } : void 0
          };
          if (await this.storage.get("framework-participation/git") === void 0) await this.storage.set("framework-participation/git", old.remoteEnabled);
        }
        saved = { revision: randomUUID11(), settings };
      }
      await this.persistSettings(mode, saved);
    }
    this.assertOpen();
    const owners = ["local", "git"].map((mode) => {
      const owner = { mode, controller: new AbortController() };
      this.configurationOwners.add(owner);
      this.startupState.set(mode, { status: "starting", owner });
      return owner;
    });
    const preparation = Promise.resolve().then(() => this.resumeStartupMove());
    for (const owner of owners) {
      const operation = Promise.resolve().then(async () => {
        try {
          await preparation;
          this.assertOpen();
          owner.controller.signal.throwIfAborted();
          const mode = owner.mode;
          const enabled = await this.storage.get("framework-participation/" + mode) ?? mode === "local";
          this.assertOpen();
          owner.controller.signal.throwIfAborted();
          if (enabled && (mode !== "git" || this.config(mode).settings.ownerRepo.trim())) {
            await this.connect(mode, owner.controller.signal);
          } else if (mode === "local") {
            const access = await this.access(mode);
            await this.withManualCleanup(access, (cleanup) => cleanup.resumePending((error, commandId) => {
              this.report(mode, error, access.connection.scope, commandId);
            }));
          }
          if (this.startupState.get(mode)?.owner === owner) this.startupState.delete(mode);
        } catch (error) {
          if (this.closed || abortedBy(owner.controller.signal, error)) {
            if (this.startupState.get(owner.mode)?.owner === owner) this.startupState.delete(owner.mode);
          } else {
            if (this.startupState.get(owner.mode)?.owner === owner) this.startupState.set(owner.mode, { status: "failed", owner });
            this.report(owner.mode, error, this.diagnosticScope(owner.mode));
          }
        } finally {
          this.configurationOwners.delete(owner);
          this.changed();
        }
      });
      this.modeStarting.set(owner.mode, operation);
    }
    this.starting = Promise.all([...this.modeStarting.values()]).then(() => void 0);
  }
  async resumeStartupMove() {
    this.assertOpen();
    const physical = this.storage;
    if (physical.moveRecords && physical.storageView) {
      const controller = this.recordMoveController = new AbortController();
      try {
        this.pendingRecordMove = await this.mover().pendingReceipt();
        await this.mover().resumePending(controller.signal);
        this.pendingRecordMove = void 0;
      } catch (error) {
        if (this.closed) throw error;
        this.recordMoving ??= error instanceof Error ? error : new Error(String(error));
        this.report("local", error);
        throw error;
      } finally {
        if (this.recordMoveController === controller) this.recordMoveController = void 0;
      }
    }
  }
  async modeReady(mode) {
    await this.initializing;
    this.assertOpen();
    if (this.recordMoving) throw this.recordMoving;
    if (this.running.has(mode)) return;
    if (this.startupState.get(mode)?.status === "failed") throw new Error(this.errors.get(mode) ?? "Collaboration startup failed. Retry connection to resume the retained work.");
    if (mode === "git" && this.startupState.get(mode)?.status === "starting") throw new Error("Git collaboration is still initializing; this operation has not been applied. Retry after initialization completes.");
    const opening = this.opening.get(mode);
    if (opening) await opening;
    else await this.modeStarting.get(mode);
    this.assertOpen();
    if (this.recordMoving) throw this.recordMoving;
    if (!this.running.has(mode) && this.startupState.get(mode)?.status === "failed") throw new Error(this.errors.get(mode) ?? "Collaboration startup failed. Retry connection to resume the retained work.");
  }
  access(mode) {
    if (this.recordMoving) return Promise.reject(this.recordMoving);
    if (this.closed) return Promise.reject(new Error("Framework service is disposed."));
    const transition = this.accessTransitions.get(mode);
    if (transition) return transition.then(() => this.access(mode));
    const prior = this.accesses.get(mode);
    if (prior) return prior;
    const settings = this.config(mode).settings;
    const controller = new AbortController();
    this.accessOpening.set(mode, controller);
    const pending = openFrameworkStorage(mode === "local" ? { mode, directory: settings.localDirectory, login: settings.userName, workerSeats: settings.workerSeats } : { mode, ownerRepo: settings.ownerRepo, repositoryDirectory: settings.repositoryDirectory, workerSeats: settings.workerSeats }, { storage: this.storage, signal: controller.signal }).then(async (connection) => {
      const assertCurrent = () => {
        this.assertOpen();
        controller.signal.throwIfAborted();
        if (this.accessOpening.get(mode) !== controller) throw new Error("Storage access was replaced before acquisition completed.");
      };
      try {
        assertCurrent();
        const access = { connection, conversation: new FrameworkConversation(connection.files, connection.transactions, { mode, collaborationId: settings.collaborationId }) };
        if (mode === "local") {
          const repairController = new AbortController();
          const done = this.resumeLocalArtifacts(connection, repairController.signal).then((references) => {
            if (!repairController.signal.aborted && !this.closed) {
              access.legacyArtifacts = references;
              this.changed();
            }
          }).catch((error) => {
            if (!abortedBy(repairController.signal, error)) this.report(mode, error, connection.scope);
          });
          access.artifactRepair = { controller: repairController, done };
        }
        return access;
      } catch (error) {
        await connection.close().catch((failure) => this.cleanupFailure(mode, failure));
        throw error;
      }
    });
    this.accesses.set(mode, pending);
    void pending.finally(() => {
      if (this.accessOpening.get(mode) === controller) this.accessOpening.delete(mode);
    }).catch(() => {
    });
    void pending.catch(() => {
      if (this.accesses.get(mode) === pending) this.accesses.delete(mode);
    });
    return pending;
  }
  async closeAccess(access) {
    access.artifactRepair?.controller.abort();
    await disposeResources([
      () => access.connection.cancelPending(),
      async () => {
        await access.artifactRepair?.done;
      },
      () => access.connection.close()
    ]);
  }
  async resumeLocalArtifacts(connection, signal) {
    const references = /* @__PURE__ */ new Map();
    const index = await withSnapshot(connection.files, (snapshot) => readJson(connection.files, snapshot, "technical/legacy-migrations/index.json"));
    for (const migration of index?.migrations ?? []) {
      signal.throwIfAborted();
      try {
        await resumePendingLegacyArtifacts(this.ctx, connection.files, connection.transactions, migration.manifestPath, {
          signal,
          onIssue: (issue2) => this.report("local", issue2.error ?? new Error(issue2.detail), connection.scope)
        });
      } catch (error) {
        if (abortedBy(signal, error)) throw error;
        this.report("local", error, connection.scope);
      }
      signal.throwIfAborted();
      try {
        references.set(migration.id, await withSnapshot(connection.files, (snapshot) => listLegacyArtifactReferences(connection.files, snapshot, migration.manifestPath)));
      } catch (error) {
        if (abortedBy(signal, error)) throw error;
        this.report("local", error, connection.scope);
      }
    }
    return references;
  }
  config(mode) {
    this.assertOpen();
    const saved = this.saved.get(mode);
    if (!saved)
      throw new Error("Framework settings are not loaded.");
    return saved;
  }
  connect(mode, signal) {
    if (this.recordMoving) return Promise.reject(this.recordMoving);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new Error("Framework service is disposed."));
    const active = this.running.get(mode);
    if (active)
      return Promise.resolve(active);
    const pending = this.opening.get(mode);
    if (pending)
      return pending;
    const controller = new AbortController();
    this.backgroundOpening.set(mode, controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    this.startupState.set(mode, { status: "starting", owner: controller });
    const operation = this.open(mode, controller.signal).then((value) => {
      if (this.startupState.get(mode)?.owner === controller) this.startupState.delete(mode);
      this.changed();
      return value;
    }, (error) => {
      if (this.startupState.get(mode)?.owner === controller) {
        if (controller.signal.aborted || this.closed) this.startupState.delete(mode);
        else this.startupState.set(mode, { status: "failed", owner: controller });
      }
      this.changed();
      throw error;
    });
    this.opening.set(mode, operation);
    void operation.finally(() => {
      signal?.removeEventListener("abort", abort);
      if (this.backgroundOpening.get(mode) === controller) this.backgroundOpening.delete(mode);
      if (this.opening.get(mode) === operation)
        this.opening.delete(mode);
    }).catch(() => {
    });
    return operation;
  }
  async open(mode, signal) {
    const settings = this.config(mode).settings;
    const workspace = await new DshWorkspaceAdapter(this.ctx).resolve(void 0, settings.workspace || void 0);
    this.assertOpen();
    signal?.throwIfAborted();
    const connection = await openFrameworkConnection(mode === "local" ? { mode, directory: settings.localDirectory, login: settings.userName, workerSeats: settings.workerSeats } : { mode, ownerRepo: settings.ownerRepo, repositoryDirectory: settings.repositoryDirectory, workerSeats: settings.workerSeats }, { storage: this.storage, signal });
    let resources;
    try {
      this.assertOpen();
      signal?.throwIfAborted();
      resources = await connection.members();
      signal?.throwIfAborted();
      if (mode === "git") this.legacyCoop ??= await readLegacyCoopSettings(this.ctx);
      await migrateFrameworkStorage({
        mode,
        scope: connection.scope,
        files: connection.files,
        transactions: connection.transactions,
        records: this.storage,
        options: async (capture, id) => {
          const member = connection.registration.member, account = connection.repository ? String(connection.repository.identity.id) : member;
          const members = {};
          if (mode === "local") for (const task of capture.tasks) for (const participant of task.participants) members[participant.identity] = member;
          else if (this.legacyCoop?.instanceId) members[account + "/" + this.legacyCoop.instanceId] = member;
          const nativeOwnershipReconciled = {};
          for (const task of capture.tasks) for (const participant of task.participants) {
            if (!members[participant.identity]) continue;
            const evidence = nativeOwnershipReconciled[participant.identity] ??= [];
            for (const execution of participant.nativeExecutions ?? []) {
              let settled = false;
              const sessionId = SessionId4(execution.sessionId), owner = execution.agentId ?? execution.sessionId;
              const live = this.ctx.agents.get(sessionId), jobs = this.ctx.jobs.list(sessionId).filter((job) => job.owner === owner && (job.status === "running" || job.status === "stopping"));
              if (!live && !jobs.length) {
                if (execution.recordedSettled && !execution.ownedJobIds.length) settled = true;
                else try {
                  const events = await new DshSessionReader(this.ctx).events(execution.sessionId);
                  const known = [.../* @__PURE__ */ new Set([...execution.ownedJobIds, ...events.filter((event) => event.type === "job/registered" && event.data.owner === owner).map((event) => event.data.jobId)])];
                  settled = known.length > 0 && pendingNativeStopJobs(owner, events, known).length === 0;
                } catch {
                }
              }
              evidence.push({ executionId: execution.executionId, generation: execution.generation, settled });
            }
          }
          return { id, owner: member, members, nativeOwnershipReconciled, conversations: mode === "local" ? [{ scope: { mode, collaborationId: settings.collaborationId }, assistantId: "default", participantId: account }] : [{
            scope: { mode, collaborationId: settings.collaborationId },
            entryPaths: capture.records.filter((record) => /^conversations\/.+\/entry\.json$/.test(record.key)).map((record) => record.key),
            ...this.legacyCoop?.instanceId ? { foregroundIdentity: { participantId: account, instanceId: this.legacyCoop.instanceId } } : {}
          }] };
        }
      });
    } catch (error) {
      await connection.close().catch((failure) => this.cleanupFailure(mode, failure));
      throw error;
    }
    const resource = { connection, resources };
    let runtime;
    const cleanupFailures = [];
    try {
      this.assertOpen();
      const profile = mode === "local" ? await this.storage.get("assistant/default") : void 0;
      const legacySkillScopes = profile?.schemaVersion === 1 && profile.id === "default" && profile.workspace.id === workspace.id ? [{ assistantId: "default", workspaceId: workspace.id }] : [];
      this.assertOpen();
      runtime = new FrameworkRoleRuntime(this.ctx, connection.files, this.storage, {
        scope: connection.scope,
        legacySkillScopes,
        legacyGitSkillParticipants: connection.repository ? [String(connection.repository.identity.id)] : [],
        member: connection.registration.member,
        primary: connection.registration.primary,
        workspace: workspace.directory,
        workerSeats: settings.workerSeats,
        mode,
        collaborationId: settings.collaborationId,
        presetId: settings.presetId,
        foreground: settings.foreground,
        background: settings.background
      }, {
        members: () => resource.resources.map((row) => row.member),
        resources: () => resource.resources,
        capacity: createRecorderCapacity(connection.files),
        changed: () => this.changed(),
        restored: () => {
          this.clearResolvedErrors(mode);
          this.changed();
        },
        cancelPending: (reason) => connection.cancelPending(reason),
        heartbeat: async () => {
          await connection.tick();
          resource.runtime.updateWorkerSeats(connection.registration.workerSeats);
        },
        observationInterrupted: () => connection.observationInterrupted(),
        observeResources: async (snapshot) => {
          const next = await connection.members(snapshot);
          const visible = (rows) => JSON.stringify(rows.map((row) => ({ member: row.member, workerSeats: row.workerSeats, availability: row.availability, error: row.error })));
          const changed = visible(next) !== visible(resource.resources);
          resource.resources = next;
          if (changed)
            this.changed();
        },
        error: (error) => {
          this.report(mode, error, this.diagnosticScope(mode, settings));
        }
      });
      resource.runtime = runtime;
      signal?.throwIfAborted();
      if (mode === "local") {
        const cleanup = new FrameworkManualCleanup(connection.files, connection.transactions, runtime.conversation, runtime);
        await cleanup.resumePending((error, commandId) => {
          cleanupFailures.push({ error, commandId });
        });
      }
      signal?.throwIfAborted();
      runtime.setForegroundModel(this.config(mode).settings.foreground);
      await runtime.start();
      this.assertOpen();
      signal?.throwIfAborted();
      runtime.setForegroundModel(this.config(mode).settings.foreground);
      this.running.set(mode, resource);
      this.clearResolvedErrors(mode);
      for (const { error, commandId } of cleanupFailures) this.report(mode, error, connection.scope, commandId);
      return resource;
    } catch (error) {
      await runtime?.dispose().catch((failure) => this.cleanupFailure(mode, failure));
      await connection.close().catch((failure) => this.cleanupFailure(mode, failure));
      throw error;
    }
  }
  settingsView(mode) {
    const saved = this.config(mode), active = this.running.get(mode);
    return {
      revision: saved.revision,
      activeMode: mode,
      collaborationId: saved.settings.collaborationId,
      settings: saved.settings,
      connection: { participating: !!active, status: active ? "connected" : "disconnected", detail: this.errors.get(mode), member: active?.connection.registration.member, workerSeats: active?.connection.registration.workerSeats },
      messages: [],
      tasks: [],
      legacyTasks: [],
      archives: this.archiveViews.get(mode) ?? [],
      resources: []
    };
  }
  async view(input = {}, signal) {
    signal?.throwIfAborted();
    const report = (error) => {
      if (signal?.aborted && error === signal.reason) throw error;
      this.report(mode, error);
    };
    const mode = input.mode ?? this.activeMode, saved = this.config(mode), active = this.running.get(mode);
    const base = this.settingsView(mode);
    if (mode === "local" && this.pendingRecordMove?.scope) base.pendingRecordMove = {
      commandId: this.pendingRecordMove.commandId,
      storageScope: this.pendingRecordMove.scope,
      expectedRevision: this.pendingRecordMove.settingsBefore.revision,
      directory: this.pendingRecordMove.targetRecords
    };
    if (mode === "git" && !saved.settings.ownerRepo.trim()) {
      base.connection.status = "unconfigured";
      return base;
    }
    const startup = this.startupState.get(mode);
    if (input.headerOnly) {
      if (startup && !active) base.connection.status = startup.status;
      if (active) base.storageScope = active.connection.scope;
      return base;
    }
    if (startup && !active && (mode === "git" || !this.accesses.has(mode) || this.accessOpening.has(mode))) {
      base.connection.status = startup.status;
      return base;
    }
    let access;
    try {
      access = await this.access(mode);
      base.connection.status = "connected";
    } catch (error) {
      if (this.closed) throw error;
      base.connection.detail = error instanceof Error ? error.message : String(error);
      return base;
    }
    signal?.throwIfAborted();
    if (this.config(mode).revision !== saved.revision) return this.view(input, signal);
    base.storageScope = access.connection.scope;
    if (input.includeArchives) base.archives = [];
    await withSnapshot(access.connection.files, async (snapshot) => {
      signal?.throwIfAborted();
      const page = await access.conversation.page(20, void 0, {}, snapshot, signal);
      signal?.throwIfAborted();
      base.messages = page.messages;
      base.pageBefore = page.moreBefore;
      let observed = active?.resources ?? [];
      try {
        observed = active?.resources ?? await this.observe(access, mode, snapshot, signal);
      } catch (error) {
        report(error);
      }
      signal?.throwIfAborted();
      const localMember = active?.connection.registration.member ?? observed.find((row) => row.instanceUUID === access.connection.identity.instanceUUID)?.member;
      base.hasOtherInstanceRecords = mode === "git" && observed.some((row) => row.instanceUUID !== access.connection.identity.instanceUUID);
      base.resources = observed.filter((row) => !row.primary).map((row) => ({ name: row.member, status: row.availability, instanceUUID: row.instanceUUID, workerSeats: row.workerSeats, detail: row.error }));
      try {
        signal?.throwIfAborted();
        try {
          access.taskIndex ??= new FrameworkTaskIndex(access.connection.files, (error) => this.report(mode, error));
          const tasks = await access.taskIndex.list(snapshot, void 0, signal);
          signal?.throwIfAborted();
          const controls2 = tasks.length ? await this.controls(access, active).taskStates(tasks.map((task) => task.taskId)) : void 0;
          signal?.throwIfAborted();
          await access.connection.files.prefetch?.(snapshot, { signal, isolatePathErrors: true, files: tasks.filter((task) => task.status !== "complete").flatMap((task) => (task.members ?? [task.owner]).map((name2) => paths.memberStatus(task.taskId, name2))) });
          signal?.throwIfAborted();
          for (const task of tasks) {
            signal?.throwIfAborted();
            const cleanup = task.status === "complete" || mode === "local" ? await readJson(access.connection.files, snapshot, cleanupRecordPath(task.taskId)) : void 0;
            signal?.throwIfAborted();
            if (cleanup?.version === 1 && cleanup.taskId === task.taskId && cleanup.phase === "released" && cleanup.historyCleared === true) {
              if (input.includeArchives && cleanup.preservedArtifacts.length) base.archives.push({ path: cleanup.preservedArtifacts[0], title: task.sourcePath, taskId: task.taskId, files: cleanup.preservedArtifacts });
              continue;
            }
            const members = await Promise.all((task.members ?? [task.owner]).map(async (name2) => {
              try {
                return { name: name2, status: (await readMemberStatus(access.connection.files, snapshot, paths.memberStatus(task.taskId, name2)))?.state ?? "unknown" };
              } catch (error) {
                report(error);
                return { name: name2, status: "unknown" };
              }
            }));
            signal?.throwIfAborted();
            base.tasks.push({
              taskId: task.taskId,
              title: task.sourcePath.split("/").at(-1),
              route: task.route,
              owner: task.owner,
              status: task.status,
              members,
              control: controls2?.get(task.taskId)?.intent,
              executions: active?.runtime.executionViews(task.taskId) ?? [],
              resultPaths: task.resultPaths ?? []
            });
          }
        } catch (error) {
          report(error);
        }
        signal?.throwIfAborted();
        try {
          const migrations = await readJson(access.connection.files, snapshot, "technical/legacy-migrations/index.json");
          signal?.throwIfAborted();
          await access.connection.files.prefetch?.(snapshot, { signal, isolatePathErrors: true, files: (migrations?.migrations ?? []).map((migration) => migration.manifestPath) });
          signal?.throwIfAborted();
          for (const migration of migrations?.migrations ?? []) {
            signal?.throwIfAborted();
            try {
              const manifest = await readJson(access.connection.files, snapshot, migration.manifestPath);
              signal?.throwIfAborted();
              if (input.includeArchives) {
                try {
                  const found = await listLegacyRecordExports(access.connection.files, snapshot, migration.manifestPath, (error) => report(error));
                  signal?.throwIfAborted();
                  (access.legacyExports ??= /* @__PURE__ */ new Map()).set(migration.id, found);
                } catch (error) {
                  access.legacyExports?.delete(migration.id);
                  report(error);
                }
                if (mode === "local") try {
                  const references = await listLegacyArtifactReferences(access.connection.files, snapshot, migration.manifestPath);
                  signal?.throwIfAborted();
                  (access.legacyArtifacts ??= /* @__PURE__ */ new Map()).set(migration.id, references);
                } catch (error) {
                  access.legacyArtifacts?.delete(migration.id);
                  report(error);
                }
              }
              const clearedIds = new Set(manifest?.clearedTasks?.map((item) => item.oldId) ?? []);
              const exports = (access.legacyExports?.get(migration.id) ?? []).filter((item) => !clearedIds.has(item.oldTaskId));
              const artifactReferences = (access.legacyArtifacts?.get(migration.id) ?? []).filter((item) => !clearedIds.has(item.oldTaskId));
              const artifactsFor = (oldTaskId) => artifactReferences.filter((item) => item.oldTaskId === oldTaskId).map((item) => ({
                id: item.id,
                sourcePath: item.sourcePath,
                sha256: item.sha256,
                archivedPath: item.status === "archived" ? item.archivedPath : void 0,
                status: item.status,
                detail: item.detail
              }));
              for (const task of manifest?.tasks ?? []) {
                if (clearedIds.has(task.oldId)) continue;
                const own = task.memberContinuations?.find((row) => row.member === localMember);
                const terminal = task.continuation === "complete" || task.continuation === "cancelled";
                base.legacyTasks.push({
                  migrationId: migration.id,
                  oldTaskId: task.oldId,
                  taskId: task.taskId,
                  continuation: terminal ? task.continuation : own?.continuation ?? task.continuation,
                  recordPath: task.recordPath,
                  recordsAvailable: exports.some((row) => row.oldTaskId === task.oldId),
                  artifacts: artifactsFor(task.oldId),
                  issues: manifest?.issues,
                  waits: terminal ? [] : own?.waits?.map((wait) => ({ ...wait, memberIdentity: own.identity }))
                });
              }
              for (const row of exports) if (!manifest?.tasks.some((task) => task.oldId === row.oldTaskId))
                base.legacyTasks.push({ migrationId: migration.id, ...row, recordsAvailable: true, artifacts: artifactsFor(row.oldTaskId) });
              if (input.includeArchives) for (const cleared of manifest?.clearedTasks ?? []) {
                const files = cleared.preservedArtifacts;
                if (Array.isArray(files) && files.length && files.every((path3) => typeof path3 === "string"))
                  base.archives.push({ path: files[0], title: cleared.oldId, taskId: cleared.taskId, files: [...files] });
              }
            } catch (error) {
              report(error);
            }
          }
        } catch (error) {
          report(error);
        }
        signal?.throwIfAborted();
        if (input.includeArchives) {
          const entries = await access.connection.files.list(snapshot, "archives/");
          base.archives.push(...entries.filter((entry) => /^archives\/[^/]+\/records\.md$/.test(entry.path)).map((entry) => {
            const taskId = entry.path.split("/")[1], prefix = `archives/${taskId}/`;
            return {
              path: entry.path,
              title: taskId,
              taskId,
              files: entries.filter((file) => file.path.startsWith(prefix) && file.path !== entry.path && file.path !== `${prefix}retention.json`).map((file) => file.path).sort()
            };
          }));
        }
      } catch (error) {
        report(error);
      }
    }, {
      signal,
      isolatePathErrors: true,
      files: [access.conversation.indexPath, "technical/legacy-migrations/index.json"],
      directories: ["tasks", ...!active ? ["instances"] : []]
    });
    signal?.throwIfAborted();
    if (active && this.running.get(mode) === active && active.connection.scope === access.connection.scope) {
      try {
        const processing = await active.runtime.foregroundProcessing?.();
        if (this.running.get(mode) === active && this.config(mode).revision === saved.revision) base.foregroundProcessing = processing;
      } catch (error) {
        report(error);
      }
    }
    signal?.throwIfAborted();
    base.connection.detail = this.errors.get(mode);
    if (input.includeArchives)
      this.archiveViews.set(mode, base.archives);
    return base;
  }
  async persistSettings(mode, saved) {
    const key = "framework-settings/" + mode;
    await this.storage.set(key, saved);
    const stored = await this.storage.get(key);
    if (!stored || !isDeepStrictEqual4(omitAbsentFields(stored), omitAbsentFields(saved))) {
      throw new Error("Saved settings could not be confirmed by storage readback.");
    }
    this.saved.set(mode, stored);
    return stored;
  }
  mover() {
    if (this.recordMover) return this.recordMover;
    const physical = this.storage;
    if (!physical.moveRecords || !physical.storageView) throw new Error("This Host does not expose its owned records relocation.");
    return this.recordMover = new FrameworkRecordMove(this.storage, physical, {
      quiesce: (receipt, signal) => this.quiesceRecords(receipt, signal),
      applySettings: async (receipt) => {
        const current = await this.storage.get("framework-settings/local");
        if (!isDeepStrictEqual4(current, receipt.settingsAfter)) {
          if (!isDeepStrictEqual4(current, receipt.settingsBefore)) throw new Error("Local settings changed outside the retained record move.");
          await this.persistSettings("local", receipt.settingsAfter);
        } else this.saved.set("local", current);
      },
      reopen: async (_receipt, signal) => {
        this.recordMoving = void 0;
        for (const mode of ["local", "git"]) {
          signal.throwIfAborted();
          this.assertOpen();
          if (await this.storage.get("framework-participation/" + mode) ?? mode === "local") await this.connect(mode, signal);
        }
      }
    });
  }
  async quiesceRecords(_receipt, signal) {
    this.pendingRecordMove = structuredClone(_receipt);
    const owners = /* @__PURE__ */ new Map();
    for (const mode of ["local", "git"]) {
      if (mode === "git" && !this.running.has(mode) && !this.opening.has(mode) && !this.accesses.has(mode)) {
        let unsettled = false;
        const settings = this.config(mode).settings;
        for (const entry of await this.storage.list("framework-connection-settings/")) {
          if (entry.value.mode !== "git") continue;
          const prefix = "framework-runtime/" + entry.key.slice("framework-connection-settings/".length) + "/roles/";
          const roles = await this.storage.list(prefix);
          if (!roles.some((row) => !row.value.released && !row.value.stopped)) continue;
          if (entry.value.ownerRepo?.toLowerCase() !== settings.ownerRepo.toLowerCase() || (entry.value.repositoryDirectory ?? "") !== settings.repositoryDirectory)
            throw new Error("A previous Git storage scope has unresolved native execution ownership; retain its records before moving.");
          unsettled = true;
        }
        if (!unsettled) continue;
      }
      if (!this.recordMoving) owners.set(mode, await this.access(mode));
    }
    this.recordMoving = new Error("The confirmed record move owns these locations; resume that command before accessing records.");
    for (const controller of [...this.accessOpening.values(), ...this.backgroundOpening.values()]) controller.abort(this.recordMoving);
    await Promise.allSettled([...this.opening.values()]);
    const failures = [];
    for (const mode of ["local", "git"]) {
      const active = this.running.get(mode), access = owners.get(mode);
      const settings = this.config(mode).settings;
      let runtime = this.relocationOwners.get(mode) ?? active?.runtime;
      try {
        if (!runtime && access) runtime = new FrameworkRoleRuntime(this.ctx, access.connection.files, this.storage, {
          scope: access.connection.scope,
          member: access.connection.identity.login,
          primary: mode === "local",
          workspace: settings.workspace,
          workerSeats: settings.workerSeats,
          mode,
          collaborationId: settings.collaborationId,
          presetId: settings.presetId,
          foreground: settings.foreground,
          background: settings.background
        }, { members: () => [], resources: () => [], heartbeat: async () => {
        }, error: (error) => this.report(mode, error), changed: () => this.changed(), cancelPending: (reason) => access.connection.cancelPending(reason) });
        if (runtime) {
          this.relocationOwners.set(mode, runtime);
          await runtime.settleForStorageMove();
        }
      } catch (error) {
        failures.push(error);
      }
      if (active) try {
        await active.connection.close();
      } catch (error) {
        failures.push(error);
      }
      if (access) try {
        await this.closeAccess(access);
      } catch (error) {
        failures.push(error);
      }
    }
    this.running.clear();
    this.accesses.clear();
    this.archiveViews.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Record relocation could not confirm all storage owners stopped.");
    this.relocationOwners.clear();
  }
  moveRecords(input) {
    const operation = this.serialRecords(async () => {
      this.assertOpen();
      if (input.mode !== "local") throw new Error("Owned records relocation is a Local user action.");
      const mover = this.mover(), prior = await mover.receipt(input.commandId);
      const controller = this.recordMoveController = new AbortController();
      try {
        if (prior) {
          if (prior.scope !== input.storageScope || prior.settingsBefore.revision !== input.expectedRevision)
            throw new Error("Move retry must retain its original location, scope and settings revision.");
          await mover.run(input.commandId, { ...prior, targetRecords: input.directory }, controller.signal);
        } else {
          const before = this.config("local");
          if (before.revision !== input.expectedRevision) throw new Error("Settings changed; reread before moving records.");
          const access = await this.access("local");
          this.checkScope(access, input.storageScope);
          if (!(access.connection.files instanceof LocalFiles)) throw new Error("Record relocation requires Local files.");
          const physical = this.storage;
          await mover.run(input.commandId, {
            sourceRecords: physical.storageView().directory,
            targetRecords: input.directory,
            sourceLocal: access.connection.files.directory,
            scope: access.connection.scope,
            settingsBefore: structuredClone(before),
            nextSettingsRevision: randomUUID11()
          }, controller.signal);
        }
        this.pendingRecordMove = void 0;
        this.clearResolvedErrors("local", input.commandId);
        this.changed();
        return this.view({ mode: "local", includeArchives: true });
      } catch (error) {
        try {
          this.pendingRecordMove = await mover.pendingReceipt() ?? this.pendingRecordMove;
        } catch {
        }
        this.report("local", error, input.storageScope, input.commandId);
        throw error;
      } finally {
        if (this.recordMoveController === controller) this.recordMoveController = void 0;
      }
    });
    return operation;
  }
  async maintenanceView(input) {
    const access = await this.access(input.mode);
    this.checkScope(access, input.storageScope);
    if (input.mode !== "local" || !(access.connection.files instanceof LocalFiles)) throw new Error("Local records management requires its Local storage.");
    const store = this.storage;
    const directories = store.storageView?.();
    return {
      localDirectory: access.connection.files.directory,
      recordsDirectory: directories?.directory,
      nativeDirectory: directories?.nativeDirectory,
      usage: await frameworkStorageUsage(access.connection.files)
    };
  }
  async openMaintenancePath(input) {
    const access = await this.access(input.mode);
    this.checkScope(access, input.storageScope);
    if (input.mode !== "local" || !(access.connection.files instanceof LocalFiles)) throw new Error("Local records management requires its Local storage.");
    const store = this.storage;
    const path3 = input.target === "records" ? access.connection.files.directory : store.storageView?.().nativeDirectory;
    if (!path3) throw new Error("The Host has not supplied the native session log directory.");
    const controller = this.ctx.get("sessionController");
    if (!controller?.canOpenWorkspacePath()) throw new Error("This Host cannot open local directories. Path: " + path3);
    await controller.openWorkspacePath({ path: path3 });
    return { path: path3 };
  }
  async legacyManifestPath(access, snapshot, migrationId) {
    const index = await readJson(access.connection.files, snapshot, "technical/legacy-migrations/index.json");
    const matches = index?.migrations.filter((item) => item.id === migrationId) ?? [];
    if (matches.length !== 1) throw new Error("Select an existing legacy migration.");
    return matches[0].manifestPath;
  }
  async legacyRecords(input) {
    const access = await this.access(input.mode);
    this.checkScope(access, input.storageScope);
    return withSnapshot(access.connection.files, async (snapshot) => {
      const manifestPath2 = await this.legacyManifestPath(access, snapshot, input.migrationId);
      const record = await readLegacyRecordExport(access.connection.files, snapshot, { manifestPath: manifestPath2, oldTaskId: input.oldTaskId });
      return { text: Buffer.from(record.bytes).toString("utf8"), revision: snapshot.revision };
    });
  }
  exportRecords(input) {
    const operation = this.serialMode(input.mode, async () => {
      const access = await this.access(input.mode);
      this.checkScope(access, input.storageScope);
      if (input.mode !== "local") throw new Error("Record export is a Local user action.");
      const workspace = await new DshWorkspaceAdapter(this.ctx).resolve(void 0, this.config(input.mode).settings.workspace || void 0);
      if (input.taskId && !input.migrationId && !input.oldTaskId)
        return exportFrameworkRecords(access.connection.files, input.taskId, workspace.directory);
      if (input.taskId || !input.migrationId || !input.oldTaskId) throw new Error("Select exactly one current or legacy record.");
      const record = await withSnapshot(access.connection.files, async (snapshot) => {
        const manifestPath2 = await this.legacyManifestPath(access, snapshot, input.migrationId);
        return readLegacyRecordExport(access.connection.files, snapshot, { manifestPath: manifestPath2, oldTaskId: input.oldTaskId });
      });
      return exportFrameworkBytes(record.bytes, record.taskId, workspace.directory);
    });
    return operation;
  }
  /** Explicit maintenance uses the existing background owner when present. A
   * disconnected Local scope gets only a mechanical lifecycle owner: no
   * registration, heartbeat, loop or Agent is started. */
  async withManualCleanup(access, operation, owned) {
    if (access.conversation.scope.mode !== "local") throw new Error("Manual record cleanup is a Local user action.");
    const settings = this.config("local").settings;
    const active = owned ?? this.running.get("local")?.runtime;
    const runtime = active ?? new FrameworkRoleRuntime(this.ctx, access.connection.files, this.storage, {
      scope: access.connection.scope,
      member: access.connection.identity.login,
      primary: true,
      workspace: settings.workspace,
      workerSeats: settings.workerSeats,
      mode: "local",
      collaborationId: settings.collaborationId,
      presetId: settings.presetId,
      foreground: settings.foreground,
      background: settings.background
    }, { members: () => [], resources: () => [], heartbeat: async () => {
    }, error: (error) => this.report("local", error), changed: () => this.changed() });
    if (runtime.config.scope !== access.connection.scope) throw new Error("Cleanup belongs to another Local storage scope.");
    const cleanup = new FrameworkManualCleanup(access.connection.files, access.connection.transactions, access.conversation, runtime);
    let result;
    const failures = [];
    try {
      result = await operation(cleanup, runtime);
    } catch (error) {
      failures.push(error);
    } finally {
      if (!active) try {
        await runtime.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Manual cleanup and lifecycle disposal failed.");
    return result;
  }
  async cleanupPreview(input) {
    await this.modeReady(input.mode);
    const operation = this.serialMode(input.mode, async () => {
      const access = await this.access(input.mode);
      this.checkScope(access, input.storageScope);
      return this.withManualCleanup(access, (cleanup) => cleanup.previewTasks());
    });
    return operation;
  }
  async cleanupRecords(input) {
    await this.modeReady(input.mode);
    const operation = this.serialMode(input.mode, async () => {
      this.assertOpen();
      const access = await this.access(input.mode);
      this.checkScope(access, input.storageScope);
      const result = await this.withManualCleanup(access, async (cleanup, runtime) => {
        if (input.action === "tasks") {
          const result2 = await cleanup.clearTasks(input.commandId, input.preview, input.confirmation);
          for (const task of input.preview.tasks) await runtime.prepareTaskCleanup(task.taskId);
          return result2;
        }
        if (input.action === "conversation") return cleanup.clearConversation(input.commandId, input.confirmation);
        return cleanup.clearPlanning(input.commandId, input.confirmation);
      });
      this.archiveViews.delete(input.mode);
      access.legacyExports = void 0;
      access.legacyArtifacts = void 0;
      this.changed();
      return result;
    });
    return operation;
  }
  knowledge(access, mode) {
    return access.knowledge ??= new FrameworkKnowledge(access.connection.files, access.connection.transactions, () => {
      this.running.get(mode)?.runtime.invalidateSkills();
      this.changed();
    });
  }
  async knowledgeList(input) {
    const access = await this.access(input.mode);
    this.checkScope(access, input.storageScope);
    return this.knowledge(access, input.mode).list();
  }
  async knowledgeRead(input) {
    const access = await this.access(input.mode);
    this.checkScope(access, input.storageScope);
    return this.knowledge(access, input.mode).read(input.path);
  }
  knowledgeEdit(input) {
    const operation = this.serialMode(input.mode, async () => {
      this.assertOpen();
      const access = await this.access(input.mode);
      this.checkScope(access, input.storageScope);
      const { mode, storageScope, commandId, ...edit } = input;
      return this.knowledge(access, mode).edit(commandId, edit);
    });
    return operation;
  }
  knowledgeStatus(input) {
    const operation = this.serialMode(input.mode, async () => {
      this.assertOpen();
      const access = await this.access(input.mode);
      this.checkScope(access, input.storageScope);
      const { mode, storageScope, commandId, ...status } = input;
      return this.knowledge(access, mode).setStatus(commandId, status);
    });
    return operation;
  }
  controls(access, active) {
    if (active) return active.runtime.controls;
    return access.controls ??= new ExecutionControls(this.storage, access.connection.scope);
  }
  taskControl(input) {
    const operation = this.serialMode(input.mode, async () => {
      this.assertOpen();
      const access = await this.access(input.mode), active = this.running.get(input.mode);
      this.checkScope(access, input.storageScope);
      const task = await withSnapshot(access.connection.files, async (snapshot) => {
        if (input.mode === "local") {
          const cleanup = await readJson(access.connection.files, snapshot, cleanupRecordPath(input.taskId));
          if (cleanup?.version === 1 && cleanup.taskId === input.taskId && cleanup.phase === "released" && cleanup.historyCleared === true) throw new Error("This Task history was explicitly cleared. Create a new Task.");
        }
        return readJson(access.connection.files, snapshot, paths.task(input.taskId));
      });
      if (!task || task.status === "complete") throw new Error("A completed or absent Task cannot be reopened or controlled.");
      const member = active?.connection.registration.member ?? (await this.observe(access, input.mode)).find((row) => row.instanceUUID === access.connection.identity.instanceUUID)?.member;
      if (!member || !(task.members ?? [task.owner]).includes(member)) throw new Error("This Host has no registered execution domain in the selected Task.");
      const controls2 = this.controls(access, active);
      await controls2.setTask(input.commandId, input.taskId, z7.enum(["running", "paused", "cancelled"]).parse(input.intent));
      if (active) {
        await active.runtime.applyUserControls(true, { taskId: input.taskId });
        const current = await controls2.task(input.taskId);
        if (current?.commandId === input.commandId && current.intent === "running") await active.runtime.resumeTask(input.taskId, input.commandId);
      }
      this.changed();
      return this.view({ mode: input.mode });
    });
    return operation;
  }
  async stopExecution(input) {
    const access = await this.access(input.mode);
    this.checkScope(access, input.storageScope);
    const active = this.running.get(input.mode);
    if (!active) throw new Error("This Host does not own a running backend for the selected execution.");
    await active.runtime.requestExecutionStop(input.commandId, input.workId, input.executionId);
    return this.view({ mode: input.mode });
  }
  observe(access, mode, snapshot, signal) {
    const c = access.connection;
    access.observer ??= new InstanceRegistration(c.files, c.transactions, this.storage, { repositoryId: c.identity.repositoryId, repositoryOwner: c.identity.owner, login: c.identity.login, instanceUUID: c.identity.instanceUUID, workerSeats: 0 });
    return access.observer.observe(snapshot, signal).then((rows) => mode === "local" ? rows.map((row) => ({ ...row, primary: row.instanceUUID === c.identity.instanceUUID })) : rows);
  }
  checkScope(access, expected) {
    if (expected !== void 0 && expected !== access.connection.scope) throw new Error("Storage destination changed; retained input belongs to its original scope.");
  }
  async history(input, signal) {
    signal?.throwIfAborted();
    const active = await this.access(input.mode);
    signal?.throwIfAborted();
    this.checkScope(active, input.storageScope);
    if (input.collaborationId !== this.config(input.mode).settings.collaborationId) throw new Error("Conversation selection changed.");
    const page = await active.conversation.page(input.limit, input.beforeId, { afterId: input.afterId, date: input.date }, void 0, signal);
    signal?.throwIfAborted();
    return page;
  }
  send(input) {
    const operation = this.serialMode(input.mode, async () => {
      await this.modeReady(input.mode);
      this.assertOpen();
      return this.sendStored(input);
    });
    return operation;
  }
  async sendStored(input) {
    const mode = z7.enum(["local", "git"]).parse(input.mode), active = await this.access(mode);
    if (input.collaborationId !== this.config(mode).settings.collaborationId)
      throw new Error("Conversation selection changed; retained input belongs to its original conversation.");
    const body = z7.object({ id: z7.string().min(1), createdAt: z7.string().datetime({ offset: true }), timezoneOffsetMinutes: z7.number().int().optional(), text: z7.string(), recipient: z7.enum(["ai", "human"]), replyTo: z7.string().optional(), device: z7.string() }).parse(input);
    this.checkScope(active, input.storageScope);
    const participantId = active.connection.repository ? String(active.connection.repository.identity.id) : active.connection.identity.login;
    const destination2 = { scope: active.connection.scope, collaborationId: input.collaborationId, participantId, body };
    const key = "framework-message-destinations/" + createHash30("sha256").update(JSON.stringify([mode, body.id])).digest("hex");
    const signature = createHash30("sha256").update(JSON.stringify(destination2)).digest("hex"), previous = await this.storage.get(key);
    if (previous !== void 0 && previous !== signature) throw new Error("Original message storage destination or content changed.");
    if (previous === void 0) await this.storage.set(key, signature);
    await active.connection.prepareWrite();
    const receipt = await active.conversation.send("client-message:" + body.id, {
      ...body,
      role: "user",
      participantId,
      username: active.connection.repository?.identity.login || (this.config(mode).settings.userName || active.connection.identity.login)
    }, { reevaluate: true });
    this.changed();
    return receipt;
  }
  async sentMessage(input, signal) {
    signal?.throwIfAborted();
    const mode = z7.enum(["local", "git"]).parse(input.mode), access = await this.access(mode);
    this.checkScope(access, input.storageScope);
    if (input.collaborationId !== access.conversation.scope.collaborationId) throw new Error("Conversation selection changed.");
    const hint = z7.object({ id: z7.string().min(1), createdAt: z7.string().datetime({ offset: true }), text: z7.string() }).parse(input);
    const participantId = access.connection.repository ? String(access.connection.repository.identity.id) : access.connection.identity.login;
    signal?.throwIfAborted();
    return access.conversation.readback(hint.id, { ...hint, participantId, role: "user" }, signal);
  }
  foregroundModel(input) {
    let mode, route;
    try {
      this.assertOpen();
      if (this.recordMoving) throw this.recordMoving;
      mode = z7.enum(["local", "git"]).parse(input.mode);
      route = model.optional().parse(input.model);
      z7.string().min(1).parse(input.commandId);
      z7.string().min(1).parse(input.expectedRevision);
    } catch (error) {
      return Promise.reject(error);
    }
    const owner = { mode, commandId: input.commandId, controller: new AbortController() };
    this.configurationOwners.add(owner);
    const signal = owner.controller.signal;
    const operation = this.serialMode(mode, async () => {
      this.assertOpen();
      signal.throwIfAborted();
      if (this.recordMoving) throw this.recordMoving;
      if (input.storageScope !== void 0) {
        let scope = this.running.get(mode)?.connection.scope;
        const access = this.accesses.get(mode);
        if (!scope && access && !this.accessOpening.has(mode)) scope = (await access).connection.scope;
        if (scope !== input.storageScope) throw new Error("Storage scope changed or is not ready; refresh before changing the foreground model.");
      }
      signal.throwIfAborted();
      const signature = JSON.stringify(["foreground-model", mode, input.storageScope, input.expectedRevision, route]);
      const key = "framework-settings-commands/" + createHash30("sha256").update(input.commandId).digest("hex");
      const prior = await this.storage.get(key);
      if (prior && prior.signature !== signature) throw new Error("Configuration command identity changed.");
      if (prior?.confirmed) return this.settingsView(mode);
      const cached = this.config(mode);
      const stored = await this.storage.get("framework-settings/" + mode) ?? cached;
      const matches = (left, right) => isDeepStrictEqual4(omitAbsentFields(left), omitAbsentFields(right));
      if (!prior && (input.expectedRevision !== stored.revision || !matches(cached, stored)))
        throw new Error("Settings changed; reload before applying this edit.");
      const next = prior?.next ?? { revision: randomUUID11(), settings: { ...stored.settings, foreground: route } };
      if (prior && !matches(stored, next) && (stored.revision !== prior.previousRevision || !matches(cached, stored)))
        throw new Error("Settings changed while the foreground model update was unconfirmed; reload before applying another edit.");
      signal.throwIfAborted();
      const command = prior ?? { signature, revision: next.revision, previousRevision: stored.revision, next };
      if (!prior) await this.storage.set(key, command);
      signal.throwIfAborted();
      if (matches(stored, next)) this.saved.set(mode, stored);
      else await this.persistSettings(mode, next);
      this.assertOpen();
      signal.throwIfAborted();
      this.running.get(mode)?.runtime.setForegroundModel(this.config(mode).settings.foreground);
      await this.storage.set(key, { ...command, confirmed: true });
      this.clearResolvedErrors(mode, input.commandId);
      this.changed();
      return this.settingsView(mode);
    }, input.commandId).catch((error) => {
      if (!abortedBy(signal, error)) this.report(mode, error, input.storageScope, input.commandId);
      throw error;
    });
    void operation.finally(() => this.configurationOwners.delete(owner)).catch(() => {
    });
    return operation;
  }
  configure(input) {
    let mode, settings;
    try {
      this.assertOpen();
      if (this.recordMoving) throw this.recordMoving;
      mode = z7.enum(["local", "git"]).parse(input.mode);
      settings = settingsSchema.parse(input.settings);
    } catch (error) {
      return Promise.reject(error);
    }
    const owner = { mode, commandId: input.commandId, controller: new AbortController() };
    const predecessors = [...this.configurationOwners].filter((value) => value.mode === mode && value.commandId !== input.commandId);
    this.configurationOwners.add(owner);
    const signal = owner.controller.signal;
    const key = "framework-settings-commands/" + createHash30("sha256").update(input.commandId).digest("hex");
    const priorCommand = this.settingsCommands.get(input.commandId);
    const admitted = (async () => {
      if (priorCommand) await priorCommand;
      signal.throwIfAborted();
      const receipt = await this.storage.get(key);
      signal.throwIfAborted();
      if (receipt && receipt.signature !== JSON.stringify([mode, settings])) throw new Error("Configuration command identity changed.");
      if (!receipt && input.expectedRevision && input.expectedRevision !== this.config(mode).revision) throw new Error("Settings changed; reload before applying this edit.");
      if (!receipt?.confirmed) for (const prior of predecessors) prior.controller.abort();
    })();
    void admitted.catch(() => {
    });
    const operation = this.serialMode(mode, async () => {
      await admitted;
      let finishAccessTransition;
      try {
        this.assertOpen();
        signal.throwIfAborted();
        if (this.recordMoving) throw this.recordMoving;
        const signature = JSON.stringify([mode, settings]), old = await this.storage.get(key);
        if (old && old.signature !== signature)
          throw new Error("Configuration command identity changed.");
        if (old?.confirmed) return this.view({ mode });
        const previous = this.config(mode);
        if (!old && input.expectedRevision && input.expectedRevision !== previous.revision)
          throw new Error("Settings changed; reload before applying this edit.");
        signal.throwIfAborted();
        const pendingStartup = this.opening.get(mode);
        if (pendingStartup && !this.running.has(mode)) {
          this.backgroundOpening.get(mode)?.abort();
          await pendingStartup.catch(() => void 0);
          signal.throwIfAborted();
        }
        const running = this.running.get(mode);
        const executionSettings = (value) => JSON.stringify([
          mode === "local" ? [value.localDirectory] : [value.ownerRepo, value.repositoryDirectory],
          value.collaborationId,
          value.workspace,
          value.presetId,
          value.foreground,
          value.background
        ]);
        const hot = !!running && executionSettings(previous.settings) === executionSettings(settings);
        if (running && !hot) {
          await this.stopRunning(running);
          this.running.delete(mode);
        }
        if (!hot) {
          let releaseTransition;
          const transition = new Promise((resolve2) => {
            releaseTransition = resolve2;
          });
          this.accessTransitions.set(mode, transition);
          finishAccessTransition = () => {
            if (this.accessTransitions.get(mode) === transition) this.accessTransitions.delete(mode);
            releaseTransition();
          };
          const access = this.accesses.get(mode);
          this.accesses.delete(mode);
          this.archiveViews.delete(mode);
          this.accessOpening.get(mode)?.abort();
          if (access) {
            const previousAccess = await access.catch(() => void 0);
            if (previousAccess) {
              await this.closeAccess(previousAccess);
            }
          }
        }
        signal.throwIfAborted();
        const next = { revision: old?.revision ?? randomUUID11(), settings };
        await this.storage.set(key, { signature, revision: next.revision });
        await this.persistSettings(mode, next);
        finishAccessTransition?.();
        finishAccessTransition = void 0;
        signal.throwIfAborted();
        await this.storage.set("framework-participation/" + mode, true);
        signal.throwIfAborted();
        const cancelUpdate = () => running?.connection.cancelPending(signal.reason);
        if (hot) signal.addEventListener("abort", cancelUpdate, { once: true });
        try {
          if (hot && running) {
            const registration = await running.connection.updateWorkerSeats(settings.workerSeats);
            signal.throwIfAborted();
            running.runtime.updateWorkerSeats(registration.workerSeats);
            running.resources = await running.connection.members();
          } else await this.connect(mode, signal);
          this.assertOpen();
          signal.throwIfAborted();
          if (mode === "git")
            await this.storage.set("framework-git-enabled", true);
          await this.storage.set(key, { signature, revision: next.revision, confirmed: true });
          this.clearResolvedErrors(mode, input.commandId);
          const priorError = this.configurationErrors.get(mode);
          const messages = this.reportedErrors.get(mode);
          if (priorError && !messages?.get(priorError)?.operationId) {
            messages?.delete(priorError);
            this.configurationErrors.delete(mode);
            this.refreshErrors(mode);
          }
        } catch (error) {
          if (!abortedBy(signal, error)) {
            this.configurationErrors.set(mode, this.report(mode, error, this.diagnosticScope(mode, settings), input.commandId));
          }
          throw error;
        } finally {
          signal.removeEventListener("abort", cancelUpdate);
        }
        this.changed();
        return this.view({ mode });
      } finally {
        finishAccessTransition?.();
      }
    }, input.commandId);
    void operation.finally(() => this.configurationOwners.delete(owner)).catch(() => {
    });
    return operation;
  }
  async gitMembers(input) {
    const access = await this.access(z7.literal("git").parse(input.mode));
    this.checkScope(access, input.storageScope);
    if (!access.connection.gitMembers) throw new Error("GitHub member operations are unavailable.");
    return access.connection.gitMembers();
  }
  async gitMemberAction(input) {
    const access = await this.access(z7.literal("git").parse(input.mode));
    this.checkScope(access, input.storageScope);
    if (!access.connection.gitMemberAction) throw new Error("GitHub member operations are unavailable.");
    const action = z7.discriminatedUnion("action", [z7.object({ action: z7.literal("cancelInvitation"), invitationId: z7.number().int().positive() }), z7.object({ action: z7.literal("remove"), username: z7.string().min(1) })]).parse(input);
    await access.connection.gitMemberAction(action);
  }
  async invite(input) {
    if (input.mode !== "git") throw new Error("GitHub invitations belong to Git mode.");
    const access = await this.access(input.mode);
    this.checkScope(access, input.storageScope);
    if (!access.connection.invite) throw new Error("GitHub member operations are unavailable.");
    return access.connection.invite(input.username);
  }
  legacyControl(input) {
    const operation = this.serialMode(input.mode, async () => {
      this.assertOpen();
      const access = await this.access(input.mode);
      this.checkScope(access, input.storageScope);
      const index = await withSnapshot(access.connection.files, (snapshot) => readJson(access.connection.files, snapshot, "technical/legacy-migrations/index.json"));
      const migration = index?.migrations.find((row) => row.id === input.migrationId);
      if (!migration) throw new Error("Original migration record does not exist in this storage scope.");
      const member = this.running.get(input.mode)?.connection.registration.member ?? (await this.observe(access, input.mode)).find((row) => row.instanceUUID === access.connection.identity.instanceUUID)?.member;
      if (!member) throw new Error("Original instance identity cannot be located for this legacy task.");
      const target = { manifestPath: migration.manifestPath, oldTaskId: input.oldTaskId, member };
      await access.connection.prepareWrite();
      if (input.action === "resume") await resumeLegacyTask(access.connection.files, access.connection.transactions, input.commandId, target);
      else if (input.action === "answer") await answerLegacyTask(access.connection.files, access.connection.transactions, input.commandId, { ...target, waitId: z7.string().min(1).parse(input.waitId), answer: z7.string().parse(input.answer) });
      else throw new Error("Unknown legacy control action.");
      this.changed();
      return this.view({ mode: input.mode });
    });
    return operation;
  }
  participation(input) {
    let mode, enabled;
    try {
      mode = z7.enum(["local", "git"]).parse(input.mode);
      enabled = z7.boolean().parse(input.enabled);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!enabled) {
      for (const owner2 of this.configurationOwners) if (owner2.mode === mode) owner2.controller.abort();
      this.backgroundOpening.get(mode)?.abort();
    }
    const owner = enabled ? { mode, controller: new AbortController() } : void 0;
    if (owner) this.configurationOwners.add(owner);
    const operation = this.serialMode(mode, async () => {
      this.assertOpen();
      owner?.controller.signal.throwIfAborted();
      await this.storage.set("framework-participation/" + mode, enabled);
      owner?.controller.signal.throwIfAborted();
      if (enabled) await this.connect(mode, owner.controller.signal);
      else {
        const running = this.running.get(mode);
        if (running) {
          try {
            await this.stopRunning(running);
          } finally {
            this.running.delete(mode);
          }
        }
      }
      this.changed();
      return enabled ? this.view({ mode }) : this.settingsView(mode);
    });
    void operation.finally(() => {
      if (owner) this.configurationOwners.delete(owner);
    }).catch(() => {
    });
    return operation;
  }
  async selectMode(input) {
    this.assertOpen();
    const mode = z7.enum(["local", "git"]).parse(input.mode);
    this.activeMode = mode;
    await this.storage.set("framework-active-mode", mode);
    this.changed();
    return this.view({ mode, headerOnly: input.headerOnly });
  }
  async readFileBytes(files, snapshot, path3) {
    const bytes = await files.readBytes(snapshot, path3);
    if (bytes !== void 0) return bytes;
    const taskId = /^(?:task-runs|Recorder Cache|technical\/recovery-inputs)\/([^/]+)\//.exec(path3)?.[1] ?? /^state\/[^/]+\/([^/]+)\//.exec(path3)?.[1];
    return taskId ? readArchivedReference(files, snapshot, taskId, path3) : void 0;
  }
  async readFile(input) {
    const active = await this.access(input.mode);
    this.checkScope(active, input.storageScope);
    const downloadUrl = "/api/deepseek-servant-framework/download?mode=" + input.mode + "&path=" + encodeURIComponent(input.path) + "&storageScope=" + encodeURIComponent(active.connection.scope);
    return withSnapshot(active.connection.files, async (snapshot) => {
      const bytes = await this.readFileBytes(active.connection.files, snapshot, input.path);
      if (bytes === void 0)
        throw new Error("File does not exist.");
      try {
        return { path: input.path, downloadUrl, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), revision: snapshot.revision };
      } catch {
        return { path: input.path, revision: snapshot.revision, binary: { bytes: bytes.byteLength, sha256: createHash30("sha256").update(bytes).digest("hex"), downloadUrl: "/api/deepseek-servant-framework/download?mode=" + input.mode + "&path=" + encodeURIComponent(input.path) + "&storageScope=" + encodeURIComponent(active.connection.scope) } };
      }
    });
  }
  async download(mode, path3, storageScope) {
    const active = await this.access(mode);
    this.checkScope(active, storageScope);
    return withSnapshot(active.connection.files, async (snapshot) => {
      const bytes = await this.readFileBytes(active.connection.files, snapshot, path3);
      if (bytes === void 0)
        throw new Error("File does not exist.");
      return bytes;
    });
  }
  stopRunning(active) {
    const prior = this.stopping.get(active);
    if (prior) return prior;
    const operation = (async () => {
      const failures = [];
      try {
        await active.runtime.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        await active.connection.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Runtime and connection disposal failed.");
    })();
    this.stopping.set(active, operation);
    return operation;
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.recordMoveController?.abort();
    for (const owner of this.configurationOwners) owner.controller.abort();
    for (const controller of [...this.accessOpening.values(), ...this.backgroundOpening.values()]) controller.abort();
    const accesses = [...this.accesses.values()];
    this.disposal = (async () => {
      const stopping = [...this.running].map(([mode, active]) => this.stopRunning(active).catch((error) => this.cleanupFailure(mode, error)));
      const cancellingAccess = accesses.map((pending) => pending.then((access) => {
        try {
          access.artifactRepair?.controller.abort();
          access.connection.cancelPending();
        } catch (error) {
          this.disposalErrors.push(error);
        }
      }, () => {
      }));
      await Promise.allSettled([this.initializing, this.starting, this.configuration, ...this.modeConfiguration.values()]);
      await Promise.allSettled([...this.opening.values()]);
      await Promise.all(stopping);
      await Promise.all(cancellingAccess);
      for (const [mode, active] of this.running) {
        if (!this.stopping.has(active)) try {
          await this.stopRunning(active);
        } catch (error) {
          this.cleanupFailure(mode, error);
        }
      }
      this.running.clear();
      for (const runtime of this.relocationOwners.values()) try {
        await runtime.dispose();
      } catch (error) {
        this.disposalErrors.push(error);
      }
      this.relocationOwners.clear();
      for (const pending of accesses) {
        const access = await pending.catch(() => void 0);
        if (access) try {
          await this.closeAccess(access);
        } catch (error) {
          this.disposalErrors.push(error);
        }
      }
      this.accesses.clear();
      this.listeners.clear();
      if (this.disposalErrors.length) throw new AggregateError(this.disposalErrors, "Framework service resource disposal failed.");
    })();
    return this.disposal;
  }
};

// src/framework/transport.ts
import { clientRequestSchema } from "@deepseek-ai/dsh-client-connection";
import { z as z8 } from "zod";

// src/mode-router/events.ts
var ModeEvents = class {
  listeners = /* @__PURE__ */ new Set();
  streams = /* @__PURE__ */ new Set();
  disposed = false;
  changed = () => {
    for (const listener of this.listeners) listener();
  };
  response(request) {
    if (this.disposed) return new Response("DSS modes are stopping.", { status: 503 });
    let cleanup = () => {
    };
    const stream = new ReadableStream({
      start: (controller) => {
        let closed = false;
        const close = () => {
          if (!closed) {
            closed = true;
            cleanup();
            controller.close();
          }
        };
        const changed = () => {
          if (!closed) controller.enqueue(new TextEncoder().encode("event: changed\ndata: {}\n\n"));
        };
        cleanup = () => {
          this.listeners.delete(changed);
          this.streams.delete(close);
          request.signal.removeEventListener("abort", close);
        };
        this.listeners.add(changed);
        this.streams.add(close);
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) close();
        else changed();
      },
      cancel() {
        cleanup();
      }
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }
  dispose() {
    this.disposed = true;
    for (const close of [...this.streams]) close();
  }
};

// src/framework/transport.ts
var methods = ["maintenanceView", "openMaintenancePath", "exportRecords", "cleanupPreview", "cleanupRecords", "knowledgeList", "knowledgeRead", "knowledgeEdit", "knowledgeStatus", "view", "history", "send", "sentMessage", "foregroundModel", "configure", "moveRecords", "legacyRecords", "legacyControl", "invite", "gitMembers", "gitMemberAction", "taskControl", "stopExecution", "participation", "selectMode", "readFile"];
function installFrameworkTransport(ctx, service) {
  const events = new ModeEvents(), off = service.subscribeChanged(events.changed);
  const fiber = ctx.inject(["connection"], (scope) => {
    scope.effect(() => scope.connection.fetch.register({ path: "/api/deepseek-servant-framework/events", methods: ["GET"], requestBody: "buffered", fetch: async (request) => events.response(request) }), "dss.framework.events");
    for (const method of methods)
      scope.effect(() => scope.connection.fetch.register({ path: "/api/deepseek-servant-framework/" + method, methods: ["POST"], requestBody: "buffered", fetch: async (request) => {
        const envelope = clientRequestSchema.safeParse(await request.json().catch(() => void 0));
        if (!envelope.success)
          return new Response("Invalid native request envelope.", { status: 400 });
        const message = envelope.data, respond = (result) => Response.json({ type: "server-response", rpcId: message.rpcId, result });
        if (message.method !== "deepseek-servant-framework/" + method)
          return respond({ ok: false, error: { code: "dss/invalid-method", message: "Invalid method.", details: {} } });
        try {
          const value = method === "view" ? await service.view(message.payload, request.signal) : method === "history" ? await service.history(message.payload, request.signal) : method === "sentMessage" ? await service.sentMessage(message.payload, request.signal) : await service[method].call(service, message.payload);
          return respond({ ok: true, value });
        } catch (error) {
          const details = error instanceof FilesOutcomeUnknownError ? { operationId: error.operationId, ...error.confirmed ? { confirmed: error.confirmed } : {} } : error instanceof FilesConflictError ? { expectedRevision: error.expectedRevision } : {};
          return respond({ ok: false, error: { code: error instanceof FilesOutcomeUnknownError ? "dss/outcome-unknown" : error instanceof FilesConflictError ? "dss/conflict" : "dss/request-failed", message: error instanceof Error ? error.message : String(error), details } });
        }
      } }), "dss.framework." + method);
    scope.effect(() => scope.connection.fetch.register({ path: "/api/deepseek-servant-framework/download", methods: ["GET"], requestBody: "buffered", fetch: async (request) => {
      try {
        const url = new URL(request.url), mode = z8.enum(["local", "git"]).parse(url.searchParams.get("mode")), path3 = z8.string().min(1).parse(url.searchParams.get("path"));
        const data = await service.download(mode, path3, url.searchParams.get("storageScope") ?? void 0), name2 = path3.split("/").at(-1);
        return new Response(new Uint8Array(data), { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(name2), "cache-control": "no-store" } });
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
      }
    } }), "dss.framework.download");
  });
  return async () => {
    off();
    events.dispose();
    await fiber.dispose();
  };
}

// src/host.ts
var name = "deepseek-servant";
var inject = ["storage", "storageDomain", "agents", "sessions", "sessionPersistence", "workspaceRegistry", "workingDirectory", "agentPresets", "jobs", "agentDefaultModel", "fs"];
var Config = z9.object({
  workerSeats: z9.number().int().nonnegative().default(2),
  presetId: z9.string().default("standard"),
  foreground: ModelRouteSchema.default({}),
  background: ModelRouteSchema.default({})
});
async function apply(ctx, config) {
  const storage = await DshStorageAdapter.open(ctx);
  const model2 = (route) => route.provider && route.model ? { provider: route.provider, model: route.model, ...route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {} } : void 0;
  const service = new FrameworkService(ctx, storage, {
    name: "DeepSeek Servant",
    userName: "",
    localDirectory: join5(storage.storageView().directory, "deepseek_servant", "framework"),
    ownerRepo: "",
    repositoryDirectory: "/",
    collaborationId: "default",
    workerSeats: config.workerSeats,
    workspace: "",
    presetId: config.presetId,
    foreground: model2(config.foreground),
    background: model2(config.background)
  });
  ctx.provide("deepseekServant", { service });
  const closeTransport = installFrameworkTransport(ctx, service);
  ctx.effect(() => () => disposeResources([closeTransport, () => service.dispose(), () => storage.close()]), "dss.framework");
  await service.initialize();
}
export {
  Config,
  apply,
  inject,
  name
};
