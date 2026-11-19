import { appendFile } from "node:fs/promises";
import { realpathSync, existsSync } from "node:fs";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Config } from "./config.ts";
import { BaanAuthProvider, LOGIN_PATH } from "./auth.ts";
import { State } from "./state.ts";
import { loadTools, type LoadedTool } from "./plugins.ts";
import { expandPath, isInside, realPathLoose } from "./platform.ts";
import type { ToolContent, ToolContext } from "./plugin.ts";
import * as ui from "./ui.ts";
import { c } from "./ui.ts";

const VERSION = "0.1.0";

function clip(v: unknown): unknown {
  if (typeof v === "string") return v.length > 500 ? `${v.slice(0, 500)}…(${v.length} chars)` : v;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
  return v;
}

export interface RunningServer { close(): Promise<void> }

export async function startServer(config: Config, opts: { quiet?: boolean; supervised?: boolean } = {}): Promise<RunningServer> {
  const state = new State(config.dataDir);
  if (!state.data.passwordHash) throw new Error("No password set. Run: baan init  (or baan passwd)");

  const { tools, plugins } = await loadTools(config);
  const toolNames = tools.map((t) => t.name);
  const allowRoots = config.workspace.allow.map((p) => (existsSync(p) ? realpathSync.native(p) : p));

  const resolvePath = (p: string): string => {
    const abs = realPathLoose(expandPath(p, config.workspace.cwd));
    if (!allowRoots.some((r) => isInside(abs, r))) throw new Error(`Access denied: ${abs} is outside workspace.allow`);
    return abs;
  };

  const audit = async (rec: Record<string, unknown>) => {
    if (!config.audit.enabled) return;
    try { await appendFile(config.audit.file, JSON.stringify({ time: new Date().toISOString(), ...rec }) + "\n", { mode: 0o600 }); }
    catch (e) { console.error("[audit]", (e as Error).message); }
  };

  const buildMcp = (clientId: string) => {
    const mcp = new McpServer(
      { name: "baan", version: VERSION },
      {
        instructions:
          `Tools on the user's own computer (${process.platform}). Working directory: ${config.workspace.cwd}. ` +
          `Relative paths resolve from there. Tools: ${toolNames.join(", ")}.`,
      },
    );
    for (const t of tools) registerTool(mcp, t, clientId);
    return mcp;
  };

  const registerTool = (mcp: McpServer, t: LoadedTool, clientId: string) => {
    mcp.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive },
      },
      async (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
        const started = Date.now();
        const ctx: ToolContext = {
          cwd: config.workspace.cwd, resolvePath, signal: extra.signal, toolNames,
          client: { id: clientId, name: state.data.clients[clientId]?.client_name },
        };
        try {
          const out = await t.run(args, ctx);
          const content: ToolContent[] = typeof out === "string" ? [{ type: "text", text: out }] : out;
          await audit({ client: clientId, tool: t.name, plugin: t.plugin, args: clip(args), ok: true, ms: Date.now() - started });
          return { content };
        } catch (e) {
          const msg = (e as Error).message;
          await audit({ client: clientId, tool: t.name, plugin: t.plugin, args: clip(args), ok: false, error: msg, ms: Date.now() - started });
          return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
        }
      },
    );
  };

  const provider = new BaanAuthProvider(state, config);
  const publicUrl = new URL(config.server.publicUrl);
  const mcpUrl = new URL("/mcp", publicUrl);

  const app = express();
  app.disable("x-powered-by");
  // baan listens on loopback and is reached through a tunnel (Tailscale/Cloudflare), which adds X-Forwarded-For.
  app.set("trust proxy", "loopback");

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: "baan",
      scopesSupported: ["mcp"],
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );
  app.post(LOGIN_PATH, express.urlencoded({ extended: false, limit: "16kb" }), provider.handleLogin);

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  // Stateless MCP: every request is independent, so restarting baan never breaks a connected client.
  app.post("/mcp", bearer, express.json({ limit: "50mb" }), async (req, res) => {
    const mcp = buildMcp(req.auth?.clientId ?? "?");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[mcp]", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const notAllowed = (_req: express.Request, res: express.Response) =>
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  app.get("/mcp", bearer, notAllowed);
  app.delete("/mcp", bearer, notAllowed);
  app.get("/", (_req, res) => res.type("text").send("baan MCP server. Connect your AI app to /mcp\n"));

  const { host, port } = config.server;
  const srv = await new Promise<import("node:http").Server>((ok, fail) => {
    const s = app.listen(port, host, () => ok(s));
    s.on("error", fail);
  });
  const local = `http://${host}:${port}`;
  const toolList = toolNames.join(", ") + (plugins.length ? c.gray(`  (plugins: ${plugins.join(", ")})`) : "");
  if (opts.quiet) ui.ok(`Running on ${local}  ${c.gray("·")}  ${toolList}`);
  else {
    console.log();
    ui.say(`${ui.icon("rocket")}${c.bold(c.green(`baan ${VERSION} is running`))} ${c.gray(`(listening on ${local})`)}`);
    console.log();
    ui.rows([
      ["link", "MCP URL", c.bold(c.cyan(mcpUrl.href))],
      ["tools", "Tools", toolList],
      ["folder", "Folders", allowRoots.join(", ")],
      ["gear", "Config", config.configPath],
    ]);
    console.log();
    if (!opts.supervised) ui.tip("Keep this window open while you use it. Stop: Ctrl+C");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) ui.warn(`Listening on ${host}, not only this computer`);
  return {
    close: () => new Promise<void>((done) => { srv.close(() => done()); srv.closeAllConnections?.(); }),
  };
}
