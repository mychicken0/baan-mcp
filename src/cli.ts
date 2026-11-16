#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { fileURLToPath } from "node:url";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { State, randomToken } from "./state.ts";
import { expandPath } from "./platform.ts";
import { loadTools } from "./plugins.ts";
import * as ui from "./ui.ts";
import { c } from "./ui.ts";

const HELP = `baan — remote MCP server for your own computer

  baan start                              first time: guided setup. Then run, and restart by itself when the config,
                                          a plugin or baan's code changes (keys: r restart, c edit config, q quit)
  baan setup                              guided setup again (folder, tools, Tailscale, background, password)
  baan background                         run in the background and start with the computer (all OSes, no admin)
  baan stop                               stop the background copy; it no longer starts with the computer
  baan panel [--no-open]                  control panel window: start, stop, restart, settings, password, log
  baan app                                make the "baan" icon in the baan folder that opens the control panel
  baan status                             is it running? where are the logs?
  baan logs                               last lines of the background log
  baan run                                what the background service runs: auto-restart, no keyboard
  baan config                             open the config file in an editor
  baan check                              check the config and load every plugin, without starting
  baan init [--public-url URL] [--port N] [--tools read,write,edit,bash] [--password-file FILE] [--force]
  baan serve                              run once, no auto-restart (for services / scripts)
  baan passwd [--password-file FILE]     new random password, signs out every app
  baan tools                              list enabled tools

Options: --config FILE (default: $BAAN_CONFIG or ${defaultConfigPath()})`;

async function newPassword(state: State, file?: string) {
  const pw = randomToken(18);
  await state.setPassword(pw);
  if (file) {
    const f = expandPath(file);
    writeFileSync(f, pw + "\n", { mode: 0o600 });
    try { chmodSync(f, 0o600); } catch { /* Windows */ }
    ui.ok(`Password saved to ${f} ${c.gray("(only you can read it). Keep it somewhere safe, then delete the file.")}`);
  } else {
    console.log();
    ui.say(`${ui.icon("key")}${c.gray("New password:")}  ${c.bold(c.yellow(pw))}`);
    console.log();
    ui.warn(`Shown only once. ${c.gray("Type it on the baan login page when you connect an AI app.")}`);
    ui.tip("Every connected AI app must sign in again. If baan is running (npm start), it restarts by itself.");
    console.log();
  }
}

async function status(configPath: string) {
  const service = await import("./service.ts");
  const config = loadConfig(configPath);
  const k = service.installed();
  const up = await service.serving(configPath);
  console.log();
  if (up) ui.ok(`baan is running${k ? " in the background" : " (in a terminal window)"}.`);
  else ui.warn("baan is not running.");
  ui.rows([
    ["rocket", "Starts with computer", k ? `yes ${c.gray(`(${service.KIND_TEXT[k]})`)}` : `no ${c.gray("(turn on: npm run background)")}`],
    ["link", "URL for your AI app", c.bold(c.cyan(`${config.server.publicUrl}/mcp`))],
    ["laptop", "Local", `http://${config.server.host}:${config.server.port}`],
    ["gear", "Config", configPath],
    ...(k ? [["book", "Logs", `npm run logs   ${c.gray(service.logFile(config.dataDir))}`] as [ui.IconName, string, string]] : []),
  ]);
  if (k) ui.tip(`Stop it: ${c.bold("npm stop")}`);
  console.log();
}

/** Make the baan icon in the baan folder if it is not there yet (people who set up before it existed). */
async function ensureLauncher(configPath: string): Promise<void> {
  const { createLauncher, launcherPath } = await import("./app.ts");
  if (existsSync(launcherPath())) return;
  try {
    const f = createLauncher(configPath);
    ui.ok(`New: a ${c.bold("baan")} icon in the baan folder opens the control panel ${c.gray(`(${f})`)}`);
  } catch (e) { ui.note(`(Could not make the baan icon: ${(e as Error).message})`); }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "public-url": { type: "string" },
      port: { type: "string" },
      tools: { type: "string" },
      "password-file": { type: "string" },
      force: { type: "boolean" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  let cmd = positionals[0];
  const configPath = values.config ? expandPath(values.config) : defaultConfigPath();

  if (!cmd || values.help) { console.log(HELP); return; }

  if (cmd === "setup" || (cmd === "start" && !existsSync(configPath))) {
    const { runSetup } = await import("./setup.ts");
    const mode = await runSetup(configPath);
    if (mode === "window") {
      const { supervise } = await import("./supervisor.ts");
      await supervise(configPath, { quietFirst: true });
    }
    return;
  }
  if (cmd === "panel") {
    const { runPanel } = await import("./panel.ts");
    await runPanel(configPath, { open: !values["no-open"] });
    return;
  }
  if (cmd === "app") {
    const { createLauncher } = await import("./app.ts");
    const f = createLauncher(configPath);
    ui.ok(`Made ${c.bold(f)}`);
    ui.tip("Double-click it to open the baan control panel. You can also drag it to your desktop or dock / taskbar.");
    return;
  }
  if (cmd === "start") {
    loadConfig(configPath); // fail early with a clear message
    await ensureLauncher(configPath);
    const service = await import("./service.ts");
    if (service.installed()) {
      // Already set to run in the background: make sure it runs, show where things are, and let the window go.
      if (!(await service.serving(configPath))) {
        ui.working("baan is set to run in the background but is not answering. Starting it…");
        await service.enable(configPath);
        await service.waitServing(configPath, 20);
      }
      await status(configPath);
      ui.tip(`To run it in this window instead: ${c.bold("npm stop")}, then ${c.bold("npm start")}.`);
      return;
    }
    if (await service.serving(configPath)) {
      ui.warn("baan is already running in another window.");
      ui.tip(`Go to that window, or close it first. Port: ${loadConfig(configPath).server.port}`);
      process.exitCode = 1;
      return;
    }
    const { supervise } = await import("./supervisor.ts");
    await supervise(configPath);
    return;
  }
  if (cmd === "run") {
    loadConfig(configPath);
    const { supervise } = await import("./supervisor.ts");
    await supervise(configPath, { background: true, quietFirst: false });
    return;
  }
  if (cmd === "background") {
    const config = loadConfig(configPath);
    const service = await import("./service.ts");
    const { printBackground } = await import("./supervisor.ts");
    if (!service.installed() && (await service.serving(configPath))) {
      ui.warn("baan is running in another window. Press b in that window instead, or close it first.");
      process.exitCode = 1;
      return;
    }
    ui.working("Starting baan in the background…");
    const r = await service.enable(configPath);
    if (!(await service.waitServing(configPath, 20))) {
      ui.fail(`baan did not answer. Last lines of ${service.logFile(config.dataDir)}:`);
      console.error(ui.passthrough(service.tail(config.dataDir, 20)));
      process.exitCode = 1;
      return;
    }
    printBackground(r, configPath, config.dataDir);
    return;
  }
  if (cmd === "stop") {
    const service = await import("./service.ts");
    const k = await service.disable(configPath);
    const up = existsSync(configPath) ? !(await service.waitServing(configPath, 5, false)) : false;
    if (k) ui.ok(`Stopped. baan no longer starts with the computer. ${c.gray(`(${service.KIND_TEXT[k]} removed)`)}`);
    else ui.say("baan was not set to run in the background.");
    if (up) ui.warn("Something still answers on baan's port — probably baan in another window. Press q there.");
    ui.tip(`Run it again: ${c.bold("npm start")} ${c.gray("(this window)")} or ${c.bold("npm run background")}`);
    return;
  }
  if (cmd === "status") { await status(configPath); return; }
  if (cmd === "logs") {
    const service = await import("./service.ts");
    const { dataDir } = loadConfig(configPath);
    const t = service.tail(dataDir, 60);
    console.log(t || "(no background log yet)");
    console.log();
    ui.tip(`Full log: ${service.logFile(dataDir)}`);
    return;
  }
  if (cmd === "config") {
    const { openInEditor } = await import("./platform.ts");
    ui.say(`${ui.icon("pencil")}${c.bold(configPath)}`);
    ui.tip(`Save it. If baan is running (npm start), it restarts by itself.`);
    await openInEditor(configPath);
    return;
  }

  if (cmd === "init") {
    if (existsSync(configPath) && !values.force) {
      console.log(`Config already exists: ${configPath} (use --force to overwrite)`);
    } else {
      const doc = YAML.parseDocument(readFileSync(fileURLToPath(new URL("../baan.example.yml", import.meta.url)), "utf8"));
      const port = Number(values.port ?? doc.getIn(["server", "port"]));
      doc.setIn(["server", "port"], port);
      doc.setIn(["server", "publicUrl"], values["public-url"] ?? `http://localhost:${port}`);
      if (values.tools) doc.setIn(["tools"], values.tools.split(",").map((s) => s.trim()).filter(Boolean));
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, doc.toString(), { mode: 0o600 });
      console.log(`Wrote ${configPath}`);
    }
    const config = loadConfig(configPath);
    const state = new State(config.dataDir);
    if (state.data.passwordHash && !values.force) console.log("Password already set (use `baan passwd` to change it).");
    else await newPassword(state, values["password-file"]);
    console.log(`Next: baan serve, then expose http://${config.server.host}:${config.server.port} at ${config.server.publicUrl}`);
    return;
  }

  const config = loadConfig(configPath);

  if (cmd === "passwd") { await newPassword(new State(config.dataDir), values["password-file"]); return; }

  if (cmd === "tools") {
    const { tools } = await loadTools(config);
    for (const t of tools) console.log(`${t.name.padEnd(14)} [${t.plugin}] ${t.description.split(". ")[0]}`);
    return;
  }

  if (cmd === "check") {
    const { tools, plugins } = await loadTools(config);
    ui.ok(`Config OK. Tools: ${tools.map((t) => t.name).join(", ")}${plugins.length ? c.gray(`  (plugins: ${plugins.join(", ")})`) : ""}`);
    return;
  }

  if (cmd === "serve") {
    const { startServer } = await import("./server.ts");
    const supervised = process.env.BAAN_SUPERVISED === "1";
    const srv = await startServer(config, { quiet: process.env.BAAN_QUIET === "1", supervised });
    const stop = () => void srv.close().finally(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return;
  }

  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((e) => { ui.fail((e as Error).message); process.exit(1); });
