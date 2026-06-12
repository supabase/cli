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
});
