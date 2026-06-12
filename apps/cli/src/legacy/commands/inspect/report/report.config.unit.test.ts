import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { legacyReadInspectRules } from "./report.config.ts";

function makeWorkdir(configToml?: string): string {
  const workdir = mkdtempSync(join(tmpdir(), "supabase-report-config-"));
  if (configToml !== undefined) {
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), configToml);
  }
  return workdir;
}

const readRules = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyReadInspectRules(fs, path, workdir);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyReadInspectRules", () => {
  it.effect("returns [] when config.toml is absent", () =>
    Effect.gen(function* () {
      const rules = yield* readRules(makeWorkdir());
      expect(rules).toEqual([]);
    }),
  );

  it.effect("returns [] when there are no inspect rules", () =>
    Effect.gen(function* () {
      const rules = yield* readRules(makeWorkdir('project_id = "demo"\n'));
      expect(rules).toEqual([]);
    }),
  );

  it.effect("parses [experimental.inspect.rules]", () =>
    Effect.gen(function* () {
      const rules = yield* readRules(
        makeWorkdir(
          [
            "[[experimental.inspect.rules]]",
            'query = "SELECT COUNT(*) FROM `locks.csv`"',
            'name = "No locks"',
            'pass = "ok"',
            'fail = "bad"',
            "",
          ].join("\n"),
        ),
      );
      expect(rules).toEqual([
        { query: "SELECT COUNT(*) FROM `locks.csv`", name: "No locks", pass: "ok", fail: "bad" },
      ]);
    }),
  );

  it.effect("expands env(VAR) in rule string fields", () =>
    Effect.gen(function* () {
      process.env["LEGACY_REPORT_TEST_FAIL"] = "from-env";
      const rules = yield* readRules(
        makeWorkdir(
          [
            "[[experimental.inspect.rules]]",
            'query = "SELECT COUNT(*) FROM `locks.csv`"',
            'name = "r"',
            'pass = "ok"',
            'fail = "env(LEGACY_REPORT_TEST_FAIL)"',
            "",
          ].join("\n"),
        ),
      );
      delete process.env["LEGACY_REPORT_TEST_FAIL"];
      expect(rules[0]?.fail).toBe("from-env");
    }),
  );

  it.effect("fails with LegacyDbConfigLoadError on a malformed config.toml", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(readRules(makeWorkdir("this is = = not valid toml [[[")));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("LegacyDbConfigLoadError");
      }
    }),
  );

  it.effect("weakly coerces scalar rule fields to strings, matching Go's decoder", () =>
    Effect.gen(function* () {
      // Go's viper UnmarshalExact keeps WeaklyTypedInput:true, so an int/bool field
      // coerces to its string form (123 → "123", true → "1") rather than erroring.
      const rules = yield* readRules(
        makeWorkdir(
          [
            "[[experimental.inspect.rules]]",
            "query = 123",
            'name = "r"',
            "pass = true",
            'fail = "bad"',
            "",
          ].join("\n"),
        ),
      );
      expect(rules[0]?.query).toBe("123");
      expect(rules[0]?.pass).toBe("1");
    }),
  );

  it.effect("fails when an inspect.rules entry is not a table (Go aborts)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readRules(makeWorkdir('[experimental.inspect]\nrules = ["not-a-table"]\n')),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("expected a map or struct");
      }
    }),
  );

  it.effect("rejects unknown keys in a rule table (Go's UnmarshalExact ErrorUnused)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readRules(
          makeWorkdir(
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
        ),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("invalid keys: fails");
      }
    }),
  );

  it.effect("accepts a single inline rules table as one rule (Go weak-typing wrap)", () =>
    Effect.gen(function* () {
      const rules = yield* readRules(
        makeWorkdir(
          [
            "[experimental.inspect.rules]",
            'query = "SELECT 1"',
            'name = "solo"',
            'pass = "ok"',
            'fail = "bad"',
            "",
          ].join("\n"),
        ),
      );
      expect(rules).toEqual([{ query: "SELECT 1", name: "solo", pass: "ok", fail: "bad" }]);
    }),
  );

  it.effect("fails when rules is a scalar string (Go aborts)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readRules(makeWorkdir('[experimental.inspect]\nrules = "oops"\n')),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("expected a map or struct");
      }
    }),
  );

  it.effect("fails when a rule field is a non-coercible type (nested table)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readRules(
          makeWorkdir(
            [
              "[[experimental.inspect.rules]]",
              "[experimental.inspect.rules.query]",
              'a = "b"',
              "",
            ].join("\n"),
          ),
        ),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("expected a string");
      }
    }),
  );
});
