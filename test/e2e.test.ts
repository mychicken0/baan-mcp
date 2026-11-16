// End-to-end: init -> serve -> OAuth (DCR + password page + PKCE) -> MCP tool calls. Runs on Linux, macOS and Windows.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import YAML from "yaml";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const dir = mkdtempSync(join(tmpdir(), "baan-test-"));
const work = join(dir, "work");
const outside = mkdtempSync(join(tmpdir(), "baan-outside-"));
const cfg = join(dir, "cfg", "baan.yml");
let port = 0;
let base = "";
let proc: ChildProcess;
let token = "";
let rpcId = 0;

function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x & 255; raw[o + 1] = y & 255; raw[o + 2] = (x ^ y) & 255;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const freePort = () => new Promise<number>((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });

async function rpc(method: string, params: unknown, auth = token) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: r.status, headers: r.headers, body: r.status === 200 ? await r.json() : await r.text() };
}
const call = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).body.result;

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mkdirSync(work);
  const init = spawnSync(process.execPath, [CLI, "init", "--config", cfg, "--port", String(port), "--public-url", base,
    "--tools", "read,write,edit,bash", "--password-file", join(dir, "pw.txt")], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  // point the workspace at the temp folder
  const doc = YAML.parseDocument(readFileSync(cfg, "utf8"));
  doc.setIn(["workspace", "cwd"], work);
  doc.setIn(["workspace", "allow"], [work]);
  writeFileSync(cfg, doc.toString());
  proc = spawn(process.execPath, [CLI, "serve", "--config", cfg], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((ok, fail) => {
    let log = "";
    proc.stdout!.on("data", (d) => { log += d; if (log.includes("listening")) ok(); });
    proc.stderr!.on("data", (d) => { log += d; });
    proc.on("exit", () => fail(new Error(log)));
  });
});
after(() => proc?.kill());

test("unauthenticated /mcp is refused with a resource metadata pointer", async () => {
  const r = await rpc("tools/list", {}, "");
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

test("OAuth: register, wrong password, right password, PKCE token, refresh", async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test App", redirect_uris: ["http://127.0.0.1:9/cb"], token_endpoint_auth_method: "none" }),
  })).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_challenge: challenge, code_challenge_method: "S256", state: "xyz" })
    .forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const page = await (await fetch(authUrl)).text();
  assert.match(page, /Test App/);
  const reqId = page.match(/name="request" value="([^"]+)"/)![1];
  const post = (password: string) => fetch(`${base}/baan/login`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: reqId, password, action: "allow" }),
  });
  assert.equal((await post("wrong")).status, 401);
  const ok = await post(readFileSync(join(dir, "pw.txt"), "utf8").trim());
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get("location")!);
  assert.equal(back.searchParams.get("state"), "xyz");
  const tok = await (await fetch(meta.token_endpoint, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb" }),
  })).json();
  assert.ok(tok.access_token && tok.refresh_token);
  const ref = await (await fetch(meta.token_endpoint, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }),
  })).json();
  assert.ok(ref.access_token);
  token = ref.access_token;
});

test("tools/list has the 4 core tools + view_image", async () => {
  const names = (await rpc("tools/list", {})).body.result.tools.map((t: any) => t.name).sort();
  const shell = process.platform === "win32" ? "powershell" : "bash";
  assert.deepEqual(names, ["edit", "read", shell, "view_image", "write"].sort());
});

test("write / read / edit", async () => {
  assert.ok(!(await call("write", { path: "a/hello.txt", content: "one\ntwo\nthree\n" })).isError);
  assert.equal((await call("read", { path: "a/hello.txt" })).content[0].text, "one\ntwo\nthree\n");
  assert.ok(!(await call("edit", { path: "a/hello.txt", oldText: "two", newText: "TWO" })).isError);
  assert.match((await call("read", { path: "a/hello.txt", offset: 2, limit: 1 })).content[0].text, /^TWO/);
  assert.ok((await call("edit", { path: "a/hello.txt", oldText: "nope", newText: "x" })).isError);
});

test("paths outside workspace.allow are refused", async () => {
  writeFileSync(join(outside, "secret.txt"), "x");
  const r = await call("read", { path: join(outside, "secret.txt") });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /outside workspace.allow/);
  assert.ok((await call("read", { path: "../../" + outside.split(/[\\/]/).pop() + "/secret.txt" })).isError);
});

test("shell tool runs in cwd and reports exit code", async () => {
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const r = await call(shell, { command: process.platform === "win32" ? "Get-Content a/hello.txt; exit 3" : "cat a/hello.txt; exit 3" });
  assert.match(r.content[0].text, /TWO/);
  assert.match(r.content[0].text, /exit code 3/);
  const t = await call(shell, { command: process.platform === "win32" ? "Start-Sleep 30" : "sleep 30", timeout: 1 });
  assert.match(t.content[0].text, /timeout/);
});

test("view_image returns the original bytes, not resized", async () => {
  const img = png(2400, 1600);
  writeFileSync(join(work, "big.png"), img);
  const r = await call("view_image", { path: "big.png" });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.match(r.content[0].text, /2400x1600 px/);
  assert.equal(r.content[1].type, "image");
  assert.equal(r.content[1].mimeType, "image/png");
  assert.ok(Buffer.from(r.content[1].data, "base64").equals(img), "image bytes changed");
  const rr = await call("read", { path: "big.png" });
  assert.ok(rr.isError && /binary/.test(rr.content[0].text), "core read must not know about images");
});

test("audit log records tool calls", () => {
  const lines = readFileSync(join(dir, "cfg", "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.tool === "view_image" && l.ok));
  assert.ok(lines.some((l) => l.tool === "read" && !l.ok));
});
