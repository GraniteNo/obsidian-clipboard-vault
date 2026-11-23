import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Exercise the actual bundled view and modal with an in-memory DOM and synthetic records.
class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.classes = new Set((options.cls ?? "").split(" ").filter(Boolean));
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    this.text = options.text ?? "";
    this.type = options.type;
    this.value = options.value ?? "";
    this.attributes = options.attr ?? {};
    this.checked = this.indeterminate = this.disabled = this.hidden = false;
  }
  createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
  createDiv(options) { return this.createEl("div", options); }
  addClass(name) { this.classes.add(name); }
  setAttribute(name, value) { this.attributes[name] = value; }
  setText(text) { this.text = text; }
  empty() { this.children = []; }
  focus() { this.focused = true; }
  addEventListener(name, callback) {
    const handlers = this.listeners.get(name) ?? [];
    handlers.push(callback);
    this.listeners.set(name, handlers);
  }
  async fire(name) {
    for (const callback of this.listeners.get(name) ?? []) await callback({ key: "Enter" });
    await new Promise(resolve => setImmediate(resolve));
  }
  all(predicate) { return this.children.flatMap(child => [...(predicate(child) ? [child] : []), ...child.all(predicate)]); }
}
class ItemView { constructor() { this.contentEl = new Element(); } }
class Plugin { constructor(app) { this.app = app; } }
class Modal {
  constructor() { this.contentEl = new Element(); this.titleEl = new Element(); }
  open() { this.onOpen(); }
  close() { this.onClose(); }
}
class Setting {
  setName() { return this; }
  setDesc() { return this; }
  addToggle(callback) {
    const toggle = { setValue(value) { this.value = value; return this; }, onChange(fn) { this.change = fn; return this; } };
    callback(toggle);
    assert.equal(toggle.value, false);
    return this;
  }
}
const module = { exports: {} };
const nodeRequire = createRequire(import.meta.url);
const obsidian = { Plugin, ItemView, Modal, Setting, PluginSettingTab: class {}, Notice: class {} };
new Function("require", "module", "exports", readFileSync(new URL("../main.js", import.meta.url), "utf8"))(
  id => id === "obsidian" ? obsidian : nodeRequire(id), module, module.exports);
const app = { workspace: { onLayoutReady() {}, getLeavesOfType: () => [] } };
const plugin = new module.exports.default(app);
let factory;
Object.assign(plugin, {
  loadData: async () => ({ enabled: false }),
  registerView(type, create) { factory = create; },
  addRibbonIcon() {}, addCommand() {}, addSettingTab() {}, registerDomEvent() {},
  addStatusBarItem: () => new Element(),
  statusText: () => "测试监控状态", dayFolder: () => "剪切板/测试", todayCount: async () => 35
});
const now = new Date();
const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(value => String(value).padStart(2, "0")).join("-");
const hits = Array.from({ length: 35 }, (_, i) => ({
  path: `剪切板/${date}.md`, title: `${i + 1}. 12:00:00 · 文本`, hash: i.toString(16).padStart(64, "0"),
  kind: "text", text: `Synthetic record ${i + 1}`, snippet: `Synthetic record ${i + 1}`, images: [], line: i * 7,
  range: i === 2 ? undefined : { start: i * 100, end: i * 100 + 90 }
}));
plugin.search = async (query, filter, limit, skip) => hits.filter(hit => hit.text.includes(query)).slice(skip, skip + limit);
await plugin.onload();
const view = factory({});
await view.onOpen();
const inputs = () => view.contentEl.all(el => el.classes.has("clipboard-vault-hit-select"));
const buttons = label => view.contentEl.all(el => el.tag === "button" && el.text === label)[0];
const select = async (input, checked) => { input.checked = checked; await input.fire("change"); };
assert.equal(inputs().length, 29);
assert.equal(view.ui.removeSelected.disabled, true);
assert.equal(view.ui.selectAll.checked, false);
await select(inputs()[0], true);
assert.equal(view.selectedHits.size, 1);
assert.equal(view.ui.selectAll.indeterminate, true);
assert.ok(view.contentEl.all(el => el.classes.has("is-selected")).length === 1);
await view.refresh();
assert.equal(inputs()[0].checked, true);

await view.ui.next.fire("click");
assert.equal(inputs().length, 5);
assert.equal(view.ui.selectAll.checked, false);
assert.equal(view.selectedHits.size, 1);
await select(view.ui.selectAll, true);
assert.equal(view.selectedHits.size, 6);
assert.ok(inputs().every(input => input.checked));
await view.ui.previous.fire("click");
assert.equal(inputs()[0].checked, true);
assert.equal(view.ui.selectAll.indeterminate, true);
await select(view.ui.selectAll, true);
assert.equal(view.selectedHits.size, 34);
await select(view.ui.selectAll, false);
assert.equal(view.selectedHits.size, 5);
assert.ok(inputs().every(input => !input.checked));
await view.ui.clearSelection.fire("click");
assert.equal(view.selectedHits.size, 0);
assert.equal(view.ui.removeSelected.disabled, true);

await select(inputs()[0], true);
await select(inputs()[1], true);
await view.ui.removeSelected.fire("click");
assert.equal(plugin.removalModal.titleEl.text, "批量删除条目");
assert.equal(plugin.removalModal.contentEl.all(el => el.tag === "li").length, 2);
const modalButton = label => plugin.removalModal.contentEl.all(el => el.tag === "button" && el.text === label)[0];
assert.equal(modalButton("取消").focused, true);
await modalButton("取消").fire("click");
assert.equal(plugin.removalModal, null);
assert.equal(view.selectedHits.size, 2);

let deletion;
plugin.deleteEntries = async (selected, trashImages, undo) => {
  deletion = { selected, trashImages, undo };
  return selected;
};
await view.ui.removeSelected.fire("click");
await modalButton("确认删除 2 条").fire("click");
assert.equal(deletion.selected.length, 2);
assert.equal(deletion.trashImages, false);
assert.equal(deletion.undo, false);
assert.equal(view.selectedHits.size, 0);
assert.equal(plugin.removalModal, null);
assert.equal(view.ui.removeSelected.disabled, true);

await select(inputs()[0], true);
await view.refresh(new Set([hits[0].path]));
assert.equal(view.selectedHits.size, 0);
assert.ok(inputs().every(input => !input.checked));
await select(inputs()[0], true);
// A record edited during an automatic refresh must lose its selection.
hits[0] = { ...hits[0], text: "Edited after selection" };
await view.refresh();
assert.equal(view.selectedHits.size, 0);
await select(inputs()[0], true);
const query = view.contentEl.all(el => el.type === "search")[0];
query.value = "Synthetic";
await buttons("搜索").fire("click");
assert.equal(view.selectedHits.size, 0);
await select(inputs()[0], true);
const kind = view.contentEl.all(el => el.attributes["aria-label"] === "归档类型")[0];
kind.value = "text";
await kind.fire("change");
assert.equal(view.selectedHits.size, 0);
query.value = "Nothing matches";
await buttons("搜索").fire("click");
assert.equal(inputs().length, 0);
assert.equal(view.ui.selectAll.disabled, true);
await view.onClose();
assert.equal(view.selectedHits.size, 0);
plugin.onunload();
console.log("Archive multi-selection and confirmation checks passed");
