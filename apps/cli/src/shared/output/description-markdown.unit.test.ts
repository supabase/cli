import { describe, expect, it } from "vitest";
import {
  descriptionMarkdownViolations,
  renderDescriptionMarkdown,
} from "./description-markdown.ts";

describe("description authoring contract", () => {
  it.each([
    ["# Heading", "h1"],
    ["Title\n=====", "h1"],
    ["> quote", "blockquote"],
    ["- item", "ul"],
    ["1. item", "ol"],
    ["---", "hr"],
    ["a | b\n--- | ---\nx | y", "table"],
    ["![image](https://example.com/image)", "img"],
    ["<div>HTML</div>", "html"],
    ["text <b>HTML</b>", "HTML"],
    ["text <!-- comment -->", "HTML"],
    ["text <custom-tag a='b'>content</custom-tag>", "HTML"],
  ])("rejects unsupported structure in %s", (source, kind) => {
    expect(descriptionMarkdownViolations(source)).toContain(kind);
    expect(renderDescriptionMarkdown(source, false)).toBe(source);
  });

  it.each([
    "Ordinary **bold**, *emphasis*, ~~deleted~~, and `code`.",
    "First\nsoft break\n\nSecond paragraph.",
    "Hard break  \nnext line",
    "[guide][ref]\n\n[ref]: https://example.com",
    "<https://example.com>",
    "<user@example.com>",
    "\\<b>escaped\\</b>",
    "&lt;b&gt;encoded&lt;/b&gt;",
    "`<b>code</b>`",
    "    echo '<b>code</b>'\n    # not a heading",
    "```sh\necho '<b>code</b>'\n# not a heading\n```",
    "",
  ])("accepts supported Markdown without mistaking literal code for structure: %s", (source) => {
    expect(descriptionMarkdownViolations(source)).toEqual([]);
  });

  it.each([false, true])(
    "renders code without borders, styling or wrapping (colors=%s)",
    (colors) => {
      const command = `echo '${"long argument ".repeat(20)}' > "$HOME/file"`;
      const code = `${command}\n  echo '<b>&amp; **literal**</b>'\n\n    echo nested`;
      const expected = `Run this:\n\n    ${command}\n      echo '<b>&amp; **literal**</b>'\n    \n        echo nested\n\nThen continue.`;
      const fenced = `Run this:\n\n\`\`\`sh\n${code}\n\`\`\`\n\nThen continue.`;
      const indented = `Run this:\n\n${code
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}\n\nThen continue.`;
      expect(renderDescriptionMarkdown(fenced, colors)).toBe(expected);
      expect(renderDescriptionMarkdown(indented, colors)).toBe(expected);
    },
  );

  it("preserves source containing tabs rather than changing executable code", () => {
    const source = "```sh\n\techo 'tab\tinside'\n```";
    expect(renderDescriptionMarkdown(source, true)).toBe(source);
  });

  it("does not duplicate the destination when a styled link label is the URL", () => {
    const source = "[**https://example.com**](https://example.com)";
    expect(Bun.stripANSI(renderDescriptionMarkdown(source, true))).toBe("https://example.com");
  });

  it("distinguishes soft breaks from hard breaks and keeps autolinks usable", () => {
    expect(
      renderDescriptionMarkdown("first\nsecond  \nthird\n\n<https://example.com>", false),
    ).toBe("first second\nthird\n\nhttps://example.com");
  });
});
