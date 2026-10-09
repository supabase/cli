import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { configValuesLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { readInspectRules } from "./report.config.ts";

const makeWorkdir = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  configToml?: string,
  dotEnv?: string,
) {
  const workdir = yield* fs.makeTempDirectory({ prefix: "supabase-report-config-" });
  if (configToml !== undefined || dotEnv !== undefined) {
    yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
  }
  if (configToml !== undefined) {
    yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), configToml);
  }
  if (dotEnv !== undefined) {
    yield* fs.writeFileString(path.join(workdir, "supabase", ".env"), dotEnv);
  }
  return workdir;
});

const rule = (fail: string) =>
  [
    "[[experimental.inspect.rules]]",
    'query = "SELECT 1"',
    'name = "r"',
    'pass = "ok"',
    `fail = "${fail}"`,
    "",
  ].join("\n");

const readRules = (options: {
  readonly configToml?: string;
  readonly dotEnv?: string;
  readonly env?: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workdir = yield* makeWorkdir(fs, path, options.configToml, options.dotEnv);
    return yield* readInspectRules(workdir);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        configValuesLayer(options.env === undefined ? {} : { env: options.env }),
      ),
    ),
  );

describe("readInspectRules", () => {
  it.effect("returns [] when config.toml is absent", () =>
    Effect.gen(function* () {
      expect(yield* readRules({})).toEqual([]);
    }),
  );

  it.effect("returns [] when there are no inspect rules", () =>
    Effect.gen(function* () {
      expect(yield* readRules({ configToml: 'project_id = "demo"\n' })).toEqual([]);
    }),
  );

  it.effect("parses [experimental.inspect.rules]", () =>
    Effect.gen(function* () {
      const rules = yield* readRules({
        configToml: [
          "[[experimental.inspect.rules]]",
          'query = "SELECT COUNT(*) FROM `locks.csv`"',
          'name = "No locks"',
          'pass = "ok"',
          'fail = "bad"',
          "",
        ].join("\n"),
      });
      expect(rules).toEqual([
        { query: "SELECT COUNT(*) FROM `locks.csv`", name: "No locks", pass: "ok", fail: "bad" },
      ]);
    }),
  );

  it.effect("fills a missing rule field with the empty string", () =>
    Effect.gen(function* () {
      const rules = yield* readRules({
        configToml: '[[experimental.inspect.rules]]\nquery = "SELECT 1"\n',
      });
      expect(rules).toEqual([{ query: "SELECT 1", name: "", pass: "", fail: "" }]);
    }),
  );

  it.effect("expands env(VAR) in rule string fields from the shell", () =>
    Effect.gen(function* () {
      const rules = yield* readRules({
        configToml: rule("env(REPORT_TEST_FAIL)"),
        env: { REPORT_TEST_FAIL: "from-env" },
      });
      expect(rules[0]?.fail).toBe("from-env");
    }),
  );

  it.effect("expands env(VAR) from the project .env when the shell leaves it unset", () =>
    Effect.gen(function* () {
      const rules = yield* readRules({
        configToml: rule("env(REPORT_TEST_X)"),
        dotEnv: "REPORT_TEST_X=fromfile\n",
      });
      expect(rules[0]?.fail).toBe("fromfile");
    }),
  );

  it.effect("fails on a malformed config.toml", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(readRules({ configToml: "this is = = not valid toml [[[" }));
      expect(error._tag).toBe("CliConfigParseError");
    }),
  );

  it.effect("rejects unknown keys in a rule table", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(readRules({ configToml: `${rule("bad")}typo = "x"\n` }));
      expect(error.message).toContain("unknown keys: typo");
    }),
  );

  it.effect("fails when a rule field is not a string", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        readRules({
          configToml: '[[experimental.inspect.rules]]\nquery = 123\nname = "r"\n',
        }),
      );
      expect(error._tag).toBe("CliConfigParseError");
    }),
  );

  it.effect("fails when an inspect.rules entry is not a table", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        readRules({ configToml: '[experimental.inspect]\nrules = ["not-a-table"]\n' }),
      );
      expect(error._tag).toBe("CliConfigParseError");
    }),
  );
});
