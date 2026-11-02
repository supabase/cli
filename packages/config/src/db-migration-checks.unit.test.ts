import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "vitest";
import { Effect, FileSystem, Path, Schema, SchemaIssue } from "effect";
import type { LoadCliConfigOptions } from "./config-document.ts";
import { loadCliConfigFile } from "./effect.ts";

const loadToml = Effect.fn("MigrationChecksTest.loadToml")(function* (
  section: string,
  options?: LoadCliConfigOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "migration-checks-" });
  yield* fs.makeDirectory(path.join(cwd, "supabase"));
  const file = path.join(cwd, "supabase", "config.toml");
  yield* fs.writeFileString(file, `project_id = "checks-test"\n${section}\n`);
  return yield* loadCliConfigFile(file, options);
});

const loadIssues = Effect.fn("MigrationChecksTest.loadIssues")(function* (
  section: string,
  options?: LoadCliConfigOptions,
) {
  const error = yield* Effect.flip(loadToml(section, options));
  if (error._tag !== "CliConfigParseError") {
    return yield* Effect.die("Expected CliConfigParseError from config loading");
  }
  const cause = error.cause;
  if (!Schema.isSchemaError(cause)) {
    return yield* Effect.die("Expected a schema error as the config parse cause");
  }
  return SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue).issues;
});

const knownRules =
  "rls_disabled_in_public, rls_enabled_no_policy, policy_exists_rls_disabled, security_definer_view, rls_policy_always_true, sensitive_columns_exposed, auth_users_exposed, function_search_path_mutable, rls_references_user_metadata";

const diagnostics = [
  {
    name: "suggests a misspelled rule",
    toml: '[db.migrations.checks]\nrls_disabled_in_publc = "warn"',
    path: ["db", "migrations", "checks", "rls_disabled_in_publc"],
    message:
      'Unknown rule "rls_disabled_in_publc" in [db.migrations.checks]. Did you mean "rls_disabled_in_public"?',
  },
  {
    name: "suggests a rule at edit distance three",
    toml: '[db.migrations.checks]\nrls_disabled_in_pub = "warn"',
    path: ["db", "migrations", "checks", "rls_disabled_in_pub"],
    message:
      'Unknown rule "rls_disabled_in_pub" in [db.migrations.checks]. Did you mean "rls_disabled_in_public"?',
  },
  {
    name: "lists known rules beyond edit distance three",
    toml: '[db.migrations.checks]\nrls_disabled_in_pu = "warn"',
    path: ["db", "migrations", "checks", "rls_disabled_in_pu"],
    message: `"rls_disabled_in_pu" is not a known rule in [db.migrations.checks]. Check the spelling, or upgrade the CLI if a teammate added it. Known rules: ${knownRules}.`,
  },
  {
    name: "rejects a severity in place of the exclude table",
    toml: '[db.migrations.checks]\nexclude = "warn"',
    path: ["db", "migrations", "checks", "exclude"],
    message: "[db.migrations.checks.exclude] must be a table",
  },
  {
    name: "names a non-string severity value",
    toml: "[db.migrations.checks]\nrls_disabled_in_public = 5",
    path: ["db", "migrations", "checks", "rls_disabled_in_public"],
    message: 'rls_disabled_in_public must be "error", "warn" or "off" (got 5)',
  },
  {
    name: "escapes quotes in a malformed exclusion diagnostic",
    toml: `[db.migrations.checks.exclude]\nrls_disabled_in_public = [' public."t']`,
    path: ["db", "migrations", "checks", "exclude", "rls_disabled_in_public", 0],
    message:
      'exclude entries are "schema.name", for example "public.countries" (got " public.\\"t")',
  },
  {
    name: "suggests the exclude table",
    toml: "[db.migrations.checks.exlude]",
    path: ["db", "migrations", "checks", "exlude"],
    message: 'Unknown key "exlude" in [db.migrations.checks]. Did you mean "exclude"?',
  },
  {
    name: "lists known rules for an unknown severity key",
    toml: '[db.migrations.checks]\nstorage_bucket_public = "warn"',
    path: ["db", "migrations", "checks", "storage_bucket_public"],
    message: `"storage_bucket_public" is not a known rule in [db.migrations.checks]. Check the spelling, or upgrade the CLI if a teammate added it. Known rules: ${knownRules}.`,
  },
  {
    name: "lists known rules for an unknown exclusion key",
    toml: '[db.migrations.checks.exclude]\nstorage_bucket_public = ["public.t"]',
    path: ["db", "migrations", "checks", "exclude", "storage_bucket_public"],
    message: `"storage_bucket_public" is not a known rule in [db.migrations.checks.exclude]. Check the spelling, or upgrade the CLI if a teammate added it. Known rules: ${knownRules}.`,
  },
  {
    name: "suggests a misspelled exclusion rule",
    toml: '[db.migrations.checks.exclude]\nrls_disabled_in_publc = ["public.t"]',
    path: ["db", "migrations", "checks", "exclude", "rls_disabled_in_publc"],
    message:
      'Unknown rule "rls_disabled_in_publc" in [db.migrations.checks.exclude]. Did you mean "rls_disabled_in_public"?',
  },
  {
    name: "names the rule and invalid severity",
    toml: '[db.migrations.checks]\nrls_disabled_in_public = "eror"',
    path: ["db", "migrations", "checks", "rls_disabled_in_public"],
    message: 'rls_disabled_in_public must be "error", "warn" or "off" (got "eror")',
  },
  {
    name: "explains a severity placed below the exclude header",
    toml: '[db.migrations.checks.exclude]\nrls_disabled_in_public = "warn"',
    path: ["db", "migrations", "checks", "exclude", "rls_disabled_in_public"],
    message: "values under [db.migrations.checks.exclude] must be lists; severities go above it",
  },
];

describe("db.migrations.checks TOML loading", () => {
  it("leaves an absent checks section undefined", () =>
    Effect.gen(function* () {
      const loaded = yield* loadToml("");
      expect(loaded.config.db.migrations.checks).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));

  it.each(diagnostics)("$name", ({ toml, path, message }) =>
    Effect.gen(function* () {
      expect(yield* loadIssues(toml)).toEqual([{ path, message }]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
  );

  it("reports several problems in the same file together", () =>
    Effect.gen(function* () {
      const issues = yield* loadIssues(
        '[db.migrations.checks]\nrls_disabled_in_publc = "warn"\nrls_disabled_in_public = "eror"\n[db.migrations.checks.exclude]\nrls_enabled_no_policy = "warn"',
      );
      expect(issues).toEqual([
        {
          path: ["db", "migrations", "checks", "rls_disabled_in_publc"],
          message:
            'Unknown rule "rls_disabled_in_publc" in [db.migrations.checks]. Did you mean "rls_disabled_in_public"?',
        },
        {
          path: ["db", "migrations", "checks", "rls_disabled_in_public"],
          message: 'rls_disabled_in_public must be "error", "warn" or "off" (got "eror")',
        },
        {
          path: ["db", "migrations", "checks", "exclude", "rls_enabled_no_policy"],
          message:
            "values under [db.migrations.checks.exclude] must be lists; severities go above it",
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));

  it.each(["public.countries", "my schema.t", "public.my table", "a.b.c"])(
    "accepts exclusion entry %j",
    (entry) =>
      Effect.gen(function* () {
        const loaded = yield* loadToml(
          `[db.migrations.checks.exclude]\nrls_disabled_in_public = ["${entry}"]`,
        );
        expect(loaded.config.db.migrations.checks).toEqual({
          exclude: { rls_disabled_in_public: [entry] },
        });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
  );

  it.each([
    '" public.t"',
    '"public.t "',
    '"public .t"',
    '"public. t"',
    '"public"',
    '".t"',
    '"public."',
    '""',
    "42",
  ])("rejects malformed exclusion entry %s and names its value and index", (entry) =>
    Effect.gen(function* () {
      const issues = yield* loadIssues(
        `[db.migrations.checks.exclude]\nrls_disabled_in_public = ["public.valid", ${entry}]`,
      );
      expect(issues).toEqual([
        {
          path: ["db", "migrations", "checks", "exclude", "rls_disabled_in_public", 1],
          message: `exclude entries are "schema.name", for example "public.countries" (got ${entry})`,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
  );

  it("accepts an empty exclusion list", () =>
    Effect.gen(function* () {
      const loaded = yield* loadToml("[db.migrations.checks.exclude]\nrls_disabled_in_public = []");
      expect(loaded.config.db.migrations.checks).toEqual({
        exclude: { rls_disabled_in_public: [] },
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));

  it("rejects a misspelled rule in the selected remote block", () =>
    Effect.gen(function* () {
      const issues = yield* loadIssues(
        '[remotes.staging]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.staging.db.migrations.checks]\nrls_disabled_in_publc = "off"',
        { projectRef: "abcdefghijklmnopqrst" },
      );
      expect(issues).toEqual([
        {
          path: ["db", "migrations", "checks", "rls_disabled_in_publc"],
          message:
            'Unknown rule "rls_disabled_in_publc" in [db.migrations.checks]. Did you mean "rls_disabled_in_public"?',
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));

  it("removes duplicate exclusions while keeping first-seen order", () =>
    Effect.gen(function* () {
      const loaded = yield* loadToml(
        '[db.migrations.checks.exclude]\nrls_disabled_in_public = ["public.b", "public.a", "public.b", "public.c", "public.a"]',
      );
      expect(loaded.config.db.migrations.checks?.exclude?.rls_disabled_in_public).toEqual([
        "public.b",
        "public.a",
        "public.c",
      ]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));

  it.each([
    "rls_disabled_in_public",
    "rls_enabled_no_policy",
    "policy_exists_rls_disabled",
    "security_definer_view",
    "rls_policy_always_true",
    "sensitive_columns_exposed",
    "auth_users_exposed",
    "function_search_path_mutable",
    "rls_references_user_metadata",
  ])("preserves a severity and exclusion for %s", (rule) =>
    Effect.gen(function* () {
      const loaded = yield* loadToml(
        `[db.migrations.checks]\n${rule} = "error"\n[db.migrations.checks.exclude]\n${rule} = ["public.countries"]`,
      );
      expect(loaded.config.db.migrations.checks).toEqual({
        [rule]: "error",
        exclude: { [rule]: ["public.countries"] },
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
  );

  it("preserves explicit severities and exclusions without filling unset rules", () =>
    Effect.gen(function* () {
      const loaded = yield* loadToml(
        '[db.migrations.checks]\nrls_disabled_in_public = "error"\nfunction_search_path_mutable = "off"\nsensitive_columns_exposed = "warn"\n[db.migrations.checks.exclude]\nrls_disabled_in_public = ["public.countries"]\nfunction_search_path_mutable = ["public.set_updated_at"]',
      );
      expect(loaded.config.db.migrations.checks).toEqual({
        rls_disabled_in_public: "error",
        function_search_path_mutable: "off",
        sensitive_columns_exposed: "warn",
        exclude: {
          rls_disabled_in_public: ["public.countries"],
          function_search_path_mutable: ["public.set_updated_at"],
        },
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));

  it("ignores unknown keys outside checks", () =>
    Effect.gen(function* () {
      const loaded = yield* loadToml(
        '[db.migrations]\nunknown_migration_option = true\nenabled = false\n[db.migrations.checks]\nrls_disabled_in_public = "error"',
      );
      expect(loaded.config.db.migrations).not.toHaveProperty("unknown_migration_option");
      expect(loaded.config.db.migrations.checks).toEqual({ rls_disabled_in_public: "error" });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));
});
