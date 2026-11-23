export type EntryKind = "text" | "url" | "code" | "image" | "files";
export type ArchiveLevel = "day" | "month" | "year" | "root";

export function isImageFilePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(path);
}

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function timeKey(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function archivePath(root: string, date: Date, level: ArchiveLevel = "day"): string {
  if (level === "root") return root;
  const year = `${root}/${date.getFullYear()}`;
  if (level === "year") return year;
  const month = `${year}/${pad(date.getMonth() + 1)}`;
  return level === "month" ? month : `${month}/${pad(date.getDate())}`;
}

export function validRoot(value: string): string | null {
  const path = value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part))) return null;
  return parts.join("/");
}

export function detectKind(value: string): Exclude<EntryKind, "image"> {
  const text = value.trim();
  if (/^https?:\/\/\S+$/i.test(text)) {
    try { new URL(text); return "url"; } catch { /* ordinary text */ }
  }
  const codeSignals = [
    /```|~~~|<\/?[a-z][^>]*>/i,
    /^\s*(?:const|let|var|function|class|import|export|def|async|#include|SELECT|INSERT)\b/m,
    /(?:=>|\breturn\b|\bawait\b|\bif\s*\()/,
    /[{};]\s*$/m
  ].filter(pattern => pattern.test(text)).length;
  return codeSignals >= 2 || (text.includes("\n") && codeSignals >= 1) ? "code" : "text";
}

export function isSensitive(text: string, keywords: string): boolean {
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/i,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=：]\s*["']?[^"'\s]{8,}/i,
    /(?:密码|口令)\s*[:=：]\s*[^\s]{8,}/
  ];
  if (patterns.some(pattern => pattern.test(text))) return true;
  return matchesKeyword(text, keywords);
}

export function matchesKeyword(text: string, keywords: string): boolean {
  const lower = text.toLowerCase();
  return keywords.split(/\r?\n/).map(item => item.trim().toLowerCase()).filter(Boolean)
    .some(item => lower.includes(item));
}

export function marker(kind: EntryKind, hash: string): string {
  return `<!-- clipboard-vault:${kind}:${hash} -->`;
}

export function hasMarker(markdown: string, kind: EntryKind, hash: string): boolean {
  return markdown.includes(marker(kind, hash));
}

export function entryCount(markdown: string): number {
  return (markdown.match(/<!-- clipboard-vault:(?:text|url|code|image|files):[a-f0-9]{64} -->/g) ?? []).length;
}

function fenceFor(text: string): string {
  const maxTicks = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
  return "`".repeat(maxTicks + 1);
}

export function renderEntry(kind: EntryKind, content: string, hash: string, date: Date, sequence = 1, truncated = false): string {
  const labels: Record<EntryKind, string> = { text: "文本", url: "链接", code: "代码", image: "图片", files: "文件路径" };
  const head = `${marker(kind, hash)}\n## ${sequence}. ${timeKey(date)} · ${labels[kind]}\n\n`;
  if (kind === "image") return `${head}![](${content})\n\n`;
  if (kind === "url") return `${head}<${new URL(content.trim()).href}>\n\n`;
  const fence = fenceFor(content);
  return `${head}${fence}\n${content.replace(/\n+$/g, "")}\n${fence}${truncated ? "\n\n> 内容过长，已截断。" : ""}\n\n`;
}

export function renderFileEntry(paths: string[], attachments: string[], hash: string, date: Date, sequence: number): string {
  const label = attachments.length ? (paths.length ? "图片附件与文件路径" : "图片附件") : "文件路径";
  let body = "";
  if (attachments.length) body += attachments.map(path => `![](${path})`).join("\n\n") + "\n\n";
  if (paths.length) {
    const text = paths.join("\n");
    const fence = fenceFor(text);
    body += `${fence}\n${text}\n${fence}\n\n`;
  }
  return `${marker("files", hash)}\n## ${sequence}. ${timeKey(date)} · ${label}\n\n${body}`;
}

export interface SearchHit {
  path: string;
  title: string;
  kind: EntryKind;
  hash: string;
  line: number;
  text: string;
  images: string[];
  snippet: string;
  range?: { start: number; end: number };
}

export interface ArchiveFilter { from?: string; through?: string; kind?: EntryKind }

export function archiveDate(path: string): string {
  return /(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1] ?? "";
}

export function recentDate(daysAgo: number, now = new Date()): string {
  return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo));
}

const ENTRY_HEADER = /^<!-- clipboard-vault:(text|url|code|image|files):([a-f0-9]{64}) -->\s*$/;
const HEADING = /^## (.+)$/;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})[^`~]*$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const AUTOLINK = /^<(https?:\/\/[^>]+)>$/i;

export function archiveEntries(path: string, markdown: string): SearchHit[] {
  const result: SearchHit[] = [];
  const lines = markdown.split(/\r?\n/);
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
    if (markdown[offset] === "\r") offset++;
    if (markdown[offset] === "\n") offset++;
  }
  let current: SearchHit | undefined;
  let plain: string[] = [];
  let fenced: string[] | undefined;
  let fence = "";
  let fenceEntry = false;
  let body: "start" | "images" | "afterFence" | "done" | "unknown" = "start";
  let endLine = 0;
  const finish = () => {
    if (!current) return;
    const content = plain.join("\n").trim();
    if (current.kind === "url") current.text = AUTOLINK.exec(content)?.[1] ?? content;
    else current.text = fenced?.join("\n") ?? content;
    if (endLine > 0 && !fenceEntry) current.range = {
      start: offsets[current.line - 1], end: offsets[endLine] ?? markdown.length
    };
    current.snippet = current.text.replace(/\n/g, " ").slice(0, 140);
    result.push(current);
  };
  for (let line = 0; line < lines.length; line++) {
    const value = lines[line];
    if (fence) {
      const close = FENCE_CLOSE.exec(value)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) {
        if (fenceEntry) { endLine = line + 1; body = "afterFence"; }
        fence = "";
        fenceEntry = false;
      } else if (fenceEntry) fenced?.push(value);
      continue;
    }
    const header = ENTRY_HEADER.exec(value);
    const title = header && HEADING.exec(lines[line + 1] ?? "")?.[1];
    if (header && title) {
      finish();
      current = { path, title, kind: header[1] as EntryKind, hash: header[2], line: ++line, text: "", images: [], snippet: "" };
      plain = [];
      fenced = undefined;
      body = "start";
      endLine = 0;
      continue;
    }
    const open = FENCE_OPEN.exec(value)?.[1];
    if (open) {
      fence = open;
      fenceEntry = !!current && ((body === "start" && current.kind !== "image" && current.kind !== "url") ||
        (body === "images" && current.kind === "files"));
      if (fenceEntry) fenced = [];
      else body = "done";
      continue;
    }
    if (!current || body === "done" || !value.trim()) continue;
    if (body === "afterFence") {
      if (value === "> 内容过长，已截断。" && (current.kind === "text" || current.kind === "code")) endLine = line + 1;
      body = "done";
      continue;
    }
    if (body === "start" && current.kind === "url" && AUTOLINK.test(value.trim())) {
      plain.push(value);
      endLine = line + 1;
      body = "done";
      continue;
    }
    if (current.kind === "image" || current.kind === "files") {
      const image = /^!\[\]\((attachments\/[^/\\]+)\)$/.exec(value.trim())?.[1];
      if ((body === "start" || body === "images") && image && isImageFilePath(image)) {
        current.images.push(image);
        endLine = line + 1;
        body = current.kind === "image" ? "done" : "images";
        continue;
      }
    }
    if (body === "images") { body = "done"; continue; }
    body = "unknown";
    plain.push(value);
  }
  finish();
  return result;
}

export function sameEntry(entry: SearchHit, hit: SearchHit): boolean {
  return entry.kind === hit.kind && entry.hash === hit.hash && entry.title === hit.title &&
    entry.text === hit.text && entry.images.length === hit.images.length &&
    entry.images.every((value, index) => value === hit.images[index]);
}

export function renumberArchiveEntries(markdown: string): string {
  // Keep the original newlines and change only the headings recognized outside code fences.
  const lines = markdown.split(/(\r?\n)/);
  for (const [index, entry] of archiveEntries("", markdown).entries()) {
    const line = entry.line * 2;
    lines[line] = lines[line].replace(/^## (?:\d+\.\s+)?/, () => `## ${index + 1}. `);
  }
  return lines.join("");
}

export function removeArchiveEntry(path: string, markdown: string, hit: SearchHit): {
  markdown: string; entry: SearchHit;
} | null {
  const change = removeArchiveEntries(path, markdown, [hit]);
  return change.entries.length ? { markdown: change.markdown, entry: change.entries[0] } : null;
}

export function removeArchiveEntries(path: string, markdown: string, hits: SearchHit[]): {
  markdown: string; entries: SearchHit[];
} {
  const current = archiveEntries(path, markdown);
  const selected = new Map<number, SearchHit>();
  for (const hit of hits) {
    if (hit.path !== path) continue;
    const matches = current.filter(entry => sameEntry(entry, hit));
    if (matches.length === 1 && matches[0].range) selected.set(matches[0].range.start, matches[0]);
  }
  // Resolve every selection against the same version before removing or renumbering anything.
  const entries = [...selected.values()].sort((a, b) => b.range!.start - a.range!.start);
  for (const entry of entries) {
    const { start, end } = entry.range!;
    markdown = markdown.slice(0, start) + markdown.slice(end);
  }
  return { markdown: entries.length ? renumberArchiveEntries(markdown) : markdown, entries };
}

export function nextSequence(markdown: string): number {
  let max = 0;
  let header = false;
  let fence = "";
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = "";
      continue;
    }
    if (header) {
      const number = Number(/^## (\d+)\.\s/.exec(line)?.[1]);
      if (Number.isSafeInteger(number) && number < Number.MAX_SAFE_INTEGER) max = Math.max(max, number);
    }
    header = ENTRY_HEADER.test(line);
    fence = FENCE_OPEN.exec(line)?.[1] ?? "";
  }
  return max + 1;
}

export function matchesKind(hit: SearchHit, kind?: EntryKind): boolean {
  if (!kind) return true;
  if (kind === "image") return hit.kind === "image" || hit.images.length > 0;
  if (kind === "files") return hit.kind === "files" && (hit.images.length === 0 || hit.text.length > 0);
  return hit.kind === kind;
}

export function searchEntries(path: string, markdown: string, query: string, limit: number, kind?: EntryKind, newest = false): SearchHit[] {
  if (limit <= 0) return [];
  const needle = query.trim().toLowerCase();
  const entries = archiveEntries(path, markdown);
  if (newest) entries.reverse();
  return entries.filter(hit => matchesKind(hit, kind) && (!needle ||
    [hit.title, hit.text, ...hit.images].join("\n").toLowerCase().includes(needle))).slice(0, limit);
}
