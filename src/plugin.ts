// Public plugin API. A plugin is a module whose default export is a factory:
//
//   import type { PluginFactory } from "baan-mcp/plugin";
//   const plugin: PluginFactory = ({ z }) => ({
//     name: "hello",
//     tools: [{ name: "hello", description: "Say hi", input: { name: z.string() }, readOnly: true,
//               run: async ({ name }) => `hi ${name}` }],
//   });
//   export default plugin;
//
// `z` (zod) is handed in, so plugins need no runtime dependency on baan or zod.
import type * as Zod from "zod";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolContext {
  /** Default working directory from config. */
  cwd: string;
  /** Resolve a user-supplied path (~ and relative to cwd) and enforce workspace.allow. Throws if outside. */
  resolvePath(p: string): string;
  /** Aborted when the MCP request is cancelled. */
  signal?: AbortSignal;
  /** Names of every tool currently enabled. */
  toolNames: string[];
}

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  input: Record<string, Zod.ZodType>;
  /** Hints shown to the client. */
  readOnly?: boolean;
  destructive?: boolean;
  run(args: any, ctx: ToolContext): Promise<string | ToolContent[]>;
}

export interface Plugin {
  name: string;
  tools?: ToolDef[];
}

export interface PluginApi {
  z: typeof Zod;
  /** Options from this plugin's block in baan.yml. */
  options: Record<string, unknown>;
  platform: { isWindows: boolean };
}

export type PluginFactory = (api: PluginApi) => Plugin | Promise<Plugin>;
