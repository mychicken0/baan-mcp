// Everything OS-specific lives here, so the rest of the code is the same on Windows, macOS and Linux.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/** Default folder for config + state: %APPDATA%\baan on Windows, $XDG_CONFIG_HOME/baan or ~/.config/baan elsewhere. */
export function defaultConfigDir(): string {
  if (IS_WINDOWS) return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "baan");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "baan");
}

/** Expand a leading ~ and make the path absolute (relative paths resolve from `base`). */
export function expandPath(p: string, base: string = process.cwd()): string {
  const s = p.trim();
  const home = s === "~" || s.startsWith("~/") || s.startsWith("~\\") ? join(homedir(), s.slice(1)) : s;
  return isAbsolute(home) ? resolve(home) : resolve(base, home);
}

/** Real path of `p`, following symlinks of the deepest part that exists (so new files can be checked too). */
export function realPathLoose(p: string): string {
  const rest: string[] = [];
  let cur = p;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(basename(cur));
    cur = parent;
  }
  return join(existsSync(cur) ? realpathSync.native(cur) : cur, ...rest);
}

/** True if `child` is `root` or inside it. Case-insensitive on Windows. */
export function isInside(child: string, root: string): boolean {
  const norm = (x: string) => (IS_WINDOWS ? x.toLowerCase() : x);
  const rel = relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Name of the shell tool: `powershell` on Windows, `bash` elsewhere (same as pi). */
export const SHELL_TOOL_NAME = IS_WINDOWS ? "powershell" : "bash";

export interface ShellResult { output: string; exitCode: number | null; timedOut: boolean }

/** Run one command with the platform shell, combined stdout+stderr, killing the whole process tree on timeout. */
export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((done) => {
    const child = IS_WINDOWS
      ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { cwd, windowsHide: true })
      : spawn("bash", ["-c", command], { cwd, detached: true });
    child.stdin?.end();
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => chunks.push(d));
    let timedOut = false;
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        if (IS_WINDOWS) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      done({ output: Buffer.concat(chunks).toString("utf8"), exitCode: code, timedOut });
    };
    child.on("error", (e) => { chunks.push(Buffer.from(String(e))); finish(null); });
    child.on("close", finish);
  });
}

/** Open a URL in the default browser. Best effort: does nothing if there is no browser. */
export function openUrl(url: string): void {
  const [cmd, args] = IS_WINDOWS
    ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const c = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    c.on("error", () => {});
    c.unref();
  } catch { /* no browser */ }
}

/** Copy text to the clipboard. Resolves true only if a clipboard tool accepted it. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const tools: [string, string[]][] = IS_WINDOWS
    ? [["clip", []]]
    : process.platform === "darwin"
      ? [["pbcopy", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [cmd, args] of tools) {
    const ok = await new Promise<boolean>((done) => {
      try {
        const c = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        c.on("error", () => done(false));
        c.on("close", (code) => done(code === 0));
        c.stdin?.end(text);
      } catch { done(false); }
    });
    if (ok) return true;
  }
  return false;
}

/** Stop a process and everything it started. Windows: taskkill /T. Elsewhere: SIGTERM, then SIGKILL after `graceMs`. */
export function stopProcessTree(child: import("node:child_process").ChildProcess, graceMs = 3000): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return done();
    child.once("exit", () => { clearTimeout(t); done(); });
    const hard = () => {
      try {
        if (IS_WINDOWS) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
    };
    const t = setTimeout(hard, IS_WINDOWS ? 0 : graceMs);
    if (!IS_WINDOWS) child.kill("SIGTERM");
  });
}

/** Open a text file for editing: $VISUAL/$EDITOR in this terminal if set, else Notepad (Windows), TextEdit (macOS) or the desktop's default app. */
export function openInEditor(file: string): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  return new Promise((done) => {
    let cmd: string, args: string[], wait = false;
    if (editor) { cmd = editor; args = [file]; wait = true; }
    else if (IS_WINDOWS) { cmd = "notepad.exe"; args = [file]; }
    else if (process.platform === "darwin") { cmd = "open"; args = ["-t", file]; }
    else { cmd = "xdg-open"; args = [file]; }
    try {
      const c = spawn(cmd, args, wait ? { stdio: "inherit", shell: IS_WINDOWS } : { stdio: "ignore", detached: true, windowsHide: true });
      c.on("error", () => done());
      if (wait) c.on("close", () => done());
      else { c.unref(); done(); }
    } catch { done(); }
  });
}
