import { describe, expect, it, vi } from "vitest";
import { Cause } from "effect";

import { rootCommand } from "./root.ts";
import { StackRoutingError } from "../command-internal/stack-backend.ts";
import {
  CompletionDirective,
  type ClassifyCompletionInput,
  type CommandPathResolution,
  type CompleteDeps,
  type CompletionCandidate,
  type CompletionResult,
  type FlagDescriptor,
  classifyCompletion,
  collectInScopeFlags,
  defaultCompleteDeps,
  formatCompletionResponse,
  resolveCommandPath,
  resolveIncludeDescriptions,
  respondToComplete,
  tryComplete,
} from "./complete.ts";

describe("respondToComplete", () => {
  describe("subcommand-name completion", () => {
    it("completes a subcommand-name prefix nested under a parent command", () => {
      const result = respondToComplete(rootCommand, ["__complete", "migration", "li"]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("list");
    });

    it("completes a subcommand-name prefix at the root", () => {
      const result = respondToComplete(rootCommand, ["__complete", "br"]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("branches");
    });
  });

  it("returns no candidates and the Default directive for a leaf command with no subcommands and no unset required flags", () => {
    const result = respondToComplete(rootCommand, ["__complete", "migration", "list", ""]);
    expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
  });

  it("offers a global flag declared once at rootCommand from a nested command path", () => {
    const result = respondToComplete(rootCommand, ["__complete", "branches", "--d"]);
    expect(result?.directive).toBe(CompletionDirective.NoFileComp);
    expect(result?.candidates.map((c) => c.name)).toContain("--debug");
  });

  it("offers the built-in --log-level flag like --help shows it", () => {
    const result = respondToComplete(rootCommand, ["__complete", "--log"]);
    expect(result?.directive).toBe(CompletionDirective.NoFileComp);
    expect(result?.candidates.map((c) => c.name)).toContain("--log-level");
  });

  it("offers the built-in --wizard flag and keeps completing after it", () => {
    const offered = respondToComplete(rootCommand, ["__complete", "--wiz"]);
    expect(offered?.candidates.map((c) => c.name)).toContain("--wizard");

    const after = respondToComplete(rootCommand, ["__complete", "--wizard", ""]);
    expect(after?.directive).toBe(CompletionDirective.NoFileComp);
    expect(after?.candidates.map((c) => c.name)).toContain("branches");
  });

  it("offers the built-in --completions flag and keeps completing after its shell value", () => {
    const offered = respondToComplete(rootCommand, ["__complete", "--comp"]);
    expect(offered?.candidates.map((c) => c.name)).toContain("--completions");

    const after = respondToComplete(rootCommand, ["__complete", "--completions", "bash", ""]);
    expect(after?.directive).toBe(CompletionDirective.NoFileComp);
    expect(after?.candidates.map((c) => c.name)).toContain("branches");

    const invalid = respondToComplete(rootCommand, [
      "__complete",
      "--completions",
      "powershell",
      "",
    ]);
    expect(invalid).toEqual({ candidates: [], directive: CompletionDirective.Default });
  });

  it("offers an ancestor's shared flag (Command.withSharedFlags) from a resolved leaf command", () => {
    const result = respondToComplete(rootCommand, [
      "__complete",
      "db",
      "schema",
      "declarative",
      "generate",
      "--no-c",
    ]);
    expect(result?.candidates.map((c) => c.name)).toContain("--no-cache");
  });

  it("offers a non-root command's own declared global flags from a nested subcommand (Command.withGlobalFlags)", () => {
    const atGroup = respondToComplete(rootCommand, ["__complete", "seed", "--l"]);
    expect(atGroup?.candidates.map((c) => c.name)).toEqual(
      expect.arrayContaining(["--linked", "--local"]),
    );

    const atLeaf = respondToComplete(rootCommand, ["__complete", "seed", "buckets", "--l"]);
    expect(atLeaf?.candidates.map((c) => c.name)).toEqual(
      expect.arrayContaining(["--linked", "--local"]),
    );
  });

  it("does not duplicate a flag name that exists both globally and as a command's own local flag", () => {
    const result = respondToComplete(rootCommand, ["__complete", "db", "diff", "--o"]);
    const outputCandidates = result?.candidates.filter((c) => c.name === "--output");
    expect(outputCandidates).toHaveLength(1);
    expect(outputCandidates?.[0]?.description).toBe(
      "Write flattened explicit diff SQL to a file for review; this is not a portable apply script.",
    );
  });

  describe("subcommand completion is not blocked by a preceding global flag", () => {
    it("lists root subcommands after a bare global flag with no value", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--debug", ""]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("branches");
    });

    it("lists subcommands after a value-taking global flag and its value", () => {
      const result = respondToComplete(rootCommand, ["__complete", "-o", "json", ""]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("migration");
    });

    it("lists subcommands after the built-in --log-level and its value", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--log-level", "error", ""]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("sso");

      const invalid = respondToComplete(rootCommand, ["__complete", "--log-level", "bogus", ""]);
      expect(invalid).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("still resolves and lists subcommands when the global flag appears before the group", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--debug", "db", ""]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("diff");
    });
  });

  it("does not offer --version on any command other than the root", () => {
    const atRoot = respondToComplete(rootCommand, ["__complete", "--v"]);
    expect(atRoot?.candidates.map((c) => c.name)).toContain("--version");

    const atSubcommand = respondToComplete(rootCommand, ["__complete", "db", "dump", "--v"]);
    expect(atSubcommand?.candidates.map((c) => c.name)).not.toContain("--version");
  });

  it("returns Default (not NoFileComp) when the resolved command doesn't match a real subcommand", () => {
    const result = respondToComplete(rootCommand, ["__complete", "db", "bogus", ""]);
    expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
  });

  describe("help/version short-circuit", () => {
    it("short-circuits to no candidates once --help/-h appears anywhere in the args", () => {
      const result = respondToComplete(rootCommand, ["__complete", "branches", "--help", "li"]);
      expect(result).toEqual({
        candidates: [],
        directive: CompletionDirective.NoFileComp,
      });
    });

    it("short-circuits on --version/-v only when resolved to the root command", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--version", "br"]);
      expect(result).toEqual({
        candidates: [],
        directive: CompletionDirective.NoFileComp,
      });
    });

    it("does not short-circuit on a subcommand's own local --version flag away from the root", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "migration",
        "squash",
        "--version",
        "20240101000000",
        "--l",
      ]);
      expect(result?.candidates.map((c) => c.name)).toContain("--linked");
    });

    it("does not short-circuit on --help positioned after a genuine `--` terminator (it is positional, not a flag)", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "db",
        "dump",
        "--",
        "--help",
        "",
      ]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("does not short-circuit on --version consumed as a PRECEDING flag's own string value", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--workdir", "--version", "br"]);
      expect(result?.candidates.map((c) => c.name)).toContain("branches");
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
    });
  });

  describe("unmatched root-level command (CLI-1965 review)", () => {
    it("returns Default with zero candidates for a flag typed after an unmatched ROOT-level positional", () => {
      const unknownRoot = respondToComplete(rootCommand, ["__complete", "nosuch", "--d"]);
      expect(unknownRoot).toEqual({ candidates: [], directive: CompletionDirective.Default });

      const unknownRootWithHelp = respondToComplete(rootCommand, [
        "__complete",
        "nosuch",
        "--help",
      ]);
      expect(unknownRootWithHelp).toEqual({
        candidates: [],
        directive: CompletionDirective.Default,
      });

      const knownCommandWithLeftover = respondToComplete(rootCommand, [
        "__complete",
        "db",
        "bogus",
        "--d",
      ]);
      expect(knownCommandWithLeftover?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["--debug", "--dns-resolver"]),
      );
    });

    it("does not treat a surviving bare `-` leftover as an unmatched command (pflag's stripFlags drops it)", () => {
      const result = respondToComplete(rootCommand, ["__complete", "-", "--d"]);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["--debug", "--dns-resolver"]),
      );
    });

    it("does not apply the unmatched-root check to a genuine `help ...` request", () => {
      const result = respondToComplete(rootCommand, ["__complete", "help", "db", "d"]);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["diff", "dump"]),
      );
    });
  });

  describe("required-flag short-circuit", () => {
    it("offers exactly the one required flag and nothing else for a command with a single required flag", () => {
      const result = respondToComplete(rootCommand, ["__complete", "domains", "create", ""]);
      expect(result).toEqual({
        candidates: [
          {
            name: "--custom-hostname",
            description: "The custom hostname to use for your Supabase project.",
          },
        ],
        directive: CompletionDirective.Default,
      });
    });

    it("short-circuits on a flag Go marks required even though this port made it optional at parse time", () => {
      // Required-ness comes from the explicit `COMPLETION_REQUIRED_FLAGS` table, not from
      // inferring it off `Flag.optional`.
      const result = respondToComplete(rootCommand, [
        "__complete",
        "vanity-subdomains",
        "activate",
        "",
      ]);
      expect(result).toEqual({
        candidates: [
          {
            name: "--desired-subdomain",
            description: "The desired vanity subdomain to use for your Supabase project.",
          },
        ],
        directive: CompletionDirective.Default,
      });
    });

    it("does not treat a zero-minimum variadic flag (Flag.atLeast(0)) as required", () => {
      const result = respondToComplete(rootCommand, ["__complete", "sso", "add", ""]);
      expect(result?.candidates.map((c) => c.name)).not.toContain("--domains");
      expect(result).toEqual({
        candidates: [
          { name: "--type", description: expect.any(String) },
          { name: "-t", description: expect.any(String) },
        ],
        directive: CompletionDirective.Default,
      });
    });
  });

  describe("flag-value completion", () => {
    it.each([
      { command: "add", flag: "metadata-file", extension: "xml" },
      { command: "add", flag: "attribute-mapping-file", extension: "json" },
      { command: "update", flag: "metadata-file", extension: "xml" },
      { command: "update", flag: "attribute-mapping-file", extension: "json" },
    ])(
      "restricts $flag on sso $command to the $extension file extension",
      ({ command, flag, extension }) => {
        // File extensions come from the COMPLETION_FLAG_FILE_EXTENSIONS lookup table,
        // not derived generically.
        const result = respondToComplete(rootCommand, ["__complete", "sso", command, `--${flag}=`]);
        expect(result).toEqual({
          candidates: [{ name: extension, description: undefined }],
          directive: CompletionDirective.FilterFileExt,
        });
      },
    );

    it("never completes a choice flag's value (sso add --type <value>)", () => {
      const result = respondToComplete(rootCommand, ["__complete", "sso", "add", "--type", ""]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("does not treat a boolean flag as consuming a following value", () => {
      const withBooleanFlag = respondToComplete(rootCommand, [
        "__complete",
        "sso",
        "add",
        "--skip-url-validation",
        "",
      ]);
      const bareNoun = respondToComplete(rootCommand, ["__complete", "sso", "add", ""]);
      expect(withBooleanFlag).toEqual(bareNoun);
      expect(withBooleanFlag?.candidates.length).toBeGreaterThan(0);
    });
  });

  describe("changed-flag exclusion and the variadic exception", () => {
    it("excludes an already-supplied, non-repeatable flag's own name from further completion", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "sso",
        "add",
        "--metadata-url",
        "https://x",
        "--m",
      ]);
      const names = result?.candidates.map((c) => c.name);
      expect(names).toContain("--metadata-file");
      expect(names).not.toContain("--metadata-url");
    });

    it("keeps offering a variadic flag's own name even after it has already been supplied", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "sso",
        "add",
        "--domains",
        "example.com",
        "--d",
      ]);
      expect(result?.candidates.map((c) => c.name)).toContain("--domains");
    });
  });

  describe("flag terminator (`--`) disables flag completion (CLI-1965 review)", () => {
    it("does not offer a flag-name candidate for a positional operand after `--`", () => {
      const result = respondToComplete(rootCommand, ["__complete", "db", "dump", "--", "--s"]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("still offers a required flag that appears (as a positional) after `--`", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "sso",
        "add",
        "--",
        "--type",
        "--typ",
      ]);
      expect(result).toEqual({
        candidates: [{ name: "--type", description: expect.any(String) }],
        directive: CompletionDirective.Default,
      });
    });
  });

  describe("attached shorthand values resolve via pflag's real strict parser (CLI-1965 review)", () => {
    it("parses a non-boolean shorthand's attached value instead of treating the token as unknown", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "functions",
        "deploy",
        "-j4",
        "--p",
      ]);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["--profile", "--project-ref", "--prune"]),
      );
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
    });
  });

  describe("a trailing incomplete flag is a hard parse error only when toComplete is itself flag-shaped (CLI-1965 review)", () => {
    it("rejects a dangling value-taking flag when toComplete is a bare flag-shaped token", () => {
      const result = respondToComplete(rootCommand, ["__complete", "-o", "--d"]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it.each([
      { toComplete: "", label: "empty toComplete" },
      { toComplete: "pre", label: "non-flag-shaped toComplete" },
    ])(
      "still falls through to flag-VALUE completion for the same dangling flag given $label",
      ({ toComplete }) => {
        const result = respondToComplete(rootCommand, ["__complete", "-o", toComplete]);
        expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
      },
    );

    it("rejects a dangling value-taking flag even when toComplete is a DIFFERENT flag's attached-value token", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "sso",
        "add",
        "--type",
        "saml",
        "--metadata-file",
        "--attribute-mapping-file=",
      ]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });
  });

  describe("changed-flag tracking honors a long flag's real value consumption (CLI-1965 review)", () => {
    it("does not mark a value token as its own changed flag, so a still-required flag stays offered", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "sso",
        "add",
        "--domains",
        "--type",
        "foo",
        "--typ",
      ]);
      expect(result).toEqual({
        candidates: [{ name: "--type", description: expect.any(String) }],
        directive: CompletionDirective.NoFileComp,
      });
    });
  });

  describe("a boolean flag with an explicit `=` is still flag-VALUE completion (CLI-1965 review)", () => {
    it("does not fall through to noun completion for `--boolFlag=value`", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--debug=maybe"]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });
  });

  describe("completion script leaves force NoFileComp (CLI-1965 review)", () => {
    it.each(["bash", "zsh", "fish", "powershell"])(
      "returns zero candidates with the NoFileComp directive for `completion %s`",
      (shell) => {
        const result = respondToComplete(rootCommand, ["__complete", "completion", shell, ""]);
        expect(result).toEqual({ candidates: [], directive: CompletionDirective.NoFileComp });
      },
    );
  });

  describe("help's own ValidArgsFunction resolves a second command path from root (CLI-1965 review)", () => {
    it("completes root subcommand names after `help`", () => {
      const result = respondToComplete(rootCommand, ["__complete", "help", "d"]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["db", "domains"]),
      );
    });

    it("completes a resolved subcommand's own children after `help <command>`", () => {
      const result = respondToComplete(rootCommand, ["__complete", "help", "db", "d"]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["diff", "dump"]),
      );
    });

    it("returns no candidates for a leaf command with no subcommands of its own", () => {
      const result = respondToComplete(rootCommand, ["__complete", "help", "db", "dump", "s"]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.NoFileComp });
    });

    it("returns no candidates for an unresolved token directly under root", () => {
      const result = respondToComplete(rootCommand, ["__complete", "help", "bogus", "d"]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.NoFileComp });
    });

    it("still lists a resolved non-root command's subcommands past an unresolved token", () => {
      const result = respondToComplete(rootCommand, ["__complete", "help", "db", "bogus", "d"]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["diff", "dump"]),
      );
    });

    it("includes the synthetic `help` candidate itself when resolved back to root", () => {
      const result = respondToComplete(rootCommand, ["__complete", "help", "h"]);
      expect(result).toEqual({
        candidates: [{ name: "help", description: "Help about any command" }],
        directive: CompletionDirective.NoFileComp,
      });
    });
  });

  describe("uint-backed flags reject a leading sign like real pflag's ParseUint (CLI-1965 review)", () => {
    it.each([
      { path: ["functions", "deploy"], flag: "jobs" },
      { path: ["migration", "down"], flag: "last" },
      { path: ["db", "reset"], flag: "last" },
    ])("rejects a negative value for $path --$flag", ({ path, flag }) => {
      // These flags are validated as unsigned integers, which reject a leading sign,
      // unlike this tree's plain signed Flag.integer regex.
      const result = respondToComplete(rootCommand, ["__complete", ...path, `--${flag}`, "-1", ""]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("still accepts a valid uint value, including the zero boundary", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "db",
        "reset",
        "--last",
        "0",
        "--d",
      ]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["--debug", "--dns-resolver", "--db-url"]),
      );
    });
  });

  describe("--output's choice values are validated per-command, not the widened global union (CLI-1965 review)", () => {
    it("rejects db query's own local values (table/csv) everywhere else", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--output", "table", ""]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("rejects the resource-command values (env/pretty/toml/yaml) under db query", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "db",
        "query",
        "--output",
        "env",
        "",
      ]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("accepts db query's own values (table/csv) under db query", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "db",
        "query",
        "--output",
        "table",
        "--li",
      ]);
      expect(result?.candidates.map((c) => c.name)).toContain("--linked");
    });

    it("accepts the resource-command values (env/pretty/toml/yaml) outside db query", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--output", "env", ""]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("branches");
    });

    it("still accepts json everywhere — the one value both Go enums share", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--output", "json", ""]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("branches");
    });
  });

  describe("flag values are validated the way real pflag parses them (CLI-1965 review)", () => {
    it("accepts a base-0 hex value for a plain (non-uint) integer flag", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "backups",
        "restore",
        "--timestamp",
        "0x10",
        "--p",
      ]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["--profile", "--project-ref"]),
      );
    });

    it("rejects a value one past int64 max for a plain (non-uint) integer flag", () => {
      // Validated against the signed int64 range, which is narrower than the uint64
      // bound `Flag.integer` alone would suggest.
      const overflow = respondToComplete(rootCommand, [
        "__complete",
        "backups",
        "restore",
        "--timestamp",
        "9223372036854775808",
        "--p",
      ]);
      expect(overflow).toEqual({ candidates: [], directive: CompletionDirective.Default });

      const max = respondToComplete(rootCommand, [
        "__complete",
        "backups",
        "restore",
        "--timestamp",
        "9223372036854775807",
        "--p",
      ]);
      expect(max?.candidates.map((c) => c.name)).toContain("--profile");

      const min = respondToComplete(rootCommand, [
        "__complete",
        "backups",
        "restore",
        "--timestamp",
        "-9223372036854775808",
        "--p",
      ]);
      expect(min?.candidates.map((c) => c.name)).toContain("--profile");
    });

    it("rejects a malformed value for Go's DurationVar flags (gen types --query-timeout, gen bearer-jwt --valid-for)", () => {
      const queryTimeout = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "types",
        "--query-timeout",
        "bogus",
        "--l",
      ]);
      expect(queryTimeout).toEqual({
        candidates: [],
        directive: CompletionDirective.Default,
      });

      const queryTimeoutValid = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "types",
        "--query-timeout",
        "5s",
        "--l",
      ]);
      expect(queryTimeoutValid?.candidates.map((c) => c.name)).toContain("--local");

      const validFor = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--valid-for",
        "bogus",
        "--p",
      ]);
      expect(validFor).toEqual({ candidates: [], directive: CompletionDirective.Default });

      const validForValid = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--valid-for",
        "1h",
        "--p",
      ]);
      expect(validForValid?.candidates.map((c) => c.name)).toContain("--profile");
    });

    it("rejects a duration one unit past Go's int64 nanosecond range for Go's DurationVar flags", () => {
      const overflow = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "types",
        "--query-timeout",
        "2562048h",
        "--l",
      ]);
      expect(overflow).toEqual({ candidates: [], directive: CompletionDirective.Default });

      const max = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "types",
        "--query-timeout",
        "2562047h47m16.854775807s",
        "--l",
      ]);
      expect(max?.candidates.map((c) => c.name)).toContain("--local");
    });

    it("rejects a malformed value for Go's TimeVar flag (gen bearer-jwt --exp, RFC3339 only)", () => {
      const invalid = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--exp",
        "bogus",
        "--p",
      ]);
      expect(invalid).toEqual({ candidates: [], directive: CompletionDirective.Default });

      const valid = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--exp",
        "2024-01-02T15:04:05Z",
        "--p",
      ]);
      expect(valid?.candidates.map((c) => c.name)).toContain("--profile");
    });

    it("rejects an out-of-range RFC3339 zone offset for gen bearer-jwt --exp", () => {
      // RFC3339 parsing caps the offset hour at 24 (not 23) and the minute at 60 (not
      // 59), so "+24:00" and "+00:60" are valid while "+25:00" and "+00:61" are not.
      const outOfRangeHour = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--exp",
        "2024-01-02T15:04:05+25:00",
        "--p",
      ]);
      expect(outOfRangeHour).toEqual({
        candidates: [],
        directive: CompletionDirective.Default,
      });

      const outOfRangeMinute = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--exp",
        "2024-01-02T15:04:05+00:61",
        "--p",
      ]);
      expect(outOfRangeMinute).toEqual({
        candidates: [],
        directive: CompletionDirective.Default,
      });

      const boundaryValid = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--exp",
        "2024-01-02T15:04:05+24:00",
        "--p",
      ]);
      expect(boundaryValid?.candidates.map((c) => c.name)).toContain("--profile");
    });

    it("accepts a comma-separated fractional second for gen bearer-jwt --exp", () => {
      // RFC3339 parsing accepts either `.` or `,` before the fractional-seconds digits.
      const commaFraction = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--exp",
        "2024-01-02T15:04:05,5Z",
        "--p",
      ]);
      expect(commaFraction?.candidates.map((c) => c.name)).toContain("--profile");

      const emptyCommaFraction = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--exp",
        "2024-01-02T15:04:05,Z",
        "--p",
      ]);
      expect(emptyCommaFraction).toEqual({
        candidates: [],
        directive: CompletionDirective.Default,
      });

      const mixedSeparators = respondToComplete(rootCommand, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--exp",
        "2024-01-02T15:04:05.5,5Z",
        "--p",
      ]);
      expect(mixedSeparators).toEqual({
        candidates: [],
        directive: CompletionDirective.Default,
      });
    });

    it("rejects a negative value for storage cp --jobs even though it's a string-typed flag in TS", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "storage",
        "cp",
        "--jobs",
        "-1",
        "--r",
      ]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("rejects malformed CSV for a StringSliceVar-backed flag", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "sso",
        "add",
        "--domains",
        'a,"b',
        "--type",
      ]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("still accepts well-formed CSV (a quoted comma) for the same flag", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "sso",
        "add",
        "--domains",
        '"example.com,example.org"',
        "--type",
      ]);
      expect(result?.candidates.map((c) => c.name)).toContain("--type");
    });

    it("does not apply CSV validation to db reset --sql-paths (a plain StringArrayVar, not StringSliceVar)", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "db",
        "reset",
        "--sql-paths",
        'a"b',
        "--d",
      ]);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["--debug", "--dns-resolver"]),
      );
    });
  });

  describe("an attached-value shorthand cluster is validated even when the owning flag is boolean (CLI-1965 review)", () => {
    it("rejects an invalid boolean value attached via `=` to a boolean shorthand", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "storage",
        "cp",
        "-r=maybe",
        "--j",
      ]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("still accepts a valid boolean value attached the same way", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "storage",
        "cp",
        "-r=true",
        "--j",
      ]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("--jobs");
    });
  });

  describe("the built-in help/version flags short-circuit on Changed, not on exact token spelling (CLI-1965 review)", () => {
    it.each(["--help=false", "--help=true", "-h=false"])(
      "treats %s the same as a bare --help",
      (token) => {
        const result = respondToComplete(rootCommand, ["__complete", token, "--d"]);
        expect(result).toEqual({ candidates: [], directive: CompletionDirective.NoFileComp });
      },
    );

    it("treats --version=false the same as a bare --version, at the root", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--version=false", "br"]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.NoFileComp });
    });

    it("does not treat --help=maybe as Changed — an invalid boolean value is an unresolved-flag parse error instead", () => {
      const result = respondToComplete(rootCommand, ["__complete", "--help=maybe", "--d"]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });
  });

  describe("a `--` consumed as a preceding flag's value is not a genuine terminator (CLI-1965 review)", () => {
    it("still offers a flag name after `--` was consumed as a value-taking flag's own value", () => {
      const result = respondToComplete(rootCommand, [
        "__complete",
        "db",
        "dump",
        "--file",
        "--",
        "--s",
      ]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("--schema");
    });

    it("still disables flag completion for a genuine, unconsumed `--` sentinel", () => {
      const result = respondToComplete(rootCommand, ["__complete", "db", "dump", "--", "--s"]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });
  });

  describe("a bare `-` is a positional argument, not a flag (CLI-1965 review)", () => {
    it("keeps the subcommand-listing gate closed when a bare `-` survives as leftover", () => {
      const result = respondToComplete(rootCommand, ["__complete", "sso", "-", "--debug", "a"]);
      expect(result).toEqual({ candidates: [], directive: CompletionDirective.Default });
    });

    it("still lets the descent continue past a bare `-` to a real subcommand match", () => {
      const result = respondToComplete(rootCommand, ["__complete", "db", "-", "dump", "--da"]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("--data-only");
    });

    it("still resolves help's own second command-path lookup past a bare `-`", () => {
      const result = respondToComplete(rootCommand, ["__complete", "help", "db", "-", "d"]);
      expect(result?.directive).toBe(CompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["diff", "dump"]),
      );
    });
  });

  it("returns undefined for zero completion args (mirrors cobra's MinimumNArgs(1) failure)", () => {
    expect(respondToComplete(rootCommand, ["__complete"])).toBeUndefined();
  });

  it("returns undefined for non-completion argv", () => {
    expect(respondToComplete(rootCommand, ["migration", "list"])).toBeUndefined();
  });
});

describe("resolveCommandPath", () => {
  it("resolves a nested subcommand path with no leftover args", () => {
    const result: CommandPathResolution = resolveCommandPath(rootCommand, ["branches", "list"]);
    expect(result.matchedPath).toEqual(["branches", "list"]);
    expect(result.leftoverArgs).toEqual([]);
    expect(result.commandChain.map((command) => command.name)).toEqual([
      "supabase",
      "branches",
      "list",
    ]);
  });

  it("stops descending at the first unmatched token and treats it and everything after as leftover", () => {
    const result = resolveCommandPath(rootCommand, ["migration", "bogus", "--x"]);
    expect(result.matchedPath).toEqual(["migration"]);
    expect(result.leftoverArgs).toEqual(["bogus", "--x"]);
  });

  it("skips flag-shaped tokens without stopping descent, and excludes them from leftoverArgs", () => {
    const result = resolveCommandPath(rootCommand, ["--debug", "migration", "list"]);
    expect(result.matchedPath).toEqual(["migration", "list"]);
    expect(result.leftoverArgs).toEqual([]);
  });

  it("also excludes a value-taking flag's consumed value token from leftoverArgs", () => {
    const result = resolveCommandPath(rootCommand, ["-o", "json", "migration", "list"]);
    expect(result.matchedPath).toEqual(["migration", "list"]);
    expect(result.leftoverArgs).toEqual([]);
  });

  it("returns just the root for an empty args list", () => {
    const result = resolveCommandPath(rootCommand, []);
    expect(result.matchedPath).toEqual([]);
    expect(result.leftoverArgs).toEqual([]);
    expect(result.commandChain.map((command) => command.name)).toEqual(["supabase"]);
  });
});

describe("collectInScopeFlags", () => {
  it("merges root global flags with the resolved command's own local flags", () => {
    const { commandChain } = resolveCommandPath(rootCommand, ["branches", "list"]);
    const flags: ReadonlyArray<FlagDescriptor> = collectInScopeFlags(rootCommand, commandChain);
    const names = flags.map((flag) => flag.name);
    expect(names).toContain("debug");
    expect(names).toContain("project-ref");

    const debugFlag = flags.find((flag) => flag.name === "debug");
    expect(debugFlag).toEqual({
      name: "debug",
      aliases: [],
      hidden: false,
      description: "output debug logs to stderr",
      isVariadic: false,
      isBoolean: true,
      primitiveTag: "Boolean",
      choiceKeys: undefined,
    });
  });

  it("includes an ancestor's shared flags (Command.withSharedFlags)", () => {
    const { commandChain } = resolveCommandPath(rootCommand, [
      "db",
      "schema",
      "declarative",
      "generate",
    ]);
    const flags = collectInScopeFlags(rootCommand, commandChain);
    expect(flags.map((flag) => flag.name)).toContain("no-cache");
  });

  it("includes a non-root command's own declared global flags across the whole chain", () => {
    const { commandChain } = resolveCommandPath(rootCommand, ["seed", "buckets"]);
    const flags = collectInScopeFlags(rootCommand, commandChain);
    expect(flags.map((flag) => flag.name)).toEqual(expect.arrayContaining(["linked", "local"]));
  });

  it("includes --version only when the chain resolves to the root command alone", () => {
    const atRoot = collectInScopeFlags(
      rootCommand,
      resolveCommandPath(rootCommand, []).commandChain,
    );
    expect(atRoot.map((flag) => flag.name)).toContain("version");

    const atSubcommand = collectInScopeFlags(
      rootCommand,
      resolveCommandPath(rootCommand, ["db", "dump"]).commandChain,
    );
    expect(atSubcommand.map((flag) => flag.name)).not.toContain("version");
  });

  it("lets a command's own local flag shadow a same-named global flag (local wins, no duplicate)", () => {
    const { commandChain } = resolveCommandPath(rootCommand, ["db", "diff"]);
    const flags = collectInScopeFlags(rootCommand, commandChain);
    const outputFlags = flags.filter((flag) => flag.name === "output");
    expect(outputFlags).toHaveLength(1);
    expect(outputFlags[0]?.description).toBe(
      "Write flattened explicit diff SQL to a file for review; this is not a portable apply script.",
    );
  });

  it("orders flags like cobra's InheritedFlags().VisitAll then NonInheritedFlags().VisitAll — alphabetical within each block, not declaration order (CLI-1965 review)", () => {
    const { commandChain } = resolveCommandPath(rootCommand, ["db", "dump"]);
    const names = collectInScopeFlags(rootCommand, commandChain).map((flag) => flag.name);

    const inheritedEnd = names.indexOf("yes");
    const ownStart = names.indexOf("completions");
    expect(inheritedEnd).toBeGreaterThanOrEqual(0);
    expect(ownStart).toBeGreaterThan(inheritedEnd);

    const inheritedBlock = names.slice(0, ownStart);
    const ownBlock = names.slice(ownStart);
    expect(inheritedBlock).toEqual([...inheritedBlock].sort((a, b) => a.localeCompare(b)));
    expect(ownBlock).toEqual([...ownBlock].sort((a, b) => a.localeCompare(b)));
    expect(inheritedBlock).not.toContain("help");
    expect(ownBlock).toContain("help");
  });

  it("orders root's own flags alphabetically end-to-end (InheritedFlags() is empty at root)", () => {
    const atRoot = collectInScopeFlags(
      rootCommand,
      resolveCommandPath(rootCommand, []).commandChain,
    );
    // `output-format` is TS-only, so it's excluded from the ordering check.
    const names = atRoot.map((flag) => flag.name).filter((name) => name !== "output-format");
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("classifyCompletion", () => {
  it("produces the same result respondToComplete does for the equivalent resolved input", () => {
    const trimmedArgs = ["migration", "li"].slice(0, -1);
    const { commandChain, matchedPath, leftoverArgs } = resolveCommandPath(
      rootCommand,
      trimmedArgs,
    );
    const inScopeFlags = collectInScopeFlags(rootCommand, commandChain);
    const input: ClassifyCompletionInput = {
      finalCommand: commandChain[commandChain.length - 1] ?? rootCommand,
      matchedPath,
      leftoverArgs,
      trimmedArgs,
      toComplete: "li",
      inScopeFlags,
    };
    const direct = classifyCompletion(input);
    const viaRespondToComplete = respondToComplete(rootCommand, ["__complete", "migration", "li"]);
    expect(direct).toEqual(viaRespondToComplete);
  });
});

describe("resolveIncludeDescriptions", () => {
  it("defaults to true for __complete with no relevant env vars", () => {
    expect(resolveIncludeDescriptions("__complete", {})).toBe(true);
  });

  it("is always false for __completeNoDesc, regardless of env vars", () => {
    expect(resolveIncludeDescriptions("__completeNoDesc", {})).toBe(false);
    expect(
      resolveIncludeDescriptions("__completeNoDesc", {
        SUPABASE_COMPLETION_DESCRIPTIONS: "true",
        COBRA_COMPLETION_DESCRIPTIONS: "true",
      }),
    ).toBe(false);
  });

  it("honors SUPABASE_COMPLETION_DESCRIPTIONS=false for __complete", () => {
    expect(
      resolveIncludeDescriptions("__complete", { SUPABASE_COMPLETION_DESCRIPTIONS: "false" }),
    ).toBe(false);
  });

  it("falls back to the generic COBRA_COMPLETION_DESCRIPTIONS when the program-specific var is unset", () => {
    expect(resolveIncludeDescriptions("__complete", { COBRA_COMPLETION_DESCRIPTIONS: "0" })).toBe(
      false,
    );
  });

  it("ignores an unparseable value and preserves the argv0-derived default", () => {
    expect(
      resolveIncludeDescriptions("__complete", {
        SUPABASE_COMPLETION_DESCRIPTIONS: "nonsense",
      }),
    ).toBe(true);
  });

  it("prioritizes the program-specific var over the generic one when both are set and conflict", () => {
    expect(
      resolveIncludeDescriptions("__complete", {
        SUPABASE_COMPLETION_DESCRIPTIONS: "true",
        COBRA_COMPLETION_DESCRIPTIONS: "false",
      }),
    ).toBe(true);
  });
});

describe("formatCompletionResponse", () => {
  it("tab-joins a description when present and prints a bare name otherwise, followed by the directive line", () => {
    const response: CompletionResult = {
      candidates: [
        { name: "list", description: "List things" },
        { name: "new", description: undefined },
      ],
      directive: CompletionDirective.NoFileComp,
    };
    expect(formatCompletionResponse(response, true)).toBe("list\tList things\nnew\n:4\n");
  });

  it("strips descriptions from every candidate when includeDescriptions is false", () => {
    const response: CompletionResult = {
      candidates: [
        { name: "list", description: "List things" },
        { name: "new", description: undefined },
      ],
      directive: CompletionDirective.NoFileComp,
    };
    expect(formatCompletionResponse(response, false)).toBe("list\nnew\n:4\n");
  });

  it("keeps only the first line of a multi-line description", () => {
    const candidate: CompletionCandidate = {
      name: "flag",
      description: "first line\nsecond line",
    };
    const response: CompletionResult = {
      candidates: [candidate],
      directive: CompletionDirective.Default,
    };
    expect(formatCompletionResponse(response, true)).toBe("flag\tfirst line\n:0\n");
  });

  it("emits just the directive line for zero candidates", () => {
    const response: CompletionResult = {
      candidates: [],
      directive: CompletionDirective.Default,
    };
    expect(formatCompletionResponse(response, true)).toBe(":0\n");
  });
});

describe("tryComplete", () => {
  function makeDeps(overrides: Partial<CompleteDeps> = {}) {
    const stdoutWrites: Array<string> = [];
    const stderrWrites: Array<string> = [];
    const exits: Array<number> = [];
    const deps: CompleteDeps = {
      root: rootCommand,
      argv: ["__complete", "migration", "li"],
      env: {},
      stdoutWrite: (message) => {
        stdoutWrites.push(message);
      },
      stderrWrite: (message) => {
        stderrWrites.push(message);
      },
      exit: (code) => {
        exits.push(code);
      },
      // No-op: telemetry capture is covered separately in complete.integration.test.ts.
      captureTelemetry: async () => {},
      ...overrides,
    };
    return { deps, stdoutWrites, stderrWrites, exits };
  }

  // `tryComplete` awaits `deps.captureTelemetry` before calling `deps.exit`.
  it("returns false and does nothing for non-__complete argv", async () => {
    const { deps, stdoutWrites, exits } = makeDeps({ argv: ["migration", "list"] });
    expect(await tryComplete(deps)).toBe(false);
    expect(stdoutWrites).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("writes the formatted response to stdout and exits 0 for a real completion request", async () => {
    const { deps, stdoutWrites, exits } = makeDeps();
    expect(await tryComplete(deps)).toBe(true);
    expect(stdoutWrites).toHaveLength(1);
    expect(stdoutWrites[0]).toContain("list\t");
    expect(stdoutWrites[0]).toMatch(/:4\n$/);
    expect(exits).toEqual([0]);
  });

  it("respects __completeNoDesc by stripping descriptions from the written response", async () => {
    const { deps, stdoutWrites } = makeDeps({ argv: ["__completeNoDesc", "migration", "li"] });
    await tryComplete(deps);
    expect(stdoutWrites[0]).toBe("list\n:4\n");
  });

  it("exits 1 and does not write anything to stdout for zero completion args", async () => {
    const { deps, stdoutWrites, exits } = makeDeps({ argv: ["__complete"] });
    expect(await tryComplete(deps)).toBe(true);
    expect(stdoutWrites).toEqual([]);
    expect(exits).toEqual([1]);
  });

  it("writes invalid environment routing failures to stderr without emitting completion stdout", async () => {
    const { deps, stdoutWrites, stderrWrites, exits } = makeDeps({
      root: undefined,
      routingFailure: Cause.fail(
        new StackRoutingError({
          message: "SUPABASE_EXPERIMENTAL_STACK must be 0 or 1 when set",
        }),
      ),
    });
    expect(await tryComplete(deps)).toBe(true);
    expect(stdoutWrites).toEqual([]);
    expect(stderrWrites).toHaveLength(1);
    expect(stderrWrites[0]).toContain("SUPABASE_EXPERIMENTAL_STACK must be 0 or 1 when set");
    expect(stderrWrites[0]).toContain(
      "Suggestion: Set SUPABASE_EXPERIMENTAL_STACK=0 to use legacy start/stop, or use `supabase stack`.",
    );
    expect(exits).toEqual([1]);
  });

  it("preserves a defect diagnostic when routing fails with a defect cause", async () => {
    const { deps, stdoutWrites, stderrWrites, exits } = makeDeps({
      root: undefined,
      routingFailure: Cause.die(new Error("completion routing defect")),
    });
    expect(await tryComplete(deps)).toBe(true);
    expect(stdoutWrites).toEqual([]);
    expect(stderrWrites[0]).toContain("completion routing defect");
    expect(exits).toEqual([1]);
  });
});

describe("defaultCompleteDeps", () => {
  it("wires argv/env from the real process and delegates stdoutWrite/exit to process.stdout.write/process.exit", () => {
    const originalArgv = process.argv;
    process.argv = [...originalArgv.slice(0, 2), "__complete", "migration", "li"];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    try {
      const deps = defaultCompleteDeps(rootCommand);
      expect(deps.root).toBe(rootCommand);
      expect(deps.argv).toEqual(["__complete", "migration", "li"]);
      expect(deps.env).toBe(process.env);

      deps.stdoutWrite("hello");
      expect(stdoutWrite).toHaveBeenCalledWith("hello");

      deps.exit(3);
      expect(exit).toHaveBeenCalledWith(3);
    } finally {
      process.argv = originalArgv;
      stdoutWrite.mockRestore();
      exit.mockRestore();
    }
  });
});
