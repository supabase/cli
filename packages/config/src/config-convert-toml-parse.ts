import { createScanner } from "jsonc-parser";
import { CliConfigConvertError } from "./config-convert.ts";
import { parseJsonc } from "./jsonc.ts";

export interface JsoncComment {
  /** Index in the document's comment ledger. */
  readonly id: number;
  readonly line: number;
  readonly raw: string;
  readonly lines: ReadonlyArray<string>;
  /** Found inside a commented-out example, so the source comment is counted through that example. */
  readonly nested: boolean;
}

export type LeadingItem =
  | { readonly blank: true }
  | { readonly blank: false; readonly comment: JsoncComment };

interface LiteralNode {
  readonly kind: "literal";
  readonly value: string | number | boolean;
}

interface ArrayItem {
  readonly value: JsoncNode;
  readonly lead: ReadonlyArray<JsoncComment>;
  inline?: JsoncComment;
}

export interface ArrayNode {
  readonly kind: "array";
  readonly items: Array<ArrayItem>;
  tail: ReadonlyArray<JsoncComment>;
  open?: JsoncComment;
  multiline: boolean;
}

export interface Entry {
  readonly kind: "member" | "example";
  readonly key: string;
  readonly value: JsoncNode;
  readonly leading: Array<LeadingItem>;
  readonly line: number;
  /** The source comment lines an example was read from. */
  readonly consumed: ReadonlyArray<JsoncComment>;
  /** Comments found while parsing an example's text; they are already part of `consumed`. */
  readonly absorbed: ReadonlyArray<JsoncComment>;
  inline?: JsoncComment;
}

export interface ObjectNode {
  readonly kind: "object";
  entries: Array<Entry>;
  tail: Array<LeadingItem>;
  open?: JsoncComment;
}

export type JsoncNode = LiteralNode | ArrayNode | ObjectNode;

export interface JsoncDocument {
  readonly lead: ReadonlyArray<JsoncComment>;
  readonly root: ObjectNode;
  readonly end: ReadonlyArray<JsoncComment>;
  readonly comments: ReadonlyArray<JsoncComment>;
}

type Slot =
  | { readonly kind: "blank" }
  | { readonly kind: "comment"; readonly comment: JsoncComment; readonly block: boolean }
  | { readonly kind: "member"; readonly entry: Entry }
  | { readonly kind: "example"; readonly entry: Entry };

interface Token {
  readonly kind: number;
  readonly line: number;
  readonly text: string;
  readonly value: string;
}

// Mirrors jsonc-parser's `SyntaxKind`, a const enum that cannot be imported.
const OPEN_BRACE = 1;
const CLOSE_BRACE = 2;
const OPEN_BRACKET = 3;
const CLOSE_BRACKET = 4;
const COMMA = 5;
const NULL = 7;
const TRUE = 8;
const FALSE = 9;
const STRING = 10;
const NUMBER = 11;
const LINE_COMMENT = 12;
const BLOCK_COMMENT = 13;
const LINE_BREAK = 14;
const WHITESPACE = 15;
const EOF = 17;

const EXAMPLE_START = /^\s*"((?:[^"\\]|\\.)*)"\s*:\s*(.*)$/;

/** Throws the converter's refusal error. */
export const refuse = (
  reason: CliConfigConvertError["reason"],
  detail: string,
  sourceLine?: number,
): never => {
  throw new CliConfigConvertError({ reason, detail, sourceLine });
};

const tokenize = (text: string, lineOffset: number): Array<Token> => {
  const scanner = createScanner(text, false);
  const tokens: Array<Token> = [];
  for (let kind = scanner.scan(); kind !== EOF; kind = scanner.scan()) {
    if (kind === WHITESPACE) {
      continue;
    }
    const start = scanner.getTokenOffset();
    const raw = text.slice(start, start + scanner.getTokenLength());
    const line = scanner.getTokenStartLine() + 1 + lineOffset;
    tokens.push({
      kind,
      line,
      text: raw,
      value: scanner.getTokenValue(),
    });
  }
  return tokens;
};

const blockLines = (raw: string): Array<string> => {
  const lines = raw
    .slice(2, -2)
    .split(/\r\n|\n|\r/)
    .map((line, index) => {
      const trimmed = line.trim();
      const text = index > 0 ? trimmed.replace(/^\*+/, "").trim() : trimmed;
      return text === "" ? "" : ` ${text}`;
    });
  while (lines.length > 1 && lines[0] === "") {
    lines.shift();
  }
  while (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
};

const bracketBalance = (text: string): number => {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      index++;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === "\\" ? 2 : 1;
      }
    } else if (char === "/" && text[index + 1] === "/") {
      break;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
    }
  }
  return depth;
};

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

const displayPath = (path: ReadonlyArray<string | number>): string =>
  path.reduce<string>((text, segment) => {
    if (typeof segment === "number") {
      return `${text}[${segment}]`;
    }
    const key = BARE_KEY.test(segment) ? segment : JSON.stringify(segment);
    return text === "" ? key : `${text}.${key}`;
  }, "");

/** Every comment is appended to `comments`; a comment's id is its index there. */
class Parser {
  private index = 0;

  constructor(
    private readonly tokens: ReadonlyArray<Token>,
    private readonly comments: Array<JsoncComment>,
    private readonly nested = false,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private comment(token: Token): JsoncComment {
    const lines =
      token.kind === LINE_COMMENT ? [token.text.slice(2).trimEnd()] : blockLines(token.text);
    const comment = {
      id: this.comments.length,
      line: token.line,
      raw: token.text.trim(),
      lines,
      nested: this.nested,
    };
    this.comments.push(comment);
    return comment;
  }

  private skipTrivia(sink: Array<JsoncComment>): void {
    for (let token = this.peek(); token !== undefined; token = this.peek()) {
      if (token.kind === LINE_BREAK) {
        this.index++;
      } else if (token.kind === LINE_COMMENT || token.kind === BLOCK_COMMENT) {
        sink.push(this.comment(token));
        this.index++;
      } else {
        return;
      }
    }
  }

  document(): Omit<JsoncDocument, "comments"> {
    const lead: Array<JsoncComment> = [];
    this.skipTrivia(lead);
    const first = this.peek();
    if (first?.kind !== OPEN_BRACE) {
      return refuse("parse_error", "the root must be an object", first?.line ?? 1);
    }
    const root = this.object([]);
    const end: Array<JsoncComment> = [];
    this.skipTrivia(end);
    return { lead, root, end };
  }

  value(path: ReadonlyArray<string | number>): JsoncNode {
    const token = this.peek();
    if (token === undefined) {
      return refuse("parse_error", "unexpected end of document");
    }
    if (token.kind === OPEN_BRACE) {
      return this.object(path);
    }
    if (token.kind === OPEN_BRACKET) {
      return this.array(path);
    }
    this.index++;
    if (token.kind === NULL) {
      return refuse(
        "unsupported_value",
        `\`${displayPath(path)}\` is null, which TOML can't represent; remove the key or give it a value, then rerun`,
        token.line,
      );
    }
    if (token.kind === TRUE || token.kind === FALSE) {
      return { kind: "literal", value: token.kind === TRUE };
    }
    if (token.kind === NUMBER) {
      const number = Number(token.value);
      if (!/[.eE]/.test(token.value) && !Number.isSafeInteger(number)) {
        return refuse(
          "unsupported_value",
          `\`${displayPath(path)}\` is ${token.value}, which is too large to convert exactly; use a smaller value or a string, then rerun`,
          token.line,
        );
      }
      return { kind: "literal", value: number };
    }
    if (token.kind === STRING) {
      return { kind: "literal", value: token.value };
    }
    return refuse("parse_error", "unexpected token", token.line);
  }

  private array(path: ReadonlyArray<string | number>): ArrayNode {
    const open = this.peek();
    this.index++;
    const node: ArrayNode = { kind: "array", items: [], tail: [], multiline: false };
    let pending: Array<JsoncComment> = [];
    let anchor: "open" | ArrayItem | undefined = "open";
    let lineHasContent = true;
    for (let token = this.peek(); token !== undefined; token = this.peek()) {
      if (token.kind === LINE_BREAK) {
        this.index++;
        lineHasContent = false;
        anchor = undefined;
      } else if (token.kind === LINE_COMMENT || token.kind === BLOCK_COMMENT) {
        this.index++;
        const comment = this.comment(token);
        if (lineHasContent && anchor === "open" && node.open === undefined) {
          node.open = comment;
        } else if (lineHasContent && typeof anchor === "object" && anchor.inline === undefined) {
          anchor.inline = comment;
        } else {
          pending.push(comment);
        }
        anchor = undefined;
        lineHasContent = true;
      } else if (token.kind === COMMA) {
        this.index++;
        lineHasContent = true;
      } else if (token.kind === CLOSE_BRACKET) {
        this.index++;
        node.tail = pending;
        node.multiline = (open?.line ?? 0) !== token.line;
        return node;
      } else {
        const item: ArrayItem = {
          value: this.value([...path, node.items.length]),
          lead: pending,
        };
        pending = [];
        node.items.push(item);
        anchor = item;
        lineHasContent = true;
      }
    }
    return refuse("parse_error", "unterminated array", open?.line);
  }

  private object(path: ReadonlyArray<string | number>): ObjectNode {
    this.index++;
    const slots: Array<Slot> = [];
    const keys = new Set<string>();
    let anchor: "open" | Entry | undefined = "open";
    let lineHasContent = true;
    const node: ObjectNode = { kind: "object", entries: [], tail: [] };
    for (let token = this.peek(); token !== undefined; token = this.peek()) {
      if (token.kind === LINE_BREAK) {
        this.index++;
        if (!lineHasContent && slots[slots.length - 1]?.kind !== "blank") {
          slots.push({ kind: "blank" });
        }
        lineHasContent = false;
        anchor = undefined;
      } else if (token.kind === LINE_COMMENT || token.kind === BLOCK_COMMENT) {
        this.index++;
        const comment = this.comment(token);
        if (lineHasContent && anchor === "open" && node.open === undefined) {
          node.open = comment;
        } else if (lineHasContent && typeof anchor === "object" && anchor.inline === undefined) {
          anchor.inline = comment;
        } else {
          slots.push({ kind: "comment", comment, block: token.kind === BLOCK_COMMENT });
        }
        anchor = undefined;
        lineHasContent = true;
      } else if (token.kind === COMMA) {
        this.index++;
        lineHasContent = true;
      } else if (token.kind === CLOSE_BRACE) {
        this.index++;
        const { entries, tail } = group(slots, this.comments);
        node.entries = entries;
        node.tail = tail;
        return node;
      } else if (token.kind === STRING) {
        this.index++;
        if (keys.has(token.value)) {
          return refuse(
            "parse_error",
            `\`${displayPath([...path, token.value])}\` is defined twice`,
            token.line,
          );
        }
        keys.add(token.value);
        const keyTrivia: Array<JsoncComment> = [];
        this.skipTrivia(keyTrivia);
        this.index++;
        this.skipTrivia(keyTrivia);
        for (const comment of keyTrivia) {
          slots.push({ kind: "comment", comment, block: comment.raw.startsWith("/*") });
        }
        const entry: Entry = {
          kind: "member",
          key: token.value,
          value: this.value([...path, token.value]),
          leading: [],
          line: token.line,
          consumed: [],
          absorbed: [],
        };
        slots.push({ kind: "member", entry });
        anchor = entry;
        lineHasContent = true;
      } else {
        return refuse("parse_error", "unexpected token", token.line);
      }
    }
    return refuse("parse_error", "unterminated object");
  }
}

const group = (
  slots: ReadonlyArray<Slot>,
  comments: Array<JsoncComment>,
): { entries: Array<Entry>; tail: Array<LeadingItem> } => {
  const entries: Array<Entry> = [];
  let leading: Array<LeadingItem> = [];
  for (const slot of detectExamples(slots, comments)) {
    if (slot.kind === "blank") {
      leading.push({ blank: true });
    } else if (slot.kind === "comment") {
      leading.push({ blank: false, comment: slot.comment });
    } else {
      slot.entry.leading.push(...leading);
      entries.push(slot.entry);
      leading = [];
    }
  }
  while (leading[leading.length - 1]?.blank === true) {
    leading.pop();
  }
  return { entries, tail: leading };
};

const exampleAt = (
  slots: ReadonlyArray<Slot>,
  start: number,
  comments: Array<JsoncComment>,
): { readonly end: number; readonly entry: Entry } | undefined => {
  const first = slots[start];
  if (first?.kind !== "comment" || first.block) {
    return undefined;
  }
  const match = EXAMPLE_START.exec(first.comment.lines[0] ?? "");
  if (match === null) {
    return undefined;
  }
  const lines = [first.comment.lines[0] ?? ""];
  const consumed = [first.comment];
  let depth = bracketBalance(match[2] ?? "");
  let end = start;
  while (depth > 0) {
    const next = slots[++end];
    if (next?.kind !== "comment" || next.block) {
      return undefined;
    }
    const text = next.comment.lines[0] ?? "";
    lines.push(text);
    consumed.push(next.comment);
    if (!/^\s*\/\//.test(text)) {
      depth += bracketBalance(text);
    }
  }
  const ledgerSize = comments.length;
  try {
    const source = `{${lines.join("\n")}\n}`;
    parseJsonc(source);
    const sub = new Parser(tokenize(source, first.comment.line - 1), comments, true).document()
      .root;
    const [only] = sub.entries;
    if (sub.entries.length === 1 && only !== undefined && only.kind === "member") {
      return {
        end,
        entry: {
          kind: "example",
          key: only.key,
          value: only.value,
          leading: [],
          line: first.comment.line,
          consumed,
          absorbed: comments.slice(ledgerSize),
          inline: only.inline,
        },
      };
    }
  } catch {
    // The text is prose, not an example.
  }
  comments.length = ledgerSize;
  return undefined;
};

const detectExamples = (slots: ReadonlyArray<Slot>, comments: Array<JsoncComment>): Array<Slot> => {
  const out: Array<Slot> = [];
  for (let index = 0; index < slots.length; index++) {
    const found = exampleAt(slots, index, comments);
    const slot = slots[index];
    if (found !== undefined) {
      out.push({ kind: "example", entry: found.entry });
      index = found.end;
    } else if (slot !== undefined) {
      out.push(slot);
    }
  }
  return out;
};

export const parseJsoncDocument = (text: string): JsoncDocument => {
  const comments: Array<JsoncComment> = [];
  const document = new Parser(tokenize(text, 0), comments).document();
  return { ...document, comments };
};
