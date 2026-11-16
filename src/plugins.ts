// Loads the built-in tools plus every enabled plugin from baan.yml into one tool list.
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import * as z from "zod";
import type { Config } from "./config.ts";
import type { Plugin, PluginFactory, ToolDef } from "./plugin.ts";
import { coreTools } from "./core/tools.ts";
import { IS_WINDOWS } from "./platform.ts";

export interface LoadedTool extends ToolDef { plugin: string }

export async function loadTools(config: Config): Promise<{ tools: LoadedTool[]; plugins: string[] }> {
  const tools: LoadedTool[] = coreTools(config).map((t) => ({ ...t, plugin: "core" }));
  const plugins: string[] = [];
  for (const entry of config.plugins) {
    if (!entry.enabled) continue;
    const spec = existsSync(entry.from) ? pathToFileURL(entry.from).href : entry.from;
    let mod: { default?: PluginFactory | Plugin };
    try {
      mod = await import(spec);
    } catch (e) {
      throw new Error(`Plugin "${entry.name}" could not be loaded from ${entry.from}: ${(e as Error).message}`);
    }
    const exp = mod.default;
    const plugin: Plugin = typeof exp === "function" ? await exp({ z, options: entry.options, platform: { isWindows: IS_WINDOWS } }) : exp!;
    if (!plugin || typeof plugin !== "object") throw new Error(`Plugin "${entry.name}" has no default export`);
    for (const t of plugin.tools ?? []) {
      if (tools.some((x) => x.name === t.name)) throw new Error(`Tool name "${t.name}" from plugin "${entry.name}" is already taken`);
      tools.push({ ...t, plugin: entry.name });
    }
    plugins.push(entry.name);
  }
  return { tools, plugins };
}
