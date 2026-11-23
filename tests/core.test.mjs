import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../core.ts", import.meta.url), "utf8");
const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code;
const module = { exports: {} };
new Function("module", "exports", "require", compiled)(module, module.exports, require);
const core = module.exports;

const date = new Date(2026, 10, 17, 11, 26, 30);
assert.equal(core.dayKey(date), "2026-11-17");
assert.equal(core.archivePath("剪切板", date), "剪切板/2026/11/17");
assert.equal(core.archivePath("剪切板", date, "month"), "剪切板/2026/11");
assert.equal(core.archivePath("剪切板", date, "year"), "剪切板/2026");
assert.equal(core.archivePath("剪切板", date, "root"), "剪切板");
assert.equal(core.isImageFilePath("C:\\图片\\照片.JPG"), true);
assert.equal(core.isImageFilePath("C:\\图片\\文档.docx"), false);
assert.equal(core.validRoot("剪切板\\归档"), "剪切板/归档");
assert.equal(core.validRoot("../private"), null);
assert.equal(core.validRoot("C:\\private"), null);
assert.equal(core.detectKind("https://example.com/a"), "url");
assert.equal(core.detectKind("const answer = 42;\nreturn answer;"), "code");
assert.equal(core.detectKind("这是普通文字"), "text");
assert.equal(core.isSensitive("password: abcdefgh123", ""), true);
assert.equal(core.isSensitive("密码：abcdefgh123", ""), true);
assert.equal(core.isSensitive("普通文字", "普通"), true);
const hash = "a".repeat(64);
const entry = core.renderEntry("code", "```\nconst x = 1;\n```", hash, date);
assert.match(entry, /````\n```/);
assert.ok(core.hasMarker(entry, "code", hash));
const hits = core.searchEntries("剪切板/2026/11/17/2026-11-17.md", entry, "const x", 10);
assert.equal(hits.length, 1);
assert.equal(hits[0].title, "1. 11:26:30 · 代码");
assert.equal(hits[0].line, 1);
assert.equal(hits[0].text, "```\nconst x = 1;\n```");
assert.equal(core.entryCount(entry), 1);
const fileEntry = core.renderEntry("files", "C:\\资料\\报告.docx\nD:\\图像\\图.png", "b".repeat(64), date, 2);
assert.match(fileEntry, /## 2\. 11:26:30 · 文件路径/);
assert.equal(core.searchEntries("a.md", fileEntry, "报告.docx", 10).length, 1);
const imported = core.renderFileEntry([], ["attachments/photo.png"], "c".repeat(64), date, 3);
assert.match(imported, /## 3\. 11:26:30 · 图片附件/);
assert.match(imported, /!\[\]\(attachments\/photo\.png\)/);
assert.equal(core.searchEntries("a.md", entry, "absent", 10).length, 0);
assert.equal(core.recentDate(1, new Date(2026, 0, 1)), "2025-12-31");
const url = core.renderEntry("url", "https://example.com/a", "d".repeat(64), date, 4);
const mixed = core.renderFileEntry(["C:\\项目\\报告.docx"], ["attachments/map.svg", "attachments/fig.png"], "e".repeat(64), date, 5);
const markerInCode = core.renderEntry("code", "line 1\n" + imported + "\nlast line", "f".repeat(64), date, 6);
const oldArchive = [entry, fileEntry, imported, url, mixed, markerInCode].join("\n").replace(/\n/g, "\r\n");
const imgHits = core.searchEntries("a.md", oldArchive, "", 10, "image", true);
assert.deepEqual(imgHits.map(hit => hit.images), [["attachments/map.svg", "attachments/fig.png"], ["attachments/photo.png"]]);
assert.equal(imgHits[0].text, "C:\\项目\\报告.docx");
assert.equal(imgHits[1].text, "");
assert.equal(core.searchEntries("a.md", oldArchive, "", 10, "files").length, 2);
assert.equal(core.searchEntries("a.md", oldArchive, "", 10, "url")[0].text, "https://example.com/a");
assert.equal(core.archiveEntries("a.md", oldArchive).length, 6);
assert.equal(core.searchEntries("a.md", oldArchive, "map.svg", 2, "image").length, 1);

const note = "# 自己添加的小标题\r\n\r\n不能删掉的工作记录\r\n";
const path = "剪切板/2026-11-17.md";
const original = [entry, fileEntry, note.replace(/\r\n/g, "\n"), imported, url, mixed, markerInCode].join("\n").replace(/\n/g, "\r\n");
const selected = core.archiveEntries(path, original)[1];
const changed = core.removeArchiveEntry(path, original, selected);
assert.ok(changed.markdown.includes(note));
assert.equal(core.archiveEntries(path, changed.markdown).length, 5);
assert.deepEqual(core.archiveEntries(path, changed.markdown).map(hit => hit.title.match(/^\d+/)[0]), ["1", "2", "3", "4", "5"]);
assert.deepEqual(core.archiveEntries(path, changed.markdown).map(hit => hit.text),
  core.archiveEntries(path, original).filter(hit => hit.hash !== selected.hash).map(hit => hit.text));
assert.equal(core.nextSequence(changed.markdown), 6);
assert.equal(core.removeArchiveEntry(path, original.replace("报告.docx", "修改后.docx"), selected), null);
assert.equal(core.removeArchiveEntry(path, original + fileEntry, selected), null);
const clipped = core.renderEntry("text", "exceeds cutoff", "8".repeat(64), date, 8, true) + "\n" + note;
const longClip = core.archiveEntries(path, clipped)[0];
assert.ok(!core.removeArchiveEntry(path, clipped, longClip).markdown.includes("内容过长"));
assert.ok(core.removeArchiveEntry(path, clipped, longClip).markdown.includes(note));
const unreadable = entry.replace(/`/g, "~").replace(/~~~~\n\n$/, "");
const illFormed = core.archiveEntries(path, unreadable)[0];
assert.equal(illFormed.range, undefined);

const preface = "# 我的工作记录\n\n## 99. 这是手工标题\n\n保留此处的内容。\n\n";
const codeText = "## 35. 代码中的标题\n\n" + core.renderEntry("text", "示例记录", "7".repeat(64), date, 77);
const makeGapped = (first, second, third) => preface +
  core.renderEntry("text", "正文有 12. 这样的序号", "1".repeat(64), date, first) +
  core.renderEntry("code", codeText, "2".repeat(64), date, second) +
  core.renderFileEntry(["C:\\项目\\附件.docx"], ["attachments/图.png"], "3".repeat(64), date, third);
for (const newline of ["\n", "\r\n"]) {
  const gapped = makeGapped(2, 12, 26).replace(/\n/g, newline).trimEnd();
  const expected = makeGapped(1, 2, 3).replace(/\n/g, newline).trimEnd();
  assert.equal(core.renumberArchiveEntries(gapped), expected);
  assert.equal(core.renumberArchiveEntries(expected), expected);
  const firstHit = core.archiveEntries(path, gapped)[0];
  const after = core.removeArchiveEntry(path, gapped, firstHit).markdown;
  const survivors = core.archiveEntries(path, after);
  assert.deepEqual(survivors.map(hit => hit.title.match(/^\d+/)[0]), ["1", "2"]);
  assert.equal(survivors[0].text, codeText.trimEnd());
  assert.deepEqual(survivors[1].images, ["attachments/图.png"]);
}
assert.equal(core.renumberArchiveEntries(preface), preface);
const single = core.renderEntry("text", "最后一条", "4".repeat(64), date, 9);
const emptyArchive = core.removeArchiveEntry(path, single, core.archiveEntries(path, single)[0]).markdown;
assert.equal(core.archiveEntries(path, emptyArchive).length, 0);
assert.equal(core.nextSequence(emptyArchive), 1);

// Select from the original version: removing early entries must not invalidate later selections.
for (const newline of ["\n", "\r\n"]) {
  const batchSource = makeGapped(2, 12, 26).replace(/\n/g, newline);
  const batchHits = core.archiveEntries(path, batchSource);
  const batch = core.removeArchiveEntries(path, batchSource, [batchHits[0], batchHits[2], batchHits[0]]);
  assert.equal(batch.entries.length, 2);
  const remaining = core.archiveEntries(path, batch.markdown);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].title, "1. 11:26:30 · 代码");
  assert.equal(remaining[0].text, codeText.trimEnd());
  assert.ok(batch.markdown.startsWith(preface.replace(/\n/g, newline)));
  assert.equal(core.nextSequence(batch.markdown), 2);
  const all = core.removeArchiveEntries(path, batchSource, batchHits);
  assert.equal(all.entries.length, 3);
  assert.equal(core.archiveEntries(path, all.markdown).length, 0);
  assert.ok(all.markdown.includes(preface.replace(/\n/g, newline)));
  assert.equal(core.nextSequence(all.markdown), 1);
  const changedSource = batchSource.replace("正文有 12.", "正文被修改");
  const partial = core.removeArchiveEntries(path, changedSource, batchHits);
  assert.equal(partial.entries.length, 2);
  assert.ok(partial.markdown.includes("正文被修改"));
  assert.equal(core.archiveEntries(path, partial.markdown).length, 1);
  assert.equal(core.removeArchiveEntries(path, batchSource, batchHits.map(hit => ({ ...hit, path: "别的笔记.md" }))).markdown, batchSource);
  assert.equal(core.removeArchiveEntries(path, batchSource, []).markdown, batchSource);
}
const sameHashSource = core.renderEntry("text", "重复内容", hash, date, 1) + core.renderEntry("text", "重复内容", hash, date, 2);
assert.equal(core.removeArchiveEntries(path, sameHashSource, core.archiveEntries(path, sameHashSource)).entries.length, 2);
const ambiguousSource = single + single;
assert.equal(core.removeArchiveEntries(path, ambiguousSource, core.archiveEntries(path, ambiguousSource)).entries.length, 0);
console.log("Core checks passed");
