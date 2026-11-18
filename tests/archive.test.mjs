import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);
class TFolder { constructor(path) { this.path = path; } }
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
  async trash(file, system) { assert.equal(system, true); records.delete(file.path); trashed.push(file.path); }
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
try {
  await writeFile(sample, png);
  await writeFile(sample2, png);
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
