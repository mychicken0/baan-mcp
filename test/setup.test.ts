// Guided setup with typed answers (local-only option, so no Tailscale needed).
import "./isolate.ts"; // never touch the real baan service
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

test("npm start with no config runs the guided setup and starts the server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baan-setup-"));
  const work = join(dir, "work");
  mkdirSync(work);
  const cfg = join(dir, "cfg", "baan.yml");
  const p = spawn(process.execPath, [CLI, "start", "--config", cfg], { stdio: ["pipe", "pipe", "pipe"] });
  // folder, level 2 (files only; 1 = everything is the default), no images, local only, only in this window
  p.stdin.end(`${work}\n2\nn\n3\n2\n`);
  let out = "";
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`timeout:\n${out}`)), 15000);
    const on = (d: Buffer) => { out += d; if (out.includes("Next time just run")) { clearTimeout(t); ok(); } };
    p.stdout.on("data", on); p.stderr.on("data", on);
  });
  p.kill();
  const c = YAML.parse(readFileSync(cfg, "utf8"));
  assert.deepEqual(c.tools, ["read", "write", "edit"]);
  assert.deepEqual(c.workspace.allow, [work]);
  assert.equal(c.plugins?.image, undefined);
  assert.match(c.server.publicUrl, /^http:\/\/localhost:\d+$/);
  assert.match(out, /\/mcp/);
  assert.match(out, /Type this password/);
});
