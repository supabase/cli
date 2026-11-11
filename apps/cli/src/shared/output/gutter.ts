import { stripVTControlCharacters } from "node:util";

import {
  type ColorStream,
  command,
  error,
  muted,
  success,
  warning,
} from "../../command-internal/colors.ts";

/**
 * The terminal layout every unframed command shares: column 0 holds a glyph or a space and
 * content starts at column 2. Every line a person sees goes through this module, so alignment is
 * decided once. See docs/adr/0034-cli-colour-system.md.
 */
export const GUTTER = "  ";

const LABEL_WIDTH = 16;
// A shortened value stays readable at a glance even on a wide terminal.
const TRUNCATED_VALUE_MAX = 48;

/** The column-0 glyph for each kind of status line. */
export type Glyph = "success" | "warning" | "error" | "prompt" | "context" | "none";

const renderGlyph = (glyph: Glyph, stream: ColorStream): string => {
  switch (glyph) {
    case "success":
      return success("✓", stream);
    case "warning":
      return warning("!", stream);
    case "error":
      return error("✗", stream);
    case "prompt":
      return muted("?", stream);
    case "context":
      return success("➜", stream);
    case "none":
      return " ";
  }
};

/** Renders a status line: the glyph in column 0, the text and its continuation lines from column 2. */
export function statusLine(
  glyph: Glyph,
  text: string,
  stream: ColorStream = process.stdout,
): string {
  const [first = "", ...rest] = text.split("\n");
  return `${renderGlyph(glyph, stream)} ${first}\n${block(rest.join("\n"))}`;
}

/** Indents every non-empty line of `text` to column 2. */
export function block(text: string): string {
  if (text === "") return "";
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => (line === "" ? "" : `${GUTTER}${line}`))
    .join("\n")
    .concat("\n");
}

/** A label/value row; `middle` shortens a long value with ` … ` in the middle. */
export type DetailRow =
  | readonly [label: string, value: string]
  | readonly [label: string, value: string, truncate: "middle"];

const MIDDLE_ELLIPSIS = " … ";

/** Shortens `text` to `width` columns by replacing its middle with ` … `. */
export function truncateMiddle(text: string, width: number): string {
  if (text.length <= width) return text;
  const keep = width - MIDDLE_ELLIPSIS.length;
  if (keep < 2) return MIDDLE_ELLIPSIS.trim();
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}${MIDDLE_ELLIPSIS}${text.slice(text.length - (keep - head))}`;
}

/** Shortens descriptive `text` to `width` columns, ending with `…`. Never use it for IDs or paths. */
export function truncateEnd(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

const GLYPHS = new Set(["✓", "!", "✗", "?", "▸", "➜", "◒", "◐", "◓", "◑"]);

/**
 * Puts every line on the gutter: a line that starts at column 0 without a glyph moves to column 2.
 * Lines that already start with whitespace or a glyph are left alone, and JSON is never touched.
 */
export function indentLines(text: string): string {
  const plain = stripVTControlCharacters(text).trimStart();
  if (plain.startsWith("{") || plain.startsWith("[")) return text;
  return text
    .split("\n")
    .map((line) => {
      const first = stripVTControlCharacters(line).charAt(0);
      return first === "" || first === " " || GLYPHS.has(first) ? line : `${GUTTER}${line}`;
    })
    .join("\n");
}

/** Renders label/value rows: labels from column 2, values from column 18. */
export function detailRows(
  rows: ReadonlyArray<DetailRow>,
  stream: { readonly columns?: number | undefined } = process.stdout,
): string {
  // Labels longer than the standard column push every value in the block further right together.
  const labelWidth = Math.max(LABEL_WIDTH, ...rows.map(([label]) => label.length + 2));
  const valueWidth = Math.min(
    TRUNCATED_VALUE_MAX,
    Math.max(20, (stream.columns ?? 80) - GUTTER.length - LABEL_WIDTH),
  );
  return block(
    rows
      .map(([label, value, truncate]) => {
        const shown = truncate === "middle" ? truncateMiddle(value, valueWidth) : value;
        return `${label.padEnd(labelWidth - 1)} ${shown}`;
      })
      .join("\n"),
  );
}

/**
 * Renders a next step: the benefit as a line ending in a colon, then the complete command on its
 * own indented line in the `command` colour. Like every block it starts with a blank line.
 */
export function nextStep(
  benefit: string,
  next: string,
  stream: ColorStream = process.stdout,
): string {
  return `\n${block(`${benefit}:\n${GUTTER}${command(next, stream)}`)}`;
}

/** A failure as people read it: a headline, optional detail, and an optional way to recover. */
export interface ErrorView {
  readonly message: string;
  readonly detail?: string | undefined;
  /** Free-text guidance, shown under the headline after a blank line. */
  readonly suggestion?: string | undefined;
  readonly recovery?: { readonly instruction: string; readonly command: string } | undefined;
}

/**
 * Renders an error: `✗` and the headline in column 0, detail lines from column 2, then after a
 * blank line the suggestion or a recovery instruction ending in a colon with its command at
 * column 4. See https://vercel.com/design/cli#failure-and-recovery.
 */
export function errorBlock(view: ErrorView, stream: ColorStream = process.stderr): string {
  const [headline = "", ...more] = view.message.split("\n");
  const detail = [...more, ...(view.detail === undefined ? [] : view.detail.split("\n"))]
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const head = `${renderGlyph("error", stream)} ${headline}\n${block(detail.map((line) => muted(line, stream)).join("\n"))}`;
  const guidance =
    view.suggestion !== undefined
      ? block(view.suggestion.replace(/^\s+/gm, ""))
      : view.recovery !== undefined
        ? block(`${view.recovery.instruction}:\n${GUTTER}${command(view.recovery.command, stream)}`)
        : "";
  return guidance === "" ? head : `${head}\n${guidance}`;
}

// clack draws prompt and spinner glyphs in column 0 followed by two spaces; the gutter keeps the
// glyph and starts text in column 2. Diamonds become the prompt glyph.
const CLACK_GLYPHS: Readonly<Record<string, Glyph | "keep">> = {
  "◆": "prompt",
  "◇": "prompt",
  "■": "error",
  "▲": "warning",
  "◒": "keep",
  "◐": "keep",
  "◓": "keep",
  "◑": "keep",
};
// oxlint-disable-next-line no-control-regex -- matches terminal escape sequences
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/y;
// Sequences that leave the cursor in column 0: cursor-to-column and clack's move(-999, …).
// oxlint-disable-next-line no-control-regex -- matches terminal escape sequences
const RETURNS_TO_COLUMN_ZERO = /^\u001b\[(?:[01]?G|\d{3,}D)$/;

/**
 * Wraps a terminal stream so clack's prompts and spinners follow the gutter: their glyphs map to
 * ours and every other line starts at column 2. The reported width shrinks by the gutter so clack
 * wraps inside it.
 */
export function gutterStream(stream: NodeJS.WriteStream): NodeJS.WriteStream {
  let atLineStart = true;
  let dropSpace = false;
  const transform = (chunk: string): string => {
    let out = "";
    let index = 0;
    while (index < chunk.length) {
      ANSI.lastIndex = index;
      const escape = ANSI.exec(chunk);
      if (escape !== null) {
        out += escape[0];
        if (RETURNS_TO_COLUMN_ZERO.test(escape[0])) atLineStart = true;
        index += escape[0].length;
        continue;
      }
      const char = chunk[index] ?? "";
      index += 1;
      if (char === "\n" || char === "\r") {
        out += char;
        atLineStart = true;
        dropSpace = false;
        continue;
      }
      if (dropSpace && char === " ") {
        dropSpace = false;
        continue;
      }
      dropSpace = false;
      if (!atLineStart) {
        out += char;
        continue;
      }
      atLineStart = false;
      const glyph = CLACK_GLYPHS[char];
      if (glyph === undefined) {
        out += `${GUTTER}${char}`;
      } else {
        out += glyph === "keep" ? char : stripVTControlCharacters(renderGlyph(glyph, stream));
        dropSpace = true;
      }
    }
    return out;
  };
  return new Proxy(stream, {
    get(target, property) {
      if (property === "write") {
        return (chunk: unknown, ...rest: Array<never>) =>
          target.write(
            typeof chunk === "string" ? transform(chunk) : (chunk as Uint8Array),
            ...rest,
          );
      }
      if (property === "columns") {
        return Math.max(20, (target.columns ?? 80) - GUTTER.length);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
