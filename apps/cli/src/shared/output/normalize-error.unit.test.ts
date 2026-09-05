import { describe, expect, test } from "vitest";
import { Cause } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import { CliConfigParseError, CliProjectEnvParseError } from "@supabase/config";
import { legacyBranchesCommand } from "../../legacy/commands/branches/branches.command.ts";
import { legacyNetworkRestrictionsCommand } from "../../legacy/commands/network-restrictions/network-restrictions.command.ts";
import { CliProjectHomeNotDirectoryError } from "../config/cli-project-home.service.ts";
import { formatCliError, normalizeCause, normalizeCliError } from "./normalize-error.ts";

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyBranchesCommand, legacyNetworkRestrictionsCommand]),
);

describe("normalizeCliError", () => {
  test("falls back to tagged error fields when no explicit mapping exists", () => {
    const error = {
      _tag: "ExampleError",
      detail: "Something went wrong",
      suggestion: "Try again",
    };

    expect(normalizeCliError(error)).toEqual({
      code: "ExampleError",
      message: "Something went wrong",
      suggestion: "Try again",
    });
  });

  // Pinning tests for CLI-2235: `@supabase/config`'s tagged errors carry no
  // `message`/`detail` field, so `normalizeCliError`'s generic fallback
  // surfaces the bare `_tag` verbatim as both the JSON `code` and the
  // displayed `message` — this is the exact string a script matching on
  // `--output-format json` error output, or a user reading stderr, sees. A
  // future rename of these tags (as happened with the
  // ProjectConfigParseError -> CliConfigParseError rename) must fail a test,
  // not sail through silently.
  test("CliConfigParseError falls back to its bare tag as both code and message", () => {
    const error = new CliConfigParseError({
      path: "supabase/config.toml",
      format: "toml",
      cause: new Error("unexpected token"),
    });

    expect(normalizeCliError(error)).toEqual({
      code: "CliConfigParseError",
      message: "CliConfigParseError",
    });
  });

  test("CliProjectEnvParseError falls back to its bare tag as both code and message", () => {
    const error = new CliProjectEnvParseError({
      path: "supabase/.env.local",
      line: 3,
    });

    expect(normalizeCliError(error)).toEqual({
      code: "CliProjectEnvParseError",
      message: "CliProjectEnvParseError",
    });
  });

  test("CliProjectHomeNotDirectoryError surfaces its tag as code with its own message", () => {
    const error = new CliProjectHomeNotDirectoryError({
      message: ".supabase could not be created: a file exists at that path",
    });

    expect(normalizeCliError(error)).toEqual({
      code: "CliProjectHomeNotDirectoryError",
      message: ".supabase could not be created: a file exists at that path",
    });
  });

  test("MissingOption renders Go Cobra's `required flag(s) X not set` wording", () => {
    const error = { _tag: "MissingOption", option: "type" };
    expect(normalizeCliError(error)).toEqual({
      code: "MissingOption",
      message: `Error: required flag(s) "type" not set`,
    });
  });

  test("MissingOption with missing `option` field falls back to bare wording", () => {
    const error = { _tag: "MissingOption" };
    expect(normalizeCliError(error)).toEqual({
      code: "MissingOption",
      message: "Error: required flag(s) not set",
    });
  });

  test("InvalidValue collapses the doubled 'Expected: Expected' prefix (e.g. a bad GlobalFlag.setting value)", () => {
    // Regression test for CLI-1898: `--output-format`/`--dns-resolver`/`--agent`/
    // legacy `--output` are `GlobalFlag.setting` flags backed by `Flag.choice`.
    // `Command.runWith` validates their values in a step that runs outside the
    // `ShowHelp` path, so a bad value never reaches `CliOutput.Formatter` (and
    // `subcommand-flag-suggestions.ts`'s fix) — it surfaces here instead.
    const error = new CliError.InvalidValue({
      option: "output-format",
      value: "bogus",
      expected: 'Expected "text" | "json" | "stream-json", got "bogus"',
      kind: "flag",
    });

    expect(normalizeCliError(error)).toEqual({
      code: "InvalidValue",
      message:
        'Invalid value for flag --output-format: "bogus". Expected "text" | "json" | "stream-json", got "bogus"',
    });
  });

  test("InvalidValue preserves an empty invalid value (e.g. `--output-format ''`)", () => {
    // Regression test for a Codex review finding on CLI-1898: `value` is raw
    // user input read straight off argv, so `''` is a legitimate way to
    // trigger this failure. Reading it through the trim-and-reject-empty
    // `readString` helper would fail the guard and leak the original
    // doubled "Expected: Expected" message instead of fixing it.
    const error = new CliError.InvalidValue({
      option: "output-format",
      value: "",
      expected: 'Expected "text" | "json" | "stream-json", got ""',
      kind: "flag",
    });

    expect(normalizeCliError(error)).toEqual({
      code: "InvalidValue",
      message:
        'Invalid value for flag --output-format: "". Expected "text" | "json" | "stream-json", got ""',
    });
  });

  test("InvalidValue preserves surrounding whitespace in the invalid value (e.g. `--output-format ' json'`)", () => {
    // Regression test for the same Codex finding: trimming `value` would
    // report a different string than what the user actually typed.
    const error = new CliError.InvalidValue({
      option: "output-format",
      value: " json",
      expected: 'Expected "text" | "json" | "stream-json", got " json"',
      kind: "flag",
    });

    expect(normalizeCliError(error)).toEqual({
      code: "InvalidValue",
      message:
        'Invalid value for flag --output-format: " json". Expected "text" | "json" | "stream-json", got " json"',
    });
  });

  test("InvalidValue passes a complete pflag-format diagnostic through verbatim (Go stderr parity, CLI-1983)", () => {
    // Legacy flags that byte-match Go pflag's parse-time diagnostics
    // (`legacyStringSliceFlag`'s malformed-CSV failure, `migration down
    // --last`) emit the COMPLETE Go message as `expected`. Wrapping it in
    // Effect's `Invalid value for flag ...: Expected: ...` template would
    // double-frame it — Go prints the bare pflag line.
    const pflagMessage =
      'invalid argument "\\"1.2.3.4" for "--db-unban-ip" flag: parse error on line 1, column 9: extraneous or missing " in quoted-field';
    const error = new CliError.InvalidValue({
      option: "db-unban-ip",
      value: '"1.2.3.4',
      expected: pflagMessage,
      kind: "flag",
    });

    expect(normalizeCliError(error)).toEqual({
      code: "InvalidValue",
      message: pflagMessage,
    });
  });

  test("ShowHelp envelope unwraps a single InvalidValue carrying a pflag-format diagnostic verbatim", () => {
    const pflagMessage =
      'invalid argument "\\"1.2.3.0/24" for "--db-allow-cidr" flag: parse error on line 1, column 12: extraneous or missing " in quoted-field';
    const error = {
      _tag: "ShowHelp",
      commandPath: ["network-restrictions", "update"],
      errors: [
        new CliError.InvalidValue({
          option: "db-allow-cidr",
          value: '"1.2.3.0/24',
          expected: pflagMessage,
          kind: "flag",
        }),
      ],
    };

    expect(normalizeCliError(error)).toEqual({
      code: "InvalidValue",
      message: pflagMessage,
    });
  });

  test("InvalidValue leaves an already-clean 'expected' message untouched", () => {
    const error = new CliError.InvalidValue({
      option: "define",
      value: "bogus",
      expected: "Invalid key=value format. Expected format: key=value, got: bogus",
      kind: "flag",
    });

    expect(normalizeCliError(error)).toEqual({
      code: "InvalidValue",
      message:
        'Invalid value for flag --define: "bogus". Expected: Invalid key=value format. Expected format: key=value, got: bogus',
    });
  });

  test("InvalidValue surfaces a complete pflag-style 'expected' message verbatim (Go flag-parse parity)", () => {
    // Legacy flags that reproduce Go's flag-parse rejections (e.g.
    // `storage cp --jobs=-1` via `Flag.mapTryCatch`) put pflag's entire
    // `invalid argument %q for %q flag: %v` string in `expected`. Wrapping it
    // in Effect's `Invalid value for flag --jobs: …` template would break
    // byte-parity with the Go CLI's stderr.
    const error = new CliError.InvalidValue({
      option: "jobs",
      value: "-1",
      expected:
        'invalid argument "-1" for "-j, --jobs" flag: strconv.ParseUint: parsing "-1": invalid syntax',
      kind: "flag",
    });

    expect(normalizeCliError(error)).toEqual({
      code: "InvalidValue",
      message:
        'invalid argument "-1" for "-j, --jobs" flag: strconv.ParseUint: parsing "-1": invalid syntax',
    });
  });

  test("ShowHelp envelope unwraps a single InvalidValue with the same doubled-prefix fix", () => {
    const error = {
      _tag: "ShowHelp",
      commandPath: ["db", "lint"],
      errors: [
        new CliError.InvalidValue({
          option: "level",
          value: "bogus",
          expected: 'Expected "warning" | "error", got "bogus"',
          kind: "flag",
        }),
      ],
    };

    expect(normalizeCliError(error)).toEqual({
      code: "InvalidValue",
      message: 'Invalid value for flag --level: "bogus". Expected "warning" | "error", got "bogus"',
    });
  });

  test("ShowHelp envelope unwraps a single MissingOption to Cobra wording", () => {
    // Effect CLI raises `ShowHelp` containing the parse error in its `errors`
    // array. We unwrap to surface the actionable message instead of "Help requested".
    const error = {
      _tag: "ShowHelp",
      commandPath: ["sso", "add"],
      errors: [{ _tag: "MissingOption", option: "type" }],
    };
    expect(normalizeCliError(error)).toEqual({
      code: "MissingOption",
      message: `Error: required flag(s) "type" not set`,
    });
  });

  // CLI-1901: before this fix, the vendored `effect` CLI library's own
  // `showHelp()` also printed this same message (via `Console.error`) as a
  // duplicate of whatever `normalizeCause` rendered here — so a tag with no
  // Go-parity-specific mapping (e.g. UnrecognizedOption) still had SOME
  // informative text visible, just twice. Now that CLI-1901's `run.ts` fix
  // suppresses the library's own duplicate print entirely, this generic
  // fallback is the ONLY place the message reaches the user — it must not
  // regress to the useless "Help requested" envelope message.
  test("ShowHelp envelope unwraps a single UnrecognizedOption to its own message (no Go-parity mapping exists yet)", () => {
    const error = {
      _tag: "ShowHelp",
      commandPath: ["branches"],
      errors: [
        new CliError.UnrecognizedOption({
          option: "--bogus",
          command: ["branches"],
          suggestions: [],
        }),
      ],
    };
    expect(normalizeCliError(error)).toEqual({
      code: "UnrecognizedOption",
      message: "Unrecognized flag: --bogus in command branches",
    });
  });

  // Regression test for a Codex review finding on CLI-1901: `run.ts`'s
  // `withoutParseErrorHelpDump` suppresses the vendored library's own
  // `Console.error` render, which used to be the only place a subcommand-flag
  // placement hint (`buildSubcommandFlagHint` /
  // `subcommand-flag-suggestions.ts`) reached the user. When a
  // `CliErrorSuggestionContext` is supplied, this fallback must reuse
  // `formatCliErrorsForDisplay` — the same helper the text/json formatters
  // use — so that hint still survives through the single-render path.
  test("ShowHelp envelope unwraps a single UnrecognizedOption and preserves its subcommand-flag hint when a suggestion context is supplied", () => {
    const error = {
      _tag: "ShowHelp",
      commandPath: ["branches"],
      errors: [
        new CliError.UnrecognizedOption({
          option: "--persistent",
          command: ["supabase", "branches"],
          suggestions: [],
        }),
      ],
    };

    const result = normalizeCliError(error, {
      rootCommand: testRoot,
      args: ["branches", "--persistent", "create"],
    });

    expect(result.code).toBe("UnrecognizedOption");
    expect(result.message).toContain(
      "Unrecognized flag: --persistent in command supabase branches",
    );
    expect(result.message).toContain(
      "Hint: --persistent is available on `supabase branches create` and `supabase branches update`. Pass it after the subcommand",
    );
  });

  // Regression test for a second Codex review finding on CLI-1901: a child
  // flag placed before its subcommand, WITH a value (e.g. `network-restrictions
  // --project-ref <ref> get`), makes Effect raise TWO simultaneous errors —
  // `UnrecognizedOption` for the flag, plus `UnknownSubcommand` for the
  // flag's own value being misread as the subcommand name. Before this fix,
  // `mappedError`'s ShowHelp unwrap only ever looked at `errors.length === 1`,
  // so a real two-error ShowHelp fell straight through to the generic
  // "Help requested" envelope message — losing the hint (and the specific
  // error) entirely now that CLI-1901 also suppresses the vendored library's
  // own duplicate render for this case.
  test("ShowHelp envelope unwraps multiple simultaneous errors and preserves the subcommand-flag hint (child flag with a value, before its subcommand)", () => {
    const error = {
      _tag: "ShowHelp",
      commandPath: ["network-restrictions"],
      errors: [
        new CliError.UnrecognizedOption({
          option: "--project-ref",
          command: ["supabase", "network-restrictions"],
          suggestions: [],
        }),
        new CliError.UnknownSubcommand({
          subcommand: "jacraenyzrorgjhsdvvf",
          parent: ["supabase", "network-restrictions"],
          suggestions: [],
        }),
      ],
    };

    const result = normalizeCliError(error, {
      rootCommand: testRoot,
      args: ["network-restrictions", "--project-ref", "jacraenyzrorgjhsdvvf", "get"],
    });

    expect(result.code).toBe("UnrecognizedOption");
    expect(result.message).toContain(
      "Unrecognized flag: --project-ref in command supabase network-restrictions",
    );
    expect(result.message).toContain(
      "Hint: --project-ref is available on `supabase network-restrictions get` and `supabase network-restrictions update`.",
    );
    expect(result.message).not.toContain("Help requested");
  });

  // A genuine, unrelated multi-error case (no shared hint to collapse them
  // into one) must still surface every error's own message, not just the
  // first — and must not crash trying to pick a single `code`.
  test("ShowHelp envelope unwraps multiple unrelated simultaneous errors into a joined message", () => {
    const error = {
      _tag: "ShowHelp",
      commandPath: ["branches"],
      errors: [
        new CliError.UnrecognizedOption({
          option: "--bogus-one",
          command: ["supabase", "branches"],
          suggestions: [],
        }),
        new CliError.UnrecognizedOption({
          option: "--bogus-two",
          command: ["supabase", "branches"],
          suggestions: [],
        }),
      ],
    };

    const result = normalizeCliError(error, { rootCommand: testRoot, args: ["branches"] });

    expect(result.code).toBe("ShowHelp");
    expect(result.message).toContain("Unrecognized flag: --bogus-one in command supabase branches");
    expect(result.message).toContain("Unrecognized flag: --bogus-two in command supabase branches");
  });

  // The same fallback also covers an InvalidValue that does NOT have the
  // CLI-1898 doubled-"Expected"-prefix bug (e.g. a custom `Flag.mapTryCatch`
  // validator like `sso add --domains`, whose `expected` text is already
  // clean) — `mappedError`'s own InvalidValue case returns `undefined` for
  // those (nothing to fix), so this generic fallback is what surfaces the
  // message, not CLI-1898's specific rebuild.
  test("ShowHelp envelope unwraps a single InvalidValue with an already-clean expected message (not the CLI-1898 doubled-prefix bug)", () => {
    const error = {
      _tag: "ShowHelp",
      commandPath: ["sso", "add"],
      errors: [
        new CliError.InvalidValue({
          option: "domains",
          value: "unterminated-quote.com",
          expected: "a comma-separated list (unterminated quote)",
          kind: "flag",
        }),
      ],
    };
    expect(normalizeCliError(error)).toEqual({
      code: "InvalidValue",
      message:
        'Invalid value for flag --domains: "unterminated-quote.com". Expected: a comma-separated list (unterminated quote)',
    });
  });

  // If the single inner error has a `_tag` but no usable `message` (neither a
  // string via its own getter nor otherwise), the fallback must not surface a
  // blank/garbage message — it should fall through to ShowHelp's own generic
  // handling, same as the pre-existing multiple-errors case below.
  test("ShowHelp envelope with a single inner error carrying no message falls back to generic", () => {
    const error = {
      _tag: "ShowHelp",
      commandPath: ["branches"],
      errors: [{ _tag: "SomeUnmappedTag" }],
    };
    const result = normalizeCliError(error);
    expect(result.code).toBe("ShowHelp");
  });

  test("ShowHelp with multiple errors does not unwrap (falls back to generic)", () => {
    const error = {
      _tag: "ShowHelp",
      commandPath: ["sso", "add"],
      errors: [
        { _tag: "MissingOption", option: "type" },
        { _tag: "MissingOption", option: "project-ref" },
      ],
    };
    // Should fall through to generic — message comes from ShowHelp itself,
    // which doesn't include one in our test fixture.
    const result = normalizeCliError(error);
    expect(result.code).toBe("ShowHelp");
  });

  test("normalizes a cause via its first failure", () => {
    const normalized = normalizeCause(
      Cause.fail({ _tag: "StackRuntimeError", message: "service failed to start" }),
    );

    expect(normalized).toEqual({
      code: "StackRuntimeError",
      message: "service failed to start",
    });
  });

  test("formats text output with detail and suggestion", () => {
    const text = formatCliError({
      code: "StackRuntimeError",
      message: "The local Supabase stack failed to start.",
      detail: "The auth workload exited before becoming ready.",
      suggestion: "Inspect the stack logs, then retry `supabase start`.",
    });

    expect(text).toContain("The local Supabase stack failed to start.");
    expect(text).toContain("Detail: The auth workload exited before becoming ready.");
    expect(text).toContain("Suggestion: Inspect the stack logs, then retry `supabase start`.");
  });
});
