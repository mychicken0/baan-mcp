// First-run setup. `npm start` runs this when there is no config yet.
// It asks a few questions, gets a public https URL (Tailscale Funnel by default: free, no domain needed),
// writes the config, sets a password, starts the server and prints exactly what to paste into the AI app.
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
      if (echo) process.stdout.write(s.replace(/^/gm, "    "));
      for (const m of s.matchAll(/https:\/\/login\.tailscale\.com\/\S+/g)) {
        if (opened.has(m[0])) continue;
        opened.add(m[0]);
        console.log(`\n  → Opening that page in your browser. If nothing opens, copy the link above into a browser.\n`);
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
    process.stdout.write(`  ${q}${def ? ` [${def}]` : ""}: `);
    const l = await this.nextLine();
    if (l === null) throw new SetupError("Setup cancelled (input closed).");
    if (!process.stdin.isTTY) process.stdout.write(`${l}\n`);
    return l.trim() || def;
  }
  async yes(q: string, def: boolean): Promise<boolean> {
    const a = (await this.ask(`${q} (y/n)`, def ? "y" : "n")).toLowerCase();
    return a.startsWith("y");
  }
  async choose(q: string, options: string[], def = 1): Promise<number> {
    console.log(`  ${q}`);
    options.forEach((o, i) => console.log(`    ${i + 1}) ${o}`));
    for (;;) {
      const n = Number(await this.ask("Choose", String(def)));
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n;
      console.log(`  Type a number from 1 to ${options.length}.`);
    }
  }
  /** Run a command that may ask for a password (sudo) or show progress, with this terminal handed over to it. */
  async interactive(cmd: string, args: string[]): Promise<number | null> {
    console.log(`\n  $ ${[cmd, ...args].join(" ")}`);
    this.rl.pause();
    const code = await new Promise<number | null>((done) => {
      const c = spawn(cmd, args, { stdio: "inherit" });
      c.on("error", () => done(null));
      c.on("close", done);
    });
    this.rl.resume();
    return code;
  }
}

function header(step: number, total: number, title: string) {
  console.log(`\n── Step ${step}/${total}: ${title} ${"─".repeat(Math.max(0, 50 - title.length))}`);
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
  for (const c of candidates) if ((await run(c, ["version"])).code === 0) return c;
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
      console.log(`\n  Tailscale needs admin rights once, so baan can manage it as "${user}" from now on (no sudo next time).`);
      if (!(await this.w.yes(`Run: sudo tailscale set --operator=${user}`, true))) throw new SetupError("Stopped. Tailscale needs this to turn on Funnel.");
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
        console.log("\n  The Tailscale service is not running on this computer.");
        if (IS_LINUX) {
          if (!(await this.w.yes("Start it now? Runs: sudo systemctl enable --now tailscaled", true))) throw new SetupError("Stopped. Start Tailscale, then run npm start again.");
          await this.w.interactive("sudo", ["systemctl", "enable", "--now", "tailscaled"]);
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          console.log("  Open the Tailscale app (it starts the service), then come back here.");
          await this.w.ask("Press Enter when Tailscale is open");
        }
        continue;
      }
      const dns = String(s.Self?.DNSName ?? "").replace(/\.$/, "");
      if (s.BackendState === "Running" && dns) return dns;
      console.log("\n  Sign in to Tailscale (free, with Google / Microsoft / GitHub / Apple). A sign-in page will open in your browser.");
      const r = await this.run(["up"], true);
      if (r.code !== 0) console.log(`  Tailscale said: ${(r.err || r.out).trim()}`);
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
    if (port !== 443 && !ours(port)) console.log(`  Port 443 is already used by something else in Tailscale, so baan uses ${port}.`);

    console.log("\n  Turning on Tailscale Funnel. The first time, a Tailscale page opens: press the button to allow Funnel, then come back.");
    const r = await this.run(["funnel", "--bg", "--yes", `--https=${port}`, `http://127.0.0.1:${localPort}`], true);
    if (r.code !== 0) throw new SetupError(`Tailscale Funnel failed:\n${(r.err || r.out).trim()}`);
    return port === 443 ? `https://${dns}` : `https://${dns}:${port}`;
  }
}

async function exposeWithTailscale(w: Wizard, localPort: number): Promise<string> {
  let bin = await findTailscale();
  while (!bin) {
    console.log("\n  Tailscale is not installed.");
    if (IS_LINUX) {
      if (!(await w.yes("Install it now with the official script? Runs: curl -fsSL https://tailscale.com/install.sh | sh", true)))
        throw new SetupError(`Install Tailscale (${TAILSCALE_DOWNLOAD}), then run npm start again.`);
      await w.interactive("sh", ["-c", "curl -fsSL https://tailscale.com/install.sh | sh"]);
    } else {
      console.log(`  Opening ${TAILSCALE_DOWNLOAD} — install Tailscale, open it once, then come back here.`);
      openUrl(TAILSCALE_DOWNLOAD);
      await w.ask("Press Enter when Tailscale is installed");
    }
    bin = await findTailscale();
  }
  const ts = new Tailscale(bin, w);
  const dns = await ts.ready();
  console.log(`  ✓ Tailscale is on. This computer is ${dns}`);
  const url = await ts.funnel(dns, localPort);
  console.log(`  ✓ Funnel is on: ${url} → http://127.0.0.1:${localPort}`);
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
    if (!told) { console.log(`  Checking that ${publicUrl} works${maxSec > 120 ? " (a new Tailscale name can take a few minutes)" : ""}…`); told = true; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

export async function runSetup(configPath: string): Promise<void> {
  const w = new Wizard();
  try {
    console.log("\nbaan setup — about 2 minutes. Press Enter to accept the answer in [brackets].");

    if (existsSync(configPath)) {
      console.log(`\n  baan is already set up (${configPath}).`);
      if (!(await w.yes("Set it up again? Your AI apps will need to sign in again", false))) return;
    }
    const TOTAL = 4;

    header(1, TOTAL, "Folder");
    console.log("  The AI can only read and edit files inside this folder.");
    let folder = "";
    for (;;) {
      folder = expandPath(await w.ask("Folder", homedir()));
      if (existsSync(folder) && statSync(folder).isDirectory()) break;
      console.log(`  "${folder}" is not a folder. Try again.`);
    }

    header(2, TOTAL, "What the AI may do");
    const level = await w.choose("Pick one (you can change it later in the config file):", [
      "Read files only  (safest)",
      "Read + create + edit files",
      `Everything, including running commands (${SHELL_TOOL_NAME})`,
    ]);
    let tools = [["read"], ["read", "write", "edit"], ["read", "write", "edit", "bash"]][level - 1];
    if (level === 3) {
      console.log(`\n  ⚠ With ${SHELL_TOOL_NAME}, anyone who logs in can do ANYTHING on this computer as you`);
      console.log("    (delete files, install programs, read secrets) — not only inside the folder above.");
      if ((await w.ask('Type "yes" to allow it')).toLowerCase() !== "yes") {
        console.log("  OK, files only.");
        tools = ["read", "write", "edit"];
      }
    }
    const image = await w.yes("Let the AI look at pictures (PNG/JPEG/GIF/WebP, full quality)?", true);

    header(3, TOTAL, "Reach it from the internet");
    const how = await w.choose("Your AI app (Gemini, Claude, ChatGPT) runs on the internet, so it needs an https address:", [
      "Tailscale Funnel — free, no domain needed  (recommended)",
      "I already have an https address that points here (Cloudflare Tunnel, my own proxy, …)",
      "Only this computer, for testing  (AI apps on the web can't reach it)",
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
        console.log("  It must look like https://something.example.com");
      }
      console.log(`  Point it at http://${host}:${port}`);
    } else publicUrl = `http://localhost:${port}`;

    header(4, TOTAL, "Password");
    const password = randomToken(18);
    console.log("  A strong password was made for you. You'll type it once when you connect an AI app.");

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

    const { startServer } = await import("./server.ts");
    await startServer(config);

    const reachable = how === 3 || (await waitReachable(config.server.publicUrl, how === 1 ? 600 : 60));
    const mcpUrl = `${config.server.publicUrl}/mcp`;
    const copied = await copyToClipboard(mcpUrl);

    const line = "═".repeat(64);
    console.log(`\n${line}`);
    console.log("  ✓ baan is running. Now connect your AI app:\n");
    console.log("  1. In Gemini / Claude / ChatGPT, add a custom connector (MCP server) with this URL:");
    console.log(`\n       ${mcpUrl}${copied ? "   (copied)" : ""}\n`);
    console.log("  2. A baan login page opens. Type this password and press Allow:");
    console.log(`\n       ${password}\n`);
    console.log("     Shown only once — save it in your password manager. New password: npm run passwd");
    if (!reachable) console.log(`\n  ⚠ ${config.server.publicUrl} does not answer yet. Open it in a browser in a few minutes;\n    when it shows "baan MCP server", the AI app will work.`);
    console.log(`\n  Allowed folder: ${folder}`);
    console.log(`  Tools: ${tools.map((t) => (t === "bash" ? SHELL_TOOL_NAME : t)).join(", ")}${image ? ", view_image" : ""}`);
    console.log(`  Config: ${configPath}`);
    console.log("\n  Keep this window open while you use it. Next time just run: npm start");
    console.log(line);
    return;
  } catch (e) {
    if (e instanceof SetupError) { console.error(`\n  ✗ ${e.message}`); process.exitCode = 1; return; }
    throw e;
  } finally {
    w.close();
  }
}
