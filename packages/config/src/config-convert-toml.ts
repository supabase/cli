import * as SmolToml from "smol-toml";
import {
  type ArrayNode,
  type Entry,
  type JsoncComment,
  type JsoncDocument,
  type JsoncNode,
  type LeadingItem,
  type ObjectNode,
  parseJsoncDocument,
  refuse,
} from "./config-convert-toml-parse.ts";
import { deepEqualValue } from "./config-edit.ts";
import { JsoncSyntaxError, parseJsonc } from "./jsonc.ts";
import { CLI_CONFIG_SCHEMA_URL } from "./schema-metadata.ts";
import { readCliConfigSchemaDeclaration } from "./schema-version.ts";

/** A JSONC comment that moved to a nearby TOML line, with its source line and anchor key path. */
export interface MovedJsoncComment {
  readonly line: number;
  readonly text: string;
  readonly anchor: ReadonlyArray<string>;
}

/** The TOML text converted from a JSONC config, with its schema reference and moved comments. */
export interface CliConfigConvertedToml {
  readonly text: string;
  readonly schemaRef: string;
  readonly schemaSource: "key" | "default";
  readonly commentCount: number;
  readonly movedComments: ReadonlyArray<MovedJsoncComment>;
}

interface SectionOptions {
  readonly array: boolean;
  readonly leading: ReadonlyArray<LeadingItem>;
  readonly commented: boolean;
  readonly tailExtra?: ReadonlyArray<string>;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

const tomlString = (value: string): string => JSON.stringify(value).split("\u007f").join("\\u007f");

const tomlKey = (key: string): string => (BARE_KEY.test(key) ? key : tomlString(key));

const tomlNumber = (value: number): string => {
  if (Number.isInteger(value)) {
    return Number.isSafeInteger(value) ? String(value) : value.toExponential();
  }
  return String(value);
};

const tomlLiteral = (value: string | number | boolean): string =>
  typeof value === "string"
    ? tomlString(value)
    : typeof value === "number"
      ? tomlNumber(value)
      : String(value);

const inlineNode = (node: JsoncNode): string => {
  if (node.kind === "literal") {
    return tomlLiteral(node.value);
  }
  if (node.kind === "array") {
    return `[${node.items.map((item) => inlineNode(item.value)).join(", ")}]`;
  }
  const members = node.entries.filter((entry) => entry.kind === "member");
  return members.length === 0
    ? "{}"
    : `{ ${members.map((entry) => `${tomlKey(entry.key)} = ${inlineNode(entry.value)}`).join(", ")} }`;
};

const isTable = (node: JsoncNode): node is ObjectNode => node.kind === "object";

const isTableArray = (node: JsoncNode): node is ArrayNode =>
  node.kind === "array" && node.items.length > 0 && node.items.every((item) => isTable(item.value));

const isChild = (entry: Entry): boolean => isTable(entry.value) || isTableArray(entry.value);

const leadingComments = (leading: ReadonlyArray<LeadingItem>): Array<JsoncComment> =>
  leading.flatMap((item) => (item.blank ? [] : [item.comment]));

/**
 * Comments inside a value rendered on one line. `shown` are hoisted above it; `absorbed` belong to
 * commented-out examples that the inline form drops and are already covered by their source lines.
 */
const collectComments = (
  node: JsoncNode,
  shown: Array<JsoncComment>,
  absorbed: Array<JsoncComment>,
): void => {
  if (node.kind === "literal") {
    return;
  }
  if (node.open !== undefined) {
    shown.push(node.open);
  }
  if (node.kind === "array") {
    for (const item of node.items) {
      shown.push(...item.lead);
      collectComments(item.value, shown, absorbed);
      if (item.inline !== undefined) {
        shown.push(item.inline);
      }
    }
    shown.push(...node.tail);
    return;
  }
  for (const entry of node.entries) {
    shown.push(...leadingComments(entry.leading));
    if (entry.kind === "example") {
      shown.push(...entry.consumed);
      absorbed.push(...entry.absorbed);
    } else {
      collectComments(entry.value, shown, absorbed);
      if (entry.inline !== undefined) {
        shown.push(entry.inline);
      }
    }
  }
  shown.push(...leadingComments(node.tail));
};

const printable = (text: string): string =>
  [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      return (code < 32 && code !== 9) || code === 127 ? " " : char;
    })
    .join("");

const newlineOf = (text: string): string => {
  const first = text.indexOf("\n");
  return first > 0 && text[first - 1] === "\r" ? "\r\n" : "\n";
};

const singleLine = (raw: string): string =>
  raw
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");

const renderDocument = (doc: JsoncDocument, schemaRef: string, schemaEntry?: Entry) => {
  const carried = new Set<number>();
  const moved: Array<MovedJsoncComment> = [];

  const carry = (comment: JsoncComment): void => {
    carried.add(comment.id);
  };

  const commentLines = (comment: JsoncComment): Array<string> => {
    carry(comment);
    return comment.lines.map((line) => `#${printable(line)}`.trimEnd());
  };

  const inlineText = (comment: JsoncComment): string => {
    carry(comment);
    const text = comment.lines
      .map((line) => printable(line).trim())
      .filter((line) => line !== "")
      .join(" ");
    return text === "" ? "#" : `# ${text}`;
  };

  const recordMoved = (comment: JsoncComment, anchor: ReadonlyArray<string>): void => {
    moved.push({ line: comment.line, text: singleLine(comment.raw), anchor });
  };

  const hoist = (comments: ReadonlyArray<JsoncComment>, anchor: ReadonlyArray<string>) =>
    comments.flatMap((comment) => {
      recordMoved(comment, anchor);
      return commentLines(comment);
    });

  const movedLeading = (comment: JsoncComment, anchor: ReadonlyArray<string>): LeadingItem => {
    recordMoved(comment, anchor);
    return { blank: false, comment };
  };

  const leadingLines = (leading: ReadonlyArray<LeadingItem>): Array<string> =>
    leading.flatMap((item) => (item.blank ? [""] : commentLines(item.comment)));

  const leaf = (entry: Entry, path: ReadonlyArray<string>, commented: boolean): Array<string> => {
    const lead = leadingLines(entry.leading);
    entry.consumed.forEach(carry);
    const key = tomlKey(entry.key);
    const value = entry.value;
    const trailing = entry.inline === undefined ? "" : ` ${inlineText(entry.inline)}`;
    const asComment = commented || entry.kind === "example";
    if (
      !asComment &&
      value.kind === "array" &&
      value.multiline &&
      value.items.length > 0 &&
      value.items.every((item) => item.value.kind === "literal")
    ) {
      const open = value.open === undefined ? "" : ` ${inlineText(value.open)}`;
      const items = value.items.flatMap((item) => {
        const own = item.inline === undefined ? "" : ` ${inlineText(item.inline)}`;
        return [
          ...item.lead.flatMap(commentLines).map((line) => `  ${line}`),
          `  ${inlineNode(item.value)},${own}`,
        ];
      });
      return [
        ...lead,
        `${key} = [${open}`,
        ...items,
        ...value.tail.flatMap(commentLines).map((line) => `  ${line}`),
        `]${trailing}`,
      ];
    }
    const shown: Array<JsoncComment> = [];
    const absorbed: Array<JsoncComment> = [];
    collectComments(value, shown, absorbed);
    absorbed.forEach(carry);
    const hoisted = hoist(shown, [...path, entry.key]);
    const line = `${key} = ${inlineNode(value)}${trailing}`;
    return [...lead, ...hoisted, asComment ? `# ${line}` : line];
  };

  const tableArray = (
    array: ArrayNode,
    path: ReadonlyArray<string>,
    leading: ReadonlyArray<LeadingItem>,
    commented: boolean,
    after: JsoncComment | undefined,
  ): Array<string> => {
    let carryOver: Array<LeadingItem> = [
      ...leading,
      ...(array.open === undefined ? [] : [movedLeading(array.open, path)]),
    ];
    return array.items.flatMap((item, index) => {
      const last = index === array.items.length - 1;
      const extra = last
        ? hoist(
            [
              ...(item.inline === undefined ? [] : [item.inline]),
              ...array.tail,
              ...(after === undefined ? [] : [after]),
            ],
            path,
          )
        : [];
      const lines = section(item.value as ObjectNode, path, {
        array: true,
        leading: [
          ...carryOver,
          ...item.lead.map((comment): LeadingItem => ({ blank: false, comment })),
        ],
        commented,
        tailExtra: extra,
      });
      carryOver = !last && item.inline !== undefined ? [movedLeading(item.inline, path)] : [];
      return index === 0 ? lines : ["", ...lines];
    });
  };

  const section = (
    obj: ObjectNode,
    path: ReadonlyArray<string>,
    options: SectionOptions,
  ): Array<string> => {
    const leaves = obj.entries.filter((entry) => !isChild(entry));
    const children = obj.entries.filter(isChild);
    // TOML creates a table that only holds subtables implicitly, so it needs no header unless it carries comments (leading or inside).
    const implicit =
      !options.array &&
      path.length > 0 &&
      leaves.length === 0 &&
      children.some((entry) => entry.kind === "member") &&
      obj.open === undefined &&
      obj.tail.length === 0 &&
      (options.commented || options.leading.every((item) => item.blank)) &&
      (options.tailExtra ?? []).length === 0;
    const lines: Array<string> = [];
    let inherited: ReadonlyArray<LeadingItem> = [];
    if (implicit) {
      inherited = options.leading;
    } else if (path.length > 0) {
      const opening = options.array ? "[[" : "[";
      const closing = options.array ? "]]" : "]";
      const open = obj.open === undefined ? "" : ` ${inlineText(obj.open)}`;
      const header = `${opening}${path.map(tomlKey).join(".")}${closing}${open}`;
      lines.push(...leadingLines(options.leading), options.commented ? `# ${header}` : header);
    }
    for (const entry of leaves) {
      lines.push(...leaf(entry, path, options.commented));
    }
    const lastEntry = obj.entries[obj.entries.length - 1];
    const tailMoves = lastEntry !== undefined && isChild(lastEntry);
    for (const item of obj.tail) {
      lines.push(
        ...(item.blank
          ? [""]
          : tailMoves
            ? hoist([item.comment], path)
            : commentLines(item.comment)),
      );
    }
    lines.push(...(options.tailExtra ?? []));
    children.forEach((entry, index) => {
      const childPath = [...path, entry.key];
      const leading: ReadonlyArray<LeadingItem> = [
        ...(index === 0 ? inherited : []),
        ...entry.leading,
      ];
      const commented = options.commented || entry.kind === "example";
      entry.consumed.forEach(carry);
      lines.push("");
      if (isTable(entry.value)) {
        const nestsTables = entry.value.entries.some(isChild);
        lines.push(
          ...section(entry.value, childPath, {
            array: false,
            leading,
            commented,
            tailExtra:
              nestsTables && entry.inline !== undefined ? hoist([entry.inline], childPath) : [],
          }),
        );
        if (!nestsTables && entry.inline !== undefined) {
          lines.push(inlineText(entry.inline));
        }
      } else if (entry.value.kind === "array") {
        lines.push(...tableArray(entry.value, childPath, leading, commented, entry.inline));
      }
    });
    return lines;
  };

  const lead = [
    ...doc.lead.flatMap(commentLines),
    ...(doc.root.open === undefined ? [] : commentLines(doc.root.open)),
    ...(schemaEntry === undefined ? [] : leadingLines(schemaEntry.leading)),
    ...(schemaEntry?.inline === undefined ? [] : [inlineText(schemaEntry.inline)]),
  ];
  const body = section(doc.root, [], { array: false, leading: [], commented: false });
  const end = doc.end.flatMap(commentLines);
  const lines = [
    `#:schema ${schemaRef}`,
    "",
    ...lead,
    ...body,
    ...(end.length > 0 ? ["", ...end] : []),
  ];

  const out: Array<string> = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (line === "" && (previous === "" || previous?.startsWith("[") === true)) {
      continue;
    }
    out.push(line);
  }
  while (out[out.length - 1] === "") {
    out.pop();
  }
  return { lines: out, carried, moved };
};

const convertDocument = (source: string): CliConfigConvertedToml => {
  const text = source.startsWith("﻿") ? source.slice(1) : source;
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    if (error instanceof JsoncSyntaxError) {
      return refuse("parse_error", error.message, error.line);
    }
    throw error;
  }
  const doc = parseJsoncDocument(text);
  const schemaEntry = doc.root.entries.find(
    (entry) => entry.kind === "member" && entry.key === "$schema",
  );
  let schemaRef = CLI_CONFIG_SCHEMA_URL;
  let schemaSource: "key" | "default" = "default";
  if (schemaEntry !== undefined) {
    if (schemaEntry.value.kind !== "literal" || typeof schemaEntry.value.value !== "string") {
      return refuse("unsupported_value", "`$schema` must be a string", schemaEntry.line);
    }
    if (schemaEntry.value.value === "" || /\s/.test(schemaEntry.value.value)) {
      return refuse(
        "unsupported_value",
        "`$schema` is empty or contains whitespace, which TOML's `#:schema` directive can't hold; use a reference without whitespace, then rerun",
        schemaEntry.line,
      );
    }
    schemaRef = schemaEntry.value.value;
    schemaSource = "key";
    doc.root.entries = doc.root.entries.filter((entry) => entry !== schemaEntry);
  }

  const rendered = renderDocument(doc, schemaRef, schemaEntry);
  const newline = newlineOf(text);
  const output = `${rendered.lines.join(newline)}${newline}`;

  const dropped = doc.comments
    .filter((comment) => !rendered.carried.has(comment.id))
    .sort((a, b) => a.line - b.line)[0];
  if (dropped !== undefined) {
    return refuse(
      "verification_mismatch",
      `could not place the comment on line ${dropped.line}; move or remove it, then rerun`,
      dropped.line,
    );
  }
  let actual: unknown;
  try {
    actual = SmolToml.parse(output);
  } catch (error) {
    return refuse(
      "verification_mismatch",
      `converted document does not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { $schema: _schema, ...expected } = parsed as Record<string, unknown>;
  if (!deepEqualValue(actual, expected)) {
    return refuse("verification_mismatch", "converted document does not match the original values");
  }
  if (readCliConfigSchemaDeclaration(output, "toml", actual)?.ref !== schemaRef) {
    return refuse("verification_mismatch", "converted document lost its schema declaration");
  }
  return {
    text: output,
    schemaRef,
    schemaSource,
    commentCount: doc.comments.filter((comment) => !comment.nested).length,
    movedComments: rendered.moved,
  };
};

/** Converts a `config.jsonc`/`config.json` document to `config.toml` text with comments carried over; verified by re-parse. */
export const convertCliConfigJsoncToToml = (source: string): CliConfigConvertedToml => {
  try {
    return convertDocument(source);
  } catch (error) {
    if (error instanceof RangeError) {
      return refuse("unsupported_value", "the config is nested too deeply to convert");
    }
    throw error;
  }
};
