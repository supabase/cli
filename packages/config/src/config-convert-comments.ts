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
  readonly source: Array<CommentedLine>;
  readonly blankBefore: boolean;
}

export interface RenderedComment {
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

function commentOut(lines: ReadonlyArray<string>): Array<string> {
  return lines.map((line) => `// ${line}`);
}

function placedLines(line: CommentedLine): Array<string> {
  return line.kind === "prose"
    ? [line.text]
    : commentOut(withComma(commentedKvLines(line.path, line.value, ""), ","));
}

type CommentedMember =
  | CommentedLine
  | { readonly kind: "child"; readonly key: string; readonly node: CommentedNode };

/** Orders a node's members, nesting dotted keys under a shared object when a sibling key or a
 * commented table already uses their first segment, so uncommenting never yields duplicate keys. */
function commentedMembers(node: CommentedNode): Array<CommentedMember> {
  const counts = new Map<string, number>();
  for (const line of node.own) {
    if (line.kind === "kv" && line.path.length > 1) {
      const key = line.path[0] ?? "";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const extra = new Map<string, Array<CommentedLine>>();
  const groups = new Map<string, CommentedNode>();
  const members: Array<CommentedMember> = [];
  let prose: Array<CommentedLine> = [];
  const flushProse = () => {
    members.push(...prose);
    prose = [];
  };
  for (const line of node.own) {
    if (line.kind === "prose") {
      prose.push(line);
      continue;
    }
    const key = line.path.length > 1 ? (line.path[0] ?? "") : undefined;
    const child = key === undefined ? undefined : node.children.get(key);
    if (
      key === undefined ||
      child?.elements !== undefined ||
      (child === undefined && (counts.get(key) ?? 0) < 2)
    ) {
      flushProse();
      members.push(line);
      continue;
    }
    const rest: CommentedLine = { kind: "kv", path: line.path.slice(1), value: line.value };
    if (child !== undefined) {
      extra.set(key, [...(extra.get(key) ?? []), ...prose, rest]);
      prose = [];
      continue;
    }
    let group = groups.get(key);
    if (group === undefined) {
      flushProse();
      group = newCommentedNode(node.at);
      groups.set(key, group);
      members.push({ kind: "child", key, node: group });
    }
    group.own.push(...prose, rest);
    prose = [];
  }
  flushProse();
  for (const [key, child] of node.children) {
    const added = extra.get(key);
    members.push({
      kind: "child",
      key,
      node: added === undefined ? child : { ...child, own: [...child.own, ...added] },
    });
  }
  return members;
}

function placedBlockLines(
  lines: ReadonlyArray<CommentedLine>,
  children: ReadonlyMap<string, CommentedNode> = new Map(),
): Array<string> {
  const node = newCommentedNode(0);
  node.own.push(...lines);
  for (const [key, child] of children) {
    node.children.set(key, child);
  }
  return commentedMembers(node).flatMap((member) =>
    member.kind === "child"
      ? [
          ...member.node.lead,
          ...commentOut(withComma(commentedChild(member.key, member.node, ""), ",")),
        ]
      : placedLines(member),
  );
}

type HostItem =
  | {
      readonly kind: "placed";
      readonly at: number;
      readonly blankBefore: boolean;
      readonly input: ReadonlyArray<CommentedLine>;
      readonly source: Array<CommentedLine>;
      readonly children: Map<string, CommentedNode>;
    }
  | {
      readonly kind: "forest";
      readonly at: number;
      readonly key: string;
      readonly node: CommentedNode;
    };

/** Renders a table's commented examples in source order, merging commented dotted keys into the
 * first example that uses their first segment, so uncommenting several never yields duplicate keys. */
export function hostComments(host: CommentHost): Array<RenderedComment> {
  const items: Array<HostItem> = [
    ...host.placed.map((block): HostItem => ({
      kind: "placed",
      at: block.at,
      blankBefore: block.blankBefore,
      input: block.source,
      source: [],
      children: new Map(),
    })),
    ...[...host.forest.children].map(([key, node]): HostItem => ({
      kind: "forest",
      at: node.at,
      key,
      node,
    })),
  ];
  items.sort((a, b) => a.at - b.at);
  const owners = new Map<string, HostItem>();
  const merged = new Set<HostItem>();
  for (const item of items) {
    if (item.kind === "forest") {
      const owner = owners.get(item.key);
      if (owner?.kind === "placed" && item.node.elements === undefined) {
        owner.children.set(item.key, item.node);
        merged.add(item);
      } else if (owner === undefined && item.node.elements === undefined) {
        owners.set(item.key, item);
      }
      continue;
    }
    let prose: Array<CommentedLine> = [];
    for (const line of item.input) {
      if (line.kind === "prose") {
        prose.push(line);
        continue;
      }
      const key = line.path.length > 1 ? line.path[0] : undefined;
      const owner = key === undefined ? undefined : owners.get(key);
      if (owner?.kind === "forest") {
        owner.node.own.push(...prose, { kind: "kv", path: line.path.slice(1), value: line.value });
      } else if (owner !== undefined && owner !== item) {
        owner.source.push(...prose, line);
      } else {
        if (key !== undefined && owner === undefined) {
          owners.set(key, item);
        }
        item.source.push(...prose, line);
      }
      prose = [];
    }
    item.source.push(...prose);
  }
  return items.flatMap((item): Array<RenderedComment> => {
    if (merged.has(item)) {
      return [];
    }
    if (item.kind === "forest") {
      const { key, node } = item;
      return [
        {
          at: item.at,
          blankBefore: true,
          lines: [...node.lead, ...commentOut(withComma(commentedChild(key, node, ""), ","))],
        },
      ];
    }
    const lines = placedBlockLines(item.source, item.children);
    return lines.length === 0 ? [] : [{ at: item.at, blankBefore: item.blankBefore, lines }];
  });
}

function commentedBody(node: CommentedNode, indent: string): Array<string> {
  const members = commentedMembers(node).flatMap((member) =>
    member.kind === "prose"
      ? [{ data: false, lines: [`${indent}${member.text}`] }]
      : member.kind === "kv"
        ? [{ data: true, lines: commentedKvLines(member.path, member.value, indent) }]
        : [
            ...(member.node.lead.length > 0
              ? [{ data: false, lines: member.node.lead.map((line) => `${indent}${line}`) }]
              : []),
            { data: true, lines: commentedChild(member.key, member.node, indent) },
          ],
  );
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

function commentedChild(key: string, node: CommentedNode, indent: string): Array<string> {
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

/** Whether a run of source comments holds a commented key or table header. */
export function holdsExample(rawLines: ReadonlyArray<string>): boolean {
  return rawLines.some((raw) => classifyComment(raw).kind !== "prose");
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
): CommentedNode | undefined {
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
        return undefined;
      }
      leadNode = newCommentedNode(at);
      existing.elements.push(leadNode);
      node = existing;
    } else if (last && existing.elements !== undefined) {
      return undefined;
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
  return target;
}

/** Where the keys of a commented table example go, so a later group separated from it only by
 * blank lines continues the same example. */
export type OpenBlock =
  | { readonly kind: "table"; readonly host: CommentHost }
  | { readonly kind: "forest"; readonly node: CommentedNode }
  | { readonly kind: "verbatim"; readonly host: CommentHost };

function proseLine(text: string): CommentedLine {
  return { kind: "prose", text };
}

function toCommentedLine(line: CommentLine): CommentedLine {
  return line.kind === "kv"
    ? { kind: "kv", path: line.path, value: line.value }
    : { kind: "prose", text: toJsoncComment(line.raw) };
}

function continueBlock(block: OpenBlock, lines: ReadonlyArray<CommentLine>, at: number): void {
  if (block.kind === "forest") {
    block.node.own.push(...lines.map(toCommentedLine));
    return;
  }
  if (block.kind === "table") {
    placeResolved(block.host, [], lines, at, true);
    return;
  }
  block.host.placed.push({
    at,
    source: lines.map((line) => proseLine(toJsoncComment(line.raw))),
    blankBefore: true,
  });
}

/** Places commented lines in `table`, moving each dotted key to the deepest existing table on its
 * path; prose travels with the key below it. Returns the block placed in `table` itself. */
function placeResolved(
  table: CommentHost,
  lead: ReadonlyArray<CommentedLine>,
  lines: ReadonlyArray<CommentLine>,
  at: number,
  blankBefore: boolean,
): PlacedComment | undefined {
  const byHost = new Map<CommentHost, Array<CommentedLine>>([[table, [...lead]]]);
  let lastHost = table;
  let prose: Array<CommentedLine> = [];
  for (const line of lines) {
    if (line.kind !== "kv") {
      prose.push(toCommentedLine(line));
      continue;
    }
    const { host, path } = deepestTable(table, line.path);
    byHost.set(host, [
      ...(byHost.get(host) ?? []),
      ...prose,
      { kind: "kv", path, value: line.value },
    ]);
    lastHost = host;
    prose = [];
  }
  byHost.get(lastHost)?.push(...prose);
  let own: PlacedComment | undefined;
  for (const [host, source] of byHost) {
    if (source.length === 0) {
      continue;
    }
    const block = { at, source, blankBefore: host === table && blankBefore };
    host.placed.push(block);
    if (host === table) {
      own = block;
    }
  }
  return own;
}

function placeBlock(
  root: CommentHost,
  header: HeaderLine,
  lead: ReadonlyArray<CommentLine>,
  body: ReadonlyArray<CommentLine>,
  at: number,
): { readonly stored: number; readonly open?: OpenBlock } {
  const hasKeys = body.some((line) => line.kind === "kv");
  if (!hasKeys && header.path.length === 1) {
    return { stored: 0 };
  }
  let table = root;
  let depth = 0;
  for (const segment of header.path) {
    const child = table.entries.get(segment);
    if (child === undefined) {
      break;
    }
    if (child.kind !== "table") {
      return { stored: 0 };
    }
    table = child;
    depth++;
  }
  const leadText = lead.map((line) => toJsoncComment(line.raw));
  const stored = lead.length + body.length + 1;
  if (depth === header.path.length) {
    if (header.isArray || !hasKeys) {
      return { stored: 0 };
    }
    placeResolved(table, leadText.map(proseLine), body, at, true);
    return { stored, open: { kind: "table", host: table } };
  }
  const own = body.map(toCommentedLine);
  const node = mergeCommented(
    table.forest,
    header.path.slice(depth),
    header.isArray,
    at,
    leadText,
    own,
  );
  return node === undefined ? { stored: 0 } : { stored, open: { kind: "forest", node } };
}

/** Resolves a commented dotted key to the deepest existing table on its path, so uncommenting it
 * adds a sibling instead of a duplicate member that would replace that table. */
function deepestTable(
  table: CommentHost,
  path: ReadonlyArray<string>,
): { readonly host: CommentHost; readonly path: ReadonlyArray<string> } {
  let host = table;
  let depth = 0;
  while (depth < path.length - 1) {
    const child = host.entries.get(path[depth] ?? "");
    if (child?.kind !== "table") {
      break;
    }
    host = child;
    depth++;
  }
  return { host, path: path.slice(depth) };
}

/**
 * Translates one run of consecutive source comments. Keys up to the last one before any header
 * land in `effective`, the table in effect at that point, or in `continues`, the commented example
 * the previous run left open; each commented header lands at its path; `tail` is the prose left
 * over for the caller to attach, and `carried` counts the source lines stored.
 */
export function translateGroup(
  root: CommentHost,
  effective: CommentHost,
  rawLines: ReadonlyArray<string>,
  first: number,
  options: {
    readonly blankBefore: boolean;
    readonly leadsNextMember: boolean;
    readonly continues?: OpenBlock | undefined;
  },
): { readonly carried: number; readonly tail: Array<string>; readonly open?: OpenBlock } {
  const classified = rawLines.map(classifyComment);
  const headerAt = classified.findIndex((line) => line.kind === "header");
  const leading = classified.slice(0, headerAt < 0 ? undefined : headerAt);
  const kept = leading.map((line) => line.kind).lastIndexOf("kv") + 1;
  if (options.continues !== undefined && kept > 0) {
    const taken = headerAt < 0 && !options.leadsNextMember ? leading.length : kept;
    continueBlock(options.continues, leading.slice(0, taken), first);
    if (headerAt < 0) {
      return {
        carried: taken,
        tail: leading.slice(taken).map((line) => toJsoncComment(line.raw)),
        open: options.continues,
      };
    }
    return translateHeaders(root, effective, classified, headerAt, first, options, {
      carried: taken,
      pending: leading.slice(taken),
    });
  }
  const keyed = placeResolved(effective, [], leading.slice(0, kept), first, options.blankBefore);
  const pending = leading.slice(kept);
  if (headerAt < 0) {
    const tail = pending.map((line) => toJsoncComment(line.raw));
    if (keyed !== undefined && !options.leadsNextMember) {
      keyed.source.push(...tail.map(proseLine));
      return { carried: kept + tail.length, tail: [] };
    }
    return { carried: kept, tail };
  }
  return translateHeaders(root, effective, classified, headerAt, first, options, {
    carried: kept,
    pending,
  });
}

function translateHeaders(
  root: CommentHost,
  effective: CommentHost,
  classified: ReadonlyArray<CommentLine>,
  headerAt: number,
  first: number,
  options: { readonly leadsNextMember: boolean },
  state: { readonly carried: number; readonly pending: ReadonlyArray<CommentLine> },
): { readonly carried: number; readonly tail: Array<string>; readonly open?: OpenBlock } {
  let { carried, pending } = state;
  let open: OpenBlock | undefined;
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
    const placed = placeBlock(root, header, lead, body, at);
    if (placed.stored > 0) {
      carried += placed.stored;
      open = placed.open;
    } else {
      const lines = [...lead, header, ...body].map((line) => toJsoncComment(line.raw));
      effective.placed.push({ at, source: lines.map(proseLine), blankBefore: true });
      carried += lines.length;
      open = { kind: "verbatim", host: effective };
    }
  }
  return { carried, tail: pending.map((line) => toJsoncComment(line.raw)), open };
}
