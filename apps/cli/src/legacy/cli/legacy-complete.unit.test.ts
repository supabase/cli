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
    // Command.withGlobalFlags on the `seed` group itself, not at legacyRoot
    // — a collector that only reads root.globalFlags misses these entirely.
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
    expect(outputCandidates?.[0]?.description).toBe(
      "Write flattened explicit diff SQL to a file for review; this is not a portable apply script.",
    );
  });

  describe("subcommand completion is not blocked by a preceding global flag", () => {
    it("lists root subcommands after a bare global flag with no value", () => {
      // `--debug ""` used to return zero candidates entirely: the leftover-args
      // computation counted `--debug` itself as "positional leftover," gating
      // out subcommand-name completion the way cobra never does for a
      // persistent flag: `__complete --debug ''` lists all root commands.
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
    // --help is.
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
    // subcommands: `__complete db bogus ''` → `:0`.
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
      // completion, not trip the root-only help/version short-circuit.
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

    it("does not short-circuit on --help positioned after a genuine `--` terminator (it is positional, not a flag)", () => {
      // A raw token scan for the literal string "--help" over-triggers once
      // `--help` appears anywhere, even past an unconsumed `--` sentinel,
      // where pflag never parses it as a flag at all: `db dump -- --help ""`
      // returns zero candidates with the DEFAULT directive — `db dump`'s own
      // file completion — not the help short-circuit's NoFileComp.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "db",
        "dump",
        "--",
        "--help",
        "",
      ]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it("does not short-circuit on --version consumed as a PRECEDING flag's own string value", () => {
      // `--workdir` is a value-taking global flag; pflag consumes the very
      // next token as its value regardless of what that token looks like,
      // so `--version` here is `--workdir`'s value, never parsed as a flag
      // occurrence: `--workdir --version br` still completes `branches`,
      // not the version short-circuit.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "--workdir",
        "--version",
        "br",
      ]);
      expect(result?.candidates.map((c) => c.name)).toContain("branches");
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
    });
  });

  describe("unmatched root-level command (CLI-1965 review)", () => {
    it("returns Default with zero candidates for a flag typed after an unmatched ROOT-level positional", () => {
      // Mirrors cobra's Command.Find -> legacyArgs (args.go:28-37): resolving
      // to root itself (no descent at all) with a leftover positional is an
      // "unknown command" error there, wins even over the --help/--version
      // short-circuit, and is stricter than the same situation under any
      // OTHER resolved command: `nosuch --d` and `nosuch --help` both return
      // zero candidates with the Default directive, while `db bogus --d` —
      // `db` itself resolves — still offers `db`'s own --debug/--dns-resolver
      // normally.
      const unknownRoot = legacyRespondToComplete(legacyRoot, ["__complete", "nosuch", "--d"]);
      expect(unknownRoot).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });

      const unknownRootWithHelp = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "nosuch",
        "--help",
      ]);
      expect(unknownRootWithHelp).toEqual({
        candidates: [],
        directive: LegacyCompletionDirective.Default,
      });

      const knownCommandWithLeftover = legacyRespondToComplete(legacyRoot, [
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
      // cobra's own stripFlags (command.go:674-710) — which legacyArgs' error
      // check runs against — drops a lone `-` from its leftover count
      // entirely, unlike legacyResolveCommandPath's own leftoverArgs (which
      // deliberately keeps it for other purposes): `__complete - --d` still
      // offers root's own --debug/--dns-resolver.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "-", "--d"]);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["--debug", "--dns-resolver"]),
      );
    });

    it("does not apply the unmatched-root check to a genuine `help ...` request", () => {
      // `help` is not a real node in this tree (see
      // legacyHelpArgumentCandidates's doc comment), so the outer resolution
      // always sees it as an immediate non-match at root — this must not be
      // mistaken for cobra's real "unknown command" error, which never fires
      // for `help` since real cobra's help command IS a real child of root.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "help", "db", "d"]);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["diff", "dump"]),
      );
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
      // exactly this flag, matching real cobra: structural inference from
      // `Flag.optional` is not a faithful proxy for "does cobra mark it
      // required" — `LEGACY_COMPLETION_REQUIRED_FLAGS` is the explicit table
      // that fixes this.
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
        // --metadata-file/--attribute-mapping-file; cobra's MarkFlagFilename
        // calls for these are captured as a small lookup table
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
      // `Flag.atLeast(0)` (repeatable) — cobra's real doCompleteFlags keeps a
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

  describe("flag terminator (`--`) disables flag completion (CLI-1965 review)", () => {
    it("does not offer a flag-name candidate for a positional operand after `--`", () => {
      // Cobra's flagCompletion gate goes false once a `--` is already present
      // in the args (completions.go:364-381), so a positional operand that
      // happens to start with `-` after the terminator must not be treated as
      // a flag-name completion: `db dump -- --s` returns zero candidates with
      // the Default directive, not `--schema`.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "db", "dump", "--", "--s"]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it("still offers a required flag that appears (as a positional) after `--`", () => {
      // completeRequireFlags is called unconditionally in cobra's noun-
      // completion branch, even past the terminator — and a token past `--`
      // is never parsed as a flag at all, so it must not be marked "changed"
      // either: `sso add -- --type --typ` still offers `--type` with the
      // Default directive.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "sso",
        "add",
        "--",
        "--type",
        "--typ",
      ]);
      expect(result).toEqual({
        candidates: [{ name: "--type", description: expect.any(String) }],
        directive: LegacyCompletionDirective.Default,
      });
    });
  });

  describe("attached shorthand values resolve via pflag's real strict parser (CLI-1965 review)", () => {
    it("parses a non-boolean shorthand's attached value instead of treating the token as unknown", () => {
      // pflag's parseSingleShortArg resolves a shorthand cluster's value by
      // its FIRST character, not its last — `-j4` is a fully valid,
      // already-resolved `--jobs=4`, so it must not suppress completion of a
      // later flag name: `functions deploy -j4 --p` still offers
      // --profile/--project-ref/--prune.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "functions",
        "deploy",
        "-j4",
        "--p",
      ]);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["--profile", "--project-ref", "--prune"]),
      );
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
    });
  });

  describe("a trailing incomplete flag is a hard parse error only when toComplete is itself flag-shaped (CLI-1965 review)", () => {
    it("rejects a dangling value-taking flag when toComplete is a bare flag-shaped token", () => {
      // Cobra's checkIfFlagCompletion only rescues a trailing incomplete flag
      // from ParseFlags() when toComplete is empty or not flag-shaped
      // (completions.go:666-687); `-o --d` leaves `-o` dangling with no
      // rescue, so the real ParseFlags() call fails outright: zero
      // candidates with the Default directive — the error is "flag needs an
      // argument: 'o' in -o".
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "-o", "--d"]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it.each([
      { toComplete: "", label: "empty toComplete" },
      { toComplete: "pre", label: "non-flag-shaped toComplete" },
    ])(
      "still falls through to flag-VALUE completion for the same dangling flag given $label",
      ({ toComplete }) => {
        const result = legacyRespondToComplete(legacyRoot, ["__complete", "-o", toComplete]);
        expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
      },
    );

    it("rejects a dangling value-taking flag even when toComplete is a DIFFERENT flag's attached-value token", () => {
      // A `toComplete` containing `=` still identifies its OWN flag name
      // (checkIfFlagCompletion's flagWithEqual branch) — that never rescues
      // an earlier, different dangling flag out of finalArgs, so
      // ParseFlags() still fails on it: `sso add --type saml --metadata-file
      // --attribute-mapping-file=` returns zero candidates with the Default
      // directive — the error is "flag needs an argument: --metadata-file"
      // — even though `--attribute-mapping-file` is itself a real flag with
      // a registered file-extension completion.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "sso",
        "add",
        "--type",
        "saml",
        "--metadata-file",
        "--attribute-mapping-file=",
      ]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });
  });

  describe("changed-flag tracking honors a long flag's real value consumption (CLI-1965 review)", () => {
    it("does not mark a value token as its own changed flag, so a still-required flag stays offered", () => {
      // pflag's parseLongArg consumes the immediately following token as a
      // non-boolean flag's value regardless of its shape — `--domains` (a
      // string flag) consumes `--type` here, so `--type` itself was never
      // parsed as a flag and must still be offered as required: `sso add
      // --domains --type foo --typ` still offers `--type` with the
      // NoFileComp directive.
      const result = legacyRespondToComplete(legacyRoot, [
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
        directive: LegacyCompletionDirective.NoFileComp,
      });
    });
  });

  describe("a boolean flag with an explicit `=` is still flag-VALUE completion (CLI-1965 review)", () => {
    it("does not fall through to noun completion for `--boolFlag=value`", () => {
      // Cobra's checkIfFlagCompletion only resets a boolean flag back to noun
      // completion in the no-`=` two-token case (`!flagWithEqual` guard);
      // `--debug=maybe` keeps `flag` set and goes to flag-VALUE completion,
      // which resolves to zero candidates: the Default directive, not the
      // root command list.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "--debug=maybe"]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });
  });

  describe("completion script leaves force NoFileComp (CLI-1965 review)", () => {
    it.each(["bash", "zsh", "fish", "powershell"])(
      "returns zero candidates with the NoFileComp directive for `completion %s`",
      (shell) => {
        // Cobra's InitDefaultCompletionCmd registers ValidArgsFunction:
        // NoFileCompletions on the completion group and each of its shell
        // leaves; getCompletions always calls a resolved command's own
        // ValidArgsFunction, overwriting the directive outright.
        const result = legacyRespondToComplete(legacyRoot, ["__complete", "completion", shell, ""]);
        expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.NoFileComp });
      },
    );
  });

  describe("help's own ValidArgsFunction resolves a second command path from root (CLI-1965 review)", () => {
    it("completes root subcommand names after `help`", () => {
      // Cobra's auto-registered help command has its own ValidArgsFunction
      // (command.go:1274-1290) that re-resolves everything after `help` from
      // root — `help d` completes as if `d` were being completed at the
      // root itself, not as an argument to `help`: `db`, `domains`.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "help", "d"]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["db", "domains"]),
      );
    });

    it("completes a resolved subcommand's own children after `help <command>`", () => {
      // `help db d` completes as `db d` would — db's own subcommands, not
      // help's: `diff`, `dump`.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "help", "db", "d"]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["diff", "dump"]),
      );
    });

    it("returns no candidates for a leaf command with no subcommands of its own", () => {
      // `db dump` is a leaf; cobra's ValidArgsFunction loops over its empty
      // Commands() and finds nothing, but still sets NoFileComp.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "help", "db", "dump", "s"]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.NoFileComp });
    });

    it("returns no candidates for an unresolved token directly under root", () => {
      // Cobra's legacyArgs validator (args.go:28-37) only errors the
      // "unknown command" case when the resolved command IS root and a
      // token is left over: `help bogus d` -> zero candidates.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "help", "bogus", "d"]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.NoFileComp });
    });

    it("still lists a resolved non-root command's subcommands past an unresolved token", () => {
      // The same legacyArgs validator never errors for a non-root resolved
      // command, even with leftover args — subcommands "will always accept
      // arbitrary arguments": `help db bogus d` still offers db's own
      // subcommands.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "help",
        "db",
        "bogus",
        "d",
      ]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["diff", "dump"]),
      );
    });

    it("includes the synthetic `help` candidate itself when resolved back to root", () => {
      // Cobra's help command is one of root's own Commands(), so completing
      // help's arguments back at root re-lists help too: `help h` -> `help`.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "help", "h"]);
      expect(result).toEqual({
        candidates: [{ name: "help", description: "Help about any command" }],
        directive: LegacyCompletionDirective.NoFileComp,
      });
    });
  });

  describe("uint-backed flags reject a leading sign like real pflag's ParseUint (CLI-1965 review)", () => {
    it.each([
      { path: ["functions", "deploy"], flag: "jobs" },
      { path: ["migration", "down"], flag: "last" },
      { path: ["db", "reset"], flag: "last" },
    ])("rejects a negative value for $path --$flag", ({ path, flag }) => {
      // These flags are validated as strconv.ParseUint(s, 0, 64) values,
      // which reject any sign prefix outright — unlike this tree's plain
      // signed Flag.integer, whose generic regex accepts one: zero
      // candidates with the Default directive for all three.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        ...path,
        `--${flag}`,
        "-1",
        "",
      ]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it("still accepts a valid uint value, including the zero boundary", () => {
      // Regression guard: the stricter check must not reject what real pflag
      // accepts: `db reset --last 0 --d` still offers
      // --debug/--dns-resolver/--db-url.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "db",
        "reset",
        "--last",
        "0",
        "--d",
      ]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["--debug", "--dns-resolver", "--db-url"]),
      );
    });
  });

  describe("--output's choice values are validated per-command, not the widened global union (CLI-1965 review)", () => {
    it("rejects db query's own local values (table/csv) everywhere else", () => {
      // The global LegacyOutputFlag's choiceKeys is the UNION of root's
      // 5-value enum and db query's own 3-value enum (legacy-go-output-
      // flag.ts), but the root persistent --output only accepts
      // env|pretty|json|toml|yaml: `--output table ""` -> zero candidates
      // with the Default directive.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "--output", "table", ""]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it("rejects the resource-command values (env/pretty/toml/yaml) under db query", () => {
      // The reverse direction of the same defect: db query's own enum is
      // json|table|csv only: `db query --output env ""` -> zero candidates
      // with the Default directive, even though `env` is valid everywhere
      // else.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "db",
        "query",
        "--output",
        "env",
        "",
      ]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it("accepts db query's own values (table/csv) under db query", () => {
      const result = legacyRespondToComplete(legacyRoot, [
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
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "--output", "env", ""]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("branches");
    });

    it("still accepts json everywhere — the one value both Go enums share", () => {
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "--output", "json", ""]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("branches");
    });
  });

  describe("flag values are validated the way real pflag parses them (CLI-1965 review)", () => {
    it("accepts a base-0 hex value for a plain (non-uint) integer flag", () => {
      // Plain int64 flags are validated as strconv.ParseInt(s, 0, 64) — base
      // 0, so a `0x`-prefixed value is valid, unlike a decimal-only regex:
      // `backups restore --timestamp 0x10 --p` still offers
      // --profile/--project-ref.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "backups",
        "restore",
        "--timestamp",
        "0x10",
        "--p",
      ]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["--profile", "--project-ref"]),
      );
    });

    it("rejects a value one past int64 max for a plain (non-uint) integer flag", () => {
      // Plain int64 flags are validated as strconv.ParseInt(s, 0, 64), a
      // NARROWER signed range than the uint64 bound `Flag.integer` alone
      // would suggest — 9223372036854775808 is a syntactically valid uint64
      // but exceeds int64 max by one: `backups restore --timestamp
      // 9223372036854775808 --p` returns zero candidates with the Default
      // directive, while int64's real bounds, 9223372036854775807 and
      // -9223372036854775808, both still offer --profile/--project-ref.
      const overflow = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "backups",
        "restore",
        "--timestamp",
        "9223372036854775808",
        "--p",
      ]);
      expect(overflow).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });

      const max = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "backups",
        "restore",
        "--timestamp",
        "9223372036854775807",
        "--p",
      ]);
      expect(max?.candidates.map((c) => c.name)).toContain("--profile");

      const min = legacyRespondToComplete(legacyRoot, [
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
      // Both are declared Flag.string in TS but validated as DurationVar
      // values (cmd/gen.go:161,179), parsed via time.ParseDuration before
      // Cobra generates completions: both `bogus` values return zero
      // candidates with the Default directive, while `5s`/`1h` still
      // complete normally.
      const queryTimeout = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "gen",
        "types",
        "--query-timeout",
        "bogus",
        "--l",
      ]);
      expect(queryTimeout).toEqual({
        candidates: [],
        directive: LegacyCompletionDirective.Default,
      });

      const queryTimeoutValid = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "gen",
        "types",
        "--query-timeout",
        "5s",
        "--l",
      ]);
      expect(queryTimeoutValid?.candidates.map((c) => c.name)).toContain("--local");

      const validFor = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--valid-for",
        "bogus",
        "--p",
      ]);
      expect(validFor).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });

      const validForValid = legacyRespondToComplete(legacyRoot, [
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
      // DurationVar values parse via time.ParseDuration, which accumulates
      // into an int64 nanosecond count — a syntactically well-formed
      // duration can still overflow that range: `gen types --query-timeout
      // 2562048h --l` — one hour past the real max — returns zero
      // candidates with the Default directive, matching `bogus`, while the
      // exact int64 max, `2562047h47m16.854775807s`, still completes
      // normally.
      const overflow = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "gen",
        "types",
        "--query-timeout",
        "2562048h",
        "--l",
      ]);
      expect(overflow).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });

      const max = legacyRespondToComplete(legacyRoot, [
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
      // Declared Flag.string in TS but validated as a TimeVar constrained
      // to time.RFC3339 (cmd/gen.go:178): `bogus` returns zero candidates
      // with the Default directive, while a real RFC3339 timestamp still
      // completes normally.
      const invalid = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "gen",
        "bearer-jwt",
        "--role",
        "anon",
        "--exp",
        "bogus",
        "--p",
      ]);
      expect(invalid).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });

      const valid = legacyRespondToComplete(legacyRoot, [
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
      // time.Parse(time.RFC3339, s) independently caps the offset hour
      // at 24 (not 23) and the offset minute at 60 (not 59): "+24:00" and
      // "+00:60" parse successfully, while "+25:00" and "+00:61" both fail
      // with "time zone offset hour/minute out of range".
      const outOfRangeHour = legacyRespondToComplete(legacyRoot, [
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
        directive: LegacyCompletionDirective.Default,
      });

      const outOfRangeMinute = legacyRespondToComplete(legacyRoot, [
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
        directive: LegacyCompletionDirective.Default,
      });

      const boundaryValid = legacyRespondToComplete(legacyRoot, [
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
      // time.Parse(time.RFC3339, s) accepts either `.` or `,` before the
      // fractional-seconds digits: "2024-01-02T15:04:05,5Z" parses
      // identically to "...05.5Z"; a bare "," with no following digit, or
      // mixing both separators in one timestamp, both still fail.
      const commaFraction = legacyRespondToComplete(legacyRoot, [
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

      const emptyCommaFraction = legacyRespondToComplete(legacyRoot, [
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
        directive: LegacyCompletionDirective.Default,
      });

      const mixedSeparators = legacyRespondToComplete(legacyRoot, [
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
        directive: LegacyCompletionDirective.Default,
      });
    });

    it("rejects a negative value for storage cp --jobs even though it's a string-typed flag in TS", () => {
      // --jobs is validated as a UintVarP value (cmd/storage.go:107), the
      // same as functions deploy/migration down/db reset above — but
      // storage cp models it as Flag.string in TS, so the uint override
      // must be consulted regardless of primitiveTag: `storage cp --jobs
      // -1 --r` returns zero candidates with the Default directive, not
      // --recursive.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "storage",
        "cp",
        "--jobs",
        "-1",
        "--r",
      ]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it("rejects malformed CSV for a StringSliceVar-backed flag", () => {
      // --domains is validated as a StringSliceVarP value (cmd/sso.go:158),
      // CSV-split via encoding/csv at parse time; an unterminated quote
      // fails that parse: `sso add --domains 'a,"b' --type` returns zero
      // candidates with the Default directive, not --type.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "sso",
        "add",
        "--domains",
        'a,"b',
        "--type",
      ]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it("still accepts well-formed CSV (a quoted comma) for the same flag", () => {
      const result = legacyRespondToComplete(legacyRoot, [
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
      // Go registers --sql-paths as a plain StringArrayVar (cmd/db.go:714) —
      // no CSV parsing — unlike every other variadic string flag in this
      // tree, so a value containing an unbalanced quote must still be
      // accepted.
      const result = legacyRespondToComplete(legacyRoot, [
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
      // pflag treats `-f=value` as an explicit value for a boolean shorthand
      // too (pflag@v1.0.10/flag.go:1005-1033) — an owning flag being boolean
      // does not, on its own, mean there is nothing to validate: `storage
      // cp -r=maybe --j` returns zero candidates with the Default
      // directive, not --jobs.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "storage",
        "cp",
        "-r=maybe",
        "--j",
      ]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it("still accepts a valid boolean value attached the same way", () => {
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "storage",
        "cp",
        "-r=true",
        "--j",
      ]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("--jobs");
    });
  });

  describe("the built-in help/version flags short-circuit on Changed, not on exact token spelling (CLI-1965 review)", () => {
    it.each(["--help=false", "--help=true", "-h=false"])(
      "treats %s the same as a bare --help",
      (token) => {
        // pflag's boolValue.Set marks the flag Changed on either spelling,
        // and cobra's helpOrVersionFlagPresent checks .Changed, not the
        // parsed value (completions.go:530-537): `--help=false --d` and
        // `--help=true --d` both return zero candidates with the
        // NoFileComp directive.
        const result = legacyRespondToComplete(legacyRoot, ["__complete", token, "--d"]);
        expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.NoFileComp });
      },
    );

    it("treats --version=false the same as a bare --version, at the root", () => {
      // `--version=false br` returns zero candidates with the NoFileComp
      // directive, not `branches`.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "--version=false", "br"]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.NoFileComp });
    });

    it("does not treat --help=maybe as Changed — an invalid boolean value is an unresolved-flag parse error instead", () => {
      // An invalid value fails pflag's own Set() before Changed is ever
      // examined, so this is Case 0 (Default), not the help short-circuit
      // (NoFileComp).
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "--help=maybe", "--d"]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });
  });

  describe("a `--` consumed as a preceding flag's value is not a genuine terminator (CLI-1965 review)", () => {
    it("still offers a flag name after `--` was consumed as a value-taking flag's own value", () => {
      // pflag's parseLongArg consumes the very next token unconditionally as
      // a non-boolean flag's value — including a literal `--` — so it never
      // reaches pflag's own end-of-flags sentinel check (pflag@v1.0.10/
      // flag.go:949-952): `db dump --file -- --s` still offers --schema,
      // not zero candidates.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "db",
        "dump",
        "--file",
        "--",
        "--s",
      ]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("--schema");
    });

    it("still disables flag completion for a genuine, unconsumed `--` sentinel", () => {
      // Regression guard: only a `--` that isn't claimed as a preceding
      // flag's value is a real terminator: `db dump -- --s` returns zero
      // candidates with the Default directive.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "db", "dump", "--", "--s"]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });
  });

  describe("a bare `-` is a positional argument, not a flag (CLI-1965 review)", () => {
    it("keeps the subcommand-listing gate closed when a bare `-` survives as leftover", () => {
      // pflag's isFlagArg requires at least 2 characters, so a bare `-` is
      // never flag-shaped — but it also never removes itself from cobra's
      // leftover finalArgs the way a matched command name does, so it keeps
      // the `len(finalArgs) == 0` subcommand-listing gate closed: `sso -
      // --debug a` returns zero candidates with the Default directive, not
      // `add`.
      const result = legacyRespondToComplete(legacyRoot, [
        "__complete",
        "sso",
        "-",
        "--debug",
        "a",
      ]);
      expect(result).toEqual({ candidates: [], directive: LegacyCompletionDirective.Default });
    });

    it("still lets the descent continue past a bare `-` to a real subcommand match", () => {
      // Regression guard: a bare `-` must not stop the descent the way an
      // unmatched real token does: `db - dump --da` still offers
      // --data-only.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "db", "-", "dump", "--da"]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toContain("--data-only");
    });

    it("still resolves help's own second command-path lookup past a bare `-`", () => {
      // The Case-2 "preceding token is flag-shaped" check must also exclude
      // a bare `-`, or it hard-stops before ever reaching help's dispatch:
      // `help db - d` still lists db's own subcommands diff/dump.
      const result = legacyRespondToComplete(legacyRoot, ["__complete", "help", "db", "-", "d"]);
      expect(result?.directive).toBe(LegacyCompletionDirective.NoFileComp);
      expect(result?.candidates.map((c) => c.name)).toEqual(
        expect.arrayContaining(["diff", "dump"]),
      );
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
      description: "output debug logs to stderr",
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
    expect(outputFlags[0]?.description).toBe(
      "Write flattened explicit diff SQL to a file for review; this is not a portable apply script.",
    );
  });

  it("orders flags like cobra's InheritedFlags().VisitAll then NonInheritedFlags().VisitAll — alphabetical within each block, not declaration order (CLI-1965 review)", () => {
    // pflag's VisitAll sorts by canonical (long) flag name; cobra's
    // completion path walks the inherited (ancestor) set first, then the
    // resolved command's own set — TWO separately-sorted runs, not one
    // merged alphabetical list: `db dump -` lists --agent, --create-ticket,
    // --debug, ... alphabetically, THEN a second alphabetical run starting
    // --data-only, --db-url, --dry-run, ....
    const { commandChain } = legacyResolveCommandPath(legacyRoot, ["db", "dump"]);
    const names = legacyCollectInScopeFlags(legacyRoot, commandChain).map((flag) => flag.name);

    const inheritedEnd = names.indexOf("yes"); // last inherited flag, alphabetically
    const ownStart = names.indexOf("data-only"); // first own/local flag, alphabetically
    expect(inheritedEnd).toBeGreaterThanOrEqual(0);
    expect(ownStart).toBeGreaterThan(inheritedEnd);

    const inheritedBlock = names.slice(0, ownStart);
    const ownBlock = names.slice(ownStart);
    expect(inheritedBlock).toEqual([...inheritedBlock].sort((a, b) => a.localeCompare(b)));
    expect(ownBlock).toEqual([...ownBlock].sort((a, b) => a.localeCompare(b)));
    // --help is db dump's own NonInherited flag (every command registers its
    // own), not part of the shared inherited block.
    expect(inheritedBlock).not.toContain("help");
    expect(ownBlock).toContain("help");
  });

  it("orders root's own flags alphabetically end-to-end (InheritedFlags() is empty at root)", () => {
    const atRoot = legacyCollectInScopeFlags(
      legacyRoot,
      legacyResolveCommandPath(legacyRoot, []).commandChain,
    );
    // `output-format` is TS-only surface with no Go equivalent, so it isn't
    // asserted here — every OTHER root flag name must still come out sorted.
    const names = atRoot.map((flag) => flag.name).filter((name) => name !== "output-format");
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
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
      // A no-op here keeps this suite's own focus (candidate-computation
      // wiring, not telemetry) pure and synchronous-fast — the real
      // production capture (`legacyCaptureCompleteTelemetryEffect`,
      // `legacyDefaultCompleteDeps`'s own default) is covered separately in
      // `legacy-complete.integration.test.ts`.
      captureTelemetry: async () => {},
      ...overrides,
    };
    return { deps, stdoutWrites, exits };
  }

  // `legacyTryComplete` returns `Promise<boolean>` — it awaits
  // `deps.captureTelemetry` before calling `deps.exit`.
  it("returns false and does nothing for non-__complete argv", async () => {
    const { deps, stdoutWrites, exits } = makeDeps({ argv: ["migration", "list"] });
    expect(await legacyTryComplete(deps)).toBe(false);
    expect(stdoutWrites).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("writes the formatted response to stdout and exits 0 for a real completion request", async () => {
    const { deps, stdoutWrites, exits } = makeDeps();
    expect(await legacyTryComplete(deps)).toBe(true);
    expect(stdoutWrites).toHaveLength(1);
    expect(stdoutWrites[0]).toContain("list\t");
    expect(stdoutWrites[0]).toMatch(/:4\n$/);
    expect(exits).toEqual([0]);
  });

  it("respects __completeNoDesc by stripping descriptions from the written response", async () => {
    const { deps, stdoutWrites } = makeDeps({ argv: ["__completeNoDesc", "migration", "li"] });
    await legacyTryComplete(deps);
    expect(stdoutWrites[0]).toBe("list\n:4\n");
  });

  it("exits 1 and does not write anything to stdout for zero completion args", async () => {
    const { deps, stdoutWrites, exits } = makeDeps({ argv: ["__complete"] });
    expect(await legacyTryComplete(deps)).toBe(true);
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
