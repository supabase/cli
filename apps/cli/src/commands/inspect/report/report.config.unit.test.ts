import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect";

import { withEnvVar } from "../../../../tests/helpers/command-mocks.ts";
import { cliConfigProviderLayer } from "../../../shared/config/cli-config-provider.layer.ts";
import { readInspectRules } from "./report.config.ts";

const makeWorkdir = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  configToml?: string,
  dotEnv?: string,
) {
  const workdir = yield* fs.makeTempDirectory({ prefix: "supabase-report-config-" });
  if (configToml !== undefined) {
    yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
    yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), configToml);
  }
  if (dotEnv !== undefined) {
    yield* fs.writeFileString(path.join(workdir, "supabase", ".env"), dotEnv);
  }
  return workdir;
});

const readRules = (configToml?: string, dotEnv?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workdir = yield* makeWorkdir(fs, path, configToml, dotEnv);
    return yield* readInspectRules(fs, path, workdir);
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, cliConfigProviderLayer)));

describe("readInspectRules", () => {
  it.effect("returns [] when config.toml is absent", () =>
    Effect.gen(function* () {
      const rules = yield* readRules();
      expect(rules).toEqual([]);
    }),
  );

  it.effect("returns [] when there are no inspect rules", () =>
    Effect.gen(function* () {
      const rules = yield* readRules('project_id = "demo"\n');
      expect(rules).toEqual([]);
    }),
  );

  it.effect("parses [experimental.inspect.rules]", () =>
    Effect.gen(function* () {
      const rules = yield* readRules(
        [
          "[[experimental.inspect.rules]]",
          'query = "SELECT COUNT(*) FROM `locks.csv`"',
          'name = "No locks"',
          'pass = "ok"',
          'fail = "bad"',
          "",
        ].join("\n"),
      );
      expect(rules).toEqual([
        { query: "SELECT COUNT(*) FROM `locks.csv`", name: "No locks", pass: "ok", fail: "bad" },
      ]);
    }),
  );

  it.effect("expands env(VAR) in rule string fields", () =>
    Effect.gen(function* () {
      const rules = yield* withEnvVar(
        "REPORT_TEST_FAIL",
        "from-env",
        readRules(
          [
            "[[experimental.inspect.rules]]",
            'query = "SELECT COUNT(*) FROM `locks.csv`"',
            'name = "r"',
            'pass = "ok"',
            'fail = "env(REPORT_TEST_FAIL)"',
            "",
          ].join("\n"),
        ),
      );
      expect(rules[0]?.fail).toBe("from-env");
    }),
  );

  it.effect(
    "keeps the literal env(VAR) when the shell sets VAR empty, even if .env defines it",
    () =>
      Effect.gen(function* () {
        const read = readRules(
          [
            "[[experimental.inspect.rules]]",
            'query = "SELECT 1"',
            'name = "r"',
            'pass = "ok"',
            'fail = "env(REPORT_TEST_X)"',
            "",
          ].join("\n"),
          "REPORT_TEST_X=fromfile\n",
        );
        const unset = yield* withEnvVar("REPORT_TEST_X", undefined, read);
        expect(unset[0]?.fail).toBe("fromfile");
        const empty = yield* withEnvVar("REPORT_TEST_X", "", read);
        expect(empty[0]?.fail).toBe("env(REPORT_TEST_X)");
      }),
  );

  it.effect("fails with DbConfigLoadError on a malformed config.toml", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(readRules("this is = = not valid toml [[["));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("DbConfigLoadError");
      }
    }),
  );

  it.effect("weakly coerces scalar rule fields to strings, matching Go's decoder", () =>
    Effect.gen(function* () {
      // Weakly-typed decoding: an int/bool field
      // coerces to its string form (123 → "123", true → "1") rather than erroring.
      const rules = yield* readRules(
        [
          "[[experimental.inspect.rules]]",
          "query = 123",
          'name = "r"',
          "pass = true",
          'fail = "bad"',
          "",
        ].join("\n"),
      );
      expect(rules[0]?.query).toBe("123");
      expect(rules[0]?.pass).toBe("1");
    }),
  );

  it.effect("fails when an inspect.rules entry is not a table (Go aborts)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readRules('[experimental.inspect]\nrules = ["not-a-table"]\n'),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("expected a map or struct");
      }
    }),
  );

  it.effect("rejects unknown keys in a rule table (Go's UnmarshalExact ErrorUnused)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readRules(
          [
            "[[experimental.inspect.rules]]",
            'query = "SELECT 1"',
            'name = "r"',
            'pass = "ok"',
            'fail = "bad"',
            'fails = "typo"',
            "",
          ].join("\n"),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("invalid keys: fails");
      }
    }),
  );

  it.effect("accepts a single inline rules table as one rule (Go weak-typing wrap)", () =>
    Effect.gen(function* () {
      const rules = yield* readRules(
        [
          "[experimental.inspect.rules]",
          'query = "SELECT 1"',
          'name = "solo"',
          'pass = "ok"',
          'fail = "bad"',
          "",
        ].join("\n"),
      );
      expect(rules).toEqual([{ query: "SELECT 1", name: "solo", pass: "ok", fail: "bad" }]);
    }),
  );

  it.effect("fails when rules is a scalar string (Go aborts)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(readRules('[experimental.inspect]\nrules = "oops"\n'));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("expected a map or struct");
      }
    }),
  );

  it.effect("fails when a rule field is a non-coercible type (nested table)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readRules(
          [
            "[[experimental.inspect.rules]]",
            "[experimental.inspect.rules.query]",
            'a = "b"',
            "",
          ].join("\n"),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("expected a string");
      }
    }),
  );
});
