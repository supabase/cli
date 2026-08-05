import { describe, expect, it, vi } from "vitest";

import { legacyRoot } from "./root.ts";
import {
  LegacyCompletionDirective,
  type LegacyClassifyCompletionInput,
  type LegacyCommandPathResolution,
  type LegacyCompleteDeps,
  type LegacyCompletionCandidate,
  type LegacyCompletionResult,
  type LegacyFlagDescriptor,
  legacyClassifyCompletion,
  legacyCollectInScopeFlags,
  legacyDefaultCompleteDeps,
  legacyFormatCompletionResponse,
  legacyResolveCommandPath,
  legacyResolveIncludeDescriptions,
  legacyRespondToComplete,
  legacyTryComplete,
} from "./legacy-complete.ts";

describe("legacyRespondToComplete", () => {
  describe("subcommand-name completion", () => {
    it("completes a subcommand-name prefix nested under a parent command", () => {
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "migration", "li"]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("list");
    });

    it("completes a subcommand-name prefix at the root", () => {
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "br"]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("branches");
    });
  });

  it("returns no candidates and the Default directive for a leaf command with no subcommands and no unset required flags", () => {
    // `migration list` has no subcommands; `--db-url`/`--password` are optional,
    // `--linked` defaults to true, and `--local` is a plain boolean, so nothing
    // is left "required" once resolved (verified against migration/list/list.command.ts).
    const result = legacyRespondToComplete(legacyRoot, ["__complete", "migration", "list", ""]);
    expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
  });

  it("offers a global flag declared once at legacyRoot from a nested command path", () => {
    // `--debug` is declared exactly once, via LEGACY_GLOBAL_FLAGS ->
    // Command.withGlobalFlags on legacyRoot (shared/legacy/global-flags.ts,
    // legacy/cli/root.ts) — it must still resolve from a resolved subcommand path.
    const result = legacyRespondToComplete(legacyRoot, ["__complete", "branches", "--d"]);
    expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
    expect(result?.candidates.map((c) => c.name)).toContain("--debug");
  });

  it("offers an ancestor's shared flag (Command.withSharedFlags) from a resolved leaf command", () => {
    // `--no-cache` is declared once on the `db schema declarative` group via
    // Command.withSharedFlags (declarative.shared.ts) and must be visible from
    // its `generate` leaf.
    const result = legacyRespondToComplete(legacyRoot, [
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
    // seed.command.ts declares --linked/--local as scoped global flags via
    // Command.withGlobalFlags on the `seed` group itself (Go's
    // seedCmd.PersistentFlags()), not at legacyRoot — a collector that only
    // reads root.globalFlags misses these entirely (CLI-1965 review finding).
    const atGroup = legacyRespondToComplete(legacyRoot, ["__complete", "seed", "--l"]);
    expect(atGroup?.candidates.map((c) => c.name)).toEqual(
      expect.arrayContaining(["--linked", "--local"]),
    );

    const atLeaf = legacyRespondToComplete(legacyRoot, ["__complete", "seed", "buckets", "--l"]);
    expect(atLeaf?.candidates.map((c) => c.name)).toEqual(
      expect.arrayContaining(["--linked", "--local"]),
    );
  });

  it("does not duplicate a flag name that exists both globally and as a command's own local flag", () => {
    // db diff declares its own local `output`/`-o` (a file path), shadowing
    // the global `--output`/`-o` choice flag declared at root — pflag's
    // InheritedFlags() skips a persistent flag shadowed by a same-named local
    // one, so exactly one `--output` candidate (the local one) must appear,
    // not two with contradictory descriptions.
    const result = legacyRespondToComplete(legacyRoot, ["__complete", "db", "diff", "--o"]);
    const outputCandidates = result?.candidates.filter((c) => c.name === "--output");
    expect(outputCandidates).toHaveLength(1);
    expect(outputCandidates?.[0]?.description).toBe("Write explicit diff output to a file path.");
  });

  describe("subcommand completion is not blocked by a preceding global flag", () => {
    it("lists root subcommands after a bare global flag with no value", () => {
      // `--debug ""` used to return zero candidates entirely: the leftover-args
      // computation counted `--debug` itself as "positional leftover," gating
      // out subcommand-name completion the way cobra never does for a
      // persistent flag (CLI-1965 review finding, empirically confirmed
      // against a real apps/cli-go build: `__complete --debug ''` lists all 36
      // root commands there).
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "--debug", ""]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("branches");
    });

    it("lists subcommands after a value-taking global flag and its value", () => {
      // `-o json ""` — "json" is `-o`'s consumed value, not a genuine extra
      // positional argument, so it must not count as leftover either.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "-o", "json", ""]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("migration");
    });

    it("still resolves and lists subcommands when the global flag appears before the group", () => {
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "--debug", "db", ""]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("diff");
    });
  });

  it("does not offer --version on any command other than the root", () => {
    // Cobra's InitDefaultVersionFlag registers --version non-persistently on
    // the root command only — it is never inherited by subcommands the way
    // --help is (CLI-1965 review finding).
    const atRoot = legacyRespondToComplete(legacyRoot, ["__complete", "--v"]);
    expect(atRoot?.candidates.map((c) => c.name)).toContain("--version");

    const atSubcommand = legacyRespondToComplete(legacyRoot, ["__complete", "db", "dump", "--v"]);
    expect(atSubcommand?.candidates.map((c) => c.name)).not.toContain("--version");
  });

  it("returns Default (not NoFileComp) when the resolved command doesn't match a real subcommand", () => {
    // Mirrors cobra: the NoFileComp directive is only set INSIDE the
    // `len(finalArgs) == 0` gate, alongside the subcommand loop — a bogus
    // trailing token (which becomes non-empty leftover) must leave the
    // directive at Default, not force NoFileComp just because `db` itself has
    // subcommands (CLI-1965 review finding; verified against a real
    // apps/cli-go build: `__complete db bogus ''` → `:0`).
    const result = legacyRespondToComplete(legacyRoot, ["__complete", "db", "bogus", ""]);
    expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
  });

  describe("help/version short-circuit", () => {
    it("short-circuits to no candidates once --help/-h appears anywhere in the args", () => {
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "branches",
        "--help",
        "li",
      ]);
      expect(result).toEqual({
        candidates: [],
        directive: LegacyCompletionDirective.NoFileComp,
      });
    });

    it("short-circuits on --version/-v only when resolved to the root command", () => {
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "--version", "br"]);
      expect(result).toEqual({
        candidates: [],
        directive: LegacyCompletionDirective.NoFileComp,
      });
    });

    it("does not short-circuit on a subcommand's own local --version flag away from the root", () => {
      // migration/squash/squash.command.ts declares its own `--version`
      // (a target migration version string) — unrelated to cobra's built-in
      // root-only version flag. Typing it while completing a *different*
      // flag on the same command must behave like normal flag-name
      // completion, not trip the root-only help/version short-circuit
      // (CLI-1965 review finding).
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "migration",
        "squash",
        "--version",
        "20240101000000",
        "--l",
      ]);
      expect(result?.candidates.map((c) => c.name)).toContain("--linked");
    });
  });

  describe("required-flag short-circuit", () => {
    it("offers exactly the one required flag and nothing else for a command with a single required flag", () => {
      // domains/create/create.command.ts: `customHostname: Flag.string("custom-hostname")`
      // has no `.pipe(Flag.optional)`/`.pipe(Flag.withDefault(...))`, so it genuinely
      // fails to parse when omitted — `projectRef` is optional and
      // `includeRawOutput` is boolean, so neither is offered alongside it.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "domains", "create", ""]);
      expect(result).toEqual({
        candidates: [
          {
            name: "--custom-hostname",
            description: "The custom hostname to use for your Supabase project.",
          },
        ],
        directive: LegacyCompletionDirective.Default,
      });
    });

    it("short-circuits on a flag Go marks required even though this port made it optional at parse time", () => {
      // vanity-subdomains/activate/activate.command.ts wraps `desiredSubdomain`
      // in `.pipe(Flag.optional)` on purpose (presence is enforced later, in
      // the handler, to let the --experimental gate and login check run
      // first) — but cobra's completion-time required-flag annotation
      // (`MarkFlagRequired`, `cmd/vanitySubdomains.go:67`) is independent of
      // TS's parse-time validation ordering, so completion must still offer
      // exactly this flag, matching real cobra (CLI-1965 review finding:
      // structural inference from `Flag.optional` is not a faithful proxy for
      // "does cobra mark it required" — `LEGACY_COMPLETION_REQUIRED_FLAGS` is
      // the explicit table that fixes this).
      const result = legacyRespondToComplete(legacyRoot, [
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
        directive: LegacyCompletionDirective.Default,
      });
    });

    it("does not treat a zero-minimum variadic flag (Flag.atLeast(0)) as required", () => {
      // sso/add/add.command.ts: `domains: legacySsoAddDomainsFlag` builds on
      // `legacyStringSliceFlag`, which is `Flag.string(...).pipe(..., Flag.atLeast(0))`
      // — a `Variadic` param with `min: 0`. Go never calls
      // `MarkFlagRequired("domains")` (only `type`), so `--domains` must not be
      // force-offered here — only the genuinely required `--type`/`-t` should
      // appear. (Required-ness now comes from the explicit
      // `LEGACY_COMPLETION_REQUIRED_FLAGS` table, not structural inference, but
      // this scenario is worth keeping as its own regression case.)
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "sso", "add", ""]);
      expect(result?.candidates.map((c) => c.name)).not.toContain("--domains");
      expect(result).toEqual({
        candidates: [
          { name: "--type", description: expect.any(String) },
          { name: "-t", description: expect.any(String) },
        ],
        directive: LegacyCompletionDirective.Default,
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
        // sso/add/add.command.ts and sso/update/update.command.ts both declare
        // --metadata-file/--attribute-mapping-file; the Go CLI's cmd/sso.go
        // MarkFlagFilename calls are ported as a small lookup table
        // (LEGACY_COMPLETION_FLAG_FILE_EXTENSIONS) rather than derived generically.
        const result = legacyRespondToComplete(legacyRoot, [
          "__complete",
          "sso",
          command,
          `--${flag}=`,
        ]);
        expect(result).toEqual({
          candidates: [{ name: extension, description: undefined }],
          directive: LegacyCompletionDirective.FilterFileExt,
        });
      },
    );

    it("never completes a choice flag's value (sso add --type <value>)", () => {
      // sso/add/add.command.ts: `type: Flag.choice("type", ["saml"])` has no
      // registered ValidArgsFunction equivalent in Go, so its value slot must
      // resolve to empty candidates + Default, not an enumeration of "saml".
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "sso",
        "add",
        "--type",
        "",
      ]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it("does not treat a boolean flag as consuming a following value", () => {
      // sso/add/add.command.ts: `skipUrlValidation: Flag.boolean("skip-url-validation")`.
      // A boolean flag must fall through to Case 3 (bare noun completion) with the
      // unchanged toComplete/trimmedArgs, so this must equal the bare `sso add ""`
      // response exactly rather than resolve to some flag-value result.
      const withBooleanFlag = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "sso",
        "add",
        "--skip-url-validation",
        "",
      ]);
      const bareNoun = legacyRespondToComplete(legacyRoot, ["__complete", "sso", "add", ""]);
      expect(withBooleanFlag).toEqual(bareNoun);
      expect(withBooleanFlag?.candidates.length).toBeGreaterThan(0);
    });
  });

  describe("changed-flag exclusion and the variadic exception", () => {
    it("excludes an already-supplied, non-repeatable flag's own name from further completion", () => {
      // sso/add/add.command.ts: `metadataUrl: Flag.string("metadata-url")` is not
      // variadic, so once supplied it must not be offered again.
      const result = legacyRespondToComplete(legacyRoot, [
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
      // sso/add/add.command.ts: `domains: legacySsoAddDomainsFlag` is built on
      // `Flag.atLeast(0)` (repeatable) — Go's real doCompleteFlags keeps a
      // Slice/Array-typed flag in the completion list even once `flag.Changed`.
      const result = legacyRespondToComplete(legacyRoot, [
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

  it("returns undefined for zero completion args (mirrors cobra's MinimumNArgs(1) failure)", () => {
    expect(legacyRespondToComplete(legacyRoot, ["__complete"])).toBeUndefined();
  });

  it("returns undefined for non-completion argv", () => {
    expect(legacyRespondToComplete(legacyRoot, ["migration", "list"])).toBeUndefined();
  });
});

describe("legacyResolveCommandPath", () => {
  it("resolves a nested subcommand path with no leftover args", () => {
    const result: LegacyCommandPathResolution = legacyResolveCommandPath(legacyRoot, [
      "branches",
      "list",
    ]);
    expect(result.matchedPath).toEqual(["branches", "list"]);
    expect(result.leftoverArgs).toEqual([]);
    expect(result.commandChain.map((command) => command.name)).toEqual([
      "supabase",
      "branches",
      "list",
    ]);
  });

  it("stops descending at the first unmatched token and treats it and everything after as leftover", () => {
    const result = legacyResolveCommandPath(legacyRoot, ["migration", "bogus", "--x"]);
    expect(result.matchedPath).toEqual(["migration"]);
    expect(result.leftoverArgs).toEqual(["bogus", "--x"]);
  });

  it("skips flag-shaped tokens without stopping descent, and excludes them from leftoverArgs", () => {
    // `--debug` is a boolean global flag — it and every genuinely-consumed
    // flag token are excluded from `leftoverArgs` entirely (not just skipped
    // during subcommand matching), since `leftoverArgs` represents cobra's
    // *positional* `finalArgs`, used to gate subcommand-name completion.
    const result = legacyResolveCommandPath(legacyRoot, ["--debug", "migration", "list"]);
    expect(result.matchedPath).toEqual(["migration", "list"]);
    expect(result.leftoverArgs).toEqual([]);
  });

  it("also excludes a value-taking flag's consumed value token from leftoverArgs", () => {
    // `-o` (the global --output choice flag) is non-boolean, so it consumes
    // "json" as its value — "json" must not be treated as an extra
    // positional token even though it isn't itself flag-shaped.
    const result = legacyResolveCommandPath(legacyRoot, ["-o", "json", "migration", "list"]);
    expect(result.matchedPath).toEqual(["migration", "list"]);
    expect(result.leftoverArgs).toEqual([]);
  });

  it("returns just the root for an empty args list", () => {
    const result = legacyResolveCommandPath(legacyRoot, []);
    expect(result.matchedPath).toEqual([]);
    expect(result.leftoverArgs).toEqual([]);
    expect(result.commandChain.map((command) => command.name)).toEqual(["supabase"]);
  });
});

describe("legacyCollectInScopeFlags", () => {
  it("merges root global flags with the resolved command's own local flags", () => {
    const { commandChain } = legacyResolveCommandPath(legacyRoot, ["branches", "list"]);
    const flags: ReadonlyArray<LegacyFlagDescriptor> = legacyCollectInScopeFlags(
      legacyRoot,
      commandChain,
    );
    const names = flags.map((flag) => flag.name);
    expect(names).toContain("debug"); // root global flag
    expect(names).toContain("project-ref"); // branches list's own local flag

    const debugFlag = flags.find((flag) => flag.name === "debug");
    expect(debugFlag).toEqual({
      name: "debug",
      aliases: [],
      hidden: false,
      description: "Output debug logs to stderr.",
      isVariadic: false,
      isBoolean: true,
      primitiveTag: "Boolean",
      choiceKeys: undefined,
    });
  });

  it("includes an ancestor's shared flags (Command.withSharedFlags)", () => {
    const { commandChain } = legacyResolveCommandPath(legacyRoot, [
      "db",
      "schema",
      "declarative",
      "generate",
    ]);
    const flags = legacyCollectInScopeFlags(legacyRoot, commandChain);
    expect(flags.map((flag) => flag.name)).toContain("no-cache");
  });

  it("includes a non-root command's own declared global flags across the whole chain", () => {
    const { commandChain } = legacyResolveCommandPath(legacyRoot, ["seed", "buckets"]);
    const flags = legacyCollectInScopeFlags(legacyRoot, commandChain);
    expect(flags.map((flag) => flag.name)).toEqual(expect.arrayContaining(["linked", "local"]));
  });

  it("includes --version only when the chain resolves to the root command alone", () => {
    const atRoot = legacyCollectInScopeFlags(
      legacyRoot,
      legacyResolveCommandPath(legacyRoot, []).commandChain,
    );
    expect(atRoot.map((flag) => flag.name)).toContain("version");

    const atSubcommand = legacyCollectInScopeFlags(
      legacyRoot,
      legacyResolveCommandPath(legacyRoot, ["db", "dump"]).commandChain,
    );
    expect(atSubcommand.map((flag) => flag.name)).not.toContain("version");
  });

  it("lets a command's own local flag shadow a same-named global flag (local wins, no duplicate)", () => {
    const { commandChain } = legacyResolveCommandPath(legacyRoot, ["db", "diff"]);
    const flags = legacyCollectInScopeFlags(legacyRoot, commandChain);
    const outputFlags = flags.filter((flag) => flag.name === "output");
    expect(outputFlags).toHaveLength(1);
    expect(outputFlags[0]?.description).toBe("Write explicit diff output to a file path.");
  });
});

describe("legacyClassifyCompletion", () => {
  it("produces the same result legacyRespondToComplete does for the equivalent resolved input", () => {
    const trimmedArgs = ["migration", "li"].slice(0, -1);
    const { commandChain, matchedPath, leftoverArgs } = legacyResolveCommandPath(
      legacyRoot,
      trimmedArgs,
    );
    const inScopeFlags = legacyCollectInScopeFlags(legacyRoot, commandChain);
    const input: LegacyClassifyCompletionInput = {
      finalCommand: commandChain[commandChain.length - 1] ?? legacyRoot,
      matchedPath,
      leftoverArgs,
      trimmedArgs,
      toComplete: "li",
      inScopeFlags,
    };
    const direct = legacyClassifyCompletion(input);
    const viaRespondToComplete = legacyRespondToComplete(legacyRoot, [
      "__complete",
      "migration",
      "li",
    ]);
    expect(direct).toEqual(viaRespondToComplete);
  });
});

describe("legacyResolveIncludeDescriptions", () => {
  it("defaults to true for __complete with no relevant env vars", () => {
    expect(legacyResolveIncludeDescriptions("__complete", {})).toBe(true);
  });

  it("is always false for __completeNoDesc, regardless of env vars", () => {
    expect(legacyResolveIncludeDescriptions("__completeNoDesc", {})).toBe(false);
    expect(
      legacyResolveIncludeDescriptions("__completeNoDesc", {
        SUPABASE_COMPLETION_DESCRIPTIONS: "true",
        COBRA_COMPLETION_DESCRIPTIONS: "true",
      }),
    ).toBe(false);
  });

  it("honors SUPABASE_COMPLETION_DESCRIPTIONS=false for __complete", () => {
    expect(
      legacyResolveIncludeDescriptions("__complete", { SUPABASE_COMPLETION_DESCRIPTIONS: "false" }),
    ).toBe(false);
  });

  it("falls back to the generic COBRA_COMPLETION_DESCRIPTIONS when the program-specific var is unset", () => {
    expect(
      legacyResolveIncludeDescriptions("__complete", { COBRA_COMPLETION_DESCRIPTIONS: "0" }),
    ).toBe(false);
  });

  it("ignores an unparseable value and preserves the argv0-derived default", () => {
    expect(
      legacyResolveIncludeDescriptions("__complete", {
        SUPABASE_COMPLETION_DESCRIPTIONS: "nonsense",
      }),
    ).toBe(true);
  });

  it("prioritizes the program-specific var over the generic one when both are set and conflict", () => {
    expect(
      legacyResolveIncludeDescriptions("__complete", {
        SUPABASE_COMPLETION_DESCRIPTIONS: "true",
        COBRA_COMPLETION_DESCRIPTIONS: "false",
      }),
    ).toBe(true);
  });
});

describe("legacyFormatCompletionResponse", () => {
  it("tab-joins a description when present and prints a bare name otherwise, followed by the directive line", () => {
    const response: LegacyCompletionResult = {
      candidates: [
        { name: "list", description: "List things" },
        { name: "new", description: undefined },
      ],
      directive: LegacyCompletionDirective.NoFileComp,
    };
    expect(legacyFormatCompletionResponse(response, true)).toBe("list\tList things\nnew\n:4\n");
  });

  it("strips descriptions from every candidate when includeDescriptions is false", () => {
    const response: LegacyCompletionResult = {
      candidates: [
        { name: "list", description: "List things" },
        { name: "new", description: undefined },
      ],
      directive: LegacyCompletionDirective.NoFileComp,
    };
    expect(legacyFormatCompletionResponse(response, false)).toBe("list\nnew\n:4\n");
  });

  it("keeps only the first line of a multi-line description", () => {
    const candidate: LegacyCompletionCandidate = {
      name: "flag",
      description: "first line\nsecond line",
    };
    const response: LegacyCompletionResult = {
      candidates: [candidate],
      directive: LegacyCompletionDirective.Default,
    };
    expect(legacyFormatCompletionResponse(response, true)).toBe("flag\tfirst line\n:0\n");
  });

  it("emits just the directive line for zero candidates", () => {
    const response: LegacyCompletionResult = {
      candidates: [],
      directive: LegacyCompletionDirective.Default,
    };
    expect(legacyFormatCompletionResponse(response, true)).toBe(":0\n");
  });
});

describe("legacyTryComplete", () => {
  function makeDeps(overrides: Partial<LegacyCompleteDeps> = {}) {
    const stdoutWrites: Array<string> = [];
    const exits: Array<number> = [];
    const deps: LegacyCompleteDeps = {
      root: legacyRoot,
      argv: ["__complete", "migration", "li"],
      env: {},
      stdoutWrite: (message) => {
        stdoutWrites.push(message);
      },
      exit: (code) => {
        exits.push(code);
      },
      ...overrides,
    };
    return { deps, stdoutWrites, exits };
  }

  it("returns false and does nothing for non-__complete argv", () => {
    const { deps, stdoutWrites, exits } = makeDeps({ argv: ["migration", "list"] });
    expect(legacyTryComplete(deps)).toBe(false);
    expect(stdoutWrites).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("writes the formatted response to stdout and exits 0 for a real completion request", () => {
    const { deps, stdoutWrites, exits } = makeDeps();
    expect(legacyTryComplete(deps)).toBe(true);
    expect(stdoutWrites).toHaveLength(1);
    expect(stdoutWrites[0]).toContain("list\t");
    expect(stdoutWrites[0]).toMatch(/:4\n$/);
    expect(exits).toEqual([0]);
  });

  it("respects __completeNoDesc by stripping descriptions from the written response", () => {
    const { deps, stdoutWrites } = makeDeps({ argv: ["__completeNoDesc", "migration", "li"] });
    legacyTryComplete(deps);
    expect(stdoutWrites[0]).toBe("list\n:4\n");
  });

  it("exits 1 and does not write anything to stdout for zero completion args", () => {
    const { deps, stdoutWrites, exits } = makeDeps({ argv: ["__complete"] });
    expect(legacyTryComplete(deps)).toBe(true);
    expect(stdoutWrites).toEqual([]);
    expect(exits).toEqual([1]);
  });
});

describe("legacyDefaultCompleteDeps", () => {
  it("wires argv/env from the real process and delegates stdoutWrite/exit to process.stdout.write/process.exit", () => {
    const originalArgv = process.argv;
    process.argv = [...originalArgv.slice(0, 2), "__complete", "migration", "li"];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    try {
      const deps = legacyDefaultCompleteDeps(legacyRoot);
      expect(deps.root).toBe(legacyRoot);
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
