// Run baan in the background and start it with the computer. One file per OS, no admin rights needed:
//  - Linux:   systemd user service (~/.config/systemd/user/baan.service). With "linger" on it starts at boot,
//             otherwise when you log in. Without systemd: a desktop autostart entry (starts when you log in).
//  - macOS:   launchd agent (~/Library/LaunchAgents/com.baan.mcp.plist), starts when you log in.
//  - Windows: a hidden launcher in the Startup folder, starts when you log in. No console window.
// The background process is `baan run`: the same auto-restart as `npm start` (config / plugin / code changes),
// no keyboard, and it also comes back by itself if the server crashes. Output goes to <config folder>/baan.log.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { IS_WINDOWS } from "./platform.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const IS_MAC = process.platform === "darwin";
/** Override only for tests, so a test never touches your real service. */
const NAME = process.env.BAAN_SERVICE_NAME || "baan";
const MAC_LABEL = NAME === "baan" ? "com.baan.mcp" : `com.baan.${NAME}`;

export type Kind = "systemd" | "autostart" | "launchd" | "startup-folder";
export const KIND_TEXT: Record<Kind, string> = {
  systemd: "systemd user service",
  autostart: "desktop autostart",
  launchd: "launchd (Login Items)",
  "startup-folder": "Windows Startup folder",
};

export const logFile = (dataDir: string) => join(dataDir, "baan.log");
export const pidFile = (dataDir: string) => join(dataDir, "baan.pid");

function sh(cmd: string, args: string[]): { code: number | null; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
  } catch (e) { return { code: null, out: String(e) }; }
}

const runArgs = (configPath: string) => [process.execPath, ...process.execArgv, CLI, "run", "--config", configPath];
const PATH_NOW = process.env.PATH ?? "";

// ── where each OS keeps it ──────────────────────────────────────────────────

const xdgConfig = () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const systemdUnit = () => join(xdgConfig(), "systemd", "user", `${NAME}.service`);
const autostartFile = () => join(xdgConfig(), "autostart", `${NAME}.desktop`);
const macPlist = () => join(homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
const winStartup = () => join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${NAME}.vbs`);
const launcherSh = (dataDir: string) => join(dataDir, `${NAME}-start.sh`);

const hasSystemdUser = () => !IS_WINDOWS && !IS_MAC && sh("systemctl", ["--user", "show-environment"]).code === 0;

/** Which mechanism this computer uses. */
export function kind(): Kind {
  if (IS_WINDOWS) return "startup-folder";
  if (IS_MAC) return "launchd";
  return hasSystemdUser() ? "systemd" : "autostart";
}

/** Is baan set to run in the background / start with the computer? */
export function installed(): Kind | null {
  if (IS_WINDOWS) return existsSync(winStartup()) ? "startup-folder" : null;
  if (IS_MAC) return existsSync(macPlist()) ? "launchd" : null;
  if (existsSync(systemdUnit())) return "systemd";
  if (existsSync(autostartFile())) return "autostart";
  return null;
}

// ── file contents ───────────────────────────────────────────────────────────

/** systemd quoting: "..." with \ and " escaped; % is special in unit files. */
const sdq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function systemdText(configPath: string, log: string): string {
  return `# Made by baan (npm run background). Remove with: npm stop
[Unit]
Description=baan MCP server
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=${runArgs(configPath).map(sdq).join(" ")}
WorkingDirectory=~
Environment=${sdq(`PATH=${PATH_NOW}`)}
Environment=BAAN_ICONS=plain
Restart=on-failure
RestartSec=5
StandardOutput=append:${log.replace(/%/g, "%%")}
StandardError=append:${log.replace(/%/g, "%%")}

[Install]
WantedBy=default.target
`;
}

function launcherText(configPath: string, log: string): string {
  return `#!/bin/sh\n# Made by baan. Starts baan in the background.\nexport PATH=${shq(PATH_NOW)}\nexport BAAN_ICONS=plain\nexec ${runArgs(configPath).map(shq).join(" ")} >> ${shq(log)} 2>&1\n`;
}

function desktopText(launcher: string): string {
  return `[Desktop Entry]\nType=Application\nName=baan\nComment=baan MCP server (remove with: npm stop)\nExec=sh "${launcher.replace(/(["`$\\])/g, "\\$1")}"\nTerminal=false\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`;
}

function plistText(configPath: string, log: string): string {
  const args = runArgs(configPath).map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(PATH_NOW)}</string>
    <key>BAAN_ICONS</key><string>plain</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** VBScript that runs baan with no window (window style 0) and appends its output to the log. */
function vbsText(configPath: string, log: string): string {
  const q = (s: string) => `"${s}"`;
  const inner = `${runArgs(configPath).map(q).join(" ")} >> ${q(log)} 2>&1`;
  const cmd = `cmd.exe /d /c "${inner}"`;
  return `' Made by baan. Starts baan in the background when you log in. Remove with: npm stop\r\nSet sh = CreateObject("WScript.Shell")\r\nsh.Environment("PROCESS")("BAAN_ICONS") = "plain"\r\nsh.Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`;
}

// ── process helpers ─────────────────────────────────────────────────────────

export function readPid(dataDir: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile(dataDir), "utf8").trim());
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM" ? Number(readFileSync(pidFile(dataDir), "utf8").trim()) : null;
  }
}

function killPid(pid: number): void {
  if (IS_WINDOWS) sh("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
}

/** Does baan answer on its local port? */
export async function serving(configPath: string): Promise<boolean> {
  try {
    const { server } = loadConfig(configPath);
    const host = ["0.0.0.0", "::", ""].includes(server.host) ? "127.0.0.1" : server.host.includes(":") ? `[${server.host}]` : server.host;
    const r = await fetch(`http://${host}:${server.port}/`, { signal: AbortSignal.timeout(2000) });
    return r.ok && (await r.text()).startsWith("baan");
  } catch { return false; }
}

export async function waitServing(configPath: string, sec: number, want = true): Promise<boolean> {
  const until = Date.now() + sec * 1000;
  for (;;) {
    if ((await serving(configPath)) === want) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── public API ──────────────────────────────────────────────────────────────

export interface EnableResult { kind: Kind; atBoot: boolean; note?: string }

/** Linux: let the user service start at boot, before anyone logs in. Tries without sudo (allowed on most desktops). */
export function linger(): boolean {
  const user = userInfo().username;
  if (/Linger=yes/.test(sh("loginctl", ["show-user", user, "-p", "Linger"]).out)) return true;
  sh("loginctl", ["enable-linger", user]);
  return /Linger=yes/.test(sh("loginctl", ["show-user", user, "-p", "Linger"]).out);
}

/** Set baan to start with the computer, and start it now. Replaces an older install. */
export async function enable(configPath: string): Promise<EnableResult> {
  const { dataDir } = loadConfig(configPath);
  mkdirSync(dataDir, { recursive: true });
  const log = logFile(dataDir);
  await disable(configPath); // stop an old copy first so the port is free
  const k = kind();

  if (k === "systemd") {
    const unit = systemdUnit();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, systemdText(configPath, log));
    sh("systemctl", ["--user", "daemon-reload"]);
    const r = sh("systemctl", ["--user", "enable", "--now", `${NAME}.service`]);
    if (r.code !== 0) throw new Error(`systemctl --user enable --now ${NAME}.service failed:\n${r.out}`);
    return { kind: k, atBoot: linger() };
  }
  if (k === "autostart") {
    const launcher = launcherSh(dataDir);
    writeFileSync(launcher, launcherText(configPath, log), { mode: 0o755 });
    try { chmodSync(launcher, 0o755); } catch { /* ignore */ }
    mkdirSync(dirname(autostartFile()), { recursive: true });
    writeFileSync(autostartFile(), desktopText(launcher));
    spawn("sh", [launcher], { detached: true, stdio: "ignore" }).unref();
    return { kind: k, atBoot: false, note: "No systemd here, so baan starts when you log in to the desktop." };
  }
  if (k === "launchd") {
    const plist = macPlist();
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, plistText(configPath, log));
    const uid = process.getuid?.() ?? 0;
    let r = sh("launchctl", ["bootstrap", `gui/${uid}`, plist]);
    if (r.code !== 0) r = sh("launchctl", ["load", "-w", plist]);
    if (r.code !== 0) throw new Error(`launchctl could not start baan:\n${r.out}`);
    return { kind: k, atBoot: false };
  }
  // Windows
  const vbs = winStartup();
  mkdirSync(dirname(vbs), { recursive: true });
  writeFileSync(vbs, vbsText(configPath, log));
  spawn("wscript.exe", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { kind: k, atBoot: false };
}

/** Stop the background copy and stop starting with the computer. Returns what was removed (null if nothing). */
export async function disable(configPath: string): Promise<Kind | null> {
  let dataDir = dirname(configPath);
  try { dataDir = loadConfig(configPath).dataDir; } catch { /* broken config: still remove */ }
  const k = installed();
  if (k === "systemd") {
    sh("systemctl", ["--user", "disable", "--now", `${NAME}.service`]);
    rmSync(systemdUnit(), { force: true });
    sh("systemctl", ["--user", "daemon-reload"]);
  } else if (k === "launchd") {
    const uid = process.getuid?.() ?? 0;
    if (sh("launchctl", ["bootout", `gui/${uid}/${MAC_LABEL}`]).code !== 0) sh("launchctl", ["unload", "-w", macPlist()]);
    rmSync(macPlist(), { force: true });
  } else if (k === "autostart") {
    rmSync(autostartFile(), { force: true });
    rmSync(launcherSh(dataDir), { force: true });
  } else if (k === "startup-folder") {
    rmSync(winStartup(), { force: true });
  }
  // Windows / desktop autostart (and anything left over): stop the process from its pid file.
  const pid = readPid(dataDir);
  if (pid && pid !== process.pid) {
    killPid(pid);
    for (let i = 0; i < 20 && readPid(dataDir); i++) await new Promise((r) => setTimeout(r, 250));
  }
  return k;
}

/** Last lines of the background log. */
export function tail(dataDir: string, lines = 40): string {
  try { return readFileSync(logFile(dataDir), "utf8").split(/\r?\n/).slice(-lines - 1).join("\n").trimEnd(); } catch { return ""; }
}

/** Keep the log small: cut it to the last part when it gets big. Called when `baan run` starts. */
export function trimLog(dataDir: string, maxBytes = 5 * 1024 * 1024): void {
  try {
    const f = logFile(dataDir);
    const buf = readFileSync(f);
    if (buf.length <= maxBytes) return;
    writeFileSync(f, buf.subarray(buf.length - maxBytes / 5));
  } catch { /* no log yet, or Windows keeps it open */ }
}

/** Opens the log for appending (for `baan run` started by hand). */
export const openLog = (dataDir: string) => openSync(logFile(dataDir), "a");
