# baan

**baan** lets AI apps like Gemini, Claude or ChatGPT use tools on **your own computer** over the internet, with a login page built in. One codebase for Linux, macOS and Windows.

- **4 built-in tools, same as [pi](https://github.com/earendil-works/pi):** `read`, `write`, `edit`, `bash` (`powershell` on Windows). Each can be turned off.
- **Everything else is a plugin.** The repo ships one: `image` → `view_image`, which sends pictures at **original resolution, never resized or recompressed**.
- **Built-in login.** Standard MCP OAuth (dynamic client registration + PKCE) with a password page served by baan itself. No Google Cloud project, no GitHub app.
- **Survives restarts.** Stateless MCP + tokens saved to disk, so restarting baan doesn't disconnect your AI app.
- **No hardcoded values.** Everything is in `baan.yml` or env vars.

> ⚠️ **Read this first.** Anyone who logs in can do whatever the enabled tools allow. `bash`/`powershell` = full control of your computer as your user, and it is **not** limited by `workspace.allow`. Plugins run with your full rights too. Use a long password, keep baan on `127.0.0.1` behind a tunnel, and only enable what you need. New configs start with `read` only.

## Requirements
Node.js **22.18+** (runs the TypeScript source directly, no build step).

## Quick start
```sh
git clone <this repo> baan && cd baan && npm install
node src/cli.ts init --public-url https://mcp.your-domain.com    # prints a password once
node src/cli.ts serve
```
`init` writes `~/.config/baan/baan.yml` (Windows: `%APPDATA%\baan\baan.yml`). Edit it to enable more tools:
```yaml
tools: [read, write, edit, bash]   # "bash" becomes powershell on Windows
```

Then make `http://127.0.0.1:8790` reachable at your public URL with a tunnel (see below) and add `https://<public-url>/mcp` as a connector in your AI app. A login page opens; type the password and press **Allow**.

## Commands
| | |
|---|---|
| `baan init [--public-url URL] [--port N] [--tools a,b] [--password-file F]` | create config + password |
| `baan serve` | start the server |
| `baan passwd` | new random password; signs out every connected app |
| `baan tools` | list enabled tools |

Every command takes `--config FILE`. Env overrides: `BAAN_CONFIG`, `BAAN_DATA_DIR`, `BAAN_HOST`, `BAAN_PORT`, `BAAN_PUBLIC_URL`.

## Getting a public https URL
baan only listens on `127.0.0.1`. Use a tunnel with a URL that **doesn't change** (a changing URL disconnects your AI app):
- **Cloudflare Tunnel** (you have a domain on Cloudflare): route `mcp.your-domain.com` → `http://127.0.0.1:8790`.
- **Tailscale Funnel** (no domain needed): `tailscale funnel 8790`, then use the `https://<machine>.<tailnet>.ts.net` URL as `publicUrl`.

## Plugins
```yaml
plugins:
  image: { from: baan-plugin-image, maxBytes: 20971520 }   # bundled package in plugins/image
  mytool: { from: ./my-plugin.ts }     # local file
  other: { from: some-npm-package }    # installed package (must ship JS)
  image: false                         # keep installed, turn off
```
A plugin's default export is a factory. It receives `z` (zod), so it needs no dependencies:
```ts
import type { PluginFactory } from "baan-mcp/src/plugin.ts";

const plugin: PluginFactory = ({ z, options }) => ({
  name: "hello",
  tools: [{
    name: "hello",
    description: "Say hello",
    input: { name: z.string() },
    readOnly: true,
    run: async ({ name }, ctx) => `hello ${name}`,   // or [{type:"text"...},{type:"image"...}]
  }],
});
export default plugin;
```
`ctx.resolvePath(p)` expands `~`, resolves relative paths and enforces `workspace.allow`.

### `image` plugin
`view_image` checks the file's real format (PNG, JPEG, GIF, WebP), reads its width × height from the header, and sends the bytes **unchanged**. Files over `maxBytes` are refused instead of shrunk. (The AI app may still scale images on its own side; baan never does.)

## Security notes
- Password is stored as a scrypt hash; access/refresh tokens are stored as SHA-256 hashes in `state.json` (mode 600).
- Login page locks after `auth.maxFailedLogins` wrong passwords for `auth.lockoutSec`.
- Every tool call is appended to `audit.log` (long arguments clipped).

## Development
```sh
npm run typecheck
npm test          # end-to-end: OAuth flow + all tools + image bytes unchanged
```

## Status
Early prototype. Planned: `baan expose tailscale|cloudflare`, a setup page in the browser, `baan plugin add/remove`, hot-reload of plugins, single-file installers.

Inspired by [pi](https://github.com/earendil-works/pi) (minimal tool set) and DeepSeek Harness (everything is a plugin). Not affiliated with either.
