import { Context, Option } from "effect";
import type { HelpDoc } from "effect/cli";
import { describe, expect, it } from "vitest";
import { withHelpMarkdown } from "./help-markdown.ts";

const emptyDoc: HelpDoc.HelpDoc = {
  description: "",
  usage: "supabase <file> [flags]",
  annotations: Context.empty(),
  flags: [],
};

const flag = (description: Option.Option<string>): HelpDoc.FlagDoc => ({
  name: "flag",
  aliases: ["f"],
  type: "string",
  required: false,
  description,
});

describe("help Markdown", () => {
  it("copies every description field while preserving syntax, metadata and absent values", () => {
    const doc: HelpDoc.HelpDoc = {
      ...emptyDoc,
      description: "**command**",
      flags: [flag(Option.some("**flag**")), flag(Option.none())],
      inheritedFlags: [flag(Option.some("*inherited*"))],
      globalFlags: [flag(Option.some("`global`"))],
      args: [
        {
          name: "file",
          required: true,
          variadic: false,
          type: "string",
          description: Option.some("*argument*"),
        },
      ],
      subcommands: [
        {
          group: "**group syntax**",
          commands: [
            {
              name: "child",
              alias: undefined,
              description: "**long**",
              shortDescription: "*short*",
            },
            { name: "other", alias: "o", description: "`fallback`", shortDescription: undefined },
          ],
        },
      ],
      examples: [
        { command: "supabase '**literal**'", description: "*caption*" },
        { command: "supabase --help" },
      ],
    };
    const original = JSON.stringify(doc);
    const result = withHelpMarkdown(doc, false);

    expect(result).toEqual({
      ...doc,
      description: "command",
      flags: [flag(Option.some("flag")), flag(Option.none())],
      inheritedFlags: [flag(Option.some("inherited"))],
      globalFlags: [flag(Option.some("global"))],
      args: [
        {
          name: "file",
          required: true,
          variadic: false,
          type: "string",
          description: Option.some("argument"),
        },
      ],
      subcommands: [
        {
          group: "**group syntax**",
          commands: [
            { name: "child", alias: undefined, description: "long", shortDescription: "short" },
            { name: "other", alias: "o", description: "fallback", shortDescription: undefined },
          ],
        },
      ],
      examples: [
        { command: "supabase '**literal**'", description: "caption" },
        { command: "supabase --help" },
      ],
    });
    expect(result.annotations).toBe(doc.annotations);
    expect(JSON.stringify(doc)).toBe(original);
    expect(withHelpMarkdown(emptyDoc, false)).toEqual(emptyDoc);
  });

  it.each([false, true])(
    "preserves paragraphs and link destinations without wrapping (colors=%s)",
    (colors) => {
      const long = "ordinary words ".repeat(20).trim();
      const result = withHelpMarkdown(
        {
          ...emptyDoc,
          description: `**bold** *emphasis* \`code\` [guide](https://example.com)\nsoft break\n\n${long}\n`,
        },
        colors,
      ).description;
      expect(Bun.stripANSI(result)).toBe(
        `bold emphasis code guide (https://example.com) soft break\n\n${long}`,
      );
      expect(result.includes("\u001b[")).toBe(colors);
      expect(result.endsWith("\n")).toBe(false);
    },
  );

  it.each([
    "Setup:\n\n\tsupabase completion bash > /tmp/completion",
    "#### Linux\n\nRun the setup command.",
    "- first\n- second",
    "<div>literal HTML</div>",
    "![image](https://example.com/image.png)",
  ])("preserves source when rendering is unsupported: %s", (description) => {
    expect(withHelpMarkdown({ ...emptyDoc, description }, true).description).toBe(description);
  });
});
