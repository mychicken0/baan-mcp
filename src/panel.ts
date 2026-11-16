// The control panel: a small web page on this computer only, to start, stop and restart baan, change settings,
// make a new password and read the log. Opened by the baan icon in the baan folder (see app.ts) or `npm run panel`.
//
// Safety:
//  - It listens on 127.0.0.1 only, on its own port (baan's port + 1), never on the MCP port. Tailscale Funnel or a
//    tunnel forwards only the MCP port, so the panel cannot be reached from the internet.
//  - Every /api request needs a random key. The key is in panel.json next to the config (only you can read it) and is
//    handed to the window in the #fragment of the URL, so it never shows up in a request line or a log.
//  - Requests must say Host: 127.0.0.1 / localhost (blocks DNS-rebinding) and, from a browser, come from the panel page.
//  - It quits by itself shortly after its window is closed. Closing the panel never stops baan.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import YAML from "yaml";
import { loadConfig, type Config } from "./config.ts";
import { State, randomToken } from "./state.ts";
import { IS_WINDOWS, SHELL_TOOL_NAME, expandPath, openUrl } from "./platform.ts";
import * as service from "./service.ts";
import { openAppWindow, launcherPath } from "./app.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const HTML = fileURLToPath(new URL("./panel.html", import.meta.url));
const LOGO = fileURLToPath(new URL("../assets/logo.svg", import.meta.url));
const GUIDE = fileURLToPath(new URL("../GUIDE.md", import.meta.url));
const BUILTIN = ["read", "write", "edit", "bash"] as const;
const DEFAULT_PANEL_PORT = 17239;
const IDLE_MS = 4 * 60_000; // no window for this long: quit
const BYE_MS = 8_000; // window closed and not reopened within this: quit

interface Info { pid: number; port: number; key: string }
const infoFile = (configPath: string) => join(dirname(configPath), "panel.json");
const urlOf = (i: Info) => `http://127.0.0.1:${i.port}/#k=${i.key}`;

function readInfo(configPath: string): Info | null {
  try { return JSON.parse(readFileSync(infoFile(configPath), "utf8")) as Info; } catch { return null; }
}

async function answers(i: Info): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${i.port}/api/hello`, { headers: { "x-baan-key": i.key }, signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

function panelPort(configPath: string): number {
  try { const p = loadConfig(configPath).server.port + 1; return p > 1024 && p < 65536 ? p : DEFAULT_PANEL_PORT; } catch { return DEFAULT_PANEL_PORT; }
}

function listen(server: Server, first: number): Promise<number> {
  return new Promise((ok, fail) => {
    let port = first;
    const tryOne = () => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && port < first + 20) { port++; tryOne(); } else fail(e);
      });
      server.listen(port, "127.0.0.1", () => ok(port));
    };
    tryOne();
  });
}

/** Open a file in a desktop app (never a terminal editor: the panel has no terminal). */
function openFile(file: string): void {
  if (IS_WINDOWS) {
    const c = spawn("notepad.exe", [file], { stdio: "ignore", detached: true, windowsHide: false });
    c.on("error", () => openUrl(file)); c.unref(); return;
  }
  if (process.platform === "darwin") {
    const c = spawn("open", ["-t", file], { stdio: "ignore", detached: true }); c.on("error", () => {}); c.unref(); return;
  }
  openUrl(file); // xdg-open
}

/** `baan check` on a config file in a fresh process: it parses and every plugin loads. */
function check(configPath: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, [...process.execArgv, CLI, "check", "--config", configPath], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0", BAAN_ICONS: "plain" }, windowsHide: true,
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => done({ ok: false, out: String(e) }));
    p.on("close", (code) => done({ ok: code === 0, out: out.trim() }));
  });
}

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

// ── what the panel can do ─────────────────────────────────────────────────────

function tryConfig(configPath: string): { config: Config | null; error: string } {
  try { return { config: loadConfig(configPath), error: "" }; } catch (e) { return { config: null, error: (e as Error).message }; }
}
const dataDirOf = (configPath: string) => tryConfig(configPath).config?.dataDir ?? dirname(configPath);

async function status(configPath: string) {
  const { config, error } = tryConfig(configPath);
  const k = service.installed();
  const running = config ? await service.serving(configPath) : false;
  return {
    running,
    mode: running ? (k ? "background" : "window") : "stopped",
    startsWithComputer: k ? (k === "systemd" && service.linger() ? "boot" : "login") : "no",
    kindText: k ? service.KIND_TEXT[k] : null,
    mcpUrl: config ? `${config.server.publicUrl}/mcp` : null,
    local: config ? `http://${config.server.host}:${config.server.port}` : null,
    folder: config?.workspace.cwd ?? null,
    tools: config ? config.tools.map((t) => (t === "bash" ? SHELL_TOOL_NAME : t)) : [],
    plugins: config ? config.plugins.filter((p) => p.enabled).map((p) => p.name) : [],
    configPath,
    configError: error,
    logFile: config ? service.logFile(config.dataDir) : null,
    launcher: launcherPath(),
    os: process.platform,
  };
}

async function start(configPath: string) {
  if (await service.serving(configPath)) return { message: "baan is already running." };
  const r = await service.enable(configPath);
  if (!(await service.waitServing(configPath, 25)))
    throw new HttpError(500, `baan did not answer. Last lines of the log:\n${service.tail(dataDirOf(configPath), 20)}`);
  return { message: `Running in the background. It starts by itself when ${r.atBoot ? "the computer starts" : "you log in"}.` };
}

async function stop(configPath: string) {
  const k = service.installed();
  if (k) await service.disable(configPath);
  else if (await service.serving(configPath)) {
    const dataDir = dataDirOf(configPath);
    const at = service.sendControl(dataDir, "stop");
    if (!(await service.waitControlDone(dataDir, at, 10)))
      throw new HttpError(500, "baan in the terminal window did not answer. Press q in that window.");
  }
  if (!(await service.waitServing(configPath, 10, false))) throw new HttpError(500, "Something still answers on baan's port.");
  return { message: k ? "Stopped. It no longer starts with the computer." : "Stopped." };
}

async function restart(configPath: string) {
  const dataDir = dataDirOf(configPath);
  if (!(await service.serving(configPath))) {
    if (service.installed()) return start(configPath);
    throw new HttpError(409, "baan is not running. Press Start.");
  }
  const at = service.sendControl(dataDir, "restart");
  const done = await service.waitControlDone(dataDir, at, 40);
  if (!done) throw new HttpError(500, "baan did not answer the restart. Look at the log.");
  if (!done.ok) throw new HttpError(500, done.message);
  if (!(await service.waitServing(configPath, 20))) throw new HttpError(500, "baan restarted but does not answer. Look at the log.");
  return { message: done.message };
}

async function toBackground(configPath: string) {
  if (service.installed()) return { message: "baan already runs in the background." };
  if (!(await service.serving(configPath))) return start(configPath);
  const dataDir = dataDirOf(configPath);
  const at = service.sendControl(dataDir, "background");
  if (!(await service.waitControlDone(dataDir, at, 10))) throw new HttpError(500, "baan in the terminal window did not answer.");
  for (let i = 0; i < 60 && !(service.installed() && (await service.serving(configPath))); i++) await new Promise((r) => setTimeout(r, 500));
  if (!service.installed()) throw new HttpError(500, "Could not move baan to the background. Look at the terminal window.");
  return { message: "baan now runs in the background and starts with the computer. You can close the terminal window." };
}

function settings(configPath: string) {
  const config = loadConfig(configPath);
  const raw = (YAML.parse(readFileSync(configPath, "utf8")) ?? {}) as Record<string, any>;
  return {
    folder: config.workspace.cwd,
    tools: config.tools,
    builtin: BUILTIN,
    shellName: SHELL_TOOL_NAME,
    plugins: config.plugins.map((p) => ({ name: p.name, enabled: p.enabled, canToggle: raw.plugins?.[p.name] !== false })),
    port: config.server.port,
    publicUrl: config.server.publicUrl,
  };
}

interface SettingsBody { folder?: string; tools?: string[]; plugins?: Record<string, boolean>; port?: number }

async function saveSettings(configPath: string, body: SettingsBody) {
  const before = loadConfig(configPath);
  const doc = YAML.parseDocument(readFileSync(configPath, "utf8"));
  if (doc.errors.length) throw new HttpError(400, `The config file has a mistake. Fix it in the editor first:\n${doc.errors[0].message}`);
  const notes: string[] = [];

  if (body.folder !== undefined && expandPath(body.folder) !== before.workspace.cwd) {
    const f = expandPath(String(body.folder));
    if (!existsSync(f) || !statSync(f).isDirectory()) throw new HttpError(400, `Folder not found: ${f}`);
    doc.setIn(["workspace", "cwd"], f);
    const allow = before.workspace.allow;
    // One folder (what setup makes): the AI works in the new folder only. Several: add it to the list.
    if (allow.length <= 1) doc.setIn(["workspace", "allow"], doc.createNode([f]));
    else if (!allow.includes(f)) doc.setIn(["workspace", "allow"], doc.createNode([...((doc.getIn(["workspace", "allow"]) as any)?.toJSON?.() ?? []), f]));
  }
  if (body.tools) {
    const want = new Set(body.tools.map(String));
    for (const t of want) if (!(BUILTIN as readonly string[]).includes(t)) throw new HttpError(400, `Unknown tool: ${t}`);
    const others = before.tools.filter((t) => !(BUILTIN as readonly string[]).includes(t));
    const next = [...BUILTIN.filter((t) => want.has(t)), ...others];
    if (next.join() !== before.tools.join()) doc.setIn(["tools"], doc.createNode(next));
  }
  for (const [name, on] of Object.entries(body.plugins ?? {})) {
    const node = doc.getIn(["plugins", name], true);
    const was = before.plugins.find((p) => p.name === name);
    if (!was) throw new HttpError(400, `Unknown plugin: ${name}`);
    if (was.enabled === on) continue;
    if (!YAML.isMap(node)) throw new HttpError(400, `Turn plugin "${name}" on in the config file (it needs "from:").`);
    if (on) node.delete("enabled"); else node.set("enabled", false);
  }
  if (body.port !== undefined && Number(body.port) !== before.server.port) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HttpError(400, "Port must be a whole number from 1024 to 65535.");
    doc.setIn(["server", "port"], port);
    const pub = before.server.publicUrl;
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(pub)) doc.setIn(["server", "publicUrl"], pub.replace(/:\d+$/, `:${port}`));
    else if (/\.ts\.net$/.test(new URL(pub).hostname))
      notes.push(`Point Tailscale at the new port (in a terminal): tailscale funnel --bg --https=${new URL(pub).port || 443} http://127.0.0.1:${port}`);
    else notes.push(`Point your tunnel (${pub}) at http://127.0.0.1:${port}.`);
  }

  const text = doc.toString();
  if (text === readFileSync(configPath, "utf8")) return { message: "Nothing changed.", notes };
  // Check the new config (and every plugin) before it replaces the old one; the running baan is never broken by a save.
  const tmp = `${configPath}.panel.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  const r = await check(tmp);
  if (!r.ok) { rmSync(tmp, { force: true }); throw new HttpError(400, `Not saved. The new settings have a problem:\n${r.out}`); }
  renameSync(tmp, configPath);
  try { chmodSync(configPath, 0o600); } catch { /* Windows */ }
  const running = await service.serving(configPath).catch(() => false) || (await isUp(before));
  return { message: running ? "Saved. baan restarts by itself with the new settings." : "Saved.", notes };
}

async function isUp(c: Config): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${c.server.port}/`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

async function newPassword(configPath: string) {
  const config = loadConfig(configPath);
  const pw = randomToken(18);
  await new State(config.dataDir).setPassword(pw);
  return { password: pw, message: "New password made. Every connected AI app must sign in again." };
}

// ── http ─────────────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => { size += d.length; if (size > 65536) { fail(new HttpError(413, "Too big")); req.destroy(); } else chunks.push(d); });
    req.on("end", () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { fail(new HttpError(400, "Bad JSON")); } });
    req.on("error", fail);
  });
}

const sameKey = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Run the control panel. If one is already open for this config, just show it. */
export async function runPanel(configPath: string, opts: { open?: boolean } = {}): Promise<void> {
  const open = opts.open !== false;
  const old = readInfo(configPath);
  if (old && (await answers(old))) {
    if (open) openAppWindow(urlOf(old));
    console.log(`baan control panel is already open: http://127.0.0.1:${old.port}/`);
    return;
  }

  const key = randomToken(24);
  let lastSeen = Date.now();
  let byeAt = 0;
  let port = 0;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const routes: Record<string, (body: any) => Promise<unknown> | unknown> = {
    "GET /api/hello": () => ({ ok: true }),
    "GET /api/status": () => status(configPath),
    "GET /api/settings": () => settings(configPath),
    "GET /api/logs": () => {
      const dataDir = dataDirOf(configPath);
      return { text: service.tail(dataDir, 300), file: service.logFile(dataDir), background: !!service.installed() };
    },
    "POST /api/start": () => start(configPath),
    "POST /api/stop": () => stop(configPath),
    "POST /api/restart": () => restart(configPath),
    "POST /api/background": () => toBackground(configPath),
    "POST /api/settings": (b) => saveSettings(configPath, b as SettingsBody),
    "POST /api/password": () => newPassword(configPath),
    "POST /api/open": (b) => {
      const what = String(b?.what);
      const file = what === "config" ? configPath : what === "guide" ? GUIDE : what === "log" ? service.logFile(dataDirOf(configPath)) : "";
      if (!file) throw new HttpError(400, "Unknown file");
      if (!existsSync(file)) throw new HttpError(404, `Not found: ${file}`);
      openFile(file);
      return { message: `Opened ${file}` };
    },
    "POST /api/bye": () => { byeAt = Date.now(); return { ok: true }; },
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (!hosts().has(String(req.headers.host ?? ""))) return send(res, 403, "Forbidden", "text/plain");
      const origin = req.headers.origin;
      if (origin && !hosts().has(origin.replace(/^http:\/\//, ""))) return send(res, 403, "Forbidden", "text/plain");
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, readFileSync(HTML), "text/html; charset=utf-8");
      if (req.method === "GET" && (url.pathname === "/logo.svg" || url.pathname === "/favicon.ico")) return send(res, 200, readFileSync(LOGO), "image/svg+xml");
      if (!url.pathname.startsWith("/api/")) return send(res, 404, "Not found", "text/plain");
      const given = String(req.headers["x-baan-key"] ?? url.searchParams.get("k") ?? "");
      if (!sameKey(given, key)) return send(res, 401, { ok: false, error: "This window has no access. Open baan from its icon." });
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(res, 404, { ok: false, error: "Not found" });
      lastSeen = Date.now();
      if (url.pathname !== "/api/bye") byeAt = 0;
      try {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        const out = await route(body);
        send(res, 200, { ok: true, ...(out as object) });
      } catch (e) {
        send(res, e instanceof HttpError ? e.status : 500, { ok: false, error: (e as Error).message });
      }
    })();
  });

  port = await listen(server, panelPort(configPath));
  const info: Info = { pid: process.pid, port, key };
  writeFileSync(infoFile(configPath), JSON.stringify(info), { mode: 0o600 });
  try { chmodSync(infoFile(configPath), 0o600); } catch { /* Windows */ }

  const quit = () => {
    if (readInfo(configPath)?.pid === process.pid) rmSync(infoFile(configPath), { force: true });
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  setInterval(() => {
    const now = Date.now();
    if (byeAt && now - byeAt > BYE_MS) quit();
    if (now - lastSeen > IDLE_MS) quit();
  }, 2000);

  console.log(`baan control panel: http://127.0.0.1:${port}/  (this computer only; it closes by itself when its window is closed)`);
  if (open) openAppWindow(urlOf(info));
  else console.log(`Open: ${urlOf(info)}`);
}
