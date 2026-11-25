import { App, FileSystemAdapter, ItemView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { archiveDate, archiveEntries, archivePath, cleanupScopeKinds, dayKey, detectKind, formatSize, hasMarker, isImageFilePath, isSensitive, matchesKeyword, nextSequence, ownedAttachmentName, pad, recentDate, removeArchiveEntries, renderEntry, renderFileEntry, sameEntry, searchEntries, timeKey, validDay, validRoot, type ArchiveFilter, type ArchiveLevel, type CleanupScope, type EntryKind, type SearchHit } from "./core";
import { ARCHIVE_COPY_FORMAT, WindowsClipboardBridge, writeWindowsClipboard, type WindowsSnapshot } from "./windows-clipboard";

declare const require: ((id: string) => unknown) | undefined;

const VIEW_TYPE = "clipboard-vault-view";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BATCH_BYTES = 200 * 1024 * 1024;
const PAGE_SIZE = 30;
const PAUSE_MINUTES = [5, 15, 30] as const;
const CLEANUP_INTERVALS = [1, 3, 7] as const;
const CLEANUP_CHECK_MS = 30 * 60 * 1000;
const CLEANUP_BACKUP_KEEP = 10;
type PauseMinutes = typeof PAUSE_MINUTES[number];
type DateScope = "all" | "today" | "yesterday" | "week" | "date";
type ImageFileMode = "attachment" | "path";

interface Settings {
  enabled: boolean;
  pauseUntil: number;
  root: string;
  archiveLevel: ArchiveLevel;
  intervalMs: number;
  captureText: boolean;
  captureImages: boolean;
  captureFiles: boolean;
  imageFileMode: ImageFileMode;
  dedupeDay: boolean;
  filterSensitive: boolean;
  ignoreKeywords: string;
  maxTextLength: number;
  cleanupAuto: boolean;
  cleanupEveryDays: number;
  cleanupOlderThanDays: number;
  cleanupScope: CleanupScope;
  cleanupLastRun: number;
}

const DEFAULTS: Settings = {
  enabled: true,
  pauseUntil: 0,
  root: "剪切板",
  archiveLevel: "day",
  intervalMs: 1000,
  captureText: true,
  captureImages: true,
  captureFiles: true,
  imageFileMode: "attachment",
  dedupeDay: true,
  filterSensitive: true,
  ignoreKeywords: "",
  maxTextLength: 50000,
  cleanupAuto: false,
  cleanupEveryDays: 7,
  cleanupOlderThanDays: 30,
  cleanupScope: "image",
  cleanupLastRun: 0
};

type Snapshot = Exclude<WindowsSnapshot, null>;
interface NativeImage { isEmpty(): boolean; toPNG(): Uint8Array }
interface ClipboardItemLike { types: readonly string[]; getType(type: string): Promise<Blob> }
interface DesktopClipboard {
  has?: (format: string) => boolean;
  readImage?: () => NativeImage;
  readText?: () => string | Promise<string>;
  read?: () => Promise<ClipboardItemLike[]> | unknown;
}

function desktopClipboard(): DesktopClipboard | null {
  try {
    const host = window as Window & { require?: (id: string) => { clipboard?: DesktopClipboard } };
    const load = host.require ?? (typeof require === "function" ? require : undefined);
    const electron = load?.("electron") as { clipboard?: DesktopClipboard } | undefined;
    return electron?.clipboard ?? null;
  } catch { return null; }
}

function fileReader(): typeof import("node:fs/promises") | null {
  const host = typeof window === "undefined" ? null : window as Window & { require?: (id: string) => unknown };
  const loaders = [host?.require, typeof require === "function" ? require : undefined];
  for (const load of loaders) {
    if (!load) continue;
    for (const name of ["node:fs/promises", "fs/promises"]) {
      try {
        const api = load(name) as Partial<typeof import("node:fs/promises")> | null;
        if (api && typeof api.readFile === "function" && typeof api.stat === "function") return api as typeof import("node:fs/promises");
      } catch { /* Try another loader. */ }
    }
  }
  return null;
}

async function digest(kind: EntryKind, bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.length + 1);
  input[0] = kind === "image" ? 1 : 0;
  input.set(bytes, 1);
  const buffer = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2, "0")).join("");
}

async function blobToPng(blob: Blob): Promise<Uint8Array> {
  if (blob.type === "image/png") return new Uint8Array(await blob.arrayBuffer());
  const bitmap = await createImageBitmap(blob).catch(() => null);
  let url: string | undefined;
  try {
    let source: ImageBitmap | HTMLImageElement;
    if (bitmap) source = bitmap;
    else {
      url = URL.createObjectURL(blob);
      const image = new Image();
      image.src = url;
      await image.decode();
      source = image;
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap ? bitmap.width : (source as HTMLImageElement).naturalWidth;
    canvas.height = bitmap ? bitmap.height : (source as HTMLImageElement).naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) throw new Error("图片转换失败");
    context.drawImage(source, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片转换失败")), "image/png"));
    return new Uint8Array(await png.arrayBuffer());
  } finally { bitmap?.close(); if (url) URL.revokeObjectURL(url); }
}

async function readItems(items: readonly ClipboardItemLike[], images: boolean, text: boolean): Promise<Snapshot | null> {
  for (const item of items) {
    if (images) {
      const format = item.types.find(type => type.startsWith("image/"));
      if (format) return { kind: "image", bytes: await blobToPng(await item.getType(format)) };
    }
    if (text && item.types.includes("text/plain")) {
      const value = await (await item.getType("text/plain")).text();
      if (value.trim()) return { kind: "text", text: value };
    }
  }
  return null;
}

function entrySelectionKey(hit: SearchHit): string {
  return JSON.stringify([hit.path, hit.kind, hit.hash, hit.title]);
}

class ClipboardView extends ItemView {
  private query = "";
  private dateScope: DateScope = "today";
  private kind?: EntryKind;
  private date = "";
  private page = 0;
  private request = 0;
  private collapsedDates = new Set<string>();
  private selectedHits = new Map<string, SearchHit>();
  private visibleHits: SearchHit[] = [];
  private selectionInputs = new Map<string, { input: HTMLInputElement; item: HTMLElement }>();
  private ui?: {
    status: HTMLElement; count: HTMLElement; path: HTMLElement; toggle: HTMLButtonElement;
    result: HTMLElement; list: HTMLElement; previous: HTMLButtonElement; next: HTMLButtonElement;
    selectAll: HTMLInputElement; selectionCount: HTMLElement; clearSelection: HTMLButtonElement; removeSelected: HTMLButtonElement;
  };

  constructor(leaf: WorkspaceLeaf, private plugin: ClipboardVaultPlugin) { super(leaf); }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "剪切板归档"; }
  getIcon(): string { return "clipboard"; }
  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("clipboard-vault-panel");
    const header = root.createDiv({ cls: "clipboard-vault-header" });
    header.createEl("h2", { text: "剪切板归档" });
    const status = header.createDiv({ cls: "clipboard-vault-status" });
    const summary = root.createDiv({ cls: "clipboard-vault-summary" });
    const count = summary.createDiv({ cls: "clipboard-vault-count" });
    const path = summary.createDiv({ cls: "clipboard-vault-path" });

    const actions = root.createDiv({ cls: "clipboard-vault-actions" });
    const toggle = actions.createEl("button");
    toggle.addEventListener("click", () => {
      if (this.plugin.isMonitoring) this.plugin.openMonitorMenu(toggle);
      else void this.plugin.setMonitoring(true);
    });
    const capture = actions.createEl("button", { text: "立即捕获" });
    capture.addEventListener("click", () => void this.plugin.captureNow());
    const open = actions.createEl("button", { text: "打开今日归档" });
    open.addEventListener("click", () => void this.plugin.openToday());
    actions.createEl("button", { text: "撤销最近捕获" }).addEventListener("click", () => void this.plugin.undoLatest());
    actions.createEl("button", { text: "清理…" }).addEventListener("click", () => this.plugin.openCleanupModal());

    const searchSection = root.createDiv({ cls: "clipboard-vault-section" });
    searchSection.createEl("h3", { text: "浏览归档" });
    const searchRow = searchSection.createDiv({ cls: "clipboard-vault-actions clipboard-vault-search-row" });
    const input = searchRow.createEl("input", { type: "search", placeholder: "搜索文字、链接或文件名",
      cls: "clipboard-vault-search-input", attr: { "aria-label": "搜索归档" } });
    input.value = this.query;
    const search = searchRow.createEl("button", { text: "搜索" });
    const run = () => {
      this.query = input.value.trim();
      this.page = 0;
      this.selectedHits.clear();
      this.updateSelection();
      void this.refresh();
    };
    search.addEventListener("click", run);
    input.addEventListener("keydown", event => { if (event.key === "Enter") run(); });
    input.addEventListener("input", () => { if (!input.value && this.query) run(); });
    const filters = searchSection.createDiv({ cls: "clipboard-vault-actions clipboard-vault-filters" });
    const scope = filters.createEl("select", { attr: { "aria-label": "归档日期" } });
    for (const [value, text] of [["today", "今天"], ["yesterday", "昨天"], ["week", "最近 7 天"], ["date", "指定日期"], ["all", "全部日期"]]) {
      scope.createEl("option", { text, value });
    }
    scope.value = this.dateScope;
    const date = filters.createEl("input", { type: "date", attr: { "aria-label": "选择归档日期" } });
    date.hidden = this.dateScope !== "date";
    date.value = this.date || dayKey(new Date());
    const kind = filters.createEl("select", { attr: { "aria-label": "归档类型" } });
    for (const [value, text] of [["", "全部类型"], ["image", "图片"], ["text", "文本"], ["url", "链接"], ["code", "代码"], ["files", "文件路径"]]) {
      kind.createEl("option", { text, value });
    }
    kind.value = this.kind ?? "";
    scope.addEventListener("change", () => { this.dateScope = scope.value as DateScope; date.hidden = this.dateScope !== "date"; this.date = date.value; run(); });
    date.addEventListener("change", () => { this.date = date.value; run(); });
    kind.addEventListener("change", () => { this.kind = (kind.value || undefined) as EntryKind | undefined; run(); });
    const result = searchSection.createDiv({ cls: "clipboard-vault-result-count", attr: { "aria-live": "polite" } });
    const selection = searchSection.createDiv({ cls: "clipboard-vault-actions clipboard-vault-selection", attr: { role: "group", "aria-label": "批量选择归档" } });
    const selectAllLabel = selection.createEl("label", { cls: "clipboard-vault-select-all" });
    const selectAll = selectAllLabel.createEl("input", { type: "checkbox" });
    selectAllLabel.createEl("span", { text: "全选本页" });
    const selectionCount = selection.createEl("span", { cls: "clipboard-vault-selection-count", attr: { "aria-live": "polite" } });
    const clearSelection = selection.createEl("button", { text: "取消选择" });
    const removeSelected = selection.createEl("button", { text: "删除所选", cls: "mod-warning" });
    selectAll.addEventListener("change", () => {
      for (const hit of this.visibleHits) {
        if (!hit.range) continue;
        if (selectAll.checked) this.selectedHits.set(entrySelectionKey(hit), hit);
        else this.selectedHits.delete(entrySelectionKey(hit));
      }
      this.updateSelection();
    });
    clearSelection.addEventListener("click", () => { this.selectedHits.clear(); this.updateSelection(); });
    removeSelected.addEventListener("click", () => {
      this.plugin.confirmBatchRemoval([...this.selectedHits.values()], removed => {
        for (const hit of removed) this.selectedHits.delete(entrySelectionKey(hit));
        this.updateSelection();
      });
    });
    const list = searchSection.createDiv({ cls: "clipboard-vault-list" });
    const pages = searchSection.createDiv({ cls: "clipboard-vault-actions clipboard-vault-pages" });
    const previous = pages.createEl("button", { text: "上一页" });
    const next = pages.createEl("button", { text: "下一页" });
    previous.addEventListener("click", () => { this.page = Math.max(0, this.page - 1); void this.refresh(); });
    next.addEventListener("click", () => { this.page++; void this.refresh(); });
    this.ui = { status, count, path, toggle, result, list, previous, next, selectAll, selectionCount, clearSelection, removeSelected };
    this.updateSelection();
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.ui = undefined;
    this.request++;
    this.selectedHits.clear();
    this.selectionInputs.clear();
    this.visibleHits = [];
  }

  private updateSelection(): void {
    const ui = this.ui;
    if (!ui) return;
    const selectable = this.visibleHits.filter(hit => hit.range);
    const count = selectable.filter(hit => this.selectedHits.has(entrySelectionKey(hit))).length;
    ui.selectAll.checked = selectable.length > 0 && count === selectable.length;
    ui.selectAll.indeterminate = count > 0 && count < selectable.length;
    ui.selectAll.disabled = !selectable.length;
    ui.selectionCount.setText(`已选 ${this.selectedHits.size} 条（可跨页）`);
    ui.clearSelection.disabled = ui.removeSelected.disabled = !this.selectedHits.size;
    for (const [key, { input, item }] of this.selectionInputs) {
      input.checked = this.selectedHits.has(key);
      item.classList.toggle("is-selected", input.checked);
    }
  }

  async refresh(changedPaths?: ReadonlySet<string>): Promise<void> {
    const ui = this.ui;
    if (!ui) return;
    if (changedPaths?.size) {
      // Deletion renumbers a whole note; discard its old selections before showing the new headings.
      for (const [key, hit] of this.selectedHits) if (changedPaths.has(hit.path)) this.selectedHits.delete(key);
      this.updateSelection();
    }
    const request = ++this.request;
    ui.status.setText(this.plugin.statusText());
    ui.path.setText(`保存位置：${this.plugin.dayFolder()}`);
    ui.toggle.setText(this.plugin.isMonitoring ? "暂停监控" : this.plugin.isTimedPaused ? "恢复监控" : "开始监控");
    ui.previous.disabled = ui.next.disabled = true;
    ui.selectAll.disabled = true;
    const filter: ArchiveFilter = { kind: this.kind };
    const now = new Date();
    switch (this.dateScope) {
      case "today": filter.from = filter.through = recentDate(0, now); break;
      case "yesterday": filter.from = filter.through = recentDate(1, now); break;
      case "week": filter.from = recentDate(6, now); filter.through = recentDate(0, now); break;
      case "date": filter.from = filter.through = this.date; break;
    }
    try {
      const [count, hits] = await Promise.all([
        this.plugin.todayCount(),
        this.dateScope === "date" && !this.date ? Promise.resolve([]) :
          this.plugin.search(this.query, filter, PAGE_SIZE + 1, this.page * PAGE_SIZE)
      ]);
      if (request !== this.request) return;
      ui.count.setText(`今日捕获：${count} 条`);
      if (!hits.length && this.page > 0) { this.page--; await this.refresh(); return; }
      ui.result.setText(hits.length ? `第 ${this.page + 1} 页 · ${Math.min(PAGE_SIZE, hits.length)} 条` :
        this.dateScope === "date" && !this.date ? "请选择日期。" : this.dateScope === "today" ?
          "今天没有符合条件的归档。可切换日期查看历史记录。" : "没有符合条件的归档。");
      ui.list.empty();
      this.selectionInputs.clear();
      this.visibleHits = hits.slice(0, PAGE_SIZE);
      for (const hit of this.visibleHits) {
        const key = entrySelectionKey(hit);
        const selected = this.selectedHits.get(key);
        if (selected && (!hit.range || !sameEntry(hit, selected))) this.selectedHits.delete(key);
      }
      this.addDateGroups(ui.list, this.visibleHits, now);
      this.updateSelection();
      ui.previous.disabled = this.page === 0;
      ui.next.disabled = hits.length <= PAGE_SIZE;
      ui.previous.hidden = ui.next.hidden = this.page === 0 && hits.length <= PAGE_SIZE;
    } catch (error) {
      if (request !== this.request) return;
      console.error("[Clipboard Vault] search", error);
      ui.result.setText("读取归档失败，请重新搜索。");
    }
  }

  private addDateGroups(container: HTMLElement, hits: SearchHit[], now: Date): void {
    const groups = new Map<string, SearchHit[]>();
    for (const hit of hits) {
      const date = archiveDate(hit.path);
      const group = groups.get(date) ?? [];
      group.push(hit);
      groups.set(date, group);
    }
    for (const [date, entries] of groups) {
      const group = container.createEl("details", { cls: "clipboard-vault-day-group" });
      group.open = !this.collapsedDates.has(date);
      const summary = group.createEl("summary", { cls: "clipboard-vault-day-heading" });
      const label = date === recentDate(0, now) ? `今天 · ${date}` :
        date === recentDate(1, now) ? `昨天 · ${date}` : date;
      summary.createEl("strong", { text: label });
      summary.createEl("span", { text: `本页 ${entries.length} 条`, cls: "clipboard-vault-day-count" });
      group.addEventListener("toggle", () => {
        if (group.open) this.collapsedDates.delete(date);
        else this.collapsedDates.add(date);
      });
      const list = group.createDiv({ cls: "clipboard-vault-day-list" });
      for (const entry of entries) this.addHit(list, entry);
    }
  }

  private addHit(container: HTMLElement, hit: SearchHit): void {
    const item = container.createDiv({ cls: "clipboard-vault-hit" });
    const heading = item.createDiv({ cls: "clipboard-vault-hit-heading" });
    if (hit.range) {
      const key = entrySelectionKey(hit);
      const input = heading.createEl("input", { type: "checkbox", cls: "clipboard-vault-hit-select",
        attr: { "aria-label": `选择 ${archiveDate(hit.path)} · ${hit.title}` } });
      this.selectionInputs.set(key, { input, item });
      input.addEventListener("change", () => {
        if (input.checked) this.selectedHits.set(key, hit);
        else this.selectedHits.delete(key);
        this.updateSelection();
      });
    }
    heading.createEl("strong", { text: hit.title });
    heading.createEl("span", { text: archiveDate(hit.path) });
    if (hit.snippet) item.createDiv({ text: hit.snippet, cls: "clipboard-vault-hit-snippet" });
    const actions = item.createDiv({ cls: "clipboard-vault-actions clipboard-vault-hit-actions" });
    actions.createEl("button", { text: "定位原文" }).addEventListener("click", () => void this.plugin.openEntry(hit));
    if (hit.text) {
      const text = hit.kind === "files" ? "复制路径" : hit.kind === "url" ? "复制链接" : hit.kind === "code" ? "复制代码" : "复制文本";
      actions.createEl("button", { text }).addEventListener("click", () => void this.plugin.copyText(hit.text));
    }
    if (hit.range) {
      actions.createEl("button", { text: "删除条目", cls: "clipboard-vault-remove" })
        .addEventListener("click", () => this.plugin.confirmRemoval(hit, false));
    }
    if (!hit.images.length) return;
    const gallery = item.createDiv({ cls: "clipboard-vault-gallery" });
    const addImage = (relative: string) => {
      const file = this.plugin.entryImage(hit, relative);
      const figure = gallery.createDiv({ cls: "clipboard-vault-thumb" });
      if (!file) { figure.createEl("span", { text: "附件缺失" }); return; }
      const image = figure.createEl("img", { attr: { alt: file.name, loading: "lazy", decoding: "async" } });
      image.addEventListener("error", () => { image.remove(); figure.createEl("span", { text: "无法预览" }); }, { once: true });
      image.src = this.plugin.app.vault.getResourcePath(file);
      figure.createEl("button", { text: "复制图片", attr: { "aria-label": `复制图片 ${file.name}` } })
        .addEventListener("click", () => void this.plugin.copyImage(file));
    };
    for (const image of hit.images.slice(0, 3)) addImage(image);
    if (hit.images.length > 3) {
      const more = actions.createEl("button", { text: `再看 ${hit.images.length - 3} 张` });
      more.addEventListener("click", () => { for (const image of hit.images.slice(3)) addImage(image); more.remove(); });
    }
  }
}

class RemoveEntryModal extends Modal {
  constructor(private plugin: ClipboardVaultPlugin, private hits: SearchHit[], private undo: boolean,
    private onRemoved?: (removed: SearchHit[]) => void) { super(plugin.app); }

  onOpen(): void {
    const batch = this.hits.length > 1;
    const action = this.undo ? "撤销最近捕获" : batch ? "批量删除条目" : "删除条目";
    this.titleEl.setText(action);
    if (batch) {
      this.contentEl.createEl("p", { text: `将删除所选的 ${this.hits.length} 条归档，涉及 ${new Set(this.hits.map(hit => archiveDate(hit.path))).size} 个日期。` });
      const preview = this.contentEl.createEl("ul", { cls: "clipboard-vault-remove-preview clipboard-vault-remove-list" });
      for (const hit of this.hits) preview.createEl("li", { text: `${archiveDate(hit.path)} · ${hit.title}${hit.snippet ? `：${hit.snippet}` : ""}` });
    } else {
      const hit = this.hits[0];
      this.contentEl.createEl("p", { text: `${archiveDate(hit.path)} · ${hit.title}` });
      if (hit.snippet) this.contentEl.createEl("p", { text: hit.snippet, cls: "clipboard-vault-remove-preview" });
    }
    this.contentEl.createEl("p", { text: "移除后，当天剩余条目将从 1 开始连续编号。" });
    let trashImages = false;
    if (this.hits.some(hit => hit.images.length)) {
      new Setting(this.contentEl).setName("同时移除独有的图片附件")
        .setDesc("把所选条目生成且未被其他笔记引用的图片移到回收站，默认保留附件。")
        .addToggle(toggle => toggle.setValue(false).onChange(value => { trashImages = value; }));
    }
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "取消" });
    const confirm = buttons.createEl("button", { text: this.undo ? "确认撤销" : batch ? `确认删除 ${this.hits.length} 条` : "确认删除", cls: "mod-warning" });
    cancel.addEventListener("click", () => this.close());
    confirm.addEventListener("click", async () => {
      confirm.disabled = cancel.disabled = true;
      const removed = await this.plugin.deleteEntries(this.hits, trashImages, this.undo);
      this.onRemoved?.(removed);
      this.close();
    }, { once: true });
    cancel.focus();
  }

  onClose(): void { this.contentEl.empty(); this.plugin.releaseRemoval(this); }
}

const CLEANUP_KINDS: Array<[EntryKind, string]> = [
  ["image", "图片"], ["text", "文本"], ["url", "链接"], ["code", "代码"], ["files", "文件路径"]
];

class CleanupModal extends Modal {
  private mode: "day" | "range" = "range";
  private day = dayKey(new Date());
  private from = recentDate(30);
  private through = recentDate(1);
  private kinds = new Set<EntryKind>(CLEANUP_KINDS.map(([kind]) => kind));
  private hits: SearchHit[] = [];
  private request = 0;
  private ui!: {
    day: HTMLInputElement; from: HTMLInputElement; through: HTMLInputElement;
    summary: HTMLElement; detail: HTMLElement; run: HTMLButtonElement;
  };

  constructor(private plugin: ClipboardVaultPlugin) { super(plugin.app); }

  onOpen(): void {
    this.titleEl.setText("清理归档");
    const { contentEl } = this;
    contentEl.createEl("p", { text: "先预览，确认后才会删除。图片只在没有其他笔记引用时才移到回收站；受影响的笔记会先备份到 .cleanup-backup。" });

    const scopeRow = contentEl.createDiv({ cls: "clipboard-vault-cleanup-row" });
    const mode = scopeRow.createEl("select", { attr: { "aria-label": "清理范围" } });
    mode.createEl("option", { text: "日期范围", value: "range" });
    mode.createEl("option", { text: "指定日期", value: "day" });
    mode.value = this.mode;
    const day = scopeRow.createEl("input", { type: "date", attr: { "aria-label": "清理哪一天" } });
    day.value = this.day;
    const from = scopeRow.createEl("input", { type: "date", attr: { "aria-label": "起始日期" } });
    from.value = this.from;
    const through = scopeRow.createEl("input", { type: "date", attr: { "aria-label": "结束日期" } });
    through.value = this.through;
    day.hidden = this.mode !== "day";
    from.hidden = through.hidden = this.mode !== "range";
    mode.addEventListener("change", () => { this.mode = mode.value === "day" ? "day" : "range"; void this.updatePreview(); });
    day.addEventListener("change", () => { this.day = day.value; void this.updatePreview(); });
    from.addEventListener("change", () => { this.from = from.value; void this.updatePreview(); });
    through.addEventListener("change", () => { this.through = through.value; void this.updatePreview(); });

    const typeRow = contentEl.createDiv({ cls: "clipboard-vault-cleanup-types", attr: { role: "group", "aria-label": "清理类型" } });
    for (const [kind, label] of CLEANUP_KINDS) {
      const item = typeRow.createEl("label", { cls: "clipboard-vault-cleanup-type" });
      const box = item.createEl("input", { type: "checkbox", attr: { "aria-label": `清理${label}` } });
      box.checked = true;
      item.createEl("span", { text: label });
      box.addEventListener("change", () => {
        if (box.checked) this.kinds.add(kind);
        else this.kinds.delete(kind);
        void this.updatePreview();
      });
    }

    const summary = contentEl.createDiv({ cls: "clipboard-vault-cleanup-summary", attr: { "aria-live": "polite" } });
    const detail = contentEl.createDiv({ cls: "clipboard-vault-cleanup-detail" });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const run = buttons.createEl("button", { text: "执行清理", cls: "mod-warning" });
    run.disabled = true;
    run.addEventListener("click", () => void this.execute());
    this.ui = { day, from, through, summary, detail, run };
    void this.updatePreview();
  }

  private range(): { from?: string; through?: string } | null {
    if (this.mode === "day") {
      const day = validDay(this.ui.day.value);
      return day ? { from: day, through: day } : null;
    }
    const from = validDay(this.ui.from.value);
    const through = validDay(this.ui.through.value);
    return from && through && from <= through ? { from, through } : null;
  }

  private async updatePreview(): Promise<void> {
    const ui = this.ui;
    const request = ++this.request;
    ui.day.hidden = this.mode !== "day";
    ui.from.hidden = ui.through.hidden = this.mode !== "range";
    this.hits = [];
    ui.run.disabled = true;
    const range = this.range();
    if (!range) {
      ui.summary.setText(this.mode === "day" ? "请选择日期。" : "请选择有效的起止日期，起始不能晚于结束。");
      ui.detail.empty();
      return;
    }
    if (!this.kinds.size) {
      ui.summary.setText("请至少选择一种类型。");
      ui.detail.empty();
      return;
    }
    ui.summary.setText("正在统计…");
    try {
      const hits = await this.plugin.collectCleanupHits(range, this.kinds);
      const stats = await this.plugin.cleanupStats(hits);
      if (request !== this.request) return;
      if (!hits.length) {
        ui.summary.setText("这段时间没有符合条件的归档。");
        ui.detail.empty();
        return;
      }
      this.hits = hits;
      ui.summary.setText(`将清理 ${stats.entries} 条 · 图片 ${stats.images} 张 · 约 ${formatSize(stats.bytes)}`);
      const groups = new Map<string, number>();
      for (const hit of hits) {
        const date = archiveDate(hit.path);
        groups.set(date, (groups.get(date) ?? 0) + 1);
      }
      const dates = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      ui.detail.empty();
      for (const [date, count] of dates.slice(0, 12)) ui.detail.createDiv({ text: `${date} · ${count} 条` });
      if (dates.length > 12) ui.detail.createDiv({ text: `…另有 ${dates.length - 12} 天` });
      ui.run.disabled = false;
    } catch (error) {
      if (request !== this.request) return;
      console.warn("[Clipboard Vault] cleanup preview", error);
      ui.summary.setText("读取归档失败，请重试。");
      ui.detail.empty();
    }
  }

  private async execute(): Promise<void> {
    const ui = this.ui;
    const hits = this.hits;
    if (!hits.length) return;
    ui.run.disabled = true;
    ui.run.setText("正在清理…");
    try {
      const result = await this.plugin.applyCleanup(hits, true);
      let message = result.removed ? `已清理 ${result.removed} 条，${result.trashed} 张图片移到回收站` : "未删除任何条目";
      if (result.skipped) message += ` · ${result.skipped} 条已更改或无法写入，已跳过`;
      if (result.backup) message += " · 原笔记已备份";
      new Notice(message);
      this.close();
    } catch (error) {
      console.warn("[Clipboard Vault] cleanup", error);
      ui.run.disabled = false;
      ui.run.setText("执行清理");
      new Notice("清理失败，请查看开发者控制台");
    }
  }

  onClose(): void {
    this.request++;
    this.hits = [];
    this.contentEl.empty();
    this.plugin.releaseCleanup(this);
  }
}

export default class ClipboardVaultPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  private timer: number | null = null;
  private resumeTimer: number | null = null;
  private monitorGeneration = 0;
  private fallbackNeedsBaseline = false;
  private settingsWrite: Promise<void> = Promise.resolve();
  private busy = false;
  private lastFingerprint: string | null = null;
  private nextAttempt = 0;
  private lastError = "";
  private statusEl: HTMLElement | null = null;
  private clipboard: DesktopClipboard | null = null;
  private windowsBridge: WindowsClipboardBridge | null = null;
  private nativeWarning = "";
  private pendingNative: WindowsSnapshot | undefined;
  private openingPanel: Promise<void> | null = null;
  private removalModal: RemoveEntryModal | null = null;
  private cleanupModal: CleanupModal | null = null;
  private cleanupTimer: number | null = null;
  private cleanupKick: number | null = null;
  private cleanupBusy = false;

  get isMonitoring(): boolean { return this.timer !== null; }
  get isTimedPaused(): boolean { return this.settings.enabled && this.settings.pauseUntil > 0; }

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = { ...DEFAULTS, ...saved };
    this.settings.root = validRoot(this.settings.root) ?? DEFAULTS.root;
    if (!["day", "month", "year", "root"].includes(this.settings.archiveLevel)) this.settings.archiveLevel = "day";
    if (!["attachment", "path"].includes(this.settings.imageFileMode)) this.settings.imageFileMode = "attachment";
    this.settings.intervalMs = Math.max(500, Math.min(10000, Number(this.settings.intervalMs) || 1000));
    this.settings.maxTextLength = Math.max(1000, Math.min(500000, Number(this.settings.maxTextLength) || 50000));
    if (!CLEANUP_INTERVALS.includes(this.settings.cleanupEveryDays as typeof CLEANUP_INTERVALS[number])) this.settings.cleanupEveryDays = 7;
    this.settings.cleanupOlderThanDays = Math.max(1, Math.min(3650, Number(this.settings.cleanupOlderThanDays) || 30));
    if (!["image", "text", "all"].includes(this.settings.cleanupScope)) this.settings.cleanupScope = "image";
    if (!Number.isFinite(this.settings.cleanupLastRun) || this.settings.cleanupLastRun < 0) this.settings.cleanupLastRun = 0;
    if (!this.settings.enabled || !Number.isFinite(this.settings.pauseUntil) || this.settings.pauseUntil <= 0) this.settings.pauseUntil = 0;
    this.clipboard = desktopClipboard();
    this.registerView(VIEW_TYPE, leaf => new ClipboardView(leaf, this));
    this.app.workspace.onLayoutReady(() => this.keepSinglePanel());
    this.addRibbonIcon("clipboard", "打开剪切板归档", () => void this.openPanel());
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("clipboard-vault-status-button");
    this.statusEl.setAttribute("role", "button");
    this.statusEl.tabIndex = 0;
    this.registerDomEvent(this.statusEl, "click", () => { if (this.statusEl) this.openMonitorMenu(this.statusEl); });
    this.registerDomEvent(this.statusEl, "keydown", event => {
      if ((event.key === "Enter" || event.key === " ") && this.statusEl) { event.preventDefault(); this.openMonitorMenu(this.statusEl); }
    });
    this.addCommand({ id: "toggle-monitoring", name: "暂停或恢复剪切板监控", callback: () => void this.setMonitoring(!this.isMonitoring) });
    this.addCommand({ id: "capture-now", name: "立即捕获剪切板", callback: () => void this.captureNow() });
    this.addCommand({ id: "open-archive", name: "打开今日剪切板归档", callback: () => void this.openToday() });
    this.addCommand({ id: "undo-capture", name: "撤销最近一次剪切板捕获", callback: () => void this.undoLatest() });
    this.addCommand({ id: "cleanup-archive", name: "清理归档（按日期和类型）", callback: () => this.openCleanupModal() });
    this.addSettingTab(new ClipboardSettingsTab(this.app, this));
    this.scheduleCleanup();
    this.updateStatus();
    if (this.isTimedPaused && this.settings.pauseUntil > Date.now()) this.scheduleResume();
    else if (this.settings.enabled) await this.startMonitoring(false);
  }

  onunload(): void {
    this.stopMonitor();
    this.clearResumeTimer();
    this.clearCleanupTimer();
    this.removalModal?.close();
    this.cleanupModal?.close();
  }

  private clearTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  saveSettings(): Promise<void> {
    const snapshot = { ...this.settings };
    const next = this.settingsWrite.catch(() => {}).then(() => this.saveData(snapshot));
    this.settingsWrite = next;
    return next;
  }

  private async saveMonitoringSettings(): Promise<void> {
    try { await this.saveSettings(); }
    catch (error) { console.warn("[Clipboard Vault] save monitoring settings", error); new Notice("监控设置未写入，重启后可能失效"); }
  }

  private stopMonitor(): void {
    this.monitorGeneration++;
    this.clearTimer();
    this.windowsBridge?.stop();
    this.windowsBridge = null;
    this.pendingNative = undefined;
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer !== null) window.clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  private scheduleResume(): void {
    this.clearResumeTimer();
    if (!this.isTimedPaused) return;
    const deadline = this.settings.pauseUntil;
    this.resumeTimer = window.setTimeout(() => {
      if (!this.isTimedPaused || this.settings.pauseUntil !== deadline) return;
      if (deadline > Date.now()) { this.scheduleResume(); return; }
      void this.startMonitoring(false);
    }, Math.min(2147483647, Math.max(0, deadline - Date.now())));
  }

  async pauseFor(minutes: PauseMinutes): Promise<void> {
    if (!this.settings.enabled) return;
    this.stopMonitor();
    this.settings.pauseUntil = Date.now() + minutes * 60000;
    this.scheduleResume();
    this.updateStatus();
    new Notice(`剪切板监控已暂停 ${minutes} 分钟`);
    await this.saveMonitoringSettings();
    await this.refreshPanel();
  }

  openMonitorMenu(anchor: HTMLElement): void {
    const menu = new Menu();
    if (!this.isMonitoring) {
      menu.addItem(item => item.setTitle(this.isTimedPaused ? "立即恢复监控" : "开始监控").setIcon("play")
        .onClick(() => void this.setMonitoring(true)));
    }
    if (this.isMonitoring || this.isTimedPaused) {
      for (const minutes of PAUSE_MINUTES) {
        menu.addItem(item => item.setTitle(`暂停 ${minutes} 分钟`).setIcon("timer").onClick(() => void this.pauseFor(minutes)));
      }
      menu.addSeparator();
      menu.addItem(item => item.setTitle("暂停，直到手动恢复").setIcon("pause").onClick(() => void this.setMonitoring(false)));
    }
    const bounds = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, anchor.ownerDocument);
  }

  async setMonitoring(enabled: boolean): Promise<void> {
    if (enabled) await this.startMonitoring(true);
    else {
      this.stopMonitor();
      this.clearResumeTimer();
      this.settings.enabled = false;
      this.settings.pauseUntil = 0;
      this.updateStatus();
      new Notice("剪切板监控已暂停");
      await this.saveMonitoringSettings();
      await this.refreshPanel();
    }
  }

  private async startMonitoring(notify: boolean): Promise<void> {
    this.stopMonitor();
    this.clearResumeTimer();
    this.settings.enabled = true;
    this.settings.pauseUntil = 0;
    this.nextAttempt = 0;
    this.lastError = "";
    this.nativeWarning = "";
    this.lastFingerprint = null;
    this.fallbackNeedsBaseline = true;
    this.timer = window.setInterval(() => void this.tick(), this.settings.intervalMs);
    this.startWindowsBridge();
    if (!this.windowsBridge) void this.tick();
    this.updateStatus();
    if (notify) new Notice("剪切板监控已开启");
    await this.saveMonitoringSettings();
    await this.refreshPanel();
  }

  restartTimer(): void {
    if (!this.isMonitoring) return;
    void this.startMonitoring(false);
  }

  statusText(): string {
    if (this.isTimedPaused) {
      const deadline = new Date(this.settings.pauseUntil);
      return `监控已暂停 · ${pad(deadline.getHours())}:${pad(deadline.getMinutes())} 自动恢复`;
    }
    if (!this.isMonitoring) return "监控已暂停";
    if (this.lastError) return `监控异常：${this.lastError}`;
    if (this.windowsBridge?.isReady) return `Windows 原生监控中 · 每 ${this.settings.intervalMs / 1000} 秒检查一次`;
    if (this.windowsBridge) return "正在启动 Windows 剪切板监控…";
    if (this.nativeWarning) return `监控中（原生读取不可用，已使用备用接口）`;
    return `监控中 · 每 ${this.settings.intervalMs / 1000} 秒检查一次`;
  }

  private updateStatus(): void {
    if (this.statusEl) {
      this.statusEl.setText(this.statusText());
      this.statusEl.setAttribute("aria-label", `${this.statusText()}，打开监控选项`);
    }
  }

  private makeWindowsBridge(): WindowsClipboardBridge | null {
    if (typeof process === "undefined" || process.platform !== "win32") return null;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const script = adapter.getFullPath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/clipboard-helper.ps1`);
    const bridge = new WindowsClipboardBridge(
      script,
      this.settings.intervalMs,
      snapshot => {
        if (this.windowsBridge !== bridge) return;
        if (this.busy || Date.now() < this.nextAttempt) this.pendingNative = snapshot;
        else void this.poll(false, snapshot);
      },
      error => {
        if (this.windowsBridge !== bridge) return;
        this.windowsBridge = null;
        bridge.stop();
        this.pendingNative = undefined;
        this.fallbackNeedsBaseline = true;
        this.nextAttempt = 0;
        this.nativeWarning = error.message;
        console.warn("[Clipboard Vault] Windows clipboard helper", error);
        this.updateStatus();
        void this.refreshPanel();
      },
      () => {
        if (this.windowsBridge !== bridge) return;
        this.lastError = "";
        this.nativeWarning = "";
        this.nextAttempt = 0;
        this.updateStatus();
        void this.refreshPanel();
      }
    );
    return bridge.isSupported ? bridge : null;
  }

  private startWindowsBridge(): void {
    this.windowsBridge = this.makeWindowsBridge();
    this.windowsBridge?.start();
  }

  private async tick(): Promise<void> {
    if (this.pendingNative !== undefined && Date.now() >= this.nextAttempt) {
      const snapshot = this.pendingNative;
      this.pendingNative = undefined;
      await this.poll(false, snapshot);
    } else if (!this.windowsBridge) {
      await this.poll(false);
    }
  }

  private reportError(error: unknown, phase: "读取" | "保存"): void {
    const message = error instanceof Error ? error.message : String(error);
    const detail = `${phase}失败：${message}`;
    const changed = this.lastError !== detail;
    this.lastError = detail;
    this.nextAttempt = Date.now() + 30000;
    this.updateStatus();
    if (changed) new Notice(phase === "读取" ? "剪切板读取受限。请在 Obsidian 前台重试，或检查当前版本的剪切板权限。" : "剪切板内容保存失败，请检查归档目录和磁盘空间。", 8000);
    console.warn(`[Clipboard Vault] ${phase}`, error);
  }

  private async fingerprint(snapshot: Snapshot): Promise<string> {
    if (snapshot.kind === "image") return digest("image", snapshot.bytes);
    if (snapshot.kind === "files") return digest("files", new TextEncoder().encode(`${this.settings.imageFileMode}\u0000${snapshot.paths.join("\u0000")}`));
    return digest(detectKind(snapshot.text), new TextEncoder().encode(snapshot.text));
  }

  async captureNow(): Promise<void> {
    const bridge = this.windowsBridge ?? this.makeWindowsBridge();
    if (bridge) {
      try { await this.poll(true, await bridge.readOnce()); return; }
      catch (error) { console.warn("[Clipboard Vault] manual native capture", error); }
    }
    await this.poll(true);
  }

  private async poll(force: boolean, override?: WindowsSnapshot): Promise<void> {
    if (this.busy || (!this.isMonitoring && !force) || (!force && Date.now() < this.nextAttempt)) return;
    if (!force && override === undefined && this.windowsBridge?.isReady) return;
    this.busy = true;
    const generation = this.monitorGeneration;
    let phase: "读取" | "保存" = "读取";
    try {
      const snapshot = override === undefined ? await this.readSnapshot(!force) : override;
      const hash = snapshot ? await this.fingerprint(snapshot) : null;
      if (!force && (generation !== this.monitorGeneration || !this.isMonitoring)) return;
      if (!force && override === undefined && this.fallbackNeedsBaseline) {
        this.fallbackNeedsBaseline = false;
        this.lastFingerprint = hash;
        return;
      }
      if (!snapshot || hash === null) { this.lastFingerprint = null; return; }
      if (!force && hash === this.lastFingerprint) return;
      phase = "保存";
      const outcome = await this.store(snapshot, hash);
      if (generation === this.monitorGeneration) this.lastFingerprint = hash;
      if (force) new Notice(outcome);
      if (outcome === "已保存") await this.refreshPanel();
      if (this.lastError) { this.lastError = ""; this.updateStatus(); }
    } catch (error) {
      if (!force && (generation !== this.monitorGeneration || !this.isMonitoring)) return;
      if (!force && phase === "保存" && override !== undefined) this.pendingNative = override;
      this.reportError(error, phase);
    } finally {
      this.busy = false;
      if (this.pendingNative !== undefined && Date.now() >= this.nextAttempt && this.isMonitoring) {
        const next = this.pendingNative;
        this.pendingNative = undefined;
        void this.poll(false, next);
      }
    }
  }

  private async readSnapshot(ignoreArchiveCopy = false): Promise<Snapshot | null> {
    const source = this.clipboard;
    if (source) {
      try { if (ignoreArchiveCopy && source.has?.(ARCHIVE_COPY_FORMAT)) return null; }
      catch { /* Older desktop API; continue reading the standard formats. */ }
      if (this.settings.captureImages && source.readImage) {
        try {
          const image = source.readImage();
          if (image && !image.isEmpty()) return { kind: "image", bytes: new Uint8Array(image.toPNG()) };
        } catch { /* Try the modern or browser API. */ }
      }
      if (source.read) {
        try {
          const items = await source.read();
          if (Array.isArray(items)) {
            const found = await readItems(items, this.settings.captureImages, this.settings.captureText);
            if (found) return found;
          }
        } catch { /* Older Electron uses readText/readImage. */ }
      }
      if (this.settings.captureText && source.readText) {
        try {
          const text = await source.readText();
          if (text.trim()) return { kind: "text", text };
          return null;
        } catch { /* Try browser API. */ }
      }
    }
    if (!navigator.clipboard) throw new Error("当前环境不提供剪切板读取接口");
    if (this.settings.captureImages && navigator.clipboard.read) {
      try {
        const result = await readItems(await navigator.clipboard.read(), true, this.settings.captureText);
        if (result) return result;
      } catch { /* Browser may deny image access; try text. */ }
    }
    if (this.settings.captureText) {
      const text = await navigator.clipboard.readText();
      if (text.trim()) return { kind: "text", text };
    }
    return null;
  }

  dayFolder(date = new Date()): string { return archivePath(this.settings.root, date, this.settings.archiveLevel); }
  private dayFile(date = new Date()): string { return `${this.dayFolder(date)}/${dayKey(date)}.md`; }

  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`归档路径被文件占用：${current}`);
      try { await this.app.vault.createFolder(current); }
      catch (error) { if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error; }
    }
  }

  private async createAttachment(bytes: Uint8Array, folder: string, stem: string, extension: string): Promise<string> {
    await this.ensureFolder(folder);
    let target = "";
    for (let index = 0; index < 100; index++) {
      target = `${folder}/${stem}${index ? `-${index}` : ""}${extension}`;
      if (!this.app.vault.getAbstractFileByPath(target)) break;
    }
    if (this.app.vault.getAbstractFileByPath(target)) throw new Error("附件文件名冲突过多");
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.app.vault.createBinary(target, buffer);
    return `attachments/${target.split("/").at(-1)}`;
  }

  // Same image bytes always produce the same file name, so one copy serves every entry of the day.
  private async reuseOrCreateAttachment(bytes: Uint8Array, folder: string, contentHash: string,
    extension: string, now: Date): Promise<string> {
    await this.ensureFolder(folder);
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) {
      const match = existing.children.find((child): child is TFile =>
        child instanceof TFile && ownedAttachmentName(child.name, contentHash));
      if (match) return `attachments/${match.name}`;
    }
    const stem = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${contentHash.slice(0, 12)}`;
    return this.createAttachment(bytes, folder, stem, extension);
  }

  private async store(snapshot: Snapshot, hash: string): Promise<string> {
    const now = new Date();
    const kind: EntryKind = snapshot.kind === "image" ? "image" : snapshot.kind === "files" ? "files" : detectKind(snapshot.text);
    if (snapshot.kind === "text") {
      if (matchesKeyword(snapshot.text, this.settings.ignoreKeywords)) return "已跳过忽略关键词";
      if (this.settings.filterSensitive && isSensitive(snapshot.text, "")) return "已跳过疑似敏感文本";
      if (!this.settings.captureText) return "文本捕获已关闭";
    } else if (snapshot.kind === "files") {
      if (!this.settings.captureFiles) return "文件路径捕获已关闭";
      if (!snapshot.paths.length) return "没有可保存的文件路径";
      if (matchesKeyword(snapshot.paths.join("\n"), this.settings.ignoreKeywords)) return "已跳过忽略关键词";
    } else {
      if (!this.settings.captureImages) return "图片捕获已关闭";
      if (snapshot.bytes.length > MAX_IMAGE_BYTES) return "图片超过 20 MB，已跳过";
    }
    const path = this.dayFile(now);
    await this.ensureFolder(this.dayFolder(now));
    let file = this.app.vault.getAbstractFileByPath(path);
    if (file && !(file instanceof TFile)) throw new Error(`归档路径被文件夹占用：${path}`);
    // Image files are deduplicated by content, so their check runs after the bytes are read.
    if (snapshot.kind !== "files" && this.settings.dedupeDay && file instanceof TFile &&
      hasMarker(await this.app.vault.read(file), kind, hash)) return "今日已保存相同内容";

    let entryHash = hash;
    let render: (sequence: number) => string;
    if (snapshot.kind === "image") {
      const content = await this.reuseOrCreateAttachment(snapshot.bytes, `${this.dayFolder(now)}/attachments`,
        await digest("image", snapshot.bytes), ".png", now);
      render = sequence => renderEntry("image", content, hash, now, sequence);
    } else if (snapshot.kind === "files") {
      const paths: string[] = [];
      const attachments: string[] = [];
      const contents: string[] = [];
      const reader = this.settings.imageFileMode === "attachment" && this.settings.captureImages ? fileReader() : null;
      let totalBytes = 0;
      let failed = 0;
      for (const sourcePath of snapshot.paths) {
        if (this.settings.imageFileMode !== "attachment" || !this.settings.captureImages || !isImageFilePath(sourcePath)) {
          paths.push(sourcePath);
          continue;
        }
        if (!reader) { paths.push(sourcePath); failed++; continue; }
        try {
          const info = await reader.stat(sourcePath);
          if (!info.isFile() || info.size > MAX_IMAGE_FILE_BYTES || totalBytes + info.size > MAX_IMAGE_BATCH_BYTES) {
            throw new Error("图片文件超过导入上限或不是普通文件");
          }
          const bytes = await reader.readFile(sourcePath);
          if (bytes.length > MAX_IMAGE_FILE_BYTES || totalBytes + bytes.length > MAX_IMAGE_BATCH_BYTES) throw new Error("图片文件超过导入上限");
          const extension = sourcePath.match(/\.[^.\\/]+$/)?.[0].toLowerCase() ?? ".png";
          const contentHash = await digest("image", bytes);
          const relative = await this.reuseOrCreateAttachment(bytes, `${this.dayFolder(now)}/attachments`, contentHash, extension, now);
          attachments.push(relative);
          contents.push(contentHash);
          totalBytes += bytes.length;
        } catch (error) {
          console.warn("[Clipboard Vault] 图片文件导入失败", error);
          paths.push(sourcePath);
          failed++;
        }
      }
      if (failed) new Notice(`${failed} 张图片未能导入附件，已保存原路径`);
      // The same picture renamed or copied from another folder hashes the same, so it is not stored twice.
      entryHash = await digest("files", new TextEncoder().encode(
        [this.settings.imageFileMode, ...[...contents].sort(), ...[...paths].sort()].join("\u0000")));
      if (this.settings.dedupeDay && file instanceof TFile &&
        hasMarker(await this.app.vault.read(file), "files", entryHash)) return "今日已保存相同内容";
      render = sequence => renderFileEntry(paths, attachments, entryHash, now, sequence);
    } else {
      const content = snapshot.text.slice(0, this.settings.maxTextLength);
      render = sequence => renderEntry(kind, content, hash, now, sequence, snapshot.text.length > this.settings.maxTextLength);
    }
    const header = `# 剪切板归档 · ${dayKey(now)}\n\n`;
    if (file instanceof TFile) {
      await this.app.vault.process(file, current => {
        if (this.settings.dedupeDay && hasMarker(current, kind, entryHash)) return current;
        return `${current.trimEnd()}\n\n${render(nextSequence(current))}`;
      });
    } else {
      try { await this.app.vault.create(path, header + render(1)); }
      catch (error) {
        file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw error;
        await this.app.vault.process(file, current => `${current.trimEnd()}\n\n${render(nextSequence(current))}`);
      }
    }
    return "已保存";
  }

  async todayEntries(): Promise<SearchHit[]> {
    const path = this.dayFile();
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? searchEntries(path, await this.app.vault.cachedRead(file), "", 10000) : [];
  }

  private archiveFiles(filter: ArchiveFilter): TFile[] {
    const prefix = `${this.settings.root}/`;
    return this.app.vault.getMarkdownFiles().filter(file => {
      if (!file.path.startsWith(prefix)) return false;
      // Hidden folders such as .cleanup-backup are never part of the archive.
      if (file.path.slice(prefix.length).split("/").some(part => part.startsWith("."))) return false;
      const date = archiveDate(file.path);
      return date && (!filter.from || date >= filter.from) && (!filter.through || date <= filter.through);
    }).sort((a, b) => archiveDate(b.path).localeCompare(archiveDate(a.path)) || b.path.localeCompare(a.path));
  }

  async todayCount(): Promise<number> {
    const date = dayKey(new Date());
    const counts = await Promise.all(this.archiveFiles({ from: date, through: date }).map(async file =>
      archiveEntries(file.path, await this.app.vault.cachedRead(file)).length));
    return counts.reduce((total, value) => total + value, 0);
  }

  async search(query: string, filter: ArchiveFilter = {}, limit = 100, skip = 0): Promise<SearchHit[]> {
    const found: SearchHit[] = [];
    let remainingSkip = skip;
    for (const file of this.archiveFiles(filter)) {
      const hits = searchEntries(file.path, await this.app.vault.cachedRead(file), query, remainingSkip + limit - found.length, filter.kind, true);
      found.push(...hits.slice(remainingSkip));
      remainingSkip = Math.max(0, remainingSkip - hits.length);
      if (found.length >= limit) break;
    }
    return found;
  }

  async latestEntry(): Promise<SearchHit | undefined> {
    let latest: SearchHit | undefined;
    let time = "";
    for (const file of this.archiveFiles({})) {
      if (latest && archiveDate(file.path) !== archiveDate(latest.path)) break;
      const entries = archiveEntries(file.path, await this.app.vault.cachedRead(file));
      // Within one file the order of capture is the order of appending, even if the clock moved back.
      const hit = entries.at(-1);
      if (!hit) continue;
      const clock = /^(?:\d+\.\s+)?(\d{2}:\d{2}:\d{2})(?=\s|$)/.exec(hit.title)?.[1] ?? "";
      if (!latest || clock > time) { latest = hit; time = clock; }
    }
    return latest;
  }

  async undoLatest(): Promise<void> {
    try {
      const hit = await this.latestEntry();
      if (!hit) { new Notice("还没有可撤销的捕获"); return; }
      this.confirmRemoval(hit, true);
    } catch (error) {
      console.warn("[Clipboard Vault] find latest archive entry", error);
      new Notice("暂时无法读取最近的捕获");
    }
  }

  confirmRemoval(hit: SearchHit, undo: boolean): void {
    if (!hit.range) { new Notice("此条目的格式已修改，请到原笔记中手动删除"); return; }
    this.removalModal?.close();
    this.removalModal = new RemoveEntryModal(this, [hit], undo);
    this.removalModal.open();
  }

  confirmBatchRemoval(hits: SearchHit[], onRemoved: (removed: SearchHit[]) => void): void {
    if (!hits.length) return;
    this.removalModal?.close();
    this.removalModal = new RemoveEntryModal(this, hits, false, onRemoved);
    this.removalModal.open();
  }

  releaseRemoval(modal: RemoveEntryModal): void {
    if (this.removalModal === modal) this.removalModal = null;
  }

  async deleteEntry(hit: SearchHit, trashImages: boolean, undo: boolean): Promise<void> {
    await this.deleteEntries([hit], trashImages, undo);
  }

  async deleteEntries(hits: SearchHit[], trashImages: boolean, undo = false): Promise<SearchHit[]> {
    const selected = [...new Map(hits.map(hit => [entrySelectionKey(hit), hit])).values()];
    if (!selected.length) return [];
    const { removed, trashed } = await this.removeEntries(selected, trashImages);
    const images = new Set(removed.flatMap(hit => hit.images.map(image => `${hit.path.slice(0, hit.path.lastIndexOf("/"))}/${image}`)));
    const skipped = selected.length - removed.length;
    let message = removed.length ? (undo ? "已撤销本次捕获" : selected.length === 1 ? "已删除条目" : `已删除 ${removed.length} 条归档`) : "未删除任何条目";
    if (skipped) message += ` · ${skipped} 条已更改、移走或无法写入，请刷新后重试`;
    if (trashImages && images.size) {
      const kept = images.size - trashed;
      const suffix = [trashed ? `${trashed} 张图片已移到回收站` : "", kept ? `${kept} 张图片未移动` : ""].filter(Boolean).join("，");
      message += ` · ${suffix}`;
    }
    new Notice(message);
    await this.refreshPanel(new Set(removed.map(hit => hit.path))).catch(error => console.warn("[Clipboard Vault] refresh after removal", error));
    return removed;
  }

  private async removeEntries(hits: SearchHit[], trashImages: boolean): Promise<{ removed: SearchHit[]; trashed: number }> {
    const selected = [...new Map(hits.map(hit => [entrySelectionKey(hit), hit])).values()];
    if (!selected.length) return { removed: [], trashed: 0 };
    const groups = new Map<string, SearchHit[]>();
    for (const hit of selected) {
      const group = groups.get(hit.path) ?? [];
      group.push(hit);
      groups.set(hit.path, group);
    }
    const removed: SearchHit[] = [];
    for (const [path, entries] of groups) {
      try {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || !path.startsWith(`${this.settings.root}/`) || !archiveDate(path)) continue;
        let deleted: SearchHit[] = [];
        await this.app.vault.process(file, markdown => {
          const change = removeArchiveEntries(file.path, markdown, entries);
          deleted = change.entries;
          return change.markdown;
        });
        removed.push(...deleted);
      } catch (error) {
        console.warn("[Clipboard Vault] remove archive entries", path, error);
      }
    }
    // Finish all note edits first so references between selected entries are checked after deletion.
    let trashed = 0;
    if (trashImages) {
      for (const hit of removed) {
        if (!hit.images.length) continue;
        trashed += await this.trashUnusedImages(hit).catch(error => {
          console.warn("[Clipboard Vault] check attachment references", error);
          return 0;
        });
      }
    }
    return { removed, trashed };
  }

  private async trashUnusedImages(hit: SearchHit): Promise<number> {
    const candidates = new Map<string, TFile>();
    for (const relative of new Set(hit.images)) {
      const file = this.entryImage(hit, relative);
      if (file && ownedAttachmentName(file.name)) candidates.set(file.path, file);
    }
    if (!candidates.size) return 0;
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const [path] of candidates) {
      if (Object.entries(resolved).some(([source, links]) => source !== hit.path && links[path])) candidates.delete(path);
    }
    // The metadata cache can lag a recent edit. Check current note/canvas text before moving anything.
    for (const note of this.app.vault.getFiles()) {
      if (!candidates.size) return 0;
      if (!["md", "canvas", "base"].includes(note.extension.toLowerCase())) continue;
      // Hidden files (e.g. .cleanup-backup copies) are not real references.
      if (note.path.split("/").some(part => part.startsWith("."))) continue;
      const text = (await (note.path === hit.path ? this.app.vault.read(note) : this.app.vault.cachedRead(note))).toLowerCase();
      const decoded = text.includes("%") ? text.replace(/%([0-9a-f]{2})/g, (_, code: string) => String.fromCharCode(parseInt(code, 16))).toLowerCase() : text;
      for (const [path, file] of candidates) {
        if (decoded.includes(file.basename.toLowerCase())) candidates.delete(path);
      }
    }
    let count = 0;
    for (const [path, file] of candidates) {
      if (this.app.vault.getAbstractFileByPath(path) !== file) continue;
      try { await this.app.vault.trash(file, true); count++; }
      catch (error) { console.warn("[Clipboard Vault] trash attachment", error); }
    }
    return count;
  }

  openCleanupModal(): void {
    this.cleanupModal?.close();
    this.cleanupModal = new CleanupModal(this);
    this.cleanupModal.open();
  }

  releaseCleanup(modal: CleanupModal): void {
    if (this.cleanupModal === modal) this.cleanupModal = null;
  }

  clearCleanupTimer(): void {
    if (this.cleanupTimer !== null) window.clearInterval(this.cleanupTimer);
    if (this.cleanupKick !== null) window.clearTimeout(this.cleanupKick);
    this.cleanupTimer = null;
    this.cleanupKick = null;
  }

  scheduleCleanup(): void {
    this.clearCleanupTimer();
    if (!this.settings.cleanupAuto) return;
    this.cleanupTimer = window.setInterval(() => void this.runAutoCleanup(), CLEANUP_CHECK_MS);
    this.cleanupKick = window.setTimeout(() => void this.runAutoCleanup(), 60000);
  }

  private async runAutoCleanup(): Promise<void> {
    if (!this.settings.cleanupAuto || this.cleanupBusy) return;
    if (this.settings.cleanupLastRun && Date.now() - this.settings.cleanupLastRun < this.settings.cleanupEveryDays * 86400000) return;
    this.cleanupBusy = true;
    try {
      const hits = await this.collectCleanupHits({ through: recentDate(this.settings.cleanupOlderThanDays, new Date()) },
        new Set(cleanupScopeKinds(this.settings.cleanupScope)));
      this.settings.cleanupLastRun = Date.now();
      await this.saveSettings();
      if (!hits.length) return;
      const result = await this.applyCleanup(hits, true);
      new Notice(`自动清理：删除 ${result.removed} 条，${result.trashed} 张图片移到回收站`);
    } catch (error) {
      console.warn("[Clipboard Vault] auto cleanup", error);
    } finally {
      this.cleanupBusy = false;
    }
  }

  async collectCleanupHits(range: { from?: string; through?: string }, kinds: ReadonlySet<EntryKind>): Promise<SearchHit[]> {
    if (!kinds.size) return [];
    const hits: SearchHit[] = [];
    for (const file of this.archiveFiles(range)) {
      const entries = archiveEntries(file.path, await this.app.vault.cachedRead(file));
      for (const entry of entries) if (entry.range && kinds.has(entry.kind)) hits.push(entry);
    }
    return hits;
  }

  async cleanupStats(hits: SearchHit[]): Promise<{ entries: number; images: number; bytes: number }> {
    const paths = new Set<string>();
    for (const hit of hits) {
      const parent = hit.path.slice(0, hit.path.lastIndexOf("/"));
      for (const image of hit.images) paths.add(`${parent}/${image}`);
    }
    let bytes = 0;
    for (const path of paths) {
      try {
        const info = await this.app.vault.adapter.stat(path);
        if (info) bytes += info.size;
      } catch { /* Missing or unreadable attachment. */ }
    }
    return { entries: hits.length, images: paths.size, bytes };
  }

  async applyCleanup(hits: SearchHit[], backup: boolean): Promise<{ removed: number; trashed: number; skipped: number; backup?: string }> {
    const selected = [...new Map(hits.map(hit => [entrySelectionKey(hit), hit])).values()];
    if (!selected.length) return { removed: 0, trashed: 0, skipped: 0 };
    const folder = backup ? await this.backupNotes(new Set(selected.map(hit => hit.path))) : undefined;
    const { removed, trashed } = await this.removeEntries(selected, true);
    await this.refreshPanel(new Set(removed.map(hit => hit.path))).catch(error => console.warn("[Clipboard Vault] refresh after cleanup", error));
    return { removed: removed.length, trashed, skipped: selected.length - removed.length, backup: folder };
  }

  private async backupNotes(paths: ReadonlySet<string>): Promise<string | undefined> {
    const now = new Date();
    const folder = `${this.settings.root}/.cleanup-backup/${dayKey(now)}-${timeKey(now).replace(/:/g, "")}`;
    let written = 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const relative = path.startsWith(`${this.settings.root}/`) ? path.slice(this.settings.root.length + 1) : file.name;
      const target = `${folder}/${relative}`;
      try {
        await this.ensureFolder(target.slice(0, target.lastIndexOf("/")));
        await this.app.vault.create(target, await this.app.vault.read(file));
        written++;
      } catch (error) {
        console.warn("[Clipboard Vault] cleanup backup", path, error);
        throw new Error(`清理前备份失败，已停止清理：${path}`);
      }
    }
    if (written) await this.pruneBackups().catch(() => {});
    return written ? folder : undefined;
  }

  private async pruneBackups(): Promise<void> {
    const parent = this.app.vault.getAbstractFileByPath(`${this.settings.root}/.cleanup-backup`);
    if (!(parent instanceof TFolder)) return;
    const folders = parent.children
      .filter((child): child is TFolder => child instanceof TFolder && /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(child.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const folder of folders.slice(CLEANUP_BACKUP_KEEP)) {
      try { await this.app.vault.delete(folder, true); }
      catch (error) { console.warn("[Clipboard Vault] prune cleanup backup", folder.path, error); }
    }
  }

  async openEntry(hit: SearchHit): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(hit.path);
      if (!(file instanceof TFile)) { new Notice("原归档笔记已移走或删除"); return; }
      const matches = archiveEntries(file.path, await this.app.vault.cachedRead(file))
        .filter(entry => entry.kind === hit.kind && entry.hash === hit.hash);
      const current = matches.find(entry => entry.title === hit.title && entry.line === hit.line) ??
        matches.find(entry => entry.title === hit.title) ?? (matches.length === 1 ? matches[0] : undefined);
      if (!current) { new Notice("找不到原条目，请刷新归档后重试"); return; }
      await this.app.workspace.getLeaf(true).openFile(file, { active: true, eState: { line: current.line } });
    } catch (error) {
      console.warn("[Clipboard Vault] open archive entry", error);
      new Notice("无法定位到原条目");
    }
  }

  entryImage(hit: SearchHit, relative: string): TFile | null {
    if (!hit.images.includes(relative)) return null;
    const parent = hit.path.slice(0, hit.path.lastIndexOf("/"));
    const file = this.app.vault.getAbstractFileByPath(`${parent}/${relative}`);
    return file instanceof TFile ? file : null;
  }

  private async writeArchiveCopy(copy: { text: string } | { png: Uint8Array }): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("当前 Vault 不支持 Windows 剪切板");
    const script = adapter.getFullPath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/clipboard-helper.ps1`);
    await writeWindowsClipboard(script, copy);
  }

  async copyText(text: string): Promise<void> {
    try { await this.writeArchiveCopy({ text }); new Notice("已复制到剪切板"); }
    catch (error) { console.warn("[Clipboard Vault] copy text", error); new Notice("复制失败，请检查 Windows 剪切板服务"); }
  }

  async copyImage(file: TFile): Promise<void> {
    try {
      const types: Record<string, string> = { jpg: "jpeg", svg: "svg+xml" };
      const ext = file.extension.toLowerCase();
      const blob = new Blob([await this.app.vault.readBinary(file)], { type: `image/${types[ext] ?? ext}` });
      const png = await blobToPng(blob);
      if (png.length > MAX_IMAGE_FILE_BYTES) { new Notice("图片转换后超过 50 MB，请从归档打开原图"); return; }
      await this.writeArchiveCopy({ png });
      new Notice("已复制图片");
    } catch (error) {
      console.warn("[Clipboard Vault] copy image", error);
      new Notice("复制图片失败，可从归档打开原图");
    }
  }

  async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
  }

  async openToday(): Promise<void> {
    const path = this.dayFile();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.openFile(path);
    else new Notice("今天还没有剪切板归档");
  }

  async openPanel(): Promise<void> {
    if (this.openingPanel) return this.openingPanel;
    this.openingPanel = (async () => {
      const existing = this.keepSinglePanel();
      if (existing) { await this.app.workspace.revealLeaf(existing); return; }
      const leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(leaf);
    })();
    try { await this.openingPanel; }
    finally { this.openingPanel = null; }
  }

  private keepSinglePanel(): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const keep = leaves.find(leaf => leaf === this.app.workspace.activeLeaf) ?? leaves[0] ?? null;
    for (const leaf of leaves) if (leaf !== keep) leaf.detach();
    return keep;
  }

  private async refreshPanel(changedPaths?: ReadonlySet<string>): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof ClipboardView) await leaf.view.refresh(changedPaths);
    }
  }
}

class ClipboardSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: ClipboardVaultPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "剪切板归档" });
    containerEl.createEl("p", { text: "仅在 Windows 桌面版 Obsidian 运行时监控。Android 通过同步的笔记查看归档；图片中的敏感信息无法自动识别。" });
    new Setting(containerEl).setName("启用自动监控").addToggle(toggle => toggle.setValue(this.plugin.settings.enabled)
      .onChange(value => void this.plugin.setMonitoring(value)));
    new Setting(containerEl).setName("保存根目录").setDesc("相对于当前 Vault，例如“剪切板”或“资料/剪切板”。")
      .addText(text => text.setValue(this.plugin.settings.root).onChange(async value => {
        const path = validRoot(value);
        if (!path) { new Notice("请输入有效的仓库相对目录，不允许 .. 或特殊字符"); return; }
        this.plugin.settings.root = path;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("日期文件夹层级").setDesc("每天仍有一个汇总笔记；此设置决定笔记所在的文件夹。")
      .addDropdown(dropdown => dropdown
        .addOption("day", "年 / 月 / 日（原设置）")
        .addOption("month", "年 / 月")
        .addOption("year", "仅按年")
        .addOption("root", "不建日期子文件夹")
        .setValue(this.plugin.settings.archiveLevel)
        .onChange(async value => {
          this.plugin.settings.archiveLevel = value as ArchiveLevel;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName("监控间隔（毫秒）").setDesc("500–10000，默认 1000。")
      .addText(text => text.setValue(String(this.plugin.settings.intervalMs)).onChange(async value => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 500 || number > 10000) return;
        this.plugin.settings.intervalMs = number;
        await this.plugin.saveSettings();
        this.plugin.restartTimer();
      }));
    new Setting(containerEl).setName("捕获文本、链接和代码").addToggle(toggle => toggle.setValue(this.plugin.settings.captureText)
      .onChange(async value => { this.plugin.settings.captureText = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("捕获图片").addToggle(toggle => toggle.setValue(this.plugin.settings.captureImages)
      .onChange(async value => { this.plugin.settings.captureImages = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("捕获复制的文件和文件夹").setDesc("图片文件按下方选择处理；其他文件和文件夹记录路径。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.captureFiles)
        .onChange(async value => { this.plugin.settings.captureFiles = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("复制图片文件时").setDesc("“保存为附件”会把图片文件复制进当天的 attachments 文件夹，并嵌入笔记；“只记录路径”不会复制图片。")
      .addDropdown(dropdown => dropdown
        .addOption("attachment", "保存为附件")
        .addOption("path", "只记录文件路径")
        .setValue(this.plugin.settings.imageFileMode)
        .onChange(async value => {
          this.plugin.settings.imageFileMode = value as ImageFileMode;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName("当天相同内容只存一次").addToggle(toggle => toggle.setValue(this.plugin.settings.dedupeDay)
      .onChange(async value => { this.plugin.settings.dedupeDay = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("过滤疑似密钥和密码").setDesc("规则无法识别所有敏感内容；请按需暂停监控。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.filterSensitive)
        .onChange(async value => { this.plugin.settings.filterSensitive = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("忽略关键词").setDesc("每行一个；含该词的文本不保存。")
      .addTextArea(area => area.setValue(this.plugin.settings.ignoreKeywords)
        .onChange(async value => { this.plugin.settings.ignoreKeywords = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("文本最大字符数").setDesc("超出部分截断；允许 1000–500000。")
      .addText(text => text.setValue(String(this.plugin.settings.maxTextLength)).onChange(async value => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1000 || number > 500000) return;
        this.plugin.settings.maxTextLength = number;
        await this.plugin.saveSettings();
      }));

    containerEl.createEl("h3", { text: "清理" });
    containerEl.createEl("p", { text: "删除旧归档以控制体积。图片只在没有其他笔记引用时才移到回收站；每次清理前会把受影响的笔记备份到保存根目录下的 .cleanup-backup。" });
    new Setting(containerEl).setName("自动清理").setDesc("按下面的间隔自动删除旧归档。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.cleanupAuto).onChange(async value => {
        this.plugin.settings.cleanupAuto = value;
        await this.plugin.saveSettings();
        this.plugin.scheduleCleanup();
      }));
    new Setting(containerEl).setName("自动清理间隔")
      .addDropdown(dropdown => dropdown
        .addOption("1", "每天")
        .addOption("3", "每 3 天")
        .addOption("7", "每周")
        .setValue(String(this.plugin.settings.cleanupEveryDays))
        .onChange(async value => {
          this.plugin.settings.cleanupEveryDays = Number(value) || 7;
          await this.plugin.saveSettings();
          this.plugin.scheduleCleanup();
        }));
    new Setting(containerEl).setName("清理多少天以前的内容").setDesc("最近 N 天不会被自动清理；允许 1–3650，默认 30。")
      .addText(text => text.setValue(String(this.plugin.settings.cleanupOlderThanDays)).onChange(async value => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 3650) return;
        this.plugin.settings.cleanupOlderThanDays = number;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("自动清理类型")
      .addDropdown(dropdown => dropdown
        .addOption("image", "只清图片")
        .addOption("text", "只清文字")
        .addOption("all", "图片和文字都清")
        .setValue(this.plugin.settings.cleanupScope)
        .onChange(async value => {
          this.plugin.settings.cleanupScope = value as CleanupScope;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName("手动清理").setDesc("选择日期和类型，先预览再删除。")
      .addButton(button => button.setButtonText("打开清理面板").onClick(() => this.plugin.openCleanupModal()));
  }
}
