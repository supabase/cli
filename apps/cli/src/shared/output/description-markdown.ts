import { Option, Schema } from "effect";
import { styleText } from "node:util";

interface MarkdownNode {
  readonly type: string | symbol;
  readonly props: {
    readonly children?: ReadonlyArray<string | MarkdownNode>;
    readonly href?: string;
  };
}

const MarkdownNode: Schema.Codec<MarkdownNode> = Schema.suspend(() =>
  Schema.Struct({
    type: Schema.Union([Schema.String, Schema.Symbol]),
    props: Schema.Struct({
      children: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, MarkdownNode]))),
      href: Schema.optionalKey(Schema.String),
    }),
  }),
);

const supported = new Set(["p", "pre", "strong", "em", "code", "a", "br", "del"]);

function violationsFor(root: MarkdownNode): ReadonlyArray<string> {
  const violations = new Set<string>();
  const visit = (node: string | MarkdownNode): void => {
    if (typeof node === "string") {
      // Raw inline tags remain whole text nodes; escaped tags are separate parser tokens.
      if (
        node.includes("<") &&
        Bun.markdown.html(node) !==
          Bun.markdown.html(node, { noHtmlBlocks: true, noHtmlSpans: true })
      )
        violations.add("HTML");
      return;
    }
    if (typeof node.type === "string" && !supported.has(node.type)) violations.add(node.type);
    if (node.type === "pre" || node.type === "code") return;
    for (const child of node.props.children ?? []) visit(child);
  };
  visit(root);
  return [...violations];
}

/** Finds structures outside the shared terminal/reference description contract. */
export function descriptionMarkdownViolations(description: string): ReadonlyArray<string> {
  const parsed = Schema.decodeUnknownOption(MarkdownNode)(Bun.markdown.react(description));
  return Option.isNone(parsed)
    ? ["unsupported Markdown parser output"]
    : violationsFor(parsed.value);
}

/** Renders copyable code blocks and inline styles without wrapping or terminal borders. */
export function renderDescriptionMarkdown(description: string, colors: boolean): string {
  // Bun expands tabs even inside fenced code; keep their source rather than alter shell input.
  if (description.includes("\t")) return description;
  const parsed = Schema.decodeUnknownOption(MarkdownNode)(Bun.markdown.react(description));
  if (Option.isNone(parsed) || violationsFor(parsed.value).length > 0) return description;
  const style = (kind: "bold" | "italic" | "inverse" | "strikethrough", text: string) =>
    colors ? styleText(kind, text, { validateStream: false }) : text;
  const render = (node: string | MarkdownNode, inCode = false): string => {
    if (typeof node === "string") return inCode ? node : node.replace(/\n/g, " ");
    const children = (node.props.children ?? [])
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
        return !node.props.href || Bun.stripANSI(children) === node.props.href
          ? children
          : `${children} (${node.props.href})`;
      case "br":
        return "\n";
      default:
        return children;
    }
  };
  return render(parsed.value).replace(/\n\n$/, "");
}
