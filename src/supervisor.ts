// `npm start` runs the server as a child process and restarts it when something changes:
//  - baan.yml is saved (any editor; the folder is watched, so "save via rename" works too)
//  - a plugin's files change
//  - baan's own source changes (after `git pull`, or while you develop)
//  - you press r
// Before every restart the new setup is checked in a separate process. If it is broken
// (YAML typo, plugin that won't load), the running server keeps going and the error is shown.
import { spawn, type ChildProcess } from "node:child_process";
import { watch, readFileSync, existsSync, statSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadConfig } from "./config.ts";
import { openInEditor, stopProcessTree } from "./platform.ts";
import * as ui from "./ui.ts";
import { c } from "./ui.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const GUIDE = fileURLToPath(new URL("../GUIDE.md", import.meta.url));

const passwordOf = (dataDir: string) => {
  try { return String(JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")).passwordHash ?? ""); } catch { return ""; }
};
const dataDirOf = (configPath: string) => { try { return loadConfig(configPath).dataDir; } catch { return dirname(configPath); } };
const hashFile = (f: string) => { try { return createHash("sha1").update(readFileSync(f)).digest("hex"); } catch { return ""; } };

/** What to watch for each enabled plugin: a local file, or the folder of a local/installed package. */
function pluginWatches(configPath: string): { dir: string; file?: string; name: string }[] {
  try {
    const out: { dir: string; file?: string; name: string }[] = [];
    for (const p of loadConfig(configPath).plugins) {
      if (!p.enabled) continue;
      if (existsSync(p.from) && statSync(p.from).isFile()) { out.push({ dir: dirname(p.from), file: basename(p.from), name: p.name }); continue; }
      let dir = existsSync(p.from) ? p.from : "";
      if (!dir) { try { dir = dirname(fileURLToPath(import.meta.resolve(p.from))); } catch { continue; } }
      if (!dir.startsWith(SRC_DIR)) out.push({ dir, name: p.name });
    }
    return out;
  } catch { return []; }
}

const CODE_FILE = /\.(ts|mts|js|mjs|cjs|json)$/;
const IGNORED = /(^|[\\/])(node_modules|\.git)([\\/]|$)|(^|[\\/])state\.json$/;

function childEnv(quiet: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BAAN_SUPERVISED: "1",
    BAAN_QUIET: quiet ? "1" : "",
    FORCE_COLOR: ui.COLOR ? "1" : "0",
    BAAN_ICONS: ui.EMOJI ? "emoji" : "plain",
  };
}

/** Run `baan check` in a fresh process: config parses, every plugin loads. */
function check(configPath: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, [...process.execArgv, CLI, "check", "--config", configPath], {
      stdio: ["ignore", "pipe", "pipe"], env: childEnv(true), windowsHide: true,
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => done({ ok: false, out: String(e) }));
    p.on("close", (code) => done({ ok: code === 0, out: out.trim() }));
  });
}

export async function supervise(configPath: string, opts: { quietFirst?: boolean } = {}): Promise<void> {
  let child: ChildProcess | null = null;
  let busy = false;
  let pending: { why: string; force: boolean } | null = null;
  let quitting = false;
  let watchers: FSWatcher[] = [];
  let configHash = hashFile(configPath);
  let dataDir = dataDirOf(configPath);
  let password = passwordOf(dataDir);

  const start = (quiet: boolean) => {
    const ch = spawn(process.execPath, [...process.execArgv, CLI, "serve", "--config", configPath], {
      stdio: ["ignore", "inherit", "inherit"], env: childEnv(quiet), windowsHide: true,
    });
    child = ch;
    ch.on("exit", (code, sig) => {
      if (child !== ch) return; // replaced on purpose
      child = null;
      if (quitting) return;
      console.log();
      ui.fail(`baan stopped ${c.gray(`(exit ${code ?? sig})`)}`);
      ui.tip(`Fix the problem above and save the config, or press ${c.bold("r")} to try again.`);
    });
  };

  let timer: NodeJS.Timeout | undefined;
  const schedule = (why: string) => {
    if (quitting) return;
    clearTimeout(timer);
    timer = setTimeout(() => void restart(why), 400); // editors write files in several steps
  };

  const rewatch = () => {
    for (const w of watchers) w.close();
    watchers = [];
    const add = (dir: string, recursive: boolean, why: string, filter: (f: string | null) => boolean) => {
      const on = (_e: string, f: string | Buffer | null) => { if (filter(f == null ? null : String(f))) schedule(why); };
      try { watchers.push(watch(dir, { recursive }, on)); }
      catch { try { watchers.push(watch(dir, on)); } catch { /* folder gone */ } }
    };
    const cfgName = basename(configPath);
    dataDir = dataDirOf(configPath);
    add(dirname(configPath), false, "Config saved", (f) => f === null || f === cfgName);
    // `npm run passwd` in another window: restart so the running server uses the new password.
    const pwFilter = (f: string | null) => (f === null || f === "state.json") && passwordOf(dataDir) !== password;
    if (existsSync(dataDir)) add(dataDir, false, "Password changed", pwFilter);
    add(SRC_DIR, true, "baan code changed", (f) => f === null || /\.(ts|js|mjs)$/.test(f));
    for (const w of pluginWatches(configPath)) {
      const why = `Plugin "${w.name}" changed`;
      if (w.file) add(w.dir, false, why, (f) => f === w.file);
      else add(w.dir, true, why, (f) => f !== null && CODE_FILE.test(f) && !IGNORED.test(f));
    }
  };

  const restart = async (why: string, force = false): Promise<void> => {
    if (busy) { if (!pending || force) pending = { why, force }; return; }
    if (why === "Config saved" && !force) {
      const h = hashFile(configPath);
      if (h === configHash) return; // touched, not changed
      configHash = h;
    }
    if (why === "Password changed") {
      const pw = passwordOf(dataDir);
      if (pw === password) return;
      password = pw;
    }
    busy = true;
    try {
      console.log();
      ui.say(`${ui.icon("restart")}${c.bold(c.cyan(why))} ${c.gray("— checking, then restarting…")}  ${ui.time()}`);
      const r = await check(configPath);
      if (!r.ok) {
        ui.fail("Not restarted. The new setup has a problem:");
        console.error(ui.passthrough(r.out) + "\n");
        ui.tip(child ? "The server keeps running with the old setup. Fix it and save again." : "Fix it and save again.");
        return;
      }
      if (child) { const old = child; child = null; await stopProcessTree(old); }
      configHash = hashFile(configPath);
      start(true);
      rewatch();
      password = passwordOf(dataDir);
    } finally {
      busy = false;
      if (pending) { const p = pending; pending = null; void restart(p.why, p.force); }
    }
  };

  const quit = async () => {
    if (quitting) return;
    quitting = true;
    clearTimeout(timer);
    for (const w of watchers) w.close();
    console.log();
    ui.say(`${ui.icon("stop")}Stopping baan…`);
    if (child) await stopProcessTree(child);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };

  const help = () => {
    console.log();
    ui.say(`${ui.key("r", "restart")}   ${ui.key("c", "edit config")}   ${ui.key("g", "guide")}   ${ui.key("q", "quit")}`);
    ui.tip(`Save ${c.bold(basename(configPath))} and baan restarts by itself.`);
    console.log();
  };

  start(!!opts.quietFirst);
  rewatch();
  await new Promise((r) => setTimeout(r, 800)); // let the server print its banner first
  if (!quitting) help();

  process.on("SIGINT", () => void quit());
  process.on("SIGTERM", () => void quit());
  process.on("SIGHUP", () => void quit());

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", async (d: Buffer) => {
      const k = d.toString().toLowerCase();
      if (k === "\x03" || k === "q") return void quit();
      if (k === "r") return void restart("Restart (r)", true);
      if (k === "g") {
        console.log();
        ui.say(`${ui.icon("book")}Guide: ${c.bold(c.cyan(GUIDE))}`);
        return;
      }
      if (k === "c") {
        const inTerminal = !!(process.env.VISUAL || process.env.EDITOR);
        console.log();
        ui.say(`${ui.icon("pencil")}Opening ${c.bold(configPath)} ${c.gray("— save it and baan restarts.")}`);
        if (inTerminal) { process.stdin.setRawMode(false); process.stdin.pause(); }
        await openInEditor(configPath);
        if (inTerminal) { process.stdin.setRawMode(true); process.stdin.resume(); }
        return;
      }
      if (k === "h" || k === "?" || k === "\r" || k === "\n") return help();
    });
  }
  await new Promise(() => {}); // run until quit
}
