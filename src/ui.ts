// How baan looks in the terminal: colors and icons that work on Linux, macOS and Windows.
//  - Colors turn on only when the output is a terminal that supports them. NO_COLOR / FORCE_COLOR are respected.
//  - Icons are emoji where the terminal can draw them, and plain symbols elsewhere
//    (old Windows console, Linux text console). Override with BAAN_ICONS=emoji or BAAN_ICONS=plain.
//  - Emoji are drawn 2 columns wide, so nothing here relies on a right-hand border lining up.
import { IS_WINDOWS } from "./platform.ts";

const env = process.env;
const out = process.stdout;

function detectColor(): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  if (env.NO_COLOR) return false;
  return !!out.isTTY && (out.hasColors?.() ?? false);
}

function detectEmoji(): boolean {
  if (env.BAAN_ICONS === "emoji") return true;
  if (env.BAAN_ICONS === "plain") return false;
  // Windows Terminal, VS Code, ConEmu and other modern terminals draw emoji; the old console window does not.
  if (IS_WINDOWS) return !!(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON" || env.TERMINAL_EMULATOR);
  return env.TERM !== "linux" && env.TERM !== "dumb";
}

export const COLOR = detectColor();
export const EMOJI = detectEmoji();

const sgr = (open: number, close: number) => (s: string | number) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: sgr(1, 22), dim: sgr(2, 22), underline: sgr(4, 24),
  red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), blue: sgr(34, 39),
  magenta: sgr(35, 39), cyan: sgr(36, 39), gray: sgr(90, 39), black: sgr(30, 39),
  bgCyan: sgr(46, 49), bgGreen: sgr(42, 49), bgRed: sgr(41, 49), bgYellow: sgr(43, 49),
};

// [emoji, plain fallback]. Plain fallbacks are characters every console font has.
// Only emoji that are 2 columns wide on their own (no U+FE0F needed), so text lines up.
const ICONS = {
  home: ["🏠", "*"], folder: ["📁", ">"], key: ["🔑", "*"], lock: ["🔒", "*"], globe: ["🌐", ">"],
  rocket: ["🚀", ">"], ok: ["✅", "√"], fail: ["❌", "×"], warn: ["🚨", "!"], tip: ["💡", "i"],
  copy: ["📋", "+"], party: ["🎉", "*"], eye: ["👀", "-"], pencil: ["📝", "-"], bolt: ["⚡", "!"],
  tools: ["🧰", "-"], gear: ["🔧", "-"], link: ["🔗", ">"], wait: ["⏳", "."], picture: ["📷", "-"],
  laptop: ["💻", "-"], plug: ["🔌", "-"], restart: ["🔄", "~"], book: ["📖", "?"], point: ["👉", ">"],
  star: ["⭐", "*"], stop: ["🛑", "x"],
} as const;
export type IconName = keyof typeof ICONS;
/** Icon followed by a space (plain mode keeps the same 2-column width so text still lines up). */
export const icon = (n: IconName) => (EMOJI ? ICONS[n][0] : ICONS[n][1].padEnd(2)) + " ";

const POINTER = EMOJI ? "❯" : ">";
const LINE = "─";
const PAD = "  ";
const WIDTH = Math.max(40, Math.min(out.columns || 72, 72) - 4);

const log = (s = "") => console.log(s);

export function banner(title: string, subtitle: string, hint?: string) {
  log();
  log(`${PAD}${icon("home")}${c.bold(c.cyan(title))}  ${c.gray("·")}  ${subtitle}`);
  log(`${PAD}${c.gray(LINE.repeat(WIDTH))}`);
  if (hint) log(`${PAD}${c.gray(hint)}`);
}

export function step(n: number, total: number, ico: IconName, title: string) {
  const dots = Array.from({ length: total }, (_, i) => (i < n ? c.cyan(EMOJI ? "●" : "#") : c.gray(EMOJI ? "○" : "."))).join(" ");
  const badge = COLOR ? c.bold(c.black(c.bgCyan(` STEP ${n}/${total} `))) : `[ STEP ${n}/${total} ]`;
  log();
  log(`${PAD}${badge}  ${icon(ico)}${c.bold(title)}   ${dots}`);
  log();
}

export const say = (s: string) => log(`${PAD}${s}`);
export const note = (s: string) => log(`${PAD}${c.gray(s)}`);
export const ok = (s: string) => log(`${PAD}${icon("ok")}${c.green(s)}`);
export const warn = (s: string) => log(`${PAD}${icon("warn")}${c.yellow(s)}`);
export const fail = (s: string) => console.error(`\n${PAD}${icon("fail")}${c.red(c.bold(s))}`);
export const tip = (s: string) => log(`${PAD}${icon("tip")}${c.gray(s)}`);
export const working = (s: string) => log(`${PAD}${icon("wait")}${s}`);
/** A command baan is about to run for you. */
export const command = (s: string) => log(`\n${PAD}${c.gray("$")} ${c.bold(s)}`);
/** Output of a program baan runs (Tailscale), indented under a gray bar. */
export const passthrough = (s: string) => s.replace(/^(?=.)/gm, `${PAD}${c.gray("│")} `);

/** A red warning block, one line per item. */
export function danger(title: string, lines: string[]) {
  log();
  log(`${PAD}${icon("warn")}${c.bold(c.red(title))}`);
  for (const l of lines) log(`${PAD}${c.red("│")}  ${l}`);
}

export interface Option { label: string; icon?: IconName; note?: string; tone?: "good" | "bad" | "info"; detail?: string }
const toneColor = { good: c.green, bad: c.red, info: c.cyan } as const;

export function options(opts: Option[], def: number) {
  opts.forEach((o, i) => {
    const isDef = i + 1 === def;
    const num = isDef ? c.bold(c.cyan(String(i + 1))) : c.cyan(String(i + 1));
    const label = isDef ? c.bold(o.label) : o.label;
    const tag = o.note ? "  " + (o.tone === "good" ? (EMOJI ? "⭐ " : "* ") : "") + (o.tone ? toneColor[o.tone](o.note) : c.gray(o.note)) : "";
    log(`${PAD}  ${num}  ${o.icon ? icon(o.icon) : ""}${label}${tag}`);
    if (o.detail) log(`${PAD}     ${o.icon ? "   " : ""}${c.gray(o.detail)}`);
  });
  log();
}

/** The prompt text before the cursor. */
export function prompt(question: string, def: string): string {
  return `${PAD}${c.cyan(POINTER)} ${c.bold(question)}${def ? " " + c.gray(`(${def})`) : ""} ${c.gray("›")} `;
}

/** Label + value rows, e.g. "Folder  /home/me". */
export function rows(items: [IconName, string, string][]) {
  const width = Math.max(...items.map(([, l]) => l.length));
  for (const [ico, label, value] of items) log(`${PAD}${icon(ico)}${c.gray(label.padEnd(width))}  ${value}`);
}

/** Numbered instruction with a highlighted value under it. */
export function instruction(n: number, text: string, value?: string, extra?: string) {
  const num = COLOR ? c.bold(c.black(c.bgGreen(` ${n} `))) : `(${n})`;
  log(`${PAD}${num}  ${c.bold(text)}`);
  if (value !== undefined) log(`\n${PAD}      ${value}${extra ? "   " + extra : ""}`);
  log();
}

export const rule = (color: (s: string) => string = c.gray) => log(`${PAD}${color(LINE.repeat(WIDTH))}`);

/** Clear the screen before setup so npm's own lines don't clutter it. Only on a real terminal. */
export function clearScreen() {
  if (out.isTTY && !env.BAAN_NO_CLEAR) out.write("\x1b[2J\x1b[3J\x1b[H");
}

/** A key hint like [r] restart. */
export const key = (k: string, what: string) => `${COLOR ? c.bold(c.black(c.bgCyan(` ${k} `))) : `[${k}]`} ${what}`;

/** Time stamp for log lines from the running server. */
export const time = () => c.gray(new Date().toTimeString().slice(0, 8));
