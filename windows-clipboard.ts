import type { ChildProcessWithoutNullStreams } from "node:child_process";

declare const require: ((id: string) => unknown) | undefined;

export type WindowsSnapshot =
  | { kind: "text"; text: string }
  | { kind: "image"; bytes: Uint8Array }
  | { kind: "files"; paths: string[] }
  | null;

type Spawn = typeof import("node:child_process").spawn;
export const ARCHIVE_COPY_FORMAT = "ClipboardVault.Copy";

function getSpawn(): Spawn | null {
  const host = window as Window & { require?: (id: string) => unknown };
  const loaders = [host.require, typeof require === "function" ? require : undefined];
  for (const load of loaders) {
    if (!load) continue;
    for (const name of ["node:child_process", "child_process"]) {
      try {
        const spawn = (load(name) as { spawn?: Spawn } | undefined)?.spawn;
        if (spawn) return spawn;
      } catch { /* Try another loader. */ }
    }
  }
  return null;
}

export function parseWindowsLine(line: string): { kind: "ready" | "empty" | "oversize-image" } | WindowsSnapshot {
  const raw = JSON.parse(line) as Record<string, unknown>;
  if (raw.kind === "ready" || raw.kind === "empty" || raw.kind === "oversize-image") return { kind: raw.kind };
  if (raw.kind === "text" && typeof raw.text === "string") return { kind: "text", text: raw.text };
  if (raw.kind === "files" && Array.isArray(raw.paths) && raw.paths.every(path => typeof path === "string")) {
    return { kind: "files", paths: raw.paths };
  }
  if (raw.kind === "image" && typeof raw.png === "string") {
    return { kind: "image", bytes: new Uint8Array(Buffer.from(raw.png, "base64")) };
  }
  throw new Error("未知的 Windows 剪切板数据");
}

export async function writeWindowsClipboard(scriptPath: string, copy: { text: string } | { png: Uint8Array }): Promise<void> {
  const spawn = getSpawn();
  if (!spawn || process.platform !== "win32") throw new Error("Windows 剪切板服务不可用");
  const payload = "text" in copy ? { text: copy.text } : { png: Buffer.from(copy.png).toString("base64") };
  return new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath, "-Write"
    ], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 15000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "Windows 剪切板写入失败"));
    });
    child.stdin.on("error", () => { /* The child can exit before reading input; report its exit error. */ });
    child.stdin.end(JSON.stringify(payload) + "\n", "utf8");
  });
}

export class WindowsClipboardBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private ready = false;
  private readonly spawn = getSpawn();

  constructor(private scriptPath: string, private intervalMs: number,
    private onSnapshot: (snapshot: WindowsSnapshot) => void,
    private onUnavailable: (error: Error) => void,
    private onReady: () => void) {}

  get isReady(): boolean { return this.ready; }
  get isSupported(): boolean { return this.spawn !== null && process.platform === "win32"; }

  start(): void {
    if (!this.isSupported || this.child) return;
    this.stopped = false;
    const child = this.spawn!("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass",
      "-File", this.scriptPath, "-ParentPid", String(process.pid), "-IntervalMs", String(this.intervalMs)
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const startup = setTimeout(() => {
      if (this.child !== child || this.ready || this.stopped) return;
      this.fail(new Error("Windows 剪切板服务启动超时"));
      child.kill();
    }, 8000);
    let pending = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 32 * 1024 * 1024) { child.kill(); this.fail(new Error("剪切板图片超过读取上限")); return; }
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line) continue;
        try {
          const payload = parseWindowsLine(line);
          if (payload && payload.kind === "ready") { clearTimeout(startup); this.ready = true; this.onReady(); continue; }
          if (payload && payload.kind === "oversize-image") continue;
          if (payload && payload.kind === "empty") { this.onSnapshot(null); continue; }
          this.onSnapshot(payload as WindowsSnapshot);
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); child.kill(); }
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.on("error", error => { clearTimeout(startup); this.fail(error); });
    child.on("exit", code => {
      clearTimeout(startup);
      this.child = null;
      this.ready = false;
      if (!this.stopped) this.fail(new Error(stderr.trim() || `Windows 剪切板服务已退出 (${code})`));
    });
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.child?.kill();
    this.child = null;
  }

  async readOnce(): Promise<WindowsSnapshot> {
    if (!this.isSupported) throw new Error("Windows 剪切板服务不可用");
    const spawn = this.spawn!;
    return new Promise<WindowsSnapshot>((resolve, reject) => {
      const child = spawn("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass",
        "-File", this.scriptPath, "-Once"
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill(), 8000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 32 * 1024 * 1024) child.kill();
      });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
      child.on("error", error => { clearTimeout(timeout); reject(error); });
      child.on("exit", code => {
        clearTimeout(timeout);
        if (code !== 0) { reject(new Error(stderr.trim() || "Windows 剪切板读取失败")); return; }
        try {
          const result = parseWindowsLine(output.trim());
          resolve(result && (result.kind === "ready" || result.kind === "empty" || result.kind === "oversize-image") ? null : result as WindowsSnapshot);
        } catch (error) { reject(error); }
      });
    });
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.onUnavailable(error);
  }
}
