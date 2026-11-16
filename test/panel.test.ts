// Control panel: only this computer + the key get in; settings are checked before saving; restart / stop reach a running baan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import YAML from "yaml";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });

function run(args: string[], until: RegExp): Promise<{ p: ChildProcess; out: () => string; m: RegExpMatchArray }> {
  const p = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BAAN_SERVICE_NAME: "baan-paneltest" } });
  let out = "";
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`timeout waiting for ${until}:\n${out}`)), 20000);
    const on = (d: Buffer) => { out += d; const m = out.match(until); if (m) { clearTimeout(t); ok({ p, out: () => out, m }); } };
    p.stdout!.on("data", on); p.stderr!.on("data", on);
  });
}
const raw = (port: number, path: string, headers: Record<string, string>) => new Promise<number>((ok, fail) => {
  const r = request({ host: "127.0.0.1", port, path, headers }, (res) => { res.resume(); ok(res.statusCode!); });
  r.on("error", fail); r.end();
});

test("control panel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baan-panel-"));
  const cfg = join(dir, "baan.yml");
  const port = await freePort();
  const init = spawnSync(process.execPath, [CLI, "init", "--config", cfg, "--port", String(port), "--tools", "read", "--password-file", join(dir, "pw")]);
  assert.equal(init.status, 0, init.stderr.toString());

  const baan = await run(["start", "--config", cfg], /baan restarts by itself/);
  const panel = await run(["panel", "--no-open", "--config", cfg], /Open: http:\/\/127\.0\.0\.1:(\d+)\/#k=(\S+)/);
  const [, pp, key] = panel.m;
  const base = `http://127.0.0.1:${pp}`;
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(`${base}/api/${path}`, body === undefined ? { headers: { "x-baan-key": key } }
      : { method: "POST", headers: { "x-baan-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, j: (await r.json()) as any };
  };
  try {
    assert.equal(Number(pp), port + 1, "panel uses its own port: baan's port + 1");
    // the page is served, the API needs the key, and only 127.0.0.1/localhost names are accepted
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/status`, { headers: { "x-baan-key": "wrong" } })).status, 401);
    assert.equal(await raw(Number(pp), "/api/status", { host: "evil.example:80", "x-baan-key": key }), 403);
    assert.equal(await raw(Number(pp), "/api/status", { host: `127.0.0.1:${pp}`, origin: "http://evil.example", "x-baan-key": key }), 403);
    assert.equal(await raw(Number(pp), "/api/status", { host: `localhost:${pp}`, "x-baan-key": key }), 200);

    let s = await api("status");
    assert.equal(s.j.running, true);
    assert.equal(s.j.mode, "window");

    // settings: a bad folder is refused and the file is untouched; a good change is saved and baan restarts with it
    const before = readFileSync(cfg, "utf8");
    let r = await api("settings", { folder: join(dir, "nope") });
    assert.equal(r.status, 400);
    assert.equal(readFileSync(cfg, "utf8"), before);
    const work = join(dir, "work"); mkdirSync(work);
    r = await api("settings", { folder: work, tools: ["read", "write"] });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    const c = YAML.parse(readFileSync(cfg, "utf8"));
    assert.deepEqual(c.tools, ["read", "write"]);
    assert.equal(c.workspace.cwd, work);
    assert.deepEqual(c.workspace.allow, [work]);
    for (let i = 0; i < 40 && !/Running on[^\n]*read, write/.test(baan.out().split("Config saved")[1] ?? ""); i++) await new Promise((x) => setTimeout(x, 250));
    assert.match(baan.out().split("Config saved")[1] ?? "", /Running on[^\n]*read, write/);

    // new password
    const hash = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).passwordHash;
    const h0 = hash();
    r = await api("password", {});
    assert.equal(r.status, 200);
    assert.ok(r.j.password.length >= 20);
    assert.notEqual(hash(), h0);

    // restart and stop reach baan running in a terminal window
    r = await api("restart", {});
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.j.message, "Restarted.");
    r = await api("stop", {});
    assert.equal(r.status, 200, JSON.stringify(r.j));
    await new Promise((x) => baan.p.exitCode !== null ? x(null) : baan.p.on("exit", x));
    s = await api("status");
    assert.equal(s.j.running, false);
  } finally {
    baan.p.kill("SIGTERM");
    panel.p.kill("SIGTERM");
    await new Promise((x) => panel.p.exitCode !== null ? x(null) : panel.p.on("exit", x));
  }
});
