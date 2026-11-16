// Config = built-in defaults <- YAML file <- environment variables. Nothing user-specific lives in the code.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { defaultConfigDir, expandPath } from "./platform.ts";

export const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface PluginEntry { name: string; from: string; enabled: boolean; options: Record<string, unknown> }

export interface Config {
  configPath: string;
  dataDir: string;
  server: { host: string; port: number; publicUrl: string };
  workspace: { cwd: string; allow: string[] };
  tools: string[];
  shell: { defaultTimeoutSec: number; maxTimeoutSec: number };
  auth: { accessTokenTtlSec: number; refreshTokenTtlSec: number; maxFailedLogins: number; lockoutSec: number };
  audit: { enabled: boolean; file: string };
  plugins: PluginEntry[];
}

const DEFAULTS = {
  server: { host: "127.0.0.1", port: 8790, publicUrl: "" },
  workspace: { cwd: "~", allow: ["~"] },
  tools: ["read"],
  shell: { defaultTimeoutSec: 120, maxTimeoutSec: 600 },
  auth: { accessTokenTtlSec: 3600, refreshTokenTtlSec: 30 * 86400, maxFailedLogins: 10, lockoutSec: 900 },
  audit: { enabled: true, file: "audit.log" },
};

export function defaultConfigPath(): string {
  return process.env.BAAN_CONFIG ? expandPath(process.env.BAAN_CONFIG) : join(defaultConfigDir(), "baan.yml");
}

export function loadConfig(path = defaultConfigPath()): Config {
  if (!existsSync(path)) throw new Error(`Config not found: ${path}\nRun: baan init`);
  const raw = (YAML.parse(readFileSync(path, "utf8")) ?? {}) as Record<string, any>;
  const configDir = dirname(path);
  const env = process.env;

  const server = { ...DEFAULTS.server, ...raw.server };
  if (env.BAAN_HOST) server.host = env.BAAN_HOST;
  if (env.BAAN_PORT) server.port = Number(env.BAAN_PORT);
  if (env.BAAN_PUBLIC_URL) server.publicUrl = env.BAAN_PUBLIC_URL;
  server.publicUrl = String(server.publicUrl || `http://localhost:${server.port}`).replace(/\/+$/, "");

  const dataDir = expandPath(env.BAAN_DATA_DIR || raw.dataDir || ".", configDir);
  const ws = { ...DEFAULTS.workspace, ...raw.workspace };
  const audit = { ...DEFAULTS.audit, ...raw.audit };

  // plugins: { image: { from: ./plugins/image, ...options } } — `false` disables, `true` = defaults.
  const plugins: PluginEntry[] = Object.entries((raw.plugins ?? {}) as Record<string, any>).map(([name, v]) => {
    const o = v === true || v == null ? {} : v === false ? { enabled: false } : { ...v };
    const { from, enabled, ...options } = o;
    const isPath = typeof from === "string" && /^(\.|~|\/|[A-Za-z]:[\\/])/.test(from);
    return {
      name,
      enabled: enabled !== false,
      from: typeof from !== "string" ? join(REPO_DIR, "plugins", name, "index.ts") : isPath ? expandPath(from, configDir) : from,
      options,
    };
  });

  return {
    configPath: path,
    dataDir,
    server,
    workspace: { cwd: expandPath(String(ws.cwd)), allow: (ws.allow as string[]).map((p) => expandPath(String(p))) },
    tools: Array.isArray(raw.tools) ? raw.tools.map(String) : DEFAULTS.tools,
    shell: { ...DEFAULTS.shell, ...raw.shell },
    auth: { ...DEFAULTS.auth, ...raw.auth },
    audit: { enabled: audit.enabled !== false, file: expandPath(String(audit.file), dataDir) },
    plugins,
  };
}
