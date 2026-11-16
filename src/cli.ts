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
  baan setup                              guided setup again (folder, tools, Tailscale, password)
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
      help: { type: "boolean", short: "h" },
    },
  });
  let cmd = positionals[0];
  const configPath = values.config ? expandPath(values.config) : defaultConfigPath();

  if (!cmd || values.help) { console.log(HELP); return; }

  if (cmd === "setup" || (cmd === "start" && !existsSync(configPath))) {
    const { runSetup } = await import("./setup.ts");
    const done = await runSetup(configPath);
    if (cmd === "start" && done) {
      const { supervise } = await import("./supervisor.ts");
      await supervise(configPath, { quietFirst: true });
    }
    return;
  }
  if (cmd === "start") {
    loadConfig(configPath); // fail early with a clear message
    const { supervise } = await import("./supervisor.ts");
    await supervise(configPath);
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
