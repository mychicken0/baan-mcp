#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { REPO_DIR, defaultConfigPath, loadConfig } from "./config.ts";
import { State, randomToken } from "./state.ts";
import { expandPath } from "./platform.ts";
import { loadTools } from "./plugins.ts";

const HELP = `baan — remote MCP server for your own computer

  baan init [--public-url URL] [--port N] [--tools read,write,edit,bash] [--password-file FILE] [--force]
  baan serve
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
    console.log(`Password saved to ${f} (only you can read it). Keep it somewhere safe, then delete the file.`);
  } else {
    console.log(`\n  Password: ${pw}\n\n  Shown once. You type it on the login page when connecting an AI app.\n`);
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
  const cmd = positionals[0];
  const configPath = values.config ? expandPath(values.config) : defaultConfigPath();

  if (!cmd || values.help) { console.log(HELP); return; }

  if (cmd === "init") {
    if (existsSync(configPath) && !values.force) {
      console.log(`Config already exists: ${configPath} (use --force to overwrite)`);
    } else {
      const doc = YAML.parseDocument(readFileSync(join(REPO_DIR, "baan.example.yml"), "utf8"));
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

  if (cmd === "serve") {
    const { startServer } = await import("./server.ts");
    await startServer(config);
    return;
  }

  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
