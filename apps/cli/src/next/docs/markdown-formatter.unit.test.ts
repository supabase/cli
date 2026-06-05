import { Option, Context } from "effect";
import type { HelpDoc } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { formatHelpDocAsMarkdown } from "./markdown-formatter.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RawFlagDoc = Omit<HelpDoc.FlagDoc, "description"> & { readonly description?: string };
type RawArgDoc = Omit<HelpDoc.ArgDoc, "description"> & { readonly description?: string };
type RawHelpDoc = Omit<Partial<HelpDoc.HelpDoc>, "flags" | "args"> & {
  readonly flags?: ReadonlyArray<RawFlagDoc>;
  readonly args?: ReadonlyArray<RawArgDoc>;
};

function optionString(value?: string): Option.Option<string> {
  return value === undefined ? Option.none() : Option.some(value);
}

function makeDoc(overrides: RawHelpDoc = {}): HelpDoc.HelpDoc {
  const { flags, args, ...rest } = overrides;
  return {
    description: "",
    usage: "myapp <command>",
    ...rest,
    flags: (flags ?? []).map((flag) => ({
      ...flag,
      description: optionString(flag.description),
    })),
    ...(args
      ? {
          args: args.map((arg) => ({
            ...arg,
            description: optionString(arg.description),
          })),
        }
      : {}),
    annotations: Context.empty(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatHelpDocAsMarkdown", () => {
  describe("usage section", () => {
    it("always renders a Usage section as a sh code block", () => {
      const doc = makeDoc({ usage: "myapp deploy [flags]" });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("## Usage\n\n```sh\nmyapp deploy [flags]\n```");
    });
  });

  describe("description section", () => {
    it("omits description section when description is empty string", () => {
      const doc = makeDoc({ description: "" });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).not.toContain("## Description");
      expect(result.startsWith("## Usage")).toBe(true);
    });

    it("renders description before Usage when present", () => {
      const doc = makeDoc({ description: "Deploy your application to the cloud." });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("Deploy your application to the cloud.");
      const descIndex = result.indexOf("Deploy your application to the cloud.");
      const usageIndex = result.indexOf("## Usage");
      expect(descIndex).toBeLessThan(usageIndex);
    });
  });

  describe("flags section", () => {
    it("omits flags section when flags array is empty", () => {
      const doc = makeDoc({ flags: [] });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).not.toContain("## Flags");
    });

    it("renders flags table with primary name and aliases", () => {
      const doc = makeDoc({
        flags: [
          {
            name: "verbose",
            aliases: ["-v"],
            type: "boolean",
            description: "Enable verbose output",
            required: false,
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("## Flags");
      expect(result).toContain("`--verbose`");
      expect(result).toContain("`-v`");
      expect(result).toContain("`boolean`");
      expect(result).toContain("Enable verbose output");
    });

    it("renders flags table with multiple flags padded to equal column widths", () => {
      const doc = makeDoc({
        flags: [
          {
            name: "token",
            aliases: ["-t"],
            type: "string",
            description: "Access token",
            required: true,
          },
          {
            name: "no-browser",
            aliases: [],
            type: "boolean",
            description: "Skip opening browser",
            required: false,
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      const lines = result.split("\n");
      const flagLines = lines.filter((l) => l.startsWith("|"));
      // All table rows should have the same length (padded)
      const lengths = flagLines.map((l) => l.length);
      expect(new Set(lengths).size).toBe(1);
    });

    it("renders flag with no aliases correctly", () => {
      const doc = makeDoc({
        flags: [
          {
            name: "force",
            aliases: [],
            type: "boolean",
            description: "Force the operation",
            required: false,
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("`--force`");
      expect(result).not.toMatch(/`--force`,/);
    });

    it("renders flag with undefined description as empty string", () => {
      const doc = makeDoc({
        flags: [
          {
            name: "quiet",
            aliases: [],
            type: "boolean",
            description: undefined,
            required: false,
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("## Flags");
    });
  });

  describe("arguments section", () => {
    it("omits arguments section when args is undefined", () => {
      const doc = makeDoc({ args: undefined });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).not.toContain("## Arguments");
    });

    it("omits arguments section when args array is empty", () => {
      const doc = makeDoc({ args: [] });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).not.toContain("## Arguments");
    });

    it("renders positional argument with required=Yes", () => {
      const doc = makeDoc({
        args: [
          {
            name: "target",
            type: "string",
            description: "Deployment target",
            required: true,
            variadic: false,
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("## Arguments");
      expect(result).toContain("`target`");
      expect(result).toContain("`string`");
      expect(result).toContain("Yes");
      expect(result).toContain("Deployment target");
    });

    it("renders optional argument with required=No", () => {
      const doc = makeDoc({
        args: [
          {
            name: "output",
            type: "file",
            description: "Output file",
            required: false,
            variadic: false,
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("No");
    });

    it("renders variadic argument with trailing ellipsis", () => {
      const doc = makeDoc({
        args: [
          {
            name: "files",
            type: "file",
            description: "Files to process",
            required: false,
            variadic: true,
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("`files...`");
    });
  });

  describe("examples section", () => {
    it("omits examples section when examples is undefined", () => {
      const doc = makeDoc({ examples: undefined });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).not.toContain("## Examples");
    });

    it("omits examples section when examples array is empty", () => {
      const doc = makeDoc({ examples: [] });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).not.toContain("## Examples");
    });

    it("renders example without description as bare code block", () => {
      const doc = makeDoc({
        examples: [{ command: "myapp deploy --env production" }],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("## Examples");
      expect(result).toContain("```sh\nmyapp deploy --env production\n```");
      // No description prefix before the block
      const examplesSection = result.split("## Examples\n\n")[1]!;
      expect(examplesSection.trimStart().startsWith("```sh")).toBe(true);
    });

    it("renders example with description before the code block", () => {
      const doc = makeDoc({
        examples: [
          {
            command: "myapp deploy --env staging",
            description: "Deploy to staging environment",
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain(
        "Deploy to staging environment\n\n```sh\nmyapp deploy --env staging\n```",
      );
    });

    it("renders multiple examples separated by blank lines", () => {
      const doc = makeDoc({
        examples: [
          { command: "myapp login --token mytoken" },
          {
            command: "myapp login",
            description: "Interactive OAuth login",
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("## Examples");
      expect(result).toContain("myapp login --token mytoken");
      expect(result).toContain("Interactive OAuth login");
      expect(result).toContain("myapp login");
    });

    it("renders examples section after flags and before subcommands", () => {
      const doc = makeDoc({
        flags: [
          {
            name: "env",
            aliases: [],
            type: "string",
            description: "Target environment",
            required: false,
          },
        ],
        examples: [{ command: "myapp deploy" }],
        subcommands: [
          {
            group: undefined,
            commands: [
              {
                name: "build",
                alias: undefined,
                shortDescription: undefined,
                description: "Build the app",
              },
            ],
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      const flagsIndex = result.indexOf("## Flags");
      const examplesIndex = result.indexOf("## Examples");
      const subcommandsIndex = result.indexOf("## Subcommands");
      expect(flagsIndex).toBeLessThan(examplesIndex);
      expect(examplesIndex).toBeLessThan(subcommandsIndex);
    });
  });

  describe("subcommands section", () => {
    it("omits subcommands section when subcommands is undefined", () => {
      const doc = makeDoc({ subcommands: undefined });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).not.toContain("## Subcommands");
    });

    it("omits subcommands section when subcommands array is empty", () => {
      const doc = makeDoc({ subcommands: [] });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).not.toContain("## Subcommands");
    });

    it("renders ungrouped subcommands (group=undefined) as a flat table", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: undefined,
            commands: [
              {
                name: "deploy",
                alias: undefined,
                shortDescription: "Deploy app",
                description: "Deploy the application",
              },
              {
                name: "build",
                alias: undefined,
                shortDescription: undefined,
                description: "Build the application",
              },
            ],
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("## Subcommands");
      expect(result).not.toContain("### ");
      expect(result).toContain("`deploy`");
      expect(result).toContain("`build`");
    });

    it("uses shortDescription when available instead of description", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: undefined,
            commands: [
              {
                name: "deploy",
                alias: undefined,
                shortDescription: "Deploy app",
                description: "Deploy the full application including all services to the cloud",
              },
            ],
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("Deploy app");
      expect(result).not.toContain(
        "Deploy the full application including all services to the cloud",
      );
    });

    it("falls back to description when shortDescription is undefined", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: undefined,
            commands: [
              {
                name: "build",
                alias: undefined,
                shortDescription: undefined,
                description: "Build the application for production",
              },
            ],
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("Build the application for production");
    });

    it("renders grouped subcommands with a ### heading", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: "Database",
            commands: [
              {
                name: "db:push",
                alias: undefined,
                shortDescription: "Push schema",
                description: "Push schema changes",
              },
              {
                name: "db:pull",
                alias: undefined,
                shortDescription: "Pull schema",
                description: "Pull remote schema",
              },
            ],
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("## Subcommands");
      expect(result).toContain("### Database");
      expect(result).toContain("`db:push`");
      expect(result).toContain("`db:pull`");
    });

    it("renders multiple groups each with their own ### heading", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: "Auth",
            commands: [
              {
                name: "login",
                alias: undefined,
                shortDescription: "Log in",
                description: "Log in to Supabase",
              },
              {
                name: "logout",
                alias: undefined,
                shortDescription: "Log out",
                description: "Log out of Supabase",
              },
            ],
          },
          {
            group: "Database",
            commands: [
              {
                name: "db:push",
                alias: undefined,
                shortDescription: "Push schema",
                description: "Push schema changes",
              },
            ],
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("### Auth");
      expect(result).toContain("### Database");
      expect(result).toContain("`login`");
      expect(result).toContain("`logout`");
      expect(result).toContain("`db:push`");
    });

    it("renders mix of ungrouped and grouped subcommands", () => {
      const doc = makeDoc({
        subcommands: [
          {
            group: undefined,
            commands: [
              {
                name: "version",
                alias: undefined,
                shortDescription: "Show version",
                description: "Show CLI version",
              },
            ],
          },
          {
            group: "Database",
            commands: [
              {
                name: "db:push",
                alias: undefined,
                shortDescription: "Push schema",
                description: "Push schema changes",
              },
            ],
          },
        ],
      });
      const result = formatHelpDocAsMarkdown(doc);
      expect(result).toContain("## Subcommands");
      // The ungrouped table should not have a ### heading before it
      const subcommandsSection = result.split("## Subcommands\n\n")[1]!;
      expect(subcommandsSection.trimStart().startsWith("|")).toBe(true);
      expect(result).toContain("### Database");
    });
  });

  describe("section ordering", () => {
    it("renders all sections in order: Description, Usage, Arguments, Flags, Examples, Subcommands", () => {
      const doc = makeDoc({
        description: "A comprehensive CLI tool.",
        usage: "myapp <command> [flags]",
        args: [
          {
            name: "target",
            type: "string",
            description: "Target environment",
            required: true,
            variadic: false,
          },
        ],
        flags: [
          {
            name: "verbose",
            aliases: ["-v"],
            type: "boolean",
            description: "Enable verbose output",
            required: false,
          },
        ],
        examples: [{ command: "myapp deploy production", description: "Deploy to production" }],
        subcommands: [
          {
            group: undefined,
            commands: [
              {
                name: "deploy",
                alias: undefined,
                shortDescription: "Deploy",
                description: "Deploy the application",
              },
            ],
          },
        ],
      });

      const result = formatHelpDocAsMarkdown(doc);

      const descriptionIndex = result.indexOf("A comprehensive CLI tool.");
      const usageIndex = result.indexOf("## Usage");
      const argsIndex = result.indexOf("## Arguments");
      const flagsIndex = result.indexOf("## Flags");
      const examplesIndex = result.indexOf("## Examples");
      const subcommandsIndex = result.indexOf("## Subcommands");

      expect(descriptionIndex).toBeLessThan(usageIndex);
      expect(usageIndex).toBeLessThan(argsIndex);
      expect(argsIndex).toBeLessThan(flagsIndex);
      expect(flagsIndex).toBeLessThan(examplesIndex);
      expect(examplesIndex).toBeLessThan(subcommandsIndex);
    });
  });

  describe("minimal doc (usage + flags only)", () => {
    it("renders a minimal doc with just usage and flags", () => {
      const doc = makeDoc({
        usage: "supabase login [flags]",
        flags: [
          {
            name: "token",
            aliases: ["-t"],
            type: "string",
            description: "Access token",
            required: false,
          },
          {
            name: "no-browser",
            aliases: [],
            type: "boolean",
            description: "Skip opening the browser",
            required: false,
          },
        ],
      });

      const result = formatHelpDocAsMarkdown(doc);

      expect(result).toContain("## Usage");
      expect(result).toContain("supabase login [flags]");
      expect(result).toContain("## Flags");
      expect(result).toContain("`--token`");
      expect(result).toContain("`-t`");
      expect(result).toContain("`--no-browser`");
      expect(result).not.toContain("## Arguments");
      expect(result).not.toContain("## Examples");
      expect(result).not.toContain("## Subcommands");
    });
  });
});
