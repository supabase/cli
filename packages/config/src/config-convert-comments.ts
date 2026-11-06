import * as SmolToml from "smol-toml";
import {
  commentedKvLines,
  INDENT,
  toJsoncComment,
  unsupportedReason,
  withComma,
} from "./config-convert-values.ts";
import { scanTomlDocument } from "./toml-scan.ts";

type CommentedLine =
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "kv"; readonly path: ReadonlyArray<string>; readonly value: unknown };

export interface CommentedNode {
  readonly at: number;
  readonly lead: Array<string>;
  readonly own: Array<CommentedLine>;
  readonly children: Map<string, CommentedNode>;
  elements?: Array<CommentedNode>;
}

export interface PlacedComment {
  readonly at: number;
  readonly lines: Array<string>;
  readonly blankBefore: boolean;
}

/** The part of a converted table that commented-out examples attach to. */
export interface CommentHost {
  readonly kind: "table";
  readonly entries: ReadonlyMap<string, CommentHost | { readonly kind: "leaf" | "aot" }>;
  readonly placed: Array<PlacedComment>;
  readonly forest: CommentedNode;
}

type CommentLine =
  | { readonly kind: "prose"; readonly raw: string }
  | {
      readonly kind: "kv";
      readonly raw: string;
      readonly path: ReadonlyArray<string>;
      readonly value: unknown;
    }
  | {
      readonly kind: "header";
      readonly raw: string;
      readonly path: ReadonlyArray<string>;
      readonly isArray: boolean;
    };

type HeaderLine = Extract<CommentLine, { kind: "header" }>;

export function newCommentedNode(at: number): CommentedNode {
  return { at, lead: [], own: [], children: new Map() };
}

export function commentOut(lines: ReadonlyArray<string>): Array<string> {
  return lines.map((line) => `// ${line}`);
}

function placedLines(line: CommentedLine): Array<string> {
  return line.kind === "prose"
    ? [line.text]
    : commentOut(withComma(commentedKvLines(line.path, line.value, ""), ","));
}

function commentedBody(node: CommentedNode, indent: string): Array<string> {
  const members = [
    ...node.own.map((line) =>
      line.kind === "prose"
        ? { data: false, lines: [`${indent}${line.text}`] }
        : { data: true, lines: commentedKvLines(line.path, line.value, indent) },
    ),
    ...[...node.children].flatMap(([key, child]) => [
      ...(child.lead.length > 0
        ? [{ data: false, lines: child.lead.map((line) => `${indent}${line}`) }]
        : []),
      { data: true, lines: commentedChild(key, child, indent) },
    ]),
  ];
  const lastData = members.map((member) => member.data).lastIndexOf(true);
  return members.flatMap((member, index) =>
    member.data && index < lastData ? withComma(member.lines, ",") : member.lines,
  );
}

function commentedObject(node: CommentedNode, indent: string, prefix: string): Array<string> {
  const body = commentedBody(node, `${indent}${INDENT}`);
  return body.length === 0
    ? [`${indent}${prefix}{}`]
    : [`${indent}${prefix}{`, ...body, `${indent}}`];
}

export function commentedChild(key: string, node: CommentedNode, indent: string): Array<string> {
  const name = JSON.stringify(key);
  const elements = node.elements;
  if (elements === undefined) {
    return commentedObject(node, indent, `${name}: `);
  }
  const elementIndent = `${indent}${INDENT}`;
  const items = elements.flatMap((element, index) => [
    ...element.lead.map((line) => `${elementIndent}${line}`),
    ...withComma(
      commentedObject(element, elementIndent, ""),
      index < elements.length - 1 ? "," : "",
    ),
  ]);
  return [`${indent}${name}: [`, ...items, `${indent}]`];
}

function parseToml(text: string): Record<string, unknown> | undefined {
  try {
    return SmolToml.parse(text);
  } catch {
    return undefined;
  }
}

function hasSpacedDot(text: string): boolean {
  return /\s\.|\.\s/.test(text.replace(/"[^"]*"|'[^']*'/g, "q"));
}

function classifyComment(raw: string): CommentLine {
  const prose: CommentLine = { kind: "prose", raw };
  const body = raw.trim().slice(1).replace(/^ /, "");
  const scan = scanTomlDocument(body);
  const token = "error" in scan || scan.tokens.length !== 1 ? undefined : scan.tokens[0];
  if (
    token === undefined ||
    (token.kind !== "header" && token.kind !== "kv") ||
    token.commentStart !== undefined ||
    parseToml(body) === undefined
  ) {
    return prose;
  }
  if (token.kind === "header") {
    return hasSpacedDot(body)
      ? prose
      : { kind: "header", raw, path: token.path, isArray: token.isArrayOfTables };
  }
  if (hasSpacedDot(body.slice(0, token.valueStart))) {
    return prose;
  }
  const value = parseToml(`v = ${body.slice(token.valueStart, token.valueEnd)}`)?.["v"];
  if (token.valueComments.length > 0 || unsupportedReason(value) !== undefined) {
    return prose;
  }
  return { kind: "kv", raw, path: token.path, value };
}

function mergeCommented(
  forest: CommentedNode,
  missing: ReadonlyArray<string>,
  isArray: boolean,
  at: number,
  lead: ReadonlyArray<string>,
  own: ReadonlyArray<CommentedLine>,
): boolean {
  let node = forest;
  let leadNode: CommentedNode | undefined;
  for (const [index, segment] of missing.entries()) {
    const holder = node.elements?.at(-1) ?? node;
    const last = index === missing.length - 1;
    const existing = holder.children.get(segment);
    if (existing === undefined) {
      const child = newCommentedNode(at);
      if (last && isArray) {
        child.elements = [newCommentedNode(at)];
      }
      holder.children.set(segment, child);
      leadNode ??= child;
      node = child;
    } else if (last && isArray) {
      if (existing.elements === undefined) {
        return false;
      }
      leadNode = newCommentedNode(at);
      existing.elements.push(leadNode);
      node = existing;
    } else if (last && existing.elements !== undefined) {
      return false;
    } else {
      node = existing;
    }
  }
  const target = node.elements?.at(-1) ?? node;
  if (leadNode === undefined) {
    target.own.push(...lead.map((text): CommentedLine => ({ kind: "prose", text })), ...own);
  } else {
    leadNode.lead.push(...lead);
    target.own.push(...own);
  }
  return true;
}

function placeBlock(
  root: CommentHost,
  header: HeaderLine,
  lead: ReadonlyArray<CommentLine>,
  body: ReadonlyArray<CommentLine>,
  at: number,
): number {
  const hasKeys = body.some((line) => line.kind === "kv");
  if (!hasKeys && header.path.length === 1) {
    return 0;
  }
  let table = root;
  let depth = 0;
  for (const segment of header.path) {
    const child = table.entries.get(segment);
    if (child === undefined) {
      break;
    }
    if (child.kind !== "table") {
      return 0;
    }
    table = child;
    depth++;
  }
  const leadText = lead.map((line) => toJsoncComment(line.raw));
  const own = body.map((line): CommentedLine =>
    line.kind === "kv"
      ? { kind: "kv", path: line.path, value: line.value }
      : { kind: "prose", text: toJsoncComment(line.raw) },
  );
  const stored = lead.length + body.length + 1;
  if (depth === header.path.length) {
    if (header.isArray || !hasKeys) {
      return 0;
    }
    table.placed.push({
      at,
      lines: [...leadText, ...own.flatMap(placedLines)],
      blankBefore: true,
    });
    return stored;
  }
  return mergeCommented(table.forest, header.path.slice(depth), header.isArray, at, leadText, own)
    ? stored
    : 0;
}

/**
 * Translates one run of consecutive source comments. Keys up to the last one before any header
 * land in `effective`, the table in effect at that point; each commented header lands at its path;
 * `tail` is the prose left over for the caller to attach, and `carried` counts the source lines
 * stored.
 */
export function translateGroup(
  root: CommentHost,
  effective: CommentHost,
  rawLines: ReadonlyArray<string>,
  first: number,
  options: { readonly blankBefore: boolean; readonly leadsNextMember: boolean },
): { readonly carried: number; readonly tail: Array<string> } {
  const classified = rawLines.map(classifyComment);
  const headerAt = classified.findIndex((line) => line.kind === "header");
  const leading = classified.slice(0, headerAt < 0 ? undefined : headerAt);
  const kept = leading.map((line) => line.kind).lastIndexOf("kv") + 1;
  let carried = 0;
  let pending = leading.slice(kept);
  const keyed: PlacedComment | undefined =
    kept === 0
      ? undefined
      : {
          at: first,
          lines: leading
            .slice(0, kept)
            .flatMap((line) =>
              line.kind === "kv"
                ? placedLines({ kind: "kv", path: line.path, value: line.value })
                : [toJsoncComment(line.raw)],
            ),
          blankBefore: options.blankBefore,
        };
  if (keyed !== undefined) {
    effective.placed.push(keyed);
    carried += kept;
  }
  if (headerAt < 0) {
    const prose = pending.map((line) => toJsoncComment(line.raw));
    if (keyed !== undefined && !options.leadsNextMember) {
      keyed.lines.push(...prose);
      return { carried: carried + prose.length, tail: [] };
    }
    return { carried, tail: prose };
  }
  const rest = classified.slice(headerAt);
  const starts = rest.flatMap((line, offset) => (line.kind === "header" ? [offset] : []));
  for (const [position, start] of starts.entries()) {
    const header = rest[start];
    if (header?.kind !== "header") {
      continue;
    }
    const section = rest.slice(start + 1, starts[position + 1] ?? rest.length);
    const isLast = position === starts.length - 1;
    const bodyLength =
      isLast && !options.leadsNextMember
        ? section.length
        : section.map((line) => line.kind).lastIndexOf("kv") + 1;
    const body = section.slice(0, bodyLength);
    const lead = pending;
    pending = section.slice(bodyLength);
    const at = first + headerAt + start;
    const stored = placeBlock(root, header, lead, body, at);
    if (stored > 0) {
      carried += stored;
    } else {
      const lines = [...lead, header, ...body].map((line) => toJsoncComment(line.raw));
      effective.placed.push({ at, lines, blankBefore: true });
      carried += lines.length;
    }
  }
  return { carried, tail: pending.map((line) => toJsoncComment(line.raw)) };
}
