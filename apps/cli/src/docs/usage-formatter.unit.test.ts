import { describe, expect, it } from "vitest";
import { Command, Flag } from "effect/unstable/cli";
import { formatAsUsageSpec } from "./usage-formatter.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultOptions = { version: "1.0.0" };

// ---------------------------------------------------------------------------
// Root-level metadata
// ---------------------------------------------------------------------------

describe("formatAsUsageSpec", () => {
  describe("root metadata", () => {
    it("outputs bin, about, and version", () => {
      const cmd = Command.make("mycli").pipe(Command.withDescription("My CLI tool"));
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain('bin "mycli"');
      expect(result).toContain('about "My CLI tool"');
      expect(result).toContain('version "1.0.0"');
    });

    it("splits multi-line description into about and long_about", () => {
      const cmd = Command.make("mycli").pipe(
        Command.withDescription("Short summary\n\nDetailed explanation of the tool."),
      );
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain('about "Short summary"');
      expect(result).toContain('long_about "Short summary\\n\\nDetailed explanation of the tool."');
    });

    it("omits about when description is empty", () => {
      const cmd = Command.make("mycli");
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain('bin "mycli"');
      expect(result).not.toContain("about");
    });
  });

  // ---------------------------------------------------------------------------
  // Flags
  // ---------------------------------------------------------------------------

  describe("flags", () => {
    it("renders a boolean flag without a value placeholder", () => {
      const cmd = Command.make("mycli", {
        verbose: Flag.boolean("verbose").pipe(
          Flag.withDescription("Enable verbose output"),
          Flag.withDefault(false),
        ),
      });
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain('flag "--verbose" help="Enable verbose output"');
    });

    it("renders a string flag with a value placeholder", () => {
      const cmd = Command.make("mycli", {
        token: Flag.string("token").pipe(Flag.withDescription("Access token")),
      });
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain('flag "--token <token>" help="Access token"');
    });

    it("renders a flag with aliases", () => {
      const cmd = Command.make("mycli", {
        verbose: Flag.boolean("verbose").pipe(
          Flag.withAlias("v"),
          Flag.withDescription("Enable verbose output"),
          Flag.withDefault(false),
        ),
      });
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain('flag "-v --verbose" help="Enable verbose output"');
    });

    it("renders a flag without description", () => {
      const cmd = Command.make("mycli", {
        force: Flag.boolean("force").pipe(Flag.withDefault(false)),
      });
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain('flag "--force"');
      expect(result).not.toContain("help=");
    });
  });

  // ---------------------------------------------------------------------------
  // Arguments
  // ---------------------------------------------------------------------------

  describe("arguments", () => {
    it("does not produce arg nodes for flag-only commands", () => {
      const cmd = Command.make("mycli", {
        token: Flag.string("token").pipe(Flag.withDescription("Token")),
      });
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).not.toContain("arg ");
    });
  });

  // ---------------------------------------------------------------------------
  // Examples
  // ---------------------------------------------------------------------------

  describe("examples", () => {
    it("renders examples with code blocks", () => {
      const cmd = Command.make("mycli").pipe(
        Command.withExamples([{ command: "mycli deploy --env production" }]),
      );
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain("example {");
      expect(result).toContain('code "mycli deploy --env production"');
      expect(result).toContain("}");
    });

    it("renders example with description as header", () => {
      const cmd = Command.make("mycli").pipe(
        Command.withExamples([{ command: "mycli deploy", description: "Deploy to production" }]),
      );
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain('header "Deploy to production"');
      expect(result).toContain('code "mycli deploy"');
    });

    it("omits header when example has no description", () => {
      const cmd = Command.make("mycli").pipe(Command.withExamples([{ command: "mycli login" }]));
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).not.toContain("header");
      expect(result).toContain('code "mycli login"');
    });
  });

  // ---------------------------------------------------------------------------
  // Subcommands
  // ---------------------------------------------------------------------------

  describe("subcommands", () => {
    it("renders subcommands as nested cmd blocks", () => {
      const login = Command.make("login").pipe(Command.withDescription("Log in"));
      const root = Command.make("mycli").pipe(Command.withSubcommands([login]));
      const result = formatAsUsageSpec(root, defaultOptions);
      expect(result).toContain('cmd "login"');
    });

    it("includes subcommand flags inside the cmd block", () => {
      const login = Command.make("login", {
        token: Flag.string("token").pipe(Flag.withDescription("Access token")),
      }).pipe(Command.withDescription("Log in"));
      const root = Command.make("mycli").pipe(Command.withSubcommands([login]));
      const result = formatAsUsageSpec(root, defaultOptions);
      expect(result).toContain('cmd "login"');
      expect(result).toContain('flag "--token <token>" help="Access token"');
    });

    it("renders deeply nested subcommands", () => {
      const branch = Command.make("branch").pipe(Command.withDescription("Manage branches"));
      const db = Command.make("db").pipe(
        Command.withDescription("Database commands"),
        Command.withSubcommands([branch]),
      );
      const root = Command.make("mycli").pipe(Command.withSubcommands([db]));
      const result = formatAsUsageSpec(root, defaultOptions);
      expect(result).toContain('cmd "db"');
      expect(result).toContain('cmd "branch"');
    });

    it("includes subcommand examples", () => {
      const login = Command.make("login").pipe(
        Command.withDescription("Log in"),
        Command.withExamples([{ command: "mycli login --token abc" }]),
      );
      const root = Command.make("mycli").pipe(Command.withSubcommands([login]));
      const result = formatAsUsageSpec(root, defaultOptions);
      expect(result).toContain('code "mycli login --token abc"');
    });

    it("renders leaf subcommand without children as single line", () => {
      const leaf = Command.make("version");
      const root = Command.make("mycli").pipe(Command.withSubcommands([leaf]));
      const result = formatAsUsageSpec(root, defaultOptions);
      // Leaf with no flags/args/examples/description renders as single line
      const versionLine = result.split("\n").find((l) => l.includes('cmd "version"'));
      expect(versionLine).toBeDefined();
      expect(versionLine).not.toContain("{");
    });
  });

  // ---------------------------------------------------------------------------
  // KDL escaping
  // ---------------------------------------------------------------------------

  describe("KDL escaping", () => {
    it("escapes double quotes in descriptions", () => {
      const cmd = Command.make("mycli").pipe(
        Command.withDescription('Use "quotes" in description'),
      );
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain('about "Use \\"quotes\\" in description"');
    });

    it("escapes backslashes in descriptions", () => {
      const cmd = Command.make("mycli").pipe(Command.withDescription("Path is C:\\Users\\test"));
      const result = formatAsUsageSpec(cmd, defaultOptions);
      expect(result).toContain("C:\\\\Users\\\\test");
    });
  });

  // ---------------------------------------------------------------------------
  // Full output structure
  // ---------------------------------------------------------------------------

  describe("full output", () => {
    it("produces valid structure for a realistic CLI", () => {
      const login = Command.make("login", {
        token: Flag.string("token").pipe(Flag.withDescription("Access token")),
        noBrowser: Flag.boolean("no-browser").pipe(
          Flag.withDescription("Skip opening browser"),
          Flag.withDefault(false),
        ),
      }).pipe(
        Command.withDescription("Log in to the platform"),
        Command.withShortDescription("Log in"),
        Command.withExamples([
          { command: "mycli login", description: "Interactive login" },
          { command: "mycli login --token abc", description: "Token login" },
        ]),
      );
      const root = Command.make("mycli").pipe(
        Command.withDescription("My CLI tool"),
        Command.withSubcommands([login]),
      );
      const result = formatAsUsageSpec(root, { version: "2.0.0" });

      expect(result).toContain('bin "mycli"');
      expect(result).toContain('about "My CLI tool"');
      expect(result).toContain('version "2.0.0"');
      expect(result).toContain('cmd "login" help="Log in"');
      expect(result).toContain('flag "--token <token>" help="Access token"');
      expect(result).toContain('flag "--no-browser" help="Skip opening browser"');
      expect(result).toContain('header "Interactive login"');
      expect(result).toContain('code "mycli login"');
    });

    it("renders the same root usage shape from a subcommand tree", () => {
      const login = Command.make("login").pipe(Command.withDescription("Log in"));
      const root = Command.make("supabase").pipe(
        Command.withDescription("Supabase CLI"),
        Command.withSubcommands([login]),
      );

      const result = formatAsUsageSpec(root, defaultOptions);

      expect(result).toContain('bin "supabase"');
      expect(result).toContain('cmd "login"');
      expect(result).toContain('version "1.0.0"');
    });
  });
});
