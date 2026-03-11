import type { HelpDoc } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { formatSection, injectSections } from "./guide-injector.ts";

function makeDoc(overrides: Partial<HelpDoc.HelpDoc> = {}): HelpDoc.HelpDoc {
  return { usage: "supabase test [flags]", flags: [], ...overrides } as HelpDoc.HelpDoc;
}

describe("formatSection", () => {
  describe("USAGE", () => {
    it("always returns a value", () => {
      const doc = makeDoc();
      const result = formatSection(doc, "USAGE");
      expect(result).toBe("## Usage\n\n```sh\nsupabase test [flags]\n```");
    });

    it("includes the usage string from the doc", () => {
      const doc = makeDoc({ usage: "supabase db push [flags]" });
      const result = formatSection(doc, "USAGE");
      expect(result).toContain("supabase db push [flags]");
    });
  });

  describe("FLAGS", () => {
    it("returns undefined when flags array is empty", () => {
      const doc = makeDoc({ flags: [] });
      expect(formatSection(doc, "FLAGS")).toBeUndefined();
    });

    it("returns a table when flags are present", () => {
      const doc = makeDoc({
        flags: [
          {
            name: "verbose",
            type: "boolean",
            aliases: [],
            description: "Enable verbose output",
            required: false,
          },
        ],
      });
      const result = formatSection(doc, "FLAGS");
      expect(result).toBeDefined();
      expect(result).toContain("## Flags");
      expect(result).toContain("`--verbose`");
      expect(result).toContain("`boolean`");
      expect(result).toContain("Enable verbose output");
    });

    it("includes aliases in the flag names column", () => {
      const doc = makeDoc({
        flags: [
          {
            name: "debug",
            type: "boolean",
            aliases: ["-d"],
            description: "Debug mode",
            required: false,
          },
        ],
      });
      const result = formatSection(doc, "FLAGS");
      expect(result).toContain("`--debug`");
      expect(result).toContain("`-d`");
    });

    it("handles flags without descriptions", () => {
      const doc = makeDoc({
        flags: [
          { name: "quiet", type: "boolean", aliases: [], description: undefined, required: false },
        ],
      });
      const result = formatSection(doc, "FLAGS");
      expect(result).toBeDefined();
      expect(result).toContain("`--quiet`");
    });
  });

  describe("ARGS", () => {
    it("returns undefined when args is undefined", () => {
      const doc = makeDoc({ args: undefined });
      expect(formatSection(doc, "ARGS")).toBeUndefined();
    });

    it("returns undefined when args array is empty", () => {
      const doc = makeDoc({ args: [] });
      expect(formatSection(doc, "ARGS")).toBeUndefined();
    });

    it("returns a table when args are present", () => {
      const doc = makeDoc({
        args: [
          {
            name: "project-ref",
            type: "string",
            required: true,
            variadic: false,
            description: "Project reference ID",
          },
        ],
      });
      const result = formatSection(doc, "ARGS");
      expect(result).toBeDefined();
      expect(result).toContain("## Arguments");
      expect(result).toContain("`project-ref`");
      expect(result).toContain("`string`");
      expect(result).toContain("Yes");
      expect(result).toContain("Project reference ID");
    });

    it("marks optional args with No in Required column", () => {
      const doc = makeDoc({
        args: [
          {
            name: "output",
            type: "string",
            required: false,
            variadic: false,
            description: undefined,
          },
        ],
      });
      const result = formatSection(doc, "ARGS");
      expect(result).toContain("No");
    });

    it("appends ... to variadic arg names", () => {
      const doc = makeDoc({
        args: [
          {
            name: "files",
            type: "string",
            required: false,
            variadic: true,
            description: undefined,
          },
        ],
      });
      const result = formatSection(doc, "ARGS");
      expect(result).toContain("`files...`");
    });

    it("handles args without descriptions", () => {
      const doc = makeDoc({
        args: [
          { name: "ref", type: "string", required: true, variadic: false, description: undefined },
        ],
      });
      const result = formatSection(doc, "ARGS");
      expect(result).toBeDefined();
    });
  });

  describe("EXAMPLES", () => {
    it("returns undefined when examples is undefined", () => {
      const doc = makeDoc({ examples: undefined });
      expect(formatSection(doc, "EXAMPLES")).toBeUndefined();
    });

    it("returns undefined when examples array is empty", () => {
      const doc = makeDoc({ examples: [] });
      expect(formatSection(doc, "EXAMPLES")).toBeUndefined();
    });

    it("returns code blocks when examples are present", () => {
      const doc = makeDoc({
        examples: [{ command: "supabase db push --db-url $DB_URL" }],
      });
      const result = formatSection(doc, "EXAMPLES");
      expect(result).toBeDefined();
      expect(result).toContain("## Examples");
      expect(result).toContain("```sh\nsupabase db push --db-url $DB_URL\n```");
    });

    it("prepends description when example has one", () => {
      const doc = makeDoc({
        examples: [{ command: "supabase login --token abc", description: "Login with a token" }],
      });
      const result = formatSection(doc, "EXAMPLES");
      expect(result).toContain("Login with a token\n\n```sh\nsupabase login --token abc\n```");
    });

    it("renders examples without description as bare code blocks", () => {
      const doc = makeDoc({
        examples: [{ command: "supabase start" }],
      });
      const result = formatSection(doc, "EXAMPLES");
      expect(result).toContain("```sh\nsupabase start\n```");
    });

    it("joins multiple examples with blank lines", () => {
      const doc = makeDoc({
        examples: [{ command: "supabase start" }, { command: "supabase stop" }],
      });
      const result = formatSection(doc, "EXAMPLES");
      expect(result).toContain("```sh\nsupabase start\n```\n\n```sh\nsupabase stop\n```");
    });
  });

  describe("SUBCOMMANDS", () => {
    it("returns undefined when subcommands is undefined", () => {
      const doc = makeDoc({ subcommands: undefined });
      expect(formatSection(doc, "SUBCOMMANDS")).toBeUndefined();
    });

    it("returns undefined when subcommands array is empty", () => {
      const doc = makeDoc({ subcommands: [] });
      expect(formatSection(doc, "SUBCOMMANDS")).toBeUndefined();
    });

    it("returns a table when subcommands are present without a group", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: undefined,
            commands: [
              {
                name: "push",
                alias: undefined,
                description: "Push migrations",
                shortDescription: "Push",
              },
            ],
          },
        ],
      });
      const result = formatSection(doc, "SUBCOMMANDS");
      expect(result).toBeDefined();
      expect(result).toContain("## Subcommands");
      expect(result).toContain("`push`");
      expect(result).toContain("Push");
    });

    it("uses shortDescription over description when available", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: undefined,
            commands: [
              {
                name: "push",
                alias: undefined,
                description: "Long description",
                shortDescription: "Short",
              },
            ],
          },
        ],
      });
      const result = formatSection(doc, "SUBCOMMANDS");
      expect(result).toContain("Short");
      expect(result).not.toContain("Long description");
    });

    it("falls back to description when shortDescription is absent", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: undefined,
            commands: [
              {
                name: "pull",
                alias: undefined,
                description: "Pull schema changes",
                shortDescription: undefined,
              },
            ],
          },
        ],
      });
      const result = formatSection(doc, "SUBCOMMANDS");
      expect(result).toContain("Pull schema changes");
    });

    it("renders a group heading when group name is provided", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: "Database",
            commands: [
              {
                name: "push",
                alias: undefined,
                description: "Push migrations",
                shortDescription: undefined,
              },
            ],
          },
        ],
      });
      const result = formatSection(doc, "SUBCOMMANDS");
      expect(result).toContain("### Database");
    });

    it("renders multiple groups separated by blank lines", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: "Database",
            commands: [
              { name: "push", alias: undefined, description: "Push", shortDescription: undefined },
            ],
          },
          {
            group: "Auth",
            commands: [
              {
                name: "users",
                alias: undefined,
                description: "List users",
                shortDescription: undefined,
              },
            ],
          },
        ],
      });
      const result = formatSection(doc, "SUBCOMMANDS");
      expect(result).toContain("### Database");
      expect(result).toContain("### Auth");
    });
  });
});

describe("injectSections", () => {
  it("replaces content between markers with the rendered section", () => {
    const doc = makeDoc();
    const template = "# Guide\n\n<!-- USAGE:START -->\n\nOld content\n\n<!-- USAGE:END -->\n\nEnd.";
    const result = injectSections(template, doc);
    expect(result).toContain("## Usage");
    expect(result).not.toContain("Old content");
  });

  it("leaves the template unchanged when no markers are present", () => {
    const doc = makeDoc();
    const template = "# Guide\n\nNo markers here.";
    const result = injectSections(template, doc);
    expect(result).toBe(template);
  });

  it("handles multiple sections in one template", () => {
    const doc = makeDoc({
      flags: [
        { name: "debug", type: "boolean", aliases: [], description: undefined, required: false },
      ],
    });
    const template = [
      "# Guide",
      "",
      "<!-- USAGE:START --><!-- USAGE:END -->",
      "",
      "<!-- FLAGS:START --><!-- FLAGS:END -->",
    ].join("\n");
    const result = injectSections(template, doc);
    expect(result).toContain("## Usage");
    expect(result).toContain("## Flags");
  });

  it("skips sections whose markers are missing without error", () => {
    const doc = makeDoc({
      flags: [
        { name: "verbose", type: "boolean", aliases: [], description: undefined, required: false },
      ],
    });
    // Only USAGE markers are present; FLAGS markers are absent
    const template = "<!-- USAGE:START --><!-- USAGE:END -->";
    expect(() => injectSections(template, doc)).not.toThrow();
    const result = injectSections(template, doc);
    expect(result).toContain("## Usage");
    expect(result).not.toContain("## Flags");
  });

  it("produces empty content between markers when section is empty (e.g. no flags)", () => {
    const doc = makeDoc({ flags: [] });
    const template = "Before<!-- FLAGS:START -->some old flags<!-- FLAGS:END -->After";
    const result = injectSections(template, doc);
    // Empty replacement means nothing between start and end markers
    expect(result).toContain("<!-- FLAGS:START --><!-- FLAGS:END -->");
    expect(result).not.toContain("some old flags");
  });

  it("preserves content outside the markers", () => {
    const doc = makeDoc();
    const template = "BEFORE<!-- USAGE:START -->old<!-- USAGE:END -->AFTER";
    const result = injectSections(template, doc);
    expect(result).toContain("BEFORE");
    expect(result).toContain("AFTER");
  });

  it("keeps start and end markers in place after injection", () => {
    const doc = makeDoc();
    const template = "<!-- USAGE:START -->old<!-- USAGE:END -->";
    const result = injectSections(template, doc);
    expect(result).toContain("<!-- USAGE:START -->");
    expect(result).toContain("<!-- USAGE:END -->");
  });

  it("only replaces markers for the section that has data, others left alone when partially present", () => {
    const doc = makeDoc({ args: undefined });
    const template = "<!-- USAGE:START --><!-- USAGE:END -->\n<!-- ARGS:START --><!-- ARGS:END -->";
    const result = injectSections(template, doc);
    expect(result).toContain("## Usage");
    // ARGS section is empty so empty replacement between its markers
    expect(result).toContain("<!-- ARGS:START --><!-- ARGS:END -->");
  });
});
