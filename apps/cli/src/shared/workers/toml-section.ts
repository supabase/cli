/**
 * Surgical edits to one `[section]` of a TOML file.
 *
 * `supabase/config.toml` belongs to the whole CLI: users hand-edit it, comment
 * it, and commit it. Round-tripping it through `saveProjectConfig` preserves the
 * data but discards every comment and normalizes the formatting the user chose
 * — a surprising side effect of `supabase workers new`, and a noisy diff in a
 * PR. So writes here are textual: locate the worker's own table, update the keys
 * that changed in place, append the ones that are new, and leave every other
 * byte of the file exactly as it was.
 *
 * Reading is still done with the real parser (`@supabase/config`); only writing
 * is textual, and only ever inside the one table it owns.
 */

/** A TOML bare key needs no quoting; anything else does. */
function isBareKey(key: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(key);
}

/** Escape a string for a TOML basic (double-quoted) string. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Render `key` for use in a table header or key position. */
export function tomlKey(key: string): string {
  return isBareKey(key) ? key : quote(key);
}

/** `key = "value"` — every value the worker commands write is a string. */
function renderPair(key: string, value: string): string {
  return `${tomlKey(key)} = ${quote(value)}`;
}

/**
 * Index of the standalone `[header]` line, or -1.
 *
 * TOML allows whitespace inside the brackets and a trailing comment, so
 * `[ workers.api ]  # mine` is the same table as `[workers.api]`. Matching on
 * the exact string would miss it and append a second table with the same name,
 * which is not valid TOML.
 */
function findHeader(lines: ReadonlyArray<string>, header: string): number {
  const pattern = new RegExp(`^\\s*\\[\\s*${escapeRegExp(header)}\\s*\\]\\s*(?:#.*)?$`);
  return lines.findIndex((line) => pattern.test(line));
}

/** Whether `text` contains a standalone `[header]` table line. */
export function sectionExists(text: string, header: string): boolean {
  return findHeader(text.split("\n"), header) !== -1;
}

/** Whether a line opens a new table (`[x]` or `[[x]]`), ending the current one. */
function opensTable(line: string): boolean {
  return /^\s*\[/.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What follows the `=` on a key's line: whether the value finishes there, and
 * any trailing comment.
 *
 * Both matter for a rewrite. A value that spans lines (an array, an inline
 * table, a `"""` string) cannot be replaced by swapping one line — doing so
 * strands its continuation lines and leaves the file unparseable. And a trailing
 * comment is the user's, so it survives the rewrite; a module that exists to
 * preserve comments should not eat the one sitting next to the value it edits.
 */
interface ScannedValue {
  /** `false` when the value continues onto the next line. */
  readonly complete: boolean;
  /** The trailing comment including its `#`, or `""`. */
  readonly comment: string;
}

function scanValue(line: string, from: number): ScannedValue {
  let depth = 0;
  let index = from;

  while (index < line.length) {
    const char = line[index];

    // A `#` outside any string or bracket starts the comment; everything from
    // here to the end of the line belongs to the user.
    if (char === "#" && depth === 0) {
      return { complete: true, comment: line.slice(index) };
    }

    if (char === '"' || char === "'") {
      const quote = char;
      const triple = line.startsWith(quote.repeat(3), index);
      const closer = triple ? quote.repeat(3) : quote;
      // A basic string honours backslash escapes; a literal string does not.
      const escapes = quote === '"';
      let cursor = index + closer.length;
      let closed = false;
      while (cursor < line.length) {
        if (escapes && line[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (line.startsWith(closer, cursor)) {
          cursor += closer.length;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) {
        return { complete: false, comment: "" };
      }
      index = cursor;
      continue;
    }

    if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
    }
    index += 1;
  }

  return { complete: depth === 0, comment: "" };
}

/**
 * The outcome of an edit. A value that spans lines cannot be rewritten one line
 * at a time, so rather than emit a broken file this reports which key it could
 * not touch and lets the caller say so.
 */
export type TomlSectionEdit =
  | { readonly _tag: "Edited"; readonly text: string }
  | { readonly _tag: "Unsupported"; readonly key: string };

/**
 * Set each of `values` inside `[header]`, returning the new file text.
 *
 * An existing key is rewritten in place, preserving its position, any comment on
 * the line above it, and any comment trailing the value itself; a new key is
 * appended after the table's last non-blank line, so trailing blank lines stay
 * between tables rather than being swallowed. A missing table is appended at the
 * end of the file, separated by one blank line.
 */
export function upsertTomlSection(
  text: string,
  header: string,
  values: Readonly<Record<string, string>>,
): TomlSectionEdit {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return { _tag: "Edited", text };
  }

  const lines = text.split("\n");
  const start = findHeader(lines, header);

  if (start === -1) {
    const block = [`[${header}]`, ...entries.map(([key, value]) => renderPair(key, value))];
    // A file that is empty (or only whitespace) gets no leading blank line; an
    // existing one gets exactly one, however it happened to be terminated.
    if (text.trim() === "") {
      return { _tag: "Edited", text: `${block.join("\n")}\n` };
    }
    return {
      _tag: "Edited",
      text: `${text.replace(/\n*$/, "")}\n\n${block.join("\n")}\n`,
    };
  }

  // The table runs to the next table header, or the end of the file.
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (opensTable(lines[index] ?? "")) {
      end = index;
      break;
    }
  }

  const pending = new Map(entries);
  for (let index = start + 1; index < end; index++) {
    const line = lines[index] ?? "";
    for (const [key, value] of pending) {
      // Match `key =`, `"key" =`, with any leading indentation the user used.
      const pattern = new RegExp(
        `^(\\s*)(?:${escapeRegExp(key)}|${escapeRegExp(quote(key))})(\\s*)=`,
      );
      const match = pattern.exec(line);
      if (match === null) {
        continue;
      }
      const scanned = scanValue(line, match[0].length);
      if (!scanned.complete) {
        return { _tag: "Unsupported", key };
      }
      const trailing = scanned.comment === "" ? "" : ` ${scanned.comment}`;
      lines[index] =
        `${match[1] ?? ""}${tomlKey(key)}${match[2] ?? ""}= ${quote(value)}${trailing}`;
      pending.delete(key);
      break;
    }
  }

  if (pending.size > 0) {
    // Append after the last line with content, so a blank line separating this
    // table from the next stays where it is.
    let insertAt = start + 1;
    for (let index = start + 1; index < end; index++) {
      if ((lines[index] ?? "").trim() !== "") {
        insertAt = index + 1;
      }
    }
    lines.splice(insertAt, 0, ...[...pending].map(([key, value]) => renderPair(key, value)));
  }

  return { _tag: "Edited", text: lines.join("\n") };
}
