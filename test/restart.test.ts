// npm start restarts the server when baan.yml is saved, and keeps the old one running if the new config is broken.
import "./isolate.ts"; // never touch the real baan service
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });

test("saving the config restarts baan; a broken config does not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baan-restart-"));
  const cfg = join(dir, "baan.yml");
  const port = await freePort();
  const init = spawnSync(process.execPath, [CLI, "init", "--config", cfg, "--port", String(port), "--tools", "read", "--password-file", join(dir, "pw")]);
  assert.equal(init.status, 0, init.stderr.toString());

  const p = spawn(process.execPath, [CLI, "start", "--config", cfg], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  const waitFor = (re: RegExp, from: number) => new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`timeout waiting for ${re}:\n${out}`)), 15000);
    const i = setInterval(() => { if (re.test(out.slice(from))) { clearTimeout(t); clearInterval(i); ok(); } }, 50);
  });
  try {
    await waitFor(/baan restarts by itself/, 0);
    const health = async () => (await fetch(`http://127.0.0.1:${port}/`)).ok;
    assert.ok(await health());

    let mark = out.length;
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^tools:\n  - read\n/m, "tools:\n  - read\n  - write\n"));
    await waitFor(/Config saved[\s\S]*Running on[^\n]*read, write/, mark);
    assert.ok(await health());

    mark = out.length;
    writeFileSync(cfg, readFileSync(cfg, "utf8") + "\nplugins:\n  broken: { from: ./does-not-exist.ts }\n");
    await waitFor(/Not restarted[\s\S]*keeps running/, mark);
    assert.ok(await health(), "old server still answers");
  } finally {
    p.kill("SIGTERM");
    await new Promise((r) => p.on("close", r));
  }
  // child is gone too
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});
