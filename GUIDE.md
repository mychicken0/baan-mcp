# baan guide: changing things

How to change settings, add plugins and build new things once baan is set up.

## Control panel

Double-click **baan** in the baan folder (`baan.desktop` on Linux, `baan.app` on macOS, `baan.lnk` on Windows). Or `npm run panel`, or press **p** in the baan window. It opens in its own window (Chrome / Edge / Brave app window if you have one, otherwise your normal browser).

| Button | What it does |
|---|---|
| ▶ Start | runs baan in the background and turns on "start with the computer" (same as `npm run background`) |
| ■ Stop | stops it; it no longer starts with the computer (same as `npm stop`). A baan in a terminal window quits |
| 🔄 Restart | checks the setup, then restarts. If the setup is broken, the old one keeps running and you see why |
| 🚀 Run in background | only for a baan running in a terminal: same as pressing **b** there |
| 💾 Save (settings) | writes `baan.yml` only after the new settings pass `baan check`; baan then restarts by itself |
| 🔑 Make a new password | shown once; every connected AI app must sign in again |

Things the panel does not have (plugin options, output limits, login timeouts…): **📝 Edit config file**.

Changing the **port** there? If you use Tailscale Funnel, point it at the new port; the panel prints the exact `tailscale funnel` command after Save.

Linux file managers (Nemo, GNOME Files) may ask once whether to trust the launcher: choose *Trust and launch* / *Mark as trusted*. Moved the baan folder or installed a new Node.js? Run `npm run app` to make the icon again.

The panel only listens on `127.0.0.1` (port = baan's port + 1). It is never reachable from the internet, and it needs a random key that is written next to the config (`panel.json`, only you can read it).

## Background and start with the computer

Setup's recommended choice runs baan **in the background and starts it with the computer**, so you can close the window. If you picked "only while this window is open", press **b** in the baan window (or run `npm run background`) to switch.

| Command | |
|---|---|
| `npm run status` | is it running, the URL for your AI app, where the config and log are |
| `npm run logs` | last lines of the log (`baan.log`, next to `baan.yml`) |
| `npm stop` | stop it, and it no longer starts with the computer |
| `npm run background` | turn it on again (also restarts it) |
| `npm start` | when it already runs in the background: just shows the status |

No admin rights are needed. What it uses:

| OS | Starts | File |
|---|---|---|
| Linux (systemd) | at boot if "linger" is on, else when you log in | `~/.config/systemd/user/baan.service` |
| Linux (no systemd) | when you log in to the desktop | `~/.config/autostart/baan.desktop` |
| macOS | when you log in | `~/Library/LaunchAgents/com.baan.mcp.plist` |
| Windows | when you log in, no window | `baan.vbs` in the Startup folder (`shell:startup`) |

Linux "linger" (start before login, good for a server with no screen): `sudo loginctl enable-linger $USER`. Setup offers to do it.
On Windows and macOS, turn on automatic login if the computer should serve after a power cut with nobody there.

In the background, baan restarts by itself exactly like in a window (table below), and if the server crashes it starts it again (after 5 s, then longer).

To run it in a window instead: `npm stop`, then `npm start`.

## How restarting works

With `npm start` in a window, or in the background, baan **restarts by itself** when:

| You… | baan… |
|---|---|
| save `baan.yml` | checks the new config, then restarts |
| change a plugin's files | restarts |
| change baan's own code (`src/`) or `git pull` | restarts |
| run `npm run passwd` in another window | restarts with the new password |
| press **r** in the baan window | restarts |

Before every restart, baan loads the new setup in a separate process first. If something is wrong (a YAML typo, a plugin that won't load), you see the error and **the old server keeps running**. Fix it, save again.

Keys in the baan window:

| Key | |
|---|---|
| **b** | move baan to the background (starts with the computer) and let you close the window |
| **r** | restart now |
| **c** | open the config in an editor |
| **g** | show where this guide is |
| **q** / Ctrl+C | stop baan |

Restarting never disconnects your AI app: logins are saved to disk and every request stands on its own.

> Need it to run once without watching (a system service, a script)? Use `node src/cli.ts serve`. That one does **not** restart by itself.

## Where the config is

| OS | File |
|---|---|
| Linux / macOS | `~/.config/baan/baan.yml` |
| Windows | `%APPDATA%\baan\baan.yml` |

Open it with `npm run config` (or press **c** in the baan window). It uses `$VISUAL` / `$EDITOR` if set, otherwise Notepad (Windows), TextEdit (macOS) or your desktop's default editor.

Check a config without starting anything: `npm run check`.

`state.json` (password hash, logins) and `audit.log` (every tool call) live next to it. Don't edit `state.json` by hand.

## Common changes

All of these are in `baan.yml`. Save, and baan restarts.

### Which tools the AI gets
```yaml
tools: [read, write, edit, bash]   # remove one to turn it off
```
`bash` is `powershell` on Windows. It can do anything you can do on the computer and is **not** limited to `workspace.allow`.

### Which folders it may touch
```yaml
workspace:
  cwd: "~/projects"          # where commands run, and where relative paths start
  allow:                     # read / write / edit only work inside these
    - "~/projects"
    - "D:\\photos"           # Windows paths work too
```

### Output size
```yaml
output:
  maxLines: 2000             # read / bash cut long output here
  maxBytes: 51200
shell:
  defaultTimeoutSec: 120     # a command is stopped after this
  maxTimeoutSec: 600
```

### Login
```yaml
auth:
  accessTokenTtlSec: 3600
  refreshTokenTtlSec: 2592000   # how long an AI app stays signed in (30 days)
  maxFailedLogins: 10           # then the login page locks for lockoutSec
  lockoutSec: 900
```
New password: `npm run passwd`. Every connected AI app has to sign in again.

### Port or internet address
`server.port` and `server.publicUrl` must match your tunnel (Tailscale Funnel / Cloudflare Tunnel). The easiest way to change them is to run the setup again (below). If you change `publicUrl` by hand, remove and re-add the connector in your AI app.

## Plugins

Everything beyond the 4 built-in tools is a plugin. Plugins are listed under `plugins:` in `baan.yml`. `from:` is required and tells baan where the plugin is:

```yaml
plugins:
  image:                         # the name you choose
    from: baan-plugin-image      # npm package name, or a path
    maxBytes: 20971520           # everything else is passed to the plugin as options
```

### Turn a plugin off
```yaml
plugins:
  image: false
```
or delete its block. Save.

### Add a plugin from npm
1. In the baan folder: `npm install some-baan-plugin`
2. Add it to `baan.yml`:
   ```yaml
   plugins:
     something:
       from: some-baan-plugin
   ```
3. Save. baan restarts and the AI app sees the new tools on its next request.

> If you install a package **without** changing `baan.yml`, press **r**. baan doesn't watch `node_modules`.
>
> Packages from npm must ship JavaScript (`.js`). Node.js doesn't run TypeScript from `node_modules`. Local files (next section) can be `.ts`.

### Add a plugin from a file or folder
```yaml
plugins:
  hello:
    from: ./plugins-local/hello.ts     # relative to the folder baan.yml is in
```
baan watches that folder, so saving the plugin's code restarts baan too.

### A plugin runs as you
A plugin can do anything your user can do. Only add plugins you trust.

## Write your own plugin

A plugin is one file whose default export returns a name and a list of tools. baan hands it `z` ([zod](https://zod.dev)) to describe inputs, so it needs no dependencies.

`hello.ts`:
```ts
import type { PluginFactory } from "baan-mcp/src/plugin.ts";   // types only, optional

const plugin: PluginFactory = ({ z, options }) => ({
  name: "hello",
  tools: [
    {
      name: "hello",
      description: "Say hello to someone.",            // the AI reads this to decide when to use the tool
      input: { name: z.string().describe("Who to greet") },
      readOnly: true,                                   // hint for the AI app: doesn't change anything
      run: async ({ name }, ctx) => `${options.greeting ?? "Hello"}, ${name}!`,
    },
  ],
});
export default plugin;
```

`baan.yml`:
```yaml
plugins:
  hello:
    from: ./hello.ts
    greeting: Hi
```

Save both. baan restarts, and the AI app gets a `hello` tool.

What a tool's `run` gets and returns:

| | |
|---|---|
| `args` | the input, already checked against `input` |
| `ctx.resolvePath(p)` | turns a path from the AI into an absolute path, and throws if it is outside `workspace.allow`. **Use it for every path.** |
| `ctx.cwd` | the configured working folder |
| `ctx.signal` | aborted when the AI app cancels the call |
| `ctx.toolNames` | every tool that is on |
| return | a string, or a list of `{ type: "text", text }` / `{ type: "image", data: <base64>, mimeType }` |

Other things to know:
- A tool that throws shows the AI an error message. baan keeps running.
- Two tools can't have the same name. baan refuses to start and tells you which one.
- `options` is everything in the plugin's block except `from`. Read your settings from there, not from constants in the code.
- `platform.isWindows` is passed in too, if a tool needs to behave differently on Windows.
- The bundled `plugins/image` is a complete real example.

## Update baan
```sh
git pull
npm install
```
baan restarts by itself when the code changes. If `npm install` added new packages, press **r** afterwards (in the background: `npm run background`).

## Run the setup again
`npm run setup` (stop a baan window first with **q**; a background copy is stopped for you). It asks the same 5 questions and makes a new password.

## Look and feel
Colors and emoji turn on by themselves when the terminal supports them.

| | |
|---|---|
| `NO_COLOR=1` | no colors |
| `FORCE_COLOR=1` | colors even when baan can't tell |
| `BAAN_ICONS=plain` | plain symbols instead of emoji (old Windows console, Linux text console) |
| `BAAN_ICONS=emoji` | emoji even when baan isn't sure the terminal can draw them |

On Windows, emoji show in **Windows Terminal** and VS Code. The old blue "Command Prompt" window gets plain symbols.

## When something goes wrong

| You see | Do this |
|---|---|
| `Not restarted. The new setup has a problem` | Read the lines under it, fix `baan.yml` or the plugin, save. The old server is still running. |
| `baan stopped (exit 1)` | Same: fix, save, or press **r**. |
| `Plugin "x" could not be loaded` | Check `from:`. For npm plugins, run `npm install` in the baan folder. |
| baan doesn't start after a reboot | `npm run status`, then `npm run logs`. Moved or deleted the baan folder, or changed Node version? Run `npm run background` again. |
| `already running in another window` | baan runs somewhere else. Go to that window, or close it first. |
| `address already in use` | Another program uses `server.port`. Change the port and update your tunnel, or stop the other program. |
| The AI app asks you to sign in again | The password changed, or `publicUrl` changed. Sign in again. |
| Double-clicking **baan** does nothing | Run `npm run app` in the baan folder (after moving the folder or a new Node.js). On Linux, allow the launcher when the file manager asks. `npm run panel` always works. |
| Panel says "This window is closed" | It closed itself after its window was idle. Close the window and double-click **baan** again. |
| The AI app can't reach baan | Open your public URL in a browser. It should say `baan MCP server`. With Tailscale, check `tailscale funnel status`. |

Every tool call is in `audit.log`, next to `baan.yml`.
