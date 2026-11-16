// The 4 built-in tools, same set as pi: read, write, edit, bash (powershell on Windows).
// Each one can be switched off in baan.yml -> tools.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as z from "zod";
import type { Config } from "../config.ts";
import type { ReadHandler, ToolDef } from "../plugin.ts";
import { SHELL_TOOL_NAME, runShell } from "../platform.ts";

function tailTruncate(text: string, MAX_LINES: number, MAX_BYTES: number): string {
  let lines = text.split("\n");
  let cut = false;
  if (lines.length > MAX_LINES) { lines = lines.slice(-MAX_LINES); cut = true; }
  let out = lines.join("\n");
  const buf = Buffer.from(out, "utf8");
  if (buf.length > MAX_BYTES) { out = buf.subarray(buf.length - MAX_BYTES).toString("utf8"); cut = true; }
  return cut ? `[output truncated, showing the last part]\n${out}` : out;
}

export function coreTools(config: Config, readers: ReadHandler[] = []): ToolDef[] {
  const { maxLines: MAX_LINES, maxBytes: MAX_BYTES } = config.output;
  const all: ToolDef[] = [
    {
      name: "read",
      title: "Read",
      // Fixed text: it must not change when plugins are turned on/off, or AI apps may ask to approve the tool again.
      description: `Read a file. Text is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB; use offset/limit for large files. ` +
        `Some other file types, such as images, come back in their own format (offset/limit do not apply).`,
      input: {
        path: z.string().describe("File path (absolute, ~/..., or relative to the working directory)"),
        offset: z.number().int().min(1).optional().describe("1-based line to start from"),
        limit: z.number().int().min(1).optional().describe("Max lines to read"),
      },
      readOnly: true,
      async run({ path, offset, limit }, ctx) {
        const file = ctx.resolvePath(path);
        if (!(await stat(file)).isFile()) throw new Error(`Not a file: ${file}`);
        for (const handle of readers) {
          const out = await handle(file, ctx);
          if (out != null) return out;
        }
        const buf = await readFile(file);
        if (buf.subarray(0, 8192).includes(0)) throw new Error(`${file} looks like a binary file; read only handles text and the file types its plugins add`);
        const lines = buf.toString("utf8").split("\n");
        const start = (offset ?? 1) - 1;
        if (start >= lines.length) throw new Error(`offset ${offset} is past the end (${lines.length} lines)`);
        let end = Math.min(lines.length, start + Math.min(limit ?? MAX_LINES, MAX_LINES));
        let body = lines.slice(start, end).join("\n");
        while (Buffer.byteLength(body) > MAX_BYTES && end > start + 1) {
          end = start + Math.max(1, Math.floor((end - start) / 2));
          body = lines.slice(start, end).join("\n");
        }
        return end < lines.length
          ? `${body}\n\n[showing lines ${start + 1}-${end} of ${lines.length}; continue with offset=${end + 1}]`
          : body;
      },
    },
    {
      name: "write",
      title: "Write",
      description: "Create a file or overwrite it completely. Parent folders are created.",
      input: {
        path: z.string().describe("File path"),
        content: z.string().describe("Full file content"),
      },
      destructive: true,
      async run({ path, content }, ctx) {
        const file = ctx.resolvePath(path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, "utf8");
        return `Wrote ${Buffer.byteLength(content)} bytes to ${file}`;
      },
    },
    {
      name: "edit",
      title: "Edit",
      description: "Replace one exact occurrence of oldText with newText. oldText must match exactly once (including whitespace).",
      input: {
        path: z.string().describe("File path"),
        oldText: z.string().min(1).describe("Exact text to find; must be unique in the file"),
        newText: z.string().describe("Replacement text"),
      },
      destructive: true,
      async run({ path, oldText, newText }, ctx) {
        const file = ctx.resolvePath(path);
        const text = await readFile(file, "utf8");
        // Files saved on Windows use CRLF; accept LF in oldText for them too.
        const crlf = text.includes("\r\n") && !oldText.includes("\r\n");
        const find = crlf ? oldText.replace(/\n/g, "\r\n") : oldText;
        const repl = crlf ? newText.replace(/\n/g, "\r\n") : newText;
        const n = text.split(find).length - 1;
        if (n !== 1) throw new Error(`oldText was found ${n} times in ${file}; it must match exactly once`);
        const i = text.indexOf(find);
        await writeFile(file, text.slice(0, i) + repl + text.slice(i + find.length), "utf8");
        return `Edited ${file}`;
      },
    },
    {
      name: SHELL_TOOL_NAME,
      title: SHELL_TOOL_NAME === "bash" ? "Bash" : "PowerShell",
      description:
        `Run a ${SHELL_TOOL_NAME} command in ${config.workspace.cwd}. Returns combined stdout/stderr (last ${MAX_LINES} lines / ${MAX_BYTES / 1024}KB) and the exit code. ` +
        `Note: this runs with the full rights of the user running baan; workspace.allow does not restrict it.`,
      input: {
        command: z.string().describe("Command to run"),
        timeout: z.number().int().min(1).optional().describe(`Seconds (default ${config.shell.defaultTimeoutSec}, max ${config.shell.maxTimeoutSec})`),
      },
      destructive: true,
      async run({ command, timeout }, ctx) {
        const sec = Math.min(timeout ?? config.shell.defaultTimeoutSec, config.shell.maxTimeoutSec);
        const r = await runShell(command, ctx.cwd, sec * 1000, ctx.signal);
        const status = r.timedOut ? `killed after ${sec}s timeout` : `exit code ${r.exitCode}`;
        return `${tailTruncate(r.output, MAX_LINES, MAX_BYTES)}\n[${status}]`;
      },
    },
  ];
  // Config uses "bash"/"shell"/"powershell" interchangeably for the shell tool, so one baan.yml works on every OS.
  const wanted = new Set(config.tools.map((t) => (["bash", "shell", "powershell"].includes(t) ? SHELL_TOOL_NAME : t)));
  return all.filter((t) => wanted.has(t.name));
}
