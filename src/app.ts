// The "baan" icon in the baan folder. Double-click it to open the control panel (start, stop, restart, settings).
// It is made for the OS you are on, and only that one:
//  - Linux:   baan.desktop  (file managers show it as "baan" with the house icon)
//  - macOS:   baan.app      (a tiny app bundle)
//  - Windows: baan.lnk      (a shortcut that runs with no console window)
// It runs `baan panel`, which opens the control panel in its own browser window.
// Make it again with `npm run app` (for example after moving the folder or installing a new Node.js).
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS, openUrl } from "./platform.ts";

const IS_MAC = process.platform === "darwin";
/** The baan folder (where package.json is). */
export const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const ASSETS = join(ROOT, "assets");

export const launcherPath = () => join(ROOT, IS_WINDOWS ? "baan.lnk" : IS_MAC ? "baan.app" : "baan.desktop");
const panelArgs = (configPath: string) => [process.execPath, ...process.execArgv, CLI, "panel", "--config", configPath];

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** One argument of a .desktop Exec line (freedesktop rules: quote if needed, then escape backslashes again). */
function desktopArg(a: string): string {
  const s = a.replace(/%/g, "%%");
  if (!/[\s"'\\><~|&;$*?#()`]/.test(s)) return s;
  return `"${s.replace(/(["`$\\])/g, "\\$1")}"`.replace(/\\/g, "\\\\");
}

function linuxLauncher(configPath: string): string {
  const file = launcherPath();
  writeFileSync(file, `[Desktop Entry]
Type=Application
Version=1.0
Name=baan
GenericName=baan control panel
Comment=Start, stop, restart and set up baan. Made by: npm run app
Exec=${panelArgs(configPath).map(desktopArg).join(" ")}
Icon=${join(ASSETS, "icon.png")}
Terminal=false
Categories=Utility;
StartupNotify=false
`, { mode: 0o755 });
  chmodSync(file, 0o755);
  // GNOME Files and Nemo only run a launcher that is executable and marked as trusted.
  try { spawnSync("gio", ["set", file, "metadata::trusted", "true"], { stdio: "ignore", timeout: 5000 }); } catch { /* no gio */ }
  return file;
}

function macLauncher(configPath: string): string {
  const app = launcherPath();
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>baan</string>
  <key>CFBundleDisplayName</key><string>baan</string>
  <key>CFBundleIdentifier</key><string>com.baan.panel</string>
  <key>CFBundleExecutable</key><string>baan</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`);
  const exe = join(app, "Contents", "MacOS", "baan");
  writeFileSync(exe, `#!/bin/sh\n# Made by baan (npm run app). Opens the baan control panel.\nexport PATH=${shq(process.env.PATH ?? "/usr/bin:/bin")}\n${panelArgs(configPath).map(shq).join(" ")} >/dev/null 2>&1 &\n`, { mode: 0o755 });
  chmodSync(exe, 0o755);
  copyFileSync(join(ASSETS, "icon.icns"), join(app, "Contents", "Resources", "icon.icns"));
  spawnSync("touch", [app]); // so Finder shows the icon right away
  return app;
}

function windowsLauncher(configPath: string): string {
  const lnk = launcherPath();
  // A tiny script next to the config runs baan with no console window; the shortcut runs that script.
  const vbs = join(dirname(configPath), "baan-panel.vbs");
  const cmd = panelArgs(configPath).map((a) => `"${a}"`).join(" ");
  mkdirSync(dirname(vbs), { recursive: true });
  writeFileSync(vbs, `' Made by baan (npm run app). Opens the baan control panel.\r\nSet sh = CreateObject("WScript.Shell")\r\nsh.Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`);
  const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const ps = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psq(lnk)})`,
    `$s.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'`,
    `$s.Arguments = ${psq(`"${vbs}"`)}`,
    `$s.WorkingDirectory = ${psq(ROOT)}`,
    `$s.IconLocation = ${psq(join(ASSETS, "icon.ico") + ",0")}`,
    `$s.Description = 'baan control panel'`,
    `$s.Save()`,
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  if (r.status !== 0 || !existsSync(lnk)) throw new Error(`Could not make the shortcut: ${(r.stderr || r.stdout || String(r.error ?? "")).trim()}`);
  return lnk;
}

/** Make (or remake) the baan icon in the baan folder for this OS. Returns its path. */
export function createLauncher(configPath: string): string {
  if (IS_WINDOWS) return windowsLauncher(configPath);
  if (IS_MAC) return macLauncher(configPath);
  return linuxLauncher(configPath);
}

// ── open the panel in its own window ──────────────────────────────────────────

function onPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const n of names) for (const d of dirs) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

/** A Chromium-based browser (Chrome, Edge, Brave, Chromium) can open a page as an app window: no tabs, no address bar. */
function appBrowser(): string[] | null {
  if (IS_WINDOWS) {
    const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    const rel = ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];
    for (const r of rel) for (const root of roots) if (existsSync(join(root, r))) return [join(root, r)];
    return null;
  }
  if (IS_MAC) {
    for (const name of ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"])
      for (const dir of ["/Applications", join(homedir(), "Applications")])
        if (existsSync(join(dir, `${name}.app`))) return ["open", "-na", join(dir, `${name}.app`), "--args"];
    return null;
  }
  const b = onPath(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"]);
  return b ? [b] : null;
}

/** Open `url` as its own app window if a Chromium-based browser is installed, otherwise in the default browser. */
export function openAppWindow(url: string): void {
  const b = appBrowser();
  if (!b) return openUrl(url);
  try {
    const [cmd, ...pre] = b;
    const c = spawn(cmd, [...pre, `--app=${url}`, "--window-size=980,860"], { stdio: "ignore", detached: true, windowsHide: true });
    c.on("error", () => openUrl(url));
    c.unref();
  } catch { openUrl(url); }
}
