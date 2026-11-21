/* oxlint-disable effecttsgo/global-console, effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/process-env, effecttsgo/new-promise -- standalone Bun dev script for the output gallery, not CLI runtime code */
/* Builds a single HTML page from the records written by an e2e run with CLI_GALLERY_DIR set.
   Usage: bun scripts/gallery.ts <records-dir> <out.html> */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Width of the pseudo-terminal the gallery captures in; override with GALLERY_COLUMNS. */
const GALLERY_COLUMNS = Number(process.env["GALLERY_COLUMNS"]) || 160;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  error?: string;
}

interface GalleryRecord {
  suite: string;
  test: string;
  slug: string;
  file: string;
  args: string[];
  piped: RunResult | null;
  tty: RunResult;
}

/* ---------- minimal terminal emulator ---------- */

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
  hidden: boolean;
}

interface Cell {
  ch: string;
  style: Style;
}

/* The 16 theme colours are CSS variables so the page's light and dark palettes can redefine them. */
const BASE16 = Array.from({ length: 16 }, (_, n) => `var(--ansi-${n})`);

function color256(n: number): string {
  if (n < 16) return BASE16[n]!;
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const defaultStyle = (): Style => ({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
  hidden: false,
});

class Terminal {
  lines: Cell[][] = [[]];
  row = 0;
  col = 0;
  style = defaultStyle();
  saved: [number, number] = [0, 0];

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {}

  get top(): number {
    return Math.max(0, this.lines.length - this.rows);
  }

  line(r: number): Cell[] {
    while (this.lines.length <= r) this.lines.push([]);
    return this.lines[r]!;
  }

  put(ch: string) {
    if (this.col >= this.cols) {
      this.col = 0;
      this.row++;
    }
    const l = this.line(this.row);
    while (l.length < this.col) l.push({ ch: " ", style: defaultStyle() });
    l[this.col] = { ch, style: { ...this.style } };
    this.col++;
  }

  sgr(params: number[]) {
    if (params.length === 0) params = [0];
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      if (p === 0) this.style = defaultStyle();
      else if (p === 1) this.style.bold = true;
      else if (p === 2) this.style.dim = true;
      else if (p === 3) this.style.italic = true;
      else if (p === 4) this.style.underline = true;
      else if (p === 7) this.style.inverse = true;
      else if (p === 8) this.style.hidden = true;
      else if (p === 28) this.style.hidden = false;
      else if (p === 9) this.style.strike = true;
      else if (p === 22) this.style.bold = this.style.dim = false;
      else if (p === 23) this.style.italic = false;
      else if (p === 24) this.style.underline = false;
      else if (p === 27) this.style.inverse = false;
      else if (p === 29) this.style.strike = false;
      else if (p >= 30 && p <= 37) this.style.fg = BASE16[p - 30]!;
      else if (p >= 90 && p <= 97) this.style.fg = BASE16[p - 90 + 8]!;
      else if (p === 39) this.style.fg = null;
      else if (p >= 40 && p <= 47) this.style.bg = BASE16[p - 40]!;
      else if (p >= 100 && p <= 107) this.style.bg = BASE16[p - 100 + 8]!;
      else if (p === 49) this.style.bg = null;
      else if (p === 38 || p === 48) {
        let c: string | null = null;
        if (params[i + 1] === 5) {
          c = color256(params[i + 2] ?? 0);
          i += 2;
        } else if (params[i + 1] === 2) {
          c = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
          i += 4;
        }
        if (p === 38) this.style.fg = c;
        else this.style.bg = c;
      }
    }
  }

  csi(raw: string, final: string) {
    const priv = raw.startsWith("?");
    const params = (priv ? raw.slice(1) : raw).split(";").map((s) => (s === "" ? NaN : Number(s)));
    const n = (i: number, d = 1) =>
      Number.isNaN(params[i]!) || params[i] === undefined ? d : params[i]!;
    if (priv) return;
    switch (final) {
      case "A":
        this.row = Math.max(this.top, this.row - n(0));
        break;
      case "B":
      case "E":
        this.row += n(0);
        if (final === "E") this.col = 0;
        break;
      case "F":
        this.row = Math.max(this.top, this.row - n(0));
        this.col = 0;
        break;
      case "C":
        this.col = Math.min(this.cols - 1, this.col + n(0));
        break;
      case "D":
        this.col = Math.max(0, this.col - n(0));
        break;
      case "G":
        this.col = Math.max(0, n(0) - 1);
        break;
      case "H":
      case "f":
        this.row = this.top + n(0) - 1;
        this.col = n(1) - 1;
        break;
      case "K": {
        const l = this.line(this.row);
        const mode = n(0, 0);
        if (mode === 0) l.length = Math.min(l.length, this.col);
        else if (mode === 1)
          for (let c = 0; c <= this.col && c < l.length; c++)
            l[c] = { ch: " ", style: defaultStyle() };
        else l.length = 0;
        break;
      }
      case "J": {
        const mode = n(0, 0);
        if (mode === 0) {
          this.line(this.row).length = Math.min(this.line(this.row).length, this.col);
          this.lines.length = this.row + 1;
        } else if (mode === 2 || mode === 3) {
          for (let r = this.top; r < this.lines.length; r++) this.lines[r] = [];
        }
        break;
      }
      case "m":
        this.sgr(params.map((p) => (Number.isNaN(p) ? 0 : p)));
        break;
      default:
        break;
    }
  }

  write(data: string) {
    const chars = Array.from(data);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      if (ch === "\x1b") {
        const next = chars[i + 1];
        if (next === "[") {
          let j = i + 2;
          let raw = "";
          while (j < chars.length && !/[@-~]/.test(chars[j]!)) raw += chars[j++];
          this.csi(raw, chars[j] ?? "");
          i = j;
        } else if (next === "]") {
          let j = i + 2;
          while (
            j < chars.length &&
            chars[j] !== "\x07" &&
            !(chars[j] === "\x1b" && chars[j + 1] === "\\")
          )
            j++;
          i = chars[j] === "\x07" ? j : j + 1;
        } else if (next === "7") {
          this.saved = [this.row, this.col];
          i++;
        } else if (next === "8") {
          [this.row, this.col] = this.saved;
          i++;
        } else {
          i++;
        }
      } else if (ch === "\r") this.col = 0;
      else if (ch === "\n") this.row++;
      else if (ch === "\b") this.col = Math.max(0, this.col - 1);
      else if (ch === "\t") this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
      else if (ch < " " || ch === "\x7f") continue;
      else this.put(ch);
      this.line(this.row);
    }
  }

  toHtml(): string {
    const out = this.lines.map((l) => {
      let html = "";
      let cur = "";
      let buf = "";
      const flush = () => {
        if (buf) html += cur ? `<span style="${cur}">${esc(buf)}</span>` : esc(buf);
        buf = "";
      };
      for (const cell of l) {
        const css = styleCss(cell.style);
        if (css !== cur) {
          flush();
          cur = css;
        }
        buf += cell.style.hidden ? " " : cell.ch;
      }
      flush();
      return html;
    });
    while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
    return out.join("\n");
  }
}

function styleCss(s: Style): string {
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) [fg, bg] = [bg ?? "var(--term-bg)", fg ?? "var(--term-fg)"];
  const parts: string[] = [];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background:${bg}`);
  if (s.bold) parts.push("font-weight:700");
  if (s.dim) parts.push("opacity:.6");
  if (s.italic) parts.push("font-style:italic");
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean);
  if (deco.length) parts.push(`text-decoration:${deco.join(" ")}`);
  return parts.join(";");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTty(raw: string): string {
  const t = new Terminal(GALLERY_COLUMNS, 50);
  t.write(raw);
  return t.toHtml();
}

/* ---------- page ---------- */

function isJson(args: string[]): boolean {
  return args.some(
    (a, i) =>
      a === "--output=json" ||
      a === "-o=json" ||
      ((a === "--output" || a === "-o") && args[i + 1] === "json"),
  );
}

function isHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function kindOf(args: string[]): "help" | "json" | "interactive" {
  return isHelp(args) ? "help" : isJson(args) ? "json" : "interactive";
}

function shellQuote(a: string): string {
  return /^[\w./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function exitBadge(r: RunResult | null, label: string): string {
  if (!r) return `<span class="badge err">${label}: no result</span>`;
  if (r.error) return `<span class="badge err">${label}: ${esc(r.error)}</span>`;
  if (r.timedOut) return `<span class="badge warn">${label}: timed out (killed)</span>`;
  return `<span class="badge ${r.exitCode === 0 ? "ok" : "err"}">${label} exit ${r.exitCode}</span>`;
}

function seconds(r: RunResult | null): string {
  const ms = (r as { durationMs?: number } | null)?.durationMs;
  return ms === undefined ? "" : ` (${(ms / 1000).toFixed(3)}s)`;
}

function card(rec: GalleryRecord): string {
  const json = isJson(rec.args);
  const cmd = ["supabase", ...rec.args].map(shellQuote).join(" ");
  const pane = json
    ? esc(prettyJson(rec.piped?.stdout ?? ""))
    : rec.tty.error
      ? esc(rec.tty.error)
      : renderTty(rec.tty.stdout);
  const piped = rec.piped;
  return `<div class="card" data-kind="${kindOf(rec.args)}">
  <div class="head"><div class="title">${esc(rec.test)}</div>
  <div class="meta">${json ? '<span class="badge kind">json</span>' : '<span class="badge kind">tty</span>'} ${exitBadge(rec.tty, "tty")} ${exitBadge(piped, "piped")} <span class="file">${esc(rec.file)}</span></div></div>
  <div class="term"><div class="chrome"><i></i><i></i><i></i><span>my-app — zsh — 100×40</span></div>
    <div class="ctx">~/my-app git:(main)${seconds(json ? rec.piped : rec.tty)}</div><div class="cmd warp">${esc(cmd)}</div><div class="cmd mac">you@Mac my-app % ${esc(cmd)}</div><pre>${pane}</pre></div>
  <details><summary>piped stdout / stderr</summary>
    <div class="label">stdout</div><pre class="raw">${esc(piped?.stdout ?? "")}</pre>
    <div class="label">stderr</div><pre class="raw">${esc(piped?.stderr ?? "")}</pre>
  </details>
</div>`;
}

/* Within a command: --help, then successful runs, JSON, --debug, and failures last. */
function cardOrder(rec: GalleryRecord): number {
  if (isHelp(rec.args)) return 0;
  const result = isJson(rec.args) ? rec.piped : rec.tty;
  if (result === null || result.error !== undefined || result.timedOut || result.exitCode !== 0) {
    return 4;
  }
  if (rec.args.includes("--debug")) return 3;
  return isJson(rec.args) ? 2 : 1;
}

/* One section per command: e2e describe names ("orgs:list", "db push") and --help paths share a key. */
function commandOf(rec: GalleryRecord): string {
  if (isHelp(rec.args))
    return rec.args.filter((a) => a !== "--help" && a !== "-h").join(" ") || "supabase";
  return (rec.suite || rec.file).replace(/:/g, " ");
}

const [recordsDir, outFile] = process.argv.slice(2);
if (!recordsDir || !outFile) {
  console.error("usage: bun scripts/gallery.ts <records-dir> <out.html>");
  process.exit(1);
}

const records: GalleryRecord[] = readdirSync(recordsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(recordsDir, f), "utf8")) as GalleryRecord)
  .sort(
    (a, b) =>
      commandOf(a).localeCompare(commandOf(b)) ||
      cardOrder(a) - cardOrder(b) ||
      a.test.localeCompare(b.test),
  );

const groups = new Map<string, GalleryRecord[]>();
for (const r of records) {
  const key = commandOf(r);
  groups.set(key, [...(groups.get(key) ?? []), r]);
}

const count = (kind: string) => records.filter((r) => kindOf(r.args) === kind).length;
const jsonCount = count("json");
const sectionId = (suite: string) =>
  `s-${suite.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
interface NavNode {
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, NavNode>;
}
const navRoot: NavNode = { name: "", path: "", children: new Map() };
for (const command of groups.keys()) {
  let node = navRoot;
  for (const word of command.split(" ")) {
    const path = node.path ? `${node.path} ${word}` : word;
    if (!node.children.has(word))
      node.children.set(word, { name: word, path, children: new Map() });
    node = node.children.get(word)!;
  }
}
const navLink = (node: NavNode, depth: number): string => {
  const recs = groups.get(node.path);
  const pad = depth === 0 ? "" : `style="padding-left:8px"`;
  return recs
    ? `<a href="#${sectionId(node.path)}" data-section="${sectionId(node.path)}" data-path="${esc(node.path)}" ${pad}>${esc(node.name)}<span>${recs.length}</span></a>`
    : `<div class="label" ${pad}>${esc(node.name)}</div>`;
};
const renderNav = (node: NavNode, depth: number): string =>
  [...node.children.values()]
    .map((child) =>
      child.children.size === 0
        ? navLink(child, depth)
        : `<div class="branch">${navLink(child, depth)}${renderNav(child, depth + 1)}</div>`,
    )
    .join("\n");
const nav = renderNav(navRoot, 0);
const sections = [...groups]
  .map(
    ([suite, recs]) =>
      `<section id="${sectionId(suite)}"><h2>${esc(suite)}</h2><div class="grid">${recs.map(card).join("\n")}</div></section>`,
  )
  .join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Supabase CLI output gallery</title>
<style>
:root{color-scheme:dark;
--page:#111;--panel:#1a1a1a;--panel-border:#2c2c2c;--text:#ddd;--muted:#888;--faint:#777;--rule:#2a2a2a;
--btn:#222;--btn-border:#444;--accent:#3ecf8e;--accent-text:#111;
--term-bg:#0a0a0a;--term-fg:#e6e6e6;--term-border:#2a2a30;--cmd:#aaa;--chrome:#202026;--block-accent:#3d3d48;
--ok-bg:#1f3d2f;--ok:#7ee2b8;--err-bg:#4a1f1f;--err:#ff8a85;--warn-bg:#4a3d1f;--warn:#f0d58c;--kind-bg:#26304a;--kind:#8cc7ff;
--ansi-0:#3b3b3b;--ansi-1:#ff5f59;--ansi-2:#3ecf8e;--ansi-3:#e5c07b;--ansi-4:#61afef;--ansi-5:#c678dd;--ansi-6:#56b6c2;--ansi-7:#d0d0d0;
--ansi-8:#6b6b6b;--ansi-9:#ff8a85;--ansi-10:#7ee2b8;--ansi-11:#f0d58c;--ansi-12:#8cc7ff;--ansi-13:#dda6ee;--ansi-14:#86d6df;--ansi-15:#ffffff}
:root[data-theme=light]{color-scheme:light;
--page:#f7f7f5;--panel:#fff;--panel-border:#e2e2df;--text:#1c1c1c;--muted:#666;--faint:#888;--rule:#e2e2df;
--btn:#fff;--btn-border:#ccc;--accent:#1b9e6a;--accent-text:#fff;
--term-bg:#ffffff;--term-fg:#1c1c1c;--term-border:#dedee3;--cmd:#555;--chrome:#f1f1f4;--block-accent:#c9c9d2;
--ok-bg:#dff5ea;--ok:#13734c;--err-bg:#fde4e2;--err:#b42318;--warn-bg:#fdf1d8;--warn:#8a5a00;--kind-bg:#e3edff;--kind:#1f4fae;
--ansi-0:#1c1c1c;--ansi-1:#c62828;--ansi-2:#15803d;--ansi-3:#a16207;--ansi-4:#1d4ed8;--ansi-5:#9333ea;--ansi-6:#0e7490;--ansi-7:#6b6b6b;
--ansi-8:#8a8a8a;--ansi-9:#dc2626;--ansi-10:#16a34a;--ansi-11:#ca8a04;--ansi-12:#2563eb;--ansi-13:#a855f7;--ansi-14:#0891b2;--ansi-15:#1c1c1c}
body{background:var(--page);color:var(--text);font:14px/1.4 -apple-system,system-ui,sans-serif;margin:0;display:grid;grid-template-columns:240px minmax(0,1fr)}
nav{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--rule);padding:16px 8px;box-sizing:border-box;font:12.5px ui-monospace,Menlo,monospace}
nav input{width:100%;box-sizing:border-box;margin:0 0 8px;padding:5px 8px;background:var(--panel);color:var(--text);border:1px solid var(--rule);border-radius:6px;font:inherit}
nav a{display:flex;justify-content:space-between;gap:8px;padding:3px 8px;border-radius:5px;color:var(--muted);text-decoration:none}
nav a:hover,nav a.here{color:var(--text);background:var(--panel)}
nav a span{color:var(--faint)}
nav a[hidden],nav .branch[hidden]{display:none}
nav a.off{pointer-events:none}
nav .branch>a,nav .branch>.label{color:var(--text)}
nav .label{padding:3px 8px;color:var(--faint)}
nav .branch>.branch,nav .branch>a,nav .branch>.label{}
nav .branch>:not(:first-child){margin-left:12px;border-left:1px solid var(--rule)}
main{padding:20px 28px;min-width:0}
section{scroll-margin-top:56px}
h1{font-size:20px;margin:0 0 8px}
.bar{position:sticky;top:0;background:var(--page);padding:10px 0;z-index:2;display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--rule)}
.bar button{background:none;color:var(--muted);border:0;border-radius:0;padding:4px 2px;margin-right:10px;cursor:pointer;font:inherit}
.bar button.on{color:var(--text);box-shadow:inset 0 -2px 0 var(--text)}
.bar .count{color:var(--muted);margin-left:12px;flex:1}
h2{font-size:16px;margin:28px 0 10px;color:var(--accent);font-family:ui-monospace,Menlo,monospace}
.grid{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.card{background:var(--panel);border:1px solid var(--panel-border);border-radius:10px;padding:12px}
.head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.title{font-weight:600}
.meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.badge{font:11px ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:4px;background:var(--btn)}
.badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.err{background:var(--err-bg);color:var(--err)}.badge.warn{background:var(--warn-bg);color:var(--warn)}.badge.kind{background:var(--kind-bg);color:var(--kind)}
.file{color:var(--faint);font-size:11px}
.term{background:var(--term-bg);border-radius:8px;border:1px solid var(--term-border);overflow:hidden;padding:14px 0 8px}
.ctx{font:13px "JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;color:var(--faint);padding:0 16px 2px}
.cmd{font:700 13px "JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;color:var(--term-fg);padding:0 16px 10px}
pre{margin:0;padding:0 16px 6px;font:13px/1.4 "JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;color:var(--term-fg);white-space:pre;max-height:600px;overflow:auto}
pre.raw{padding:10px 12px}
.chrome{display:none;align-items:center;gap:7px;height:26px;padding:0 10px;background:var(--chrome);border-bottom:1px solid var(--term-border);position:relative;margin:-14px 0 8px}
.chrome i{width:11px;height:11px;border-radius:50%;background:#ff5f57}.chrome i:nth-child(2){background:#febc2e}.chrome i:nth-child(3){background:#28c840}
.chrome span{position:absolute;left:0;right:0;text-align:center;color:var(--muted);font:12px -apple-system,system-ui,sans-serif;pointer-events:none}
.cmd.mac{display:none}
body[data-term=macos] .term{border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
body[data-term=macos] .chrome{display:flex}
body[data-term=macos] .ctx,body[data-term=macos] .cmd.warp{display:none}
body[data-term=macos] .cmd.mac{display:block;font-weight:400;padding:0 10px 2px}
body[data-term=macos] .cmd,body[data-term=macos] pre{font-family:"SF Mono",Menlo,monospace;font-size:12px}
body[data-term=macos] pre{padding:0 10px 6px}
details{margin-top:8px}summary{cursor:pointer;color:var(--muted);font-size:12px}
.label{color:var(--faint);font-size:11px;margin:6px 0 2px}
pre.raw{background:var(--term-bg);border-radius:6px;max-height:300px}
${["interactive", "json", "help"].map((k) => `body[data-filter=${k}] .card:not([data-kind=${k}]),body[data-filter=${k}] section:not(:has(.card[data-kind=${k}])){display:none}`).join("\n")}
</style></head><body data-filter="interactive">
<nav><input id="find" placeholder="Filter commands" autocomplete="off">
${nav}</nav>
<main>
<h1>Supabase CLI output gallery</h1>
<div class="bar">
<button data-f="interactive" class="on">Interactive (${count("interactive")})</button>
<button data-f="json">JSON (${jsonCount})</button>
<button data-f="help">--help (${count("help")})</button>
<button data-f="all">All (${records.length})</button>
<span class="count">Interactive cards show a ${GALLERY_COLUMNS}-column pseudo-terminal re-run; JSON cards show piped stdout.</span>
<button id="termstyle" title="Switch terminal style">Warp / Terminal</button>
<button id="theme" title="Switch light or dark">Light / dark</button>
</div>
${sections}
</main>
<script>
const root=document.documentElement;
root.dataset.theme=localStorage.getItem('gallery-theme')||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
document.body.dataset.term=localStorage.getItem('gallery-term')||'warp';
document.getElementById('termstyle').onclick=()=>{document.body.dataset.term=document.body.dataset.term==='warp'?'macos':'warp';localStorage.setItem('gallery-term',document.body.dataset.term);};
document.getElementById('theme').onclick=()=>{root.dataset.theme=root.dataset.theme==='light'?'dark':'light';localStorage.setItem('gallery-theme',root.dataset.theme);};
const syncNav=()=>{const q=document.getElementById('find').value.toLowerCase();document.querySelectorAll('nav a').forEach(a=>{const sec=document.getElementById(a.dataset.section);const shown=getComputedStyle(sec).display!=='none';a.hidden=!shown||!a.dataset.path.toLowerCase().includes(q);});document.querySelectorAll('nav a.off').forEach(a=>a.classList.remove('off'));
[...document.querySelectorAll('nav .branch')].reverse().forEach(d=>{const head=d.firstElementChild;const rest=[...d.children].slice(1).some(c=>c.matches('a:not([hidden])')||c.querySelector?.('a:not([hidden])'));
if(head.tagName==='A'&&head.hidden&&rest){head.hidden=false;head.classList.add('off');}
d.hidden=!rest&&(head.tagName!=='A'||head.hidden);});};
document.getElementById('find').oninput=syncNav;
// Scroll spy: the current section is the last visible one whose top has passed the sticky bar.
const links=new Map([...document.querySelectorAll('nav a')].map(a=>[a.dataset.section,a]));
let current=null,queued=false;
const spy=()=>{queued=false;const line=document.querySelector('.bar').getBoundingClientRect().bottom+8;let here=null;
for(const sec of document.querySelectorAll('main section')){if(sec.offsetParent===null)continue;if(sec.getBoundingClientRect().top<=line)here=sec;else break;}
const shown=[...document.querySelectorAll('main section')].filter(sec=>sec.offsetParent!==null);
if(innerHeight+scrollY>=document.documentElement.scrollHeight-2)here=shown.at(-1)??here;
here??=shown[0];
if(!here||here.id===current)return;current=here.id;
links.forEach((a,id)=>a.classList.toggle('here',id===current));
links.get(current)?.scrollIntoView({block:'nearest'});};
addEventListener('scroll',()=>{if(!queued){queued=true;requestAnimationFrame(spy);}},{passive:true});
addEventListener('resize',spy);
document.querySelectorAll('.bar button[data-f]').forEach(b=>b.onclick=()=>{document.body.dataset.filter=b.dataset.f;document.querySelectorAll('.bar button[data-f]').forEach(x=>x.classList.toggle('on',x===b));syncNav();current=null;spy();});
syncNav();spy();
</script>
</body></html>`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.log(
  `wrote ${outFile}: ${records.length} records (${records.length - jsonCount} interactive, ${jsonCount} json)`,
);
