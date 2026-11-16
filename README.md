# baan

**baan** lets AI apps like Gemini, Claude or ChatGPT use tools on **your own computer** over the internet, with a login page built in. One codebase for Linux, macOS and Windows.

- **4 built-in tools, same as [pi](https://github.com/earendil-works/pi):** `read`, `write`, `edit`, `bash` (`powershell` on Windows). Each can be turned off.
- **Everything else is a plugin.** The repo ships one: `image` → `view_image`, which sends pictures at **original resolution, never resized or recompressed**.
- **Built-in login.** Standard MCP OAuth (dynamic client registration + PKCE) with a password page served by baan itself. No Google Cloud project, no GitHub app.
- **Survives restarts.** Stateless MCP + tokens saved to disk, so restarting baan doesn't disconnect your AI app.
- **No hardcoded values.** Everything is in `baan.yml` or env vars.

> ⚠️ **Read this first.** Anyone who logs in can do whatever the enabled tools allow. `bash`/`powershell` = full control of your computer as your user, and it is **not** limited by `workspace.allow`. Plugins run with your full rights too. Use a long password, keep baan on `127.0.0.1` behind a tunnel, and only enable what you need. New configs start with `read` only.

## Quick start
You need [Node.js 22.18+](https://nodejs.org) and [Git](https://git-scm.com). Same commands on Linux, macOS and Windows:
```sh
git clone https://github.com/mychicken0/baan-mcp.git
cd baan-mcp
npm install
npm start
```
That's it. `npm start` walks you through everything, and you mostly just press Enter:

1. **Folder** the AI may work in (default: your home folder).
2. **What it may do:** read only (default) / + create and edit files / + run commands.
3. **Internet address.** No domain needed: baan sets up **Tailscale Funnel** for you. It installs Tailscale if missing (Linux), opens the free sign-in page in your browser, turns Funnel on, and finds your `https://<computer>.<tailnet>.ts.net` address itself. Already have Cloudflare Tunnel or your own domain? Pick that instead.
4. **Password** is made for you.

At the end it prints the URL to paste into your AI app (also copied to the clipboard) and the password for the login page. Next time just run `npm start`.

## Commands
| | |
|---|---|
| `npm start` (`baan start`) | first run: guided setup, then start. Later: start |
| `npm run setup` (`baan setup`) | run the guided setup again |
| `npm run passwd` (`baan passwd`) | new random password; signs out every connected app |
| `baan init [--public-url URL] [--port N] [--tools a,b] [--password-file F]` | create config + password without questions (scripts) |
| `baan serve` | start the server |
| `baan tools` | list enabled tools |

Every command takes `--config FILE`. Env overrides: `BAAN_CONFIG`, `BAAN_DATA_DIR`, `BAAN_HOST`, `BAAN_PORT`, `BAAN_PUBLIC_URL`.

## Getting a public https URL
baan only listens on `127.0.0.1`; the AI app reaches it through a tunnel. The URL must **not change** (a changing URL disconnects your AI app).
- **Tailscale Funnel** (default in setup, no domain): setup runs `tailscale funnel --bg --https=443 http://127.0.0.1:<port>`. If port 443 is already used by another Tailscale service, it uses 8443 or 10000 instead and never overwrites it. The first time, Tailscale asks you to allow Funnel in the browser.
- **Your own domain** (Cloudflare Tunnel, reverse proxy): point it at `http://127.0.0.1:<port>` and enter the address in setup.

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
Early prototype. Planned: run in the background / at login, a setup page in the browser, `baan plugin add/remove`, hot-reload of plugins, single-file installers.

Inspired by [pi](https://github.com/earendil-works/pi) (minimal tool set) and DeepSeek Harness (everything is a plugin). Not affiliated with either.
