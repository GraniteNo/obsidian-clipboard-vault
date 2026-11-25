import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);
class TFolder {
  constructor(path) { this.path = path; }
  get children() {
    const prefix = `${this.path}/`;
    return [...records.values()].filter(value => value.path.startsWith(prefix) && !value.path.slice(prefix.length).includes("/"));
  }
}
class TFile {
  constructor(path, content = "") {
    this.path = path;
    this.content = content;
    this.name = path.split("/").at(-1);
    this.extension = this.name.split(".").at(-1);
    this.basename = this.name.slice(0, -this.extension.length - 1);
  }
}
class Plugin { constructor(app) { this.app = app; } }
class ItemView {}
class PluginSettingTab {}
class Setting {}
class Notice {}
class Modal {}

const records = new Map();
const trashed = [];
const vault = {
  getAbstractFileByPath(path) { return records.get(path) ?? null; },
  async createFolder(path) { if (records.has(path)) throw Error("exists"); records.set(path, new TFolder(path)); },
  async create(path, content) { if (records.has(path)) throw Error("exists"); const file = new TFile(path, content); records.set(path, file); return file; },
  async createBinary(path, content) { if (records.has(path)) throw Error("exists"); const file = new TFile(path, content); records.set(path, file); return file; },
  async read(file) { return file.content; },
  async cachedRead(file) { return file.content; },
  async process(file, callback) { file.content = callback(file.content); return file.content; },
  getFiles() { return [...records.values()].filter(value => value instanceof TFile); },
  getMarkdownFiles() { return this.getFiles().filter(value => value.path.endsWith(".md")); },
  async trash(file, system) { assert.equal(system, true); records.delete(file.path); trashed.push(file.path); },
  adapter: { async stat(path) { return records.has(path) ? { size: 1234 } : null; } }
};
const app = { vault, metadataCache: { resolvedLinks: {} }, workspace: { getLeavesOfType: () => [] } };
const module = { exports: {} };
const js = readFileSync(new URL("../main.js", import.meta.url), "utf8");
new Function("require", "module", "exports", js)((id) => id === "obsidian"
  ? { Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, TFolder, Modal }
  : nodeRequire(id), module, module.exports);
const PluginClass = module.exports.default;
const plugin = new PluginClass(app);
plugin.settings.imageFileMode = "path";
const hash1 = "1".repeat(64);
const hash2 = "2".repeat(64);

assert.equal(await plugin.store({ kind: "text", text: "First clip" }, hash1), "已保存");
assert.equal(await plugin.store({ kind: "text", text: "First clip" }, hash1), "今日已保存相同内容");
assert.equal(await plugin.store({ kind: "text", text: "Second clip" }, hash2), "已保存");
const notes = vault.getMarkdownFiles();
assert.equal(notes.length, 1);
assert.equal((notes[0].content.match(/<!-- clipboard-vault:/g) ?? []).length, 2);
assert.match(notes[0].content, /## 1\. .*· 文本/);
assert.match(notes[0].content, /## 2\. .*· 文本/);
assert.equal((await plugin.todayEntries()).length, 2);
assert.equal((await plugin.search("Second clip")).length, 1);
const imageHash = "3".repeat(64);
assert.equal(await plugin.store({ kind: "image", bytes: Uint8Array.from([137, 80, 78, 71]) }, imageHash), "已保存");
assert.equal((await plugin.todayEntries()).length, 3);
assert.equal([...records.keys()].filter(path => path.endsWith(".png")).length, 1);
assert.match(notes[0].content, /## 3\. .*· 图片/);
assert.equal(await plugin.store({ kind: "files", paths: ["C:\\文档\\报告.docx", "D:\\图像\\图.png"] }, "4".repeat(64)), "已保存");
assert.match(notes[0].content, /## 4\. .*· 文件路径/);
assert.match(notes[0].content, /C:\\文档\\报告.docx/);
plugin.settings.archiveLevel = "month";
assert.equal(await plugin.store({ kind: "text", text: "Monthly layout" }, "5".repeat(64)), "已保存");
assert.equal(vault.getMarkdownFiles().length, 2);
assert.match(vault.getMarkdownFiles()[1].path, /\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md$/);
assert.match(vault.getMarkdownFiles()[1].content, /## 1\. .*· 文本/);
const temporary = await mkdtemp(join(tmpdir(), "clipboard-vault-test-"));
const sample = join(temporary, "sample.png");
const sample2 = join(temporary, "second.jpg");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
const png2 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
try {
  await writeFile(sample, png);
  await writeFile(sample2, png2);
  plugin.settings.imageFileMode = "attachment";
  const attachmentHash = await plugin.fingerprint({ kind: "files", paths: [sample] });
  plugin.settings.imageFileMode = "path";
  const pathHash = await plugin.fingerprint({ kind: "files", paths: [sample] });
  assert.notEqual(attachmentHash, pathHash);
  plugin.settings.imageFileMode = "attachment";
  const copied = { kind: "files", paths: [sample, sample2, "C:\\资料\\说明.docx"] };
  assert.equal(await plugin.store(copied, "6".repeat(64)), "已保存");
  const monthly = vault.getMarkdownFiles()[1];
  assert.match(monthly.content, /## 2\. .*· 图片附件与文件路径/);
  assert.equal((monthly.content.match(/!\[\]\(attachments\//g) ?? []).length, 2);
  assert.match(monthly.content, /C:\\资料\\说明.docx/);
  assert.ok(!monthly.content.includes(sample));
  const importedFiles = [...records.values()].filter(value => value.path.includes("/attachments/") && value.path.endsWith(".png"));
  assert.ok(importedFiles.some(value => Buffer.from(value.content).equals(png)));
  assert.equal(await plugin.store(copied, "6".repeat(64)), "今日已保存相同内容");
  const before = [...records.keys()].filter(path => path.includes("/attachments/")).length;
  plugin.settings.imageFileMode = "path";
  assert.equal(await plugin.store({ kind: "files", paths: [sample] }, "7".repeat(64)), "已保存");
  assert.match(monthly.content, /## 3\. .*· 文件路径/);
  assert.ok(monthly.content.includes(sample));
  assert.equal([...records.keys()].filter(path => path.includes("/attachments/")).length, before);
} finally {
  await unlink(sample);
  await unlink(sample2);
  await rmdir(temporary);
}
const leaves = [];
let createdPanels = 0;
app.workspace = {
  activeLeaf: null,
  getLeavesOfType: type => leaves.filter(leaf => leaf.type === type),
  getRightLeaf() {
    createdPanels++;
    const leaf = {
      type: "empty",
      async setViewState(state) {
        await new Promise(resolve => setTimeout(resolve, 5));
        this.type = state.type;
      },
      detach() { leaves.splice(leaves.indexOf(this), 1); }
    };
    leaves.push(leaf);
    return leaf;
  },
  async revealLeaf() {}
};
await Promise.all([plugin.openPanel(), plugin.openPanel(), plugin.openPanel()]);
assert.equal(createdPanels, 1);
await plugin.openPanel();
assert.equal(createdPanels, 1);
const duplicate = { type: "clipboard-vault-view", detach() { leaves.splice(leaves.indexOf(this), 1); } };
leaves.push(duplicate);
await plugin.openPanel();
assert.equal(app.workspace.getLeavesOfType("clipboard-vault-view").length, 1);

const now = new Date();
const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(value => String(value).padStart(2, "0")).join("-");
const old1 = "剪切板/2000/2000-01-01.md";
const old2 = "剪切板/2000-01-02.md";
const plainClip = (value, number, digit) =>
  "<!-- clipboard-vault:text:" + digit.repeat(64) + " -->\n## " + number + ". 01:00:00 · 文本\n\n```\n" + value + "\n```\n";
await vault.create(old1, plainClip("Old match 1", 1, "1"));
await vault.create(old2, plainClip("Old match 2", 1, "2") + "\n" + plainClip("Old match 3", 2, "3"));
const oldFilter = { from: "2000-01-01", through: "2000-01-02", kind: "text" };
assert.deepEqual((await plugin.search("match", oldFilter, 2)).map(hit => hit.text), ["Old match 3", "Old match 2"]);
assert.deepEqual((await plugin.search("match", oldFilter, 2, 1)).map(hit => hit.text), ["Old match 2", "Old match 1"]);
assert.equal((await plugin.search("", { from: today, through: today, kind: "image" })).length, 2);
assert.equal(await plugin.todayCount(), 7);
const images = await plugin.search("", { kind: "image", from: today, through: today }, 10);
assert.ok(images.every(hit => hit.images.every(image => plugin.entryImage(hit, image) instanceof TFile)));
assert.equal(plugin.entryImage(images[0], "attachments/does-not-exist.png"), null);
const target = (await plugin.search("Old match 3"))[0];
const ref = records.get(old2);
ref.content = "# Prepended heading\n\n" + ref.content;
const opened = [];
app.workspace.getLeaf = newLeaf => {
  assert.equal(newLeaf, true);
  return { openFile: async (file, options) => opened.push([file.path, options.eState.line]) };
};
await plugin.openEntry(target);
assert.deepEqual(opened, [[old2, target.line + 2]]);
await plugin.openEntry({ ...target, hash: "0".repeat(64) });
assert.equal(opened.length, 1);

const target2 = (await plugin.search("Old match 2"))[0];
await plugin.deleteEntry(target2, false, false);
assert.ok(!ref.content.includes("Old match 2"));
assert.ok(ref.content.includes("Old match 3"));
assert.match(ref.content, /## 1\. 01:00:00 · 文本/);
assert.ok(ref.content.includes("# Prepended heading"));
ref.content = ref.content.replace("Old match 3", "Moved to a new title");
await plugin.deleteEntry(target, false, false);
assert.ok(ref.content.includes("Moved to a new title"));

const mixedHit = images.find(hit => hit.images.length === 2);
const [shared, unique] = mixedHit.images.map(image => plugin.entryImage(mixedHit, image));
await vault.create("项目笔记.md", "![" + shared.name + "](" + shared.path + ")");
const preview = [];
plugin.confirmRemoval = (hit, undo) => preview.push([hit, undo]);
await plugin.undoLatest();
assert.equal(preview[0][1], true);
assert.equal(preview[0][0].text, (await plugin.latestEntry()).text);
await plugin.deleteEntry(mixedHit, true, false);
assert.deepEqual(trashed, [unique.path]);
assert.ok(records.has(shared.path));
const standalone = images.find(hit => hit.images.length === 1);
const keepFile = plugin.entryImage(standalone, standalone.images[0]);
await plugin.deleteEntry(standalone, false, true);
assert.ok(records.has(keepFile.path));
assert.equal((await plugin.search("", { from: today, through: today, kind: "image" })).length, 0);
assert.equal(await plugin.store({ kind: "text", text: "After deletion" }, "9".repeat(64)), "已保存");
assert.match(vault.getMarkdownFiles()[1].content, /## 3\. .*· 文本/);

// Batch edits use one process call per note, preserve new captures, and continue after a failed note.
const batchPath1 = "剪切板/1999/1999-01-01.md";
const batchPath2 = "剪切板/1999/1999-01-02.md";
const failedPath = "剪切板/1999/1999-01-03.md";
const outsidePath = "私人笔记/1999-01-04.md";
const manual = "# 手工添加的工作记录\r\n\r\n必须保留。\r\n\r\n";
await vault.create(batchPath1, (plainClip("Batch first", 1, "a") + "\n" + plainClip("Keep middle", 2, "b") + "\n" + plainClip("Batch last", 3, "c")).replace(/\n/g, "\r\n") + manual);
await vault.create(batchPath2, plainClip("Batch other date", 1, "a") + "\n" + plainClip("Edited later", 2, "d"));
await vault.create(failedPath, plainClip("Read only", 1, "e"));
await vault.create(outsidePath, plainClip("Outside archive", 1, "f"));
const firstDate = (await plugin.search("", { from: "1999-01-01", through: "1999-01-01" }, 10)).reverse();
const otherDate = await plugin.search("", { from: "1999-01-02", through: "1999-01-02" }, 10);
const failedHit = (await plugin.search("Read only"))[0];
const outsideHit = { ...firstDate[0], path: outsidePath };
const failedNote = records.get(failedPath);
const failedContent = failedNote.content;
records.get(batchPath1).content += plainClip("Captured while selecting", 4, "e").replace(/\n/g, "\r\n");
records.get(batchPath2).content = records.get(batchPath2).content.replace("Edited later", "Edited after selection");
const processCalls = [];
const originalProcess = vault.process;
vault.process = async (file, callback) => {
  processCalls.push(file.path);
  if (file.path === failedPath) throw new Error("Simulated read-only note");
  return originalProcess(file, callback);
};
const originalWarn = console.warn;
let batchRemoved;
try {
  console.warn = () => {};
  batchRemoved = await plugin.deleteEntries([firstDate[0], firstDate[2], ...otherDate, failedHit, outsideHit, firstDate[0]], false);
} finally {
  vault.process = originalProcess;
  console.warn = originalWarn;
}
assert.equal(batchRemoved.length, 3);
assert.deepEqual(processCalls, [batchPath1, batchPath2, failedPath]);
assert.ok(records.get(batchPath1).content.includes(manual));
assert.ok(records.get(batchPath1).content.includes("Captured while selecting"));
assert.deepEqual((await plugin.search("", { from: "1999-01-01", through: "1999-01-01" }, 10)).map(hit => hit.title.match(/^\d+/)[0]), ["2", "1"]);
assert.ok(records.get(batchPath2).content.includes("Edited after selection"));
assert.ok(!records.get(batchPath2).content.includes("Batch other date"));
assert.equal(failedNote.content, failedContent);
assert.ok(records.get(outsidePath).content.includes("Outside archive"));

// A shared attachment can be trashed only after all selected references have been removed.
const batchImage = "剪切板/1998/attachments/010000-aaaaaaaaaaaa.png";
const imageNote = number => "<!-- clipboard-vault:image:" + "a".repeat(64) + " -->\n## " + number + ". 01:00:00 · 图片\n\n![](attachments/010000-aaaaaaaaaaaa.png)\n\n";
await vault.createBinary(batchImage, png);
await vault.create("剪切板/1998/1998-01-01.md", imageNote(1));
await vault.create("剪切板/1998/1998-01-02.md", imageNote(1));
const batchImages = await plugin.search("", { from: "1998-01-01", through: "1998-01-02" }, 10);
assert.equal((await plugin.deleteEntries(batchImages, true)).length, 2);
assert.ok(!records.has(batchImage));
assert.equal(trashed.filter(path => path === batchImage).length, 1);

// The same image bytes are recognised by content: a rename or another folder never stores it twice.
{
  const dedupeDir = await mkdtemp(join(tmpdir(), "clipboard-vault-dedupe-"));
  const fresh = Buffer.concat([png2, Buffer.from([0])]);
  const first = join(dedupeDir, "shot.png");
  const second = join(dedupeDir, "截图副本.png");
  const renamed = join(dedupeDir, "again.png");
  try {
    await writeFile(first, fresh);
    await writeFile(second, fresh);
    await writeFile(renamed, fresh);
    plugin.settings.imageFileMode = "attachment";
    const attachments = () => [...records.keys()].filter(path => path.includes("/attachments/")).length;
    const base = attachments();
    assert.equal(await plugin.store({ kind: "files", paths: [first] }, "b1".padEnd(64, "0")), "已保存");
    assert.equal(attachments(), base + 1);
    // Same bytes, different name and folder: recognised as a duplicate.
    assert.equal(await plugin.store({ kind: "files", paths: [second] }, "b2".padEnd(64, "0")), "今日已保存相同内容");
    assert.equal(attachments(), base + 1);
    // A pasted bitmap of the same picture reuses the attachment written for the file.
    const bytes = new Uint8Array(fresh);
    assert.equal(await plugin.store({ kind: "image", bytes }, await plugin.fingerprint({ kind: "image", bytes })), "已保存");
    assert.equal(attachments(), base + 1);
    // A batch mixing a new path with an already stored picture writes no second copy.
    assert.equal(await plugin.store({ kind: "files", paths: [renamed, "C:\\资料\\新文档.docx"] }, "b4".padEnd(64, "0")), "已保存");
    assert.equal(attachments(), base + 1);
    // The very same content copied again is skipped, and no second copy is written.
    assert.equal(await plugin.store({ kind: "files", paths: [renamed] }, "b5".padEnd(64, "0")), "今日已保存相同内容");
    assert.equal(attachments(), base + 1);
    const hits = await plugin.search("", {}, 400);
    assert.ok(hits.every(hit => hit.images.every(image => plugin.entryImage(hit, image) instanceof TFile)));
  } finally {
    for (const file of [first, second, renamed]) await unlink(file);
    await rmdir(dedupeDir);
  }
}

// Cleanup collects by date range and type, backs the note up, and only trashes owned, unreferenced images.
const cleanupNote = "剪切板/1997/1997-01-01.md";
const cleanupImage = "剪切板/1997/attachments/010000-bbbbbbbbbbbb.png";
const cleanupHash = "b".repeat(64);
await vault.createBinary(cleanupImage, png);
await vault.create(cleanupNote,
  "<!-- clipboard-vault:image:" + cleanupHash + " -->\n## 1. 01:00:00 · 图片\n\n![](attachments/010000-bbbbbbbbbbbb.png)\n\n" +
  plainClip("Old text to clean", 2, "c") + "\n" + plainClip("Another old line", 3, "d"));
const imageHits = await plugin.collectCleanupHits({ from: "1997-01-01", through: "1997-01-01" }, new Set(["image"]));
assert.equal(imageHits.length, 1);
assert.equal((await plugin.collectCleanupHits({ from: "1997-01-01", through: "1997-01-01" }, new Set(["text"]))).length, 2);
assert.equal((await plugin.collectCleanupHits({ from: "1997-01-01", through: "1997-01-01" }, new Set())).length, 0);
assert.equal((await plugin.collectCleanupHits({ from: "1996-01-01", through: "1996-12-31" }, new Set(["image", "text"]))).length, 0);
assert.deepEqual(await plugin.cleanupStats(imageHits), { entries: 1, images: 1, bytes: 1234 });

const cleanup = await plugin.applyCleanup(imageHits, true);
assert.equal(cleanup.removed, 1);
assert.equal(cleanup.trashed, 1);
assert.equal(cleanup.skipped, 0);
assert.ok(cleanup.backup.startsWith("剪切板/.cleanup-backup/"));
const backupFile = records.get(`${cleanup.backup}/1997/1997-01-01.md`);
assert.ok(backupFile && backupFile.content.includes("01:00:00 · 图片"));
assert.ok(!records.has(cleanupImage));
assert.ok(trashed.includes(cleanupImage));
assert.ok(!records.get(cleanupNote).content.includes("· 图片"));
assert.match(records.get(cleanupNote).content, /## 1\. 01:00:00 · 文本/);
assert.match(records.get(cleanupNote).content, /## 2\. 01:00:00 · 文本/);
// Backups never show up as archive entries.
const visible = await plugin.search("", {}, 200);
assert.ok(visible.length > 0);
assert.ok(visible.every(hit => !hit.path.includes(".cleanup-backup")));

const staleHits = await plugin.collectCleanupHits({ from: "1997-01-01", through: "1997-01-01" }, new Set(["text"]));
records.get(cleanupNote).content = records.get(cleanupNote).content.replace("Old text to clean", "Changed after preview");
const stale = await plugin.applyCleanup(staleHits, false);
assert.equal(stale.removed, 1);
assert.equal(stale.skipped, 1);
assert.equal(stale.backup, undefined);
assert.ok(records.get(cleanupNote).content.includes("Changed after preview"));
assert.ok(!records.get(cleanupNote).content.includes("Another old line"));

// A failed backup must abort cleanup before any selected archive content is removed.
const backupFailureHits = await plugin.collectCleanupHits({ from: "1997-01-01", through: "1997-01-01" }, new Set(["text"]));
assert.equal(backupFailureHits.length, 1);
const beforeFailedBackup = records.get(cleanupNote).content;
const createBeforeFailure = vault.create;
const warnBeforeFailure = console.warn;
try {
  vault.create = async (path, content) => {
    if (path.includes("/.cleanup-backup/")) throw new Error("Simulated backup write failure");
    return createBeforeFailure(path, content);
  };
  console.warn = () => {};
  await assert.rejects(() => plugin.applyCleanup(backupFailureHits, true), /清理前备份失败/);
} finally {
  vault.create = createBeforeFailure;
  console.warn = warnBeforeFailure;
}
assert.equal(records.get(cleanupNote).content, beforeFailedBackup);

// Timed pause and restart use a fake clock; no system clipboard or active Vault is touched.
const originalNow = Date.now;
let tickNow = originalNow();
let id = 0;
const scheduled = new Map();
globalThis.window = {
  setInterval: () => ++id, clearInterval() {},
  setTimeout(callback, ms) { scheduled.set(++id, { callback, ms }); return id; },
  clearTimeout(timer) { scheduled.delete(timer); }
};
Date.now = () => tickNow;
const stored = [];
let saved;
let clipboardText = "before pause";
const makeMonitor = () => {
  const monitor = new PluginClass(app);
  Object.assign(monitor, {
    async saveData(data) { saved = structuredClone(data); },
    async loadData() { return saved; },
    registerView() {}, addRibbonIcon() {}, registerDomEvent() {}, addCommand() {}, addSettingTab() {},
    addStatusBarItem: () => ({ addClass() {}, setText() {}, setAttribute() {} }),
    makeWindowsBridge: () => null,
    fingerprint: async snapshot => snapshot.text,
    readSnapshot: async () => ({ kind: "text", text: clipboardText }),
    async store(snapshot) { stored.push(snapshot.text); return "已保存"; }
  });
  return monitor;
};
const flush = () => new Promise(resolve => setImmediate(resolve));
app.workspace.onLayoutReady = () => {};
try {
  const monitor = makeMonitor();
  await monitor.setMonitoring(true);
  await flush();
  assert.deepEqual(stored, []);
  clipboardText = "normal capture";
  await monitor.tick();
  assert.deepEqual(stored, ["normal capture"]);
  let finishReading;
  monitor.readSnapshot = () => new Promise(resolve => { finishReading = resolve; });
  const inFlight = monitor.tick();
  await monitor.pauseFor(15);
  finishReading({ kind: "text", text: "ignore in flight" });
  await inFlight;
  assert.equal(monitor.isMonitoring, false);
  assert.equal(monitor.isTimedPaused, true);
  assert.equal(saved.pauseUntil, tickNow + 15 * 60000);
  assert.deepEqual(stored, ["normal capture"]);
  monitor.onunload();
  assert.equal(scheduled.size, 0);

  tickNow += 5 * 60000;
  clipboardText = "copied during pause";
  const restored = makeMonitor();
  await restored.onload();
  assert.equal(restored.isMonitoring, false);
  const [job] = scheduled.values();
  assert.equal(job.ms, 10 * 60000);
  tickNow += job.ms;
  job.callback();
  await flush();
  assert.equal(restored.isMonitoring, true);
  assert.equal(saved.pauseUntil, 0);
  assert.deepEqual(stored, ["normal capture"]);
  clipboardText = "after resume";
  await restored.tick();
  assert.deepEqual(stored, ["normal capture", "after resume"]);
  await restored.pauseFor(5);
  clipboardText = "manual during pause";
  await restored.captureNow();
  assert.equal(stored.at(-1), "manual during pause");
  await restored.setMonitoring(false);
  assert.equal(scheduled.size, 0);
  assert.equal(saved.enabled, false);
  assert.equal(saved.pauseUntil, 0);
  restored.onunload();
} finally {
  Date.now = originalNow;
  delete globalThis.window;
}
console.log("Vault archive and panel checks passed");
