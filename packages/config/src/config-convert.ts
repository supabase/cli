import { Data, Effect } from "effect";
import * as SmolToml from "smol-toml";
import {
  type CommentedNode,
  commentedChild,
  commentOut,
  newCommentedNode,
  type PlacedComment,
  translateGroup,
} from "./config-convert-comments.ts";
import {
  type ArrayDecor,
  INDENT,
  indented,
  isScalar,
  renderValue,
  toJsoncComment,
  unsupportedReason,
  withComma,
} from "./config-convert-values.ts";
import { deepEqualValue } from "./config-edit.ts";
import { parseJsonc } from "./jsonc.ts";
import { CLI_CONFIG_SCHEMA_URL } from "./schema-metadata.ts";
import {
  scanScalarArrayLayout,
  scanTomlDocument,
  tomlSchemaDirective,
  type TomlArrayLayout,
  type TomlHeaderToken,
  type TomlKeyToken,
  type TomlToken,
} from "./toml-scan.ts";

export interface MovedTomlComment {
  readonly line: number;
  readonly text: string;
  readonly anchor: ReadonlyArray<string>;
}

export interface CliConfigConverted {
  readonly text: string;
  readonly schemaRef: string;
  readonly schemaSource: "directive" | "key" | "default";
  readonly commentCount: number;
  readonly movedComments: ReadonlyArray<MovedTomlComment>;
}

/** The converter refused the document; `sourceLine` is the 1-based `config.toml` line when known. */
export class CliConfigConvertError extends Data.TaggedError("CliConfigConvertError")<{
  readonly reason: "parse_error" | "unsupported_value" | "verification_mismatch";
  readonly detail: string;
  readonly sourceLine?: number;
}> {}

interface Decor {
  readonly lead: Array<string>;
  blankBefore: boolean;
  inline?: string;
  at: number;
}

interface LeafNode extends Decor {
  readonly kind: "leaf";
  readonly value: unknown;
  readonly spread: boolean;
  array?: ArrayDecor;
  readonly hoisted: Array<string>;
  readonly trail: Array<string>;
}

interface TableNode extends Decor {
  readonly kind: "table";
  entries: Map<string, ConfigNode>;
  readonly inner: Array<string>;
  readonly placed: Array<PlacedComment>;
  readonly forest: CommentedNode;
}

interface ArrayOfTablesNode {
  readonly kind: "aot";
  readonly elements: Array<TableNode>;
}

type ConfigNode = LeafNode | TableNode | ArrayOfTablesNode;

function refusal(
  reason: CliConfigConvertError["reason"],
  detail: string,
  sourceLine?: number,
): CliConfigConvertError {
  return new CliConfigConvertError({
    reason,
    detail,
    ...(sourceLine === undefined ? {} : { sourceLine }),
  });
}

function newTable(): TableNode {
  return {
    kind: "table",
    entries: new Map(),
    lead: [],
    blankBefore: false,
    at: -1,
    inner: [],
    placed: [],
    forest: newCommentedNode(-1),
  };
}

function entryAt(node: ConfigNode): number {
  return node.kind === "aot" ? (node.elements[0]?.at ?? -1) : node.at;
}

function renderTableBody(table: TableNode, indent: string): Array<string> {
  const entries = [...table.entries];
  const pending = [
    ...table.placed,
    ...[...table.forest.children].map(([key, node]) => ({
      at: node.at,
      blankBefore: true,
      lines: [...node.lead, ...commentOut(withComma(commentedChild(key, node, ""), ","))],
    })),
  ].sort((a, b) => a.at - b.at);
  const body = indented(indent, table.inner);
  const flushBefore = (limit: number) => {
    for (let item = pending[0]; item !== undefined && item.at < limit; item = pending[0]) {
      pending.shift();
      body.push(
        ...(item.blankBefore && body.length > 0 ? [""] : []),
        ...indented(indent, item.lines),
      );
    }
  };
  for (const [index, [key, node]] of entries.entries()) {
    flushBefore(entryAt(node));
    const comma = index < entries.length - 1 || pending.length > 0 ? "," : "";
    const first = index === 0 && body.length === table.inner.length;
    body.push(...renderEntry(key, node, indent, comma, first));
  }
  flushBefore(Number.POSITIVE_INFINITY);
  return body;
}

function renderTableOpen(
  table: TableNode,
  prefix: string,
  indent: string,
  comma: string,
): Array<string> {
  const inline = table.inline === undefined ? "" : ` ${table.inline}`;
  const body = renderTableBody(table, `${indent}${INDENT}`);
  if (body.length === 0) {
    return [`${indent}${prefix}{}${comma}${inline}`];
  }
  return [`${indent}${prefix}{${inline}`, ...body, `${indent}}${comma}`];
}

function renderEntry(
  key: string,
  node: ConfigNode,
  indent: string,
  comma: string,
  first: boolean,
): Array<string> {
  const name = JSON.stringify(key);
  const blank = (decor: Decor) => (decor.blankBefore && !first ? [""] : []);
  if (node.kind === "leaf") {
    const [head = "", ...rest] = renderValue(node.value, indent, node.spread, node.array);
    const lines = [`${indent}${name}: ${head}`, ...rest];
    lines[lines.length - 1] += `${comma}${node.inline === undefined ? "" : ` ${node.inline}`}`;
    return [
      ...blank(node),
      ...indented(indent, node.lead),
      ...indented(indent, node.hoisted),
      ...lines,
      ...indented(indent, node.trail),
    ];
  }
  if (node.kind === "table") {
    return [
      ...blank(node),
      ...indented(indent, node.lead),
      ...renderTableOpen(node, `${name}: `, indent, comma),
    ];
  }
  const elementIndent = `${indent}${INDENT}`;
  const elements = node.elements.flatMap((element, index) => [
    ...(index > 0 && element.blankBefore ? [""] : []),
    ...indented(elementIndent, element.lead),
    ...renderTableOpen(element, "", elementIndent, index < node.elements.length - 1 ? "," : ""),
  ]);
  const head = node.elements[0];
  return [
    ...(head === undefined ? [] : blank(head)),
    `${indent}${name}: [`,
    ...elements,
    `${indent}]${comma}`,
  ];
}

function isMember(token: TomlToken | undefined): token is TomlHeaderToken | TomlKeyToken {
  return token?.kind === "header" || token?.kind === "kv";
}

const descend = Effect.fnUntraced(function* (
  parent: TableNode,
  segment: string,
  line: number,
  created: Array<TableNode>,
) {
  const existing = parent.entries.get(segment);
  if (existing === undefined) {
    const table = newTable();
    parent.entries.set(segment, table);
    created.push(table);
    return table;
  }
  if (existing.kind === "table") {
    return existing;
  }
  const last =
    existing.kind === "aot" ? existing.elements[existing.elements.length - 1] : undefined;
  if (last === undefined) {
    return yield* refusal("parse_error", `"${segment}" is defined twice`, line);
  }
  return last;
});

const walk = Effect.fnUntraced(function* (
  root: TableNode,
  path: ReadonlyArray<string>,
  line: number,
  created: Array<TableNode>,
) {
  let table = root;
  for (const segment of path) {
    table = yield* descend(table, segment, line, created);
  }
  return table;
});

function arrayDecor(
  layout: TomlArrayLayout,
  text: string,
  comment: (raw: string) => string,
): ArrayDecor {
  const raw = (span: { readonly start: number; readonly end: number }) =>
    comment(text.slice(span.start, span.end));
  return {
    items: layout.items.map((item) => ({
      lead: item.leading.map(raw),
      ...(item.trailing === undefined ? {} : { trail: raw(item.trailing) }),
    })),
    tail: layout.tail.map(raw),
  };
}

const convertDocument = Effect.fnUntraced(function* (text: string) {
  const parsed = yield* Effect.try({
    try: () => SmolToml.parse(text),
    catch: (error) =>
      refusal(
        "parse_error",
        error instanceof Error ? error.message : String(error),
        error instanceof SmolToml.TomlError ? error.line : undefined,
      ),
  });
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
  const scan = yield* Effect.try({
    try: () => scanTomlDocument(text),
    catch: (error) =>
      refusal("parse_error", error instanceof Error ? error.message : String(error)),
  });
  if ("error" in scan) {
    return yield* refusal("parse_error", scan.error, lineOf(scan.offset));
  }
  const { tokens, headers } = scan;
  let commentCount = 0;
  const comment = (raw: string) => {
    commentCount++;
    return toJsoncComment(raw);
  };
  const commentAt = (offset: number) => comment(text.slice(offset).split(/\r?\n|\r/, 1)[0] ?? "");

  const directive = Object.hasOwn(parsed, "$schema") ? undefined : tomlSchemaDirective(text);
  const firstTokenIndex = directive === undefined ? 0 : 1;

  const root = newTable();
  const rootLead: Array<string> = [];
  const rootEnd: Array<string> = [];
  const movedComments: Array<MovedTomlComment> = [];
  const members: Array<TableNode | LeafNode | undefined> = [];
  const implicitParents = new Map<number, TableNode>();
  const effective: Array<TableNode> = [];
  let scannedComments = directive === undefined ? 0 : -1;
  let current = root;

  for (const [index, token] of tokens.entries()) {
    const created: Array<TableNode> = [];
    if (token.kind === "comment") {
      scannedComments++;
    } else if (token.kind === "header") {
      const line = lineOf(token.start);
      let table: TableNode;
      if (token.isArrayOfTables) {
        const parent = yield* walk(root, token.path.slice(0, -1), line, created);
        const name = token.path[token.path.length - 1] ?? "";
        const existing = parent.entries.get(name);
        table = newTable();
        if (existing === undefined) {
          parent.entries.set(name, { kind: "aot", elements: [table] });
        } else if (existing.kind === "aot") {
          existing.elements.push(table);
        } else {
          return yield* refusal("parse_error", `"${name}" is defined twice`, line);
        }
      } else {
        table = yield* walk(root, token.path, line, created);
      }
      const implicit = created[0];
      if (implicit !== undefined && implicit !== table) {
        implicitParents.set(index, implicit);
      }
      if (token.commentStart !== undefined) {
        scannedComments++;
        table.inline = commentAt(token.commentStart);
      }
      if (token.isArrayOfTables) {
        table.at = index;
      }
      current = table;
      members[index] = table;
    } else if (token.kind === "kv") {
      const line = lineOf(token.start);
      const base = token.tableIndex >= 0 ? (headers[token.tableIndex]?.path.length ?? 0) : 0;
      const relative = token.path.slice(base);
      const parent = yield* walk(current, relative.slice(0, -1), line, created);
      const name = relative[relative.length - 1] ?? "";
      if (parent.entries.has(name)) {
        return yield* refusal("parse_error", `"${name}" is defined twice`, line);
      }
      if (created[0] !== undefined) {
        implicitParents.set(index, created[0]);
      }
      const valueText = text.slice(token.valueStart, token.valueEnd);
      const value = yield* Effect.try({
        try: () => SmolToml.parse(`v = ${valueText}`)["v"],
        catch: (error) =>
          refusal("parse_error", error instanceof Error ? error.message : String(error), line),
      });
      const unsupported = unsupportedReason(value);
      if (unsupported !== undefined) {
        return yield* refusal("unsupported_value", `${token.path.join(".")}: ${unsupported}`, line);
      }
      const leaf: LeafNode = {
        kind: "leaf",
        value,
        spread: valueText.includes("\n"),
        lead: [],
        hoisted: [],
        trail: [],
        blankBefore: false,
        at: index,
      };
      scannedComments += token.valueComments.length;
      if (token.commentStart !== undefined) {
        scannedComments++;
        leaf.inline = commentAt(token.commentStart);
      }
      const scalarCount =
        leaf.spread && Array.isArray(value) && value.every(isScalar) ? value.length : 0;
      const layout =
        scalarCount > 0 ? scanScalarArrayLayout(text, token.valueStart, token.valueEnd) : null;
      if (layout !== null && layout.items.length === scalarCount) {
        leaf.array = arrayDecor(layout, text, comment);
      } else {
        for (const span of token.valueComments) {
          const raw = text.slice(span.start, span.end).trim();
          leaf.hoisted.push(comment(raw));
          movedComments.push({ line: lineOf(span.start), text: raw, anchor: token.path });
        }
      }
      parent.entries.set(name, leaf);
      members[index] = leaf;
    }
    for (const table of created) {
      table.at = index;
    }
    effective[index] = current;
  }

  tokens.forEach((token, index) => {
    if (token.kind !== "comment" || index < firstTokenIndex) {
      return;
    }
    const previous = index > firstTokenIndex ? tokens[index - 1] : undefined;
    if (previous?.kind === "comment") {
      return;
    }
    let end = index;
    while (tokens[end]?.kind === "comment") {
      end++;
    }
    const rawLines = tokens.slice(index, end).map((entry) => text.slice(entry.start, entry.end));
    const blankBefore = previous === undefined || previous.kind === "blank";
    const next = tokens[end];
    const leadTarget = isMember(next) ? (implicitParents.get(end) ?? members[end]) : undefined;
    const { carried, tail } = translateGroup(root, effective[index - 1] ?? root, rawLines, index, {
      blankBefore,
      leadsNextMember: leadTarget !== undefined,
    });
    commentCount += carried + tail.length;
    if (tail.length === 0) {
      return;
    }
    const keysPlaced = carried > 0;
    if (leadTarget !== undefined) {
      if (leadTarget.lead.length === 0) {
        leadTarget.blankBefore = blankBefore && !keysPlaced;
      }
      leadTarget.lead.push(...tail);
      return;
    }
    const owner = isMember(previous) ? members[index - 1] : undefined;
    if (owner !== undefined) {
      (owner.kind === "table" ? owner.inner : owner.trail).push(...tail);
      return;
    }
    const nextMemberIndex = tokens.findIndex((entry, at) => at >= end && isMember(entry));
    const nextMember = implicitParents.get(nextMemberIndex) ?? members[nextMemberIndex];
    const hasMemberBefore = tokens.slice(0, index).some(isMember);
    if (!hasMemberBefore) {
      rootLead.push(...tail, ...(next === undefined ? [] : [""]));
    } else if (nextMember !== undefined) {
      if (nextMember.lead.length === 0) {
        nextMember.blankBefore = true;
      }
      nextMember.lead.push(...tail, "");
    } else {
      rootEnd.push("", ...tail);
    }
  });

  if (commentCount !== scannedComments) {
    return yield* refusal(
      "verification_mismatch",
      `converted document carries ${commentCount} of ${scannedComments} comments`,
    );
  }

  members.forEach((member, index) => {
    if (member === undefined) {
      return;
    }
    if (member.lead.length === 0) {
      member.blankBefore = index > firstTokenIndex && tokens[index - 1]?.kind === "blank";
    }
    const implicit = implicitParents.get(index);
    if (implicit !== undefined && implicit.lead.length === 0) {
      implicit.blankBefore = member.blankBefore;
    }
  });

  const keyed = root.entries.get("$schema");
  let schemaRef: string;
  let schemaSource: "directive" | "key" | "default";
  if (keyed !== undefined) {
    if (keyed.kind !== "leaf" || typeof keyed.value !== "string") {
      return yield* refusal("unsupported_value", "`$schema` must be a string");
    }
    schemaRef = keyed.value;
    schemaSource = "key";
    root.entries.delete("$schema");
    root.entries = new Map([["$schema", keyed], ...root.entries]);
  } else {
    schemaRef = directive?.ref ?? CLI_CONFIG_SCHEMA_URL;
    schemaSource = directive === undefined ? "default" : "directive";
    const entry: LeafNode = {
      kind: "leaf",
      value: schemaRef,
      spread: false,
      lead: [],
      hoisted: [],
      trail: [],
      blankBefore: false,
      at: -1,
    };
    root.entries = new Map([["$schema", entry], ...root.entries]);
  }

  const newline = scan.newline;
  const rendered = [
    ...rootLead,
    "{",
    ...renderTableBody(root, INDENT),
    ...indented(INDENT, rootEnd),
    "}",
  ].join(newline);
  const output = `${rendered}${newline}`;

  const actual = yield* Effect.try({
    try: () => parseJsonc(output),
    catch: (error) =>
      refusal(
        "verification_mismatch",
        `converted document does not parse: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  if (!deepEqualValue(actual, { $schema: schemaRef, ...parsed })) {
    return yield* refusal(
      "verification_mismatch",
      "converted document does not match the original values",
    );
  }

  return { text: output, schemaRef, schemaSource, commentCount, movedComments };
});

/** Converts a `config.toml` document to `config.jsonc` text with comments carried over; verified by re-parse. */
export const convertCliConfigTomlToJsonc = (
  source: string,
): Effect.Effect<CliConfigConverted, CliConfigConvertError> =>
  convertDocument(source.startsWith("﻿") ? source.slice(1) : source);
