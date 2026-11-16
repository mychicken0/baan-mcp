# baan guide: changing things

How to change settings, add plugins and build new things once baan is set up.

## How restarting works

Run baan with `npm start` and keep the window open. It **restarts by itself** when:

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
baan restarts by itself when the code changes. If `npm install` added new packages, press **r** afterwards.

## Run the setup again
Stop baan (**q**), then `npm run setup`. It asks the same 4 questions and makes a new password.

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
| `address already in use` | Another program uses `server.port`. Change the port and update your tunnel, or stop the other program. |
| The AI app asks you to sign in again | The password changed, or `publicUrl` changed. Sign in again. |
| The AI app can't reach baan | Open your public URL in a browser. It should say `baan MCP server`. With Tailscale, check `tailscale funnel status`. |

Every tool call is in `audit.log`, next to `baan.yml`.
