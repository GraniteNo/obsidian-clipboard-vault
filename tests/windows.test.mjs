import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../windows-clipboard.ts", import.meta.url), "utf8");
const code = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code;
const module = { exports: {} };
new Function("module", "exports", "require", "Buffer", code)(module, module.exports, require, Buffer);
const { parseWindowsLine, writeWindowsClipboard } = module.exports;

assert.deepEqual(parseWindowsLine('{"kind":"ready"}'), { kind: "ready" });
assert.deepEqual(parseWindowsLine('{"kind":"files","paths":["C:\\\\报告.docx","D:\\\\图.png"]}'), {
  kind: "files", paths: ["C:\\报告.docx", "D:\\图.png"]
});
assert.deepEqual([...parseWindowsLine('{"kind":"image","png":"iVBORw=="}').bytes], [137, 80, 78, 71]);
assert.throws(() => parseWindowsLine('{"kind":"unknown"}'));
if (process.platform === "win32") {
  const writes = [];
  globalThis.window = { require: id => id === "node:child_process" ? {
    spawn(exe, args, options) {
      assert.equal(exe, "powershell.exe");
      assert.deepEqual(args.slice(-3), ["-File", "E:\\vault\\clipboard-helper.ps1", "-Write"]);
      assert.equal(options.windowsHide, true);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough() });
      const chunks = [];
      child.stdin.on("data", chunk => chunks.push(chunk));
      child.stdin.on("end", () => {
        writes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        child.emit("close", 0);
      });
      return child;
    }
  } : undefined };
  try {
    const text = "多行文本\nC:\\图片\\地图.png\n'\"$()";
    await writeWindowsClipboard("E:\\vault\\clipboard-helper.ps1", { text });
    await writeWindowsClipboard("E:\\vault\\clipboard-helper.ps1", { png: Uint8Array.of(137, 80, 78, 71) });
    assert.deepEqual(writes, [{ text }, { png: "iVBORw==" }]);
  } finally { delete globalThis.window; }
}
console.log("Windows clipboard message checks passed");
