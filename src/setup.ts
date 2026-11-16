// First-run setup. `npm start` runs this when there is no config yet.
// It asks a few questions, gets a public https URL (Tailscale Funnel by default: free, no domain needed),
// writes the config, sets a password, starts baan (in the background and with the computer, by default)
// and prints exactly what to paste into the AI app.
import { createInterface, type Interface } from "node:readline";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { loadConfig } from "./config.ts";
import { State, randomToken } from "./state.ts";
import { IS_WINDOWS, SHELL_TOOL_NAME, copyToClipboard, expandPath, openUrl } from "./platform.ts";
import * as ui from "./ui.ts";
import { c } from "./ui.ts";

const IS_LINUX = process.platform === "linux";
const FUNNEL_PORTS = [443, 8443, 10000]; // the only ports Tailscale Funnel allows
const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

class SetupError extends Error {}

interface RunResult { code: number | null; out: string; err: string }

/** Run a command. `echo` shows its output live; Tailscale login/approval links are opened in the browser. */
function run(cmd: string, args: string[], echo = false): Promise<RunResult> {
  return new Promise((done) => {
    let out = "", err = "";
    const opened = new Set<string>();
    const watch = (s: string) => {
      if (echo) process.stdout.write(ui.passthrough(s));
      for (const m of s.matchAll(/https:\/\/login\.tailscale\.com\/\S+/g)) {
        if (opened.has(m[0])) continue;
        opened.add(m[0]);
        console.log();
        ui.say(`${ui.icon("globe")}${c.bold("Opening that page in your browser.")} ${c.gray("Nothing opened? Copy the link above into a browser.")}`);
        console.log();
        openUrl(m[0]);
      }
    };
    let child;
    try { child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (e) { done({ code: null, out, err: String(e) }); return; }
    child.stdout.on("data", (d: Buffer) => { out += d; watch(d.toString()); });
    child.stderr.on("data", (d: Buffer) => { err += d; watch(d.toString()); });
    child.on("error", (e) => done({ code: null, out, err: err + String(e) }));
    child.on("close", (code) => done({ code, out, err }));
  });
}

export class Wizard {
  // Lines are queued as they arrive, so answers typed (or pasted) ahead of the question are never lost.
  private rl: Interface;
  private lines: string[] = [];
  private waiting: ((l: string | null) => void) | null = null;
  private closed = false;
  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    this.rl.on("line", (l) => { if (this.waiting) { const w = this.waiting; this.waiting = null; w(l); } else this.lines.push(l); });
    this.rl.on("close", () => { this.closed = true; this.waiting?.(null); this.waiting = null; });
  }
  close() { this.rl.close(); }

  private nextLine(): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => { this.waiting = r; });
  }

  async ask(q: string, def = ""): Promise<string> {
    // Give readline the prompt, so it redraws it (not its default "> ") when the line is edited.
    this.rl.setPrompt(ui.prompt(q, def));
    this.rl.prompt();
    const l = await this.nextLine();
    if (l === null) throw new SetupError("Setup cancelled (input closed).");
    if (!process.stdin.isTTY) process.stdout.write(`${l}\n`);
    return l.trim() || def;
  }
  async yes(q: string, def: boolean): Promise<boolean> {
    for (;;) {
      const a = (await this.ask(`${q} ${c.gray(def ? "[Y/n]" : "[y/N]")}`)).toLowerCase();
      if (!a) return def;
      if (a.startsWith("y")) return true;
      if (a.startsWith("n")) return false;
      ui.note("   Type y (yes) or n (no), or press Enter.");
    }
  }
  async choose(q: string, opts: ui.Option[], def = 1): Promise<number> {
    ui.say(q);
    console.log();
    ui.options(opts, def);
    for (;;) {
      const n = Number(await this.ask(`Pick 1-${opts.length}`, String(def)));
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) return n;
      ui.warn(`Type a number from 1 to ${opts.length}.`);
    }
  }
  /** Run a command that may ask for a password (sudo) or show progress, with this terminal handed over to it. */
  async interactive(cmd: string, args: string[]): Promise<number | null> {
    ui.command([cmd, ...args].join(" "));
    this.rl.pause();
    const code = await new Promise<number | null>((done) => {
      const ch = spawn(cmd, args, { stdio: "inherit" });
      ch.on("error", () => done(null));
      ch.on("close", done);
    });
    this.rl.resume();
    return code;
  }
}

function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, host, () => s.close(() => done(true)));
  });
}

// ── Tailscale ────────────────────────────────────────────────────────────────

async function findTailscale(): Promise<string | null> {
  const candidates = ["tailscale"];
  if (IS_WINDOWS) candidates.push(`${process.env.ProgramFiles || "C:\\Program Files"}\\Tailscale\\tailscale.exe`);
  if (process.platform === "darwin") candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  for (const cand of candidates) if ((await run(cand, ["version"])).code === 0) return cand;
  return null;
}

const accessDenied = (r: RunResult) => /access denied|permission denied|must be root|operator|sudo/i.test(r.out + r.err);

class Tailscale {
  private bin: string;
  private w: Wizard;
  constructor(bin: string, w: Wizard) { this.bin = bin; this.w = w; }

  /** Run a tailscale command; on Linux, if it needs root, make this user a Tailscale operator once and retry. */
  async run(args: string[], echo = false): Promise<RunResult> {
    let r = await run(this.bin, args, echo);
    if (r.code !== 0 && IS_LINUX && accessDenied(r)) {
      const user = userInfo().username;
      console.log();
      ui.say(`${ui.icon("lock")}Tailscale needs admin rights ${c.bold("once")}, so baan can manage it as ${c.cyan(user)} (no sudo next time).`);
      if (!(await this.w.yes(`Run ${c.cyan(`sudo tailscale set --operator=${user}`)}?`, true))) throw new SetupError("Stopped. Tailscale needs this to turn on Funnel.");
      if ((await this.w.interactive("sudo", [this.bin, "set", `--operator=${user}`])) !== 0) throw new SetupError("Could not set the Tailscale operator.");
      r = await run(this.bin, args, echo);
    }
    return r;
  }

  async status(): Promise<any | null> {
    const r = await run(this.bin, ["status", "--json"]);
    try { return JSON.parse(r.out); } catch { return null; }
  }

  /** Make sure tailscaled runs and this computer is signed in. Returns the machine's DNS name (xxx.ts.net). */
  async ready(): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const s = await this.status();
      if (!s) {
        console.log();
        ui.warn("The Tailscale service is not running on this computer.");
        if (IS_LINUX) {
          if (!(await this.w.yes(`Start it now? ${c.gray("(sudo systemctl enable --now tailscaled)")}`, true))) throw new SetupError("Stopped. Start Tailscale, then run npm start again.");
          await this.w.interactive("sudo", ["systemctl", "enable", "--now", "tailscaled"]);
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          ui.say(`Open the ${c.bold("Tailscale")} app (that starts it), then come back here.`);
          await this.w.ask("Press Enter when Tailscale is open");
        }
        continue;
      }
      const dns = String(s.Self?.DNSName ?? "").replace(/\.$/, "");
      if (s.BackendState === "Running" && dns) return dns;
      console.log();
      ui.say(`${ui.icon("key")}${c.bold("Sign in to Tailscale")} ${c.gray("— free, with Google / Microsoft / GitHub / Apple.")}`);
      ui.note("   A sign-in page opens in your browser.");
      const r = await this.run(["up"], true);
      if (r.code !== 0) ui.warn(`Tailscale said: ${(r.err || r.out).trim()}`);
    }
    throw new SetupError("Tailscale is still not signed in. Open the Tailscale app, sign in, then run npm start again.");
  }

  /** Pick a Funnel port (443 if free) and point it at baan. Returns the public https URL. */
  async funnel(dns: string, localPort: number): Promise<string> {
    const st = await this.run(["serve", "status", "--json"]);
    let cfg: any = {};
    try { cfg = JSON.parse(st.out || "{}"); } catch { /* empty config prints nothing */ }
    const target = (p: number) => cfg?.Web?.[`${dns}:${p}`]?.Handlers?.["/"]?.Proxy as string | undefined;
    const used = (p: number) => !!cfg?.TCP?.[String(p)];
    const ours = (p: number) => { const t = target(p); return !!t && new RegExp(`:${localPort}/?$`).test(t); };
    const port = FUNNEL_PORTS.find(ours) ?? FUNNEL_PORTS.find((p) => !used(p));
    if (!port) throw new SetupError(`Tailscale ports ${FUNNEL_PORTS.join(", ")} are all used by other services. Free one with "tailscale serve status", then run setup again.`);
    if (port !== 443 && !ours(port)) ui.note(`   Port 443 is already used by something else in Tailscale, so baan uses ${port}.`);

    console.log();
    ui.working(`${c.bold("Turning on Tailscale Funnel…")}`);
    ui.note("   First time only: a Tailscale page opens — press the button to allow Funnel, then come back.");
    const r = await this.run(["funnel", "--bg", "--yes", `--https=${port}`, `http://127.0.0.1:${localPort}`], true);
    if (r.code !== 0) throw new SetupError(`Tailscale Funnel failed:\n${(r.err || r.out).trim()}`);
    return port === 443 ? `https://${dns}` : `https://${dns}:${port}`;
  }
}

async function exposeWithTailscale(w: Wizard, localPort: number): Promise<string> {
  let bin = await findTailscale();
  while (!bin) {
    console.log();
    ui.warn("Tailscale is not installed yet.");
    if (IS_LINUX) {
      if (!(await w.yes(`Install it now with the official script? ${c.gray("(curl -fsSL https://tailscale.com/install.sh | sh)")}`, true)))
        throw new SetupError(`Install Tailscale (${TAILSCALE_DOWNLOAD}), then run npm start again.`);
      await w.interactive("sh", ["-c", "curl -fsSL https://tailscale.com/install.sh | sh"]);
    } else {
      ui.say(`${ui.icon("globe")}Opening ${c.cyan(TAILSCALE_DOWNLOAD)} — install Tailscale, open it once, then come back.`);
      openUrl(TAILSCALE_DOWNLOAD);
      await w.ask("Press Enter when Tailscale is installed");
    }
    bin = await findTailscale();
  }
  const ts = new Tailscale(bin, w);
  const dns = await ts.ready();
  ui.ok(`Tailscale is on. This computer is ${c.bold(dns)}`);
  const url = await ts.funnel(dns, localPort);
  ui.ok(`Funnel is on: ${c.bold(url)} ${c.gray(`→ http://127.0.0.1:${localPort}`)}`);
  return url;
}

// ── Main flow ───────────────────────────────────────────────────────────────

/** Wait until the public URL answers with baan's own reply. */
async function waitReachable(publicUrl: string, maxSec: number): Promise<boolean> {
  const until = Date.now() + maxSec * 1000;
  let told = false;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${publicUrl}/`, { signal: AbortSignal.timeout(8000) });
      if (r.ok && (await r.text()).startsWith("baan")) return true;
    } catch { /* not yet */ }
    if (!told) {
      ui.working(`Checking that ${c.bold(publicUrl)} works${maxSec > 120 ? c.gray(" (a new Tailscale name can take a few minutes)") : ""}…`);
      told = true;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/** false: stopped. "background": baan already runs as a service. "window": the caller runs it in this terminal. */
export async function runSetup(configPath: string): Promise<false | "background" | "window"> {
  const w = new Wizard();
  try {
    ui.clearScreen();
    ui.banner("baan setup", "let AI apps use this computer", "About 2 minutes. Press Enter to keep the answer shown in (gray).");

    if (existsSync(configPath)) {
      console.log();
      ui.say(`baan is already set up ${c.gray(`(${configPath})`)}`);
      if (!(await w.yes("Set it up again? Your AI apps will need to sign in again", false))) return false;
      const service = await import("./service.ts");
      if (service.installed()) {
        await service.disable(configPath); // frees the port; turned on again below if you pick it
        ui.note("   Stopped the background copy for now.");
      }
    }
    const TOTAL = 5;

    ui.step(1, TOTAL, "folder", "Folder");
    ui.say("The AI can only read and edit files inside this folder.");
    console.log();
    let folder = "";
    for (;;) {
      folder = expandPath(await w.ask("Folder", homedir()));
      if (existsSync(folder) && statSync(folder).isDirectory()) break;
      ui.warn(`"${folder}" is not a folder. Try again.`);
    }
    ui.ok(folder);

    ui.step(2, TOTAL, "lock", "What the AI may do");
    const level = await w.choose(`Pick one ${c.gray("(change it any time: npm run config)")}:`, [
      { icon: "bolt", label: "Everything", note: "recommended", tone: "good",
        detail: `read + write + edit files, and run commands (${SHELL_TOOL_NAME}) — what pi does` },
      { icon: "pencil", label: "Files only", detail: "read + write + edit, no commands" },
      { icon: "eye", label: "Read only", detail: "the AI can look, not change anything" },
    ]);
    const tools = [["read", "write", "edit", "bash"], ["read", "write", "edit"], ["read"]][level - 1];
    if (level === 1) {
      ui.danger(`Good to know: ${SHELL_TOOL_NAME} can do anything you can do on this computer`, [
        "so only you should know the password (setup makes a strong one).",
        `${SHELL_TOOL_NAME} is not limited to the folder above.`,
      ]);
    }
    console.log();
    const image = await w.yes(`${ui.icon("picture")}Let the AI look at pictures? ${c.gray("(PNG/JPEG/GIF/WebP, full quality)")}`, true);
    ui.ok(`Tools: ${tools.map((t) => (t === "bash" ? SHELL_TOOL_NAME : t)).join(", ")}${image ? ", view_image" : ""}`);

    ui.step(3, TOTAL, "globe", "Reach it from the internet");
    const how = await w.choose(`Gemini / Claude / ChatGPT run on the internet, so baan needs an ${c.bold("https")} address:`, [
      { icon: "globe", label: "Tailscale Funnel", note: "recommended", tone: "good", detail: "free, no domain needed — baan sets it up for you" },
      { icon: "link", label: "My own https address", detail: "Cloudflare Tunnel, your own domain, a reverse proxy…" },
      { icon: "laptop", label: "Only this computer", detail: "for testing — web AI apps can't reach it" },
    ]);

    const example = readFileSync(fileURLToPath(new URL("../baan.example.yml", import.meta.url)), "utf8");
    const doc = YAML.parseDocument(example);
    let port = Number(doc.getIn(["server", "port"]));
    const host = String(doc.getIn(["server", "host"]));
    while (!(await portIsFree(port, host))) port++;

    let publicUrl: string;
    if (how === 1) publicUrl = await exposeWithTailscale(w, port);
    else if (how === 2) {
      for (;;) {
        publicUrl = (await w.ask("Your https address (without /mcp)")).replace(/\/+$/, "").replace(/\/mcp$/, "");
        if (/^https:\/\/[^/\s]+$/.test(publicUrl)) break;
        ui.warn("It must look like https://something.example.com");
      }
      ui.tip(`Point that address at ${c.bold(`http://${host}:${port}`)}`);
    } else publicUrl = `http://localhost:${port}`;

    ui.step(4, TOTAL, "rocket", "Keep it running");
    const keep = await w.choose("When should baan run?", [
      { icon: "rocket", label: "Always, in the background", note: "recommended", tone: "good",
        detail: "starts by itself with the computer — you can close this window" },
      { icon: "laptop", label: "Only while this window is open", detail: "stops when you close it (press b later to switch)" },
    ]);
    const background = keep === 1;
    if (background && IS_LINUX) {
      const service = await import("./service.ts");
      if (service.kind() === "systemd" && !service.linger()) {
        ui.say(`${ui.icon("lock")}To start ${c.bold("before anyone logs in")} (right after the computer starts), Linux needs admin rights once.`);
        if (await w.yes(`Run ${c.cyan(`sudo loginctl enable-linger ${userInfo().username}`)}? ${c.gray("(No = starts when you log in)")}`, true))
          await w.interactive("sudo", ["loginctl", "enable-linger", userInfo().username]);
      }
    }

    ui.step(5, TOTAL, "key", "Password");
    const password = randomToken(18);
    ui.ok("A strong password was made for you.");
    ui.note("   You type it once, on the login page, when you connect an AI app.");

    doc.setIn(["server", "port"], port);
    doc.setIn(["server", "publicUrl"], publicUrl);
    doc.setIn(["workspace", "cwd"], folder);
    doc.setIn(["workspace", "allow"], doc.createNode([folder]));
    doc.setIn(["tools"], doc.createNode(tools));
    if (!image) doc.deleteIn(["plugins", "image"]);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, doc.toString(), { mode: 0o600 });

    const config = loadConfig(configPath);
    const state = new State(config.dataDir);
    await state.setPassword(password); // also signs out every app connected before

    console.log();
    const { startServer } = await import("./server.ts");
    const server = await startServer(config, { quiet: true });

    const reachable = how === 3 || (await waitReachable(config.server.publicUrl, how === 1 ? 600 : 60));
    await server.close(); // from here baan runs with auto-restart: as a background service, or in this window

    let bgResult: import("./service.ts").EnableResult | null = null;
    if (background) {
      const service = await import("./service.ts");
      ui.working(`${c.bold("Starting baan in the background")} ${c.gray(`(${service.KIND_TEXT[service.kind()]})`)}…`);
      try {
        bgResult = await service.enable(configPath);
        if (!(await service.waitServing(configPath, 20))) throw new Error(`It did not answer. Log:\n${service.tail(config.dataDir, 15)}`);
      } catch (e) {
        bgResult = null;
        await service.disable(configPath).catch(() => null);
        ui.fail(`Could not run in the background: ${(e as Error).message}`);
        ui.tip("baan runs in this window instead. Try again later with: npm run background");
      }
    }

    const mcpUrl = `${config.server.publicUrl}/mcp`;
    const copied = await copyToClipboard(mcpUrl);

    console.log();
    ui.rule(c.green);
    console.log();
    ui.say(`${ui.icon("party")}${c.bold(c.green("All set! baan is running."))} ${c.gray("Now connect your AI app:")}`);
    console.log();
    ui.instruction(1, "In Gemini / Claude / ChatGPT, add a custom connector (MCP server) with this URL:",
      `${ui.icon("link")}${c.bold(c.cyan(c.underline(mcpUrl)))}`, copied ? c.green(`${ui.icon("copy")}copied`) : "");
    ui.instruction(2, "A baan login page opens. Type this password and press Allow:",
      `${ui.icon("key")}${c.bold(c.yellow(password))}`);
    ui.warn(`Shown only once — save it in your password manager now. ${c.gray("New password: npm run passwd")}`);
    if (!reachable) {
      console.log();
      ui.warn(`${config.server.publicUrl} does not answer yet.`);
      ui.note(`   Open it in a browser in a few minutes; when it shows "baan MCP server", the AI app will work.`);
    }
    console.log();
    ui.rows([
      ["folder", "Folder", folder],
      ["tools", "Tools", tools.map((t) => (t === "bash" ? SHELL_TOOL_NAME : t)).join(", ") + (image ? ", view_image" : "")],
      ["gear", "Config", configPath],
    ]);
    if (bgResult) {
      const { printBackground } = await import("./supervisor.ts");
      printBackground(bgResult, configPath, config.dataDir);
      ui.tip(`Change something later? Edit the config and save — baan restarts by itself. ${c.gray("See GUIDE.md")}`);
      ui.rule(c.green);
      console.log();
      return "background";
    }
    console.log();
    ui.tip(`Keep this window open while you use it. Next time just run: ${c.bold(c.cyan("npm start"))}`);
    ui.tip(`Change something later? Edit the config and save — baan restarts by itself. ${c.gray("See GUIDE.md")}`);
    ui.rule(c.green);
    return "window";
  } catch (e) {
    if (e instanceof SetupError) { ui.fail(e.message); process.exitCode = 1; return false; }
    throw e;
  } finally {
    w.close();
  }
}
