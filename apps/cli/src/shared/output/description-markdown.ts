import { Marked, type Token, type Tokens } from "marked";
import { stripVTControlCharacters, styleText } from "node:util";

interface MarkdownNode {
  readonly type: string;
  readonly children: ReadonlyArray<string | MarkdownNode>;
  readonly href?: string;
}

// Bare `www.` and `https://` text stays text, as in the contract's other renderers.
const parser = new Marked({ tokenizer: { url: () => undefined } });

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const decodeEntities = (text: string) =>
  text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (_, dec, hex, name) =>
    name === undefined
      ? String.fromCodePoint(Number.parseInt(dec ?? hex, dec === undefined ? 16 : 10))
      : NAMED_ENTITIES[name]!,
  );

const inlineNodes = (
  tokens: ReadonlyArray<Token> | undefined,
): ReadonlyArray<string | MarkdownNode> =>
  (tokens ?? []).map((token): string | MarkdownNode => {
    switch (token.type) {
      case "text":
        return decodeEntities(token.text);
      case "escape":
        return token.text;
      case "codespan":
        return { type: "code", children: [token.text] };
      case "strong":
        return { type: "strong", children: inlineNodes(token.tokens) };
      case "em":
        return { type: "em", children: inlineNodes(token.tokens) };
      case "del":
        return { type: "del", children: inlineNodes(token.tokens) };
      case "br":
        return { type: "br", children: [] };
      case "link":
        return { type: "a", href: token.href, children: inlineNodes(token.tokens) };
      case "image":
        return { type: "img", children: [] };
      case "html":
        return { type: "HTML", children: [] };
      default:
        return { type: token.type, children: [] };
    }
  });

const blockNodes = (tokens: ReadonlyArray<Token>): ReadonlyArray<MarkdownNode> =>
  tokens.flatMap((token): ReadonlyArray<MarkdownNode> => {
    switch (token.type) {
      case "space":
      case "def":
        return [];
      case "paragraph":
        return [{ type: "p", children: inlineNodes(token.tokens) }];
      case "code":
        return [{ type: "pre", children: [`${token.text}\n`] }];
      case "heading":
        return [{ type: `h${(token as Tokens.Heading).depth}`, children: [] }];
      case "list":
        return [{ type: (token as Tokens.List).ordered ? "ol" : "ul", children: [] }];
      case "html":
        return [{ type: "html", children: [] }];
      default:
        return [{ type: token.type, children: [] }];
    }
  });

const parse = (description: string): MarkdownNode => ({
  type: "root",
  children: blockNodes(parser.lexer(description)),
});

const supported = new Set(["p", "pre", "strong", "em", "code", "a", "br", "del"]);

function violationsFor(root: MarkdownNode): ReadonlyArray<string> {
  const violations = new Set<string>();
  const visit = (node: string | MarkdownNode): void => {
    if (typeof node === "string") return;
    if (node.type !== "root" && !supported.has(node.type)) violations.add(node.type);
    if (node.type === "pre" || node.type === "code") return;
    for (const child of node.children) visit(child);
  };
  visit(root);
  return [...violations];
}

/** Finds structures outside the shared terminal/reference description contract. */
export function descriptionMarkdownViolations(description: string): ReadonlyArray<string> {
  return violationsFor(parse(description));
}

/** Renders copyable code blocks and inline styles without wrapping or terminal borders. */
export function renderDescriptionMarkdown(description: string, colors: boolean): string {
  // Markdown parsers expand tabs even inside fenced code; keep the source rather than alter shell input.
  if (description.includes("\t")) return description;
  const parsed = parse(description);
  if (violationsFor(parsed).length > 0) return description;
  const style = (kind: "bold" | "italic" | "inverse" | "strikethrough", text: string) =>
    colors ? styleText(kind, text, { validateStream: false }) : text;
  const render = (node: string | MarkdownNode, inCode = false): string => {
    if (typeof node === "string") return inCode ? node : node.replace(/\n/g, " ");
    const children = node.children
      .map((child) => render(child, inCode || node.type === "pre" || node.type === "code"))
      .join("");
    switch (node.type) {
      case "p":
        return `${children}\n\n`;
      case "pre":
        return `${children
          .replace(/\n$/, "")
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n")}\n\n`;
      case "strong":
        return style("bold", children);
      case "em":
        return style("italic", children);
      case "code":
        return inCode ? children : style("inverse", children.replace(/\r\n?|\n/g, " "));
      case "del":
        return style("strikethrough", children);
      case "a":
        return !node.href || stripVTControlCharacters(children) === node.href
          ? children
          : `${children} (${node.href})`;
      case "br":
        return "\n";
      default:
        return children;
    }
  };
  return render(parsed).replace(/\n\n$/, "");
}
