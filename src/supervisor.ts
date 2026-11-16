// `npm start` runs the server as a child process and restarts it when something changes:
//  - baan.yml is saved (any editor; the folder is watched, so "save via rename" works too)
//  - a plugin's files change
//  - baan's own source changes (after `git pull`, or while you develop)
//  - you press r
// Before every restart the new setup is checked in a separate process. If it is broken
// (YAML typo, plugin that won't load), the running server keeps going and the error is shown.
// Background mode (`baan run`, used by the start-with-computer service) is the same without the keyboard,
// writes a pid file, and also brings the server back by itself if it crashes.
// Both modes also take orders from the control panel (restart / stop / move to the background) through
// <data folder>/baan.control, and answer in baan.control.done.
import { spawn, type ChildProcess } from "node:child_process";
import { watch, readFileSync, existsSync, statSync, writeFileSync, rmSync, mkdirSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadConfig } from "./config.ts";
import { openInEditor, stopProcessTree } from "./platform.ts";
import * as ui from "./ui.ts";
import { c } from "./ui.ts";
import * as service from "./service.ts";
import { ROOT } from "./app.ts";

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

export async function supervise(configPath: string, opts: { quietFirst?: boolean; background?: boolean } = {}): Promise<void> {
  const bg = !!opts.background;
  let crashes = 0;
  let startedAt = 0;
  let retry: NodeJS.Timeout | undefined;
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
    startedAt = Date.now();
    ch.on("exit", (code, sig) => {
      if (child !== ch) return; // replaced on purpose
      child = null;
      if (quitting) return;
      console.log();
      ui.fail(`baan stopped ${c.gray(`(exit ${code ?? sig})`)}  ${ui.time()}`);
      if (bg) return retryLater();
      ui.tip(`Fix the problem above and save the config, or press ${c.bold("r")} to try again.`);
    });
  };

  /** Background mode: bring the server back after a crash, waiting longer each time (5 s … 1 min). */
  const retryLater = () => {
    if (quitting) return;
    crashes = Date.now() - startedAt > 120_000 ? 1 : crashes + 1;
    const sec = Math.min(60, 5 * crashes);
    ui.note(`Trying again in ${sec} s.`);
    clearTimeout(retry);
    retry = setTimeout(() => void restart("Starting again after a stop", true), sec * 1000);
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
    // Orders from the control panel.
    const ctl = basename(service.controlFile(dataDir));
    try { if (existsSync(dataDir)) watchers.push(watch(dataDir, (_e, f) => { if (f == null || String(f) === ctl) void onControl(); })); } catch { /* ignore */ }
    add(SRC_DIR, true, "baan code changed", (f) => f === null || /\.(ts|js|mjs)$/.test(f));
    for (const w of pluginWatches(configPath)) {
      const why = `Plugin "${w.name}" changed`;
      if (w.file) add(w.dir, false, why, (f) => f === w.file);
      else add(w.dir, true, why, (f) => f !== null && CODE_FILE.test(f) && !IGNORED.test(f));
    }
  };

  /** true = restarted, false = the new setup is broken (old one keeps running), undefined = nothing to do / queued. */
  const restart = async (why: string, force = false): Promise<boolean | undefined> => {
    if (busy) { if (!pending || force) pending = { why, force }; return undefined; }
    if (why === "Config saved" && !force) {
      const h = hashFile(configPath);
      if (h === configHash) return undefined; // touched, not changed
      configHash = h;
    }
    if (why === "Password changed") {
      const pw = passwordOf(dataDir);
      if (pw === password) return undefined;
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
        if (bg && !child) retryLater();
        return false;
      }
      if (child) { const old = child; child = null; await stopProcessTree(old); }
      configHash = hashFile(configPath);
      start(true);
      rewatch();
      password = passwordOf(dataDir);
      return true;
    } finally {
      busy = false;
      if (pending) { const p = pending; pending = null; void restart(p.why, p.force); }
    }
  };

  let controlBusy = false;
  const onControl = async () => {
    if (controlBusy || quitting) return;
    const f = service.controlFile(dataDir);
    let cmd = "";
    try { cmd = readFileSync(f, "utf8").trim(); } catch { return; }
    rmSync(f, { force: true });
    controlBusy = true;
    const done = (ok: boolean, message: string) => service.writeControlDone(dataDir, { cmd, ok, message });
    try {
      if (cmd === "restart") {
        const r = await restart("Restart (control panel)", true);
        done(r !== false, r === false ? "Not restarted: the setup has a problem, so the old one keeps running. Look at the log." : r ? "Restarted." : "Restart queued.");
      } else if (cmd === "stop") {
        done(true, "Stopping.");
        await quit();
      } else if (cmd === "background" && !bg) {
        done(true, "Moving to the background.");
        await toBackground();
      } else done(false, `Unknown order: ${cmd}`);
    } finally { controlBusy = false; }
  };

  const quit = async () => {
    if (quitting) return;
    quitting = true;
    clearTimeout(timer);
    clearTimeout(retry);
    for (const w of watchers) w.close();
    console.log();
    ui.say(`${ui.icon("stop")}Stopping baan…`);
    if (child) await stopProcessTree(child);
    if (bg) rmSync(service.pidFile(dataDir), { force: true });
    if (process.stdin.isTTY && !bg) process.stdin.setRawMode(false);
    process.exit(0);
  };

  /** Key b: move this window's baan to the background service (starts with the computer), then let the window go. */
  const toBackground = async () => {
    if (quitting) return;
    quitting = true;
    clearTimeout(timer);
    for (const w of watchers) w.close();
    watchers = [];
    console.log();
    ui.working(`${c.bold("Moving baan to the background")} ${c.gray("— it will start by itself when the computer starts…")}`);
    if (child) { const old = child; child = null; await stopProcessTree(old); }
    try {
      const r = await service.enable(configPath);
      const up = await service.waitServing(configPath, 20);
      if (!up) throw new Error(`It did not answer. Last lines of ${service.logFile(dataDir)}:\n${service.tail(dataDir, 15)}`);
      printBackground(r, configPath, dataDir);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.exit(0);
    } catch (e) {
      ui.fail(`Could not run in the background: ${(e as Error).message}`);
      ui.tip("baan keeps running in this window instead.");
      quitting = false;
      start(true);
      rewatch();
      help();
    }
  };

  const help = () => {
    console.log();
    ui.say(`${ui.key("b", "run in background")}   ${ui.key("p", "control panel")}   ${ui.key("r", "restart")}   ${ui.key("c", "edit config")}   ${ui.key("g", "guide")}   ${ui.key("q", "quit")}`);
    ui.tip(`Press ${c.bold("b")} to keep baan running after you close this window ${c.gray("(and start it with the computer)")}.`);
    ui.tip(`Save ${c.bold(basename(configPath))} and baan restarts by itself.`);
    console.log();
  };

  if (bg) {
    mkdirSync(dataDir, { recursive: true });
    service.trimLog(dataDir);
    writeFileSync(service.pidFile(dataDir), String(process.pid));
    console.log();
    ui.say(`${ui.icon("rocket")}baan started in the background ${c.gray(`(pid ${process.pid})`)}  ${new Date().toISOString()}`);
  }
  start(!!opts.quietFirst);
  rewatch();
  await new Promise((r) => setTimeout(r, 800)); // let the server print its banner first
  if (!quitting && !bg) help();

  process.on("SIGINT", () => void quit());
  process.on("SIGTERM", () => void quit());
  process.on("SIGHUP", () => void (bg ? undefined : quit()));

  if (process.stdin.isTTY && !bg) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", async (d: Buffer) => {
      const k = d.toString().toLowerCase();
      if (k === "\x03" || k === "q") return void quit();
      if (k === "r") return void restart("Restart (r)", true);
      if (k === "b") return void toBackground();
      if (k === "p") {
        console.log();
        ui.say(`${ui.icon("home")}Opening the control panel… ${c.gray("(or double-click baan in the baan folder)")}`);
        spawn(process.execPath, [...process.execArgv, CLI, "panel", "--config", configPath], { stdio: "ignore", detached: true, windowsHide: true }).unref();
        return;
      }
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

/** What to tell the user once baan runs in the background. */
export function printBackground(r: service.EnableResult, configPath: string, dataDir: string): void {
  console.log();
  ui.ok(`baan is running in the background. ${c.bold("You can close this window.")}`);
  ui.say(`${ui.icon("rocket")}${r.atBoot ? "It starts by itself when the computer starts." : "It starts by itself when you log in to this computer."} ${c.gray(`(${service.KIND_TEXT[r.kind]})`)}`);
  if (r.note) ui.note(`   ${r.note}`);
  ui.tip(`Save ${c.bold(basename(configPath))} and it still restarts by itself.`);
  console.log();
  ui.rows([
    ["gear", "Status", "npm run status"],
    ["book", "Logs", `npm run logs   ${c.gray(service.logFile(dataDir))}`],
    ["stop", "Stop", `npm stop   ${c.gray("(stops it and no longer starts with the computer)")}`],
    ["home", "Control panel", `double-click ${c.bold("baan")} in ${ROOT}   ${c.gray("(or npm run panel)")}`],
  ]);
  console.log();
}
