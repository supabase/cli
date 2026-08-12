import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag, LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigLoadError } from "../../../shared/legacy-db-config.errors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyMigrationFetch } from "./fetch.handler.ts";
import type { LegacyMigrationFetchFlags } from "./fetch.command.ts";

const SELECT_SQL =
  "SELECT version, coalesce(name, '') as name, statements FROM supabase_migrations.schema_migrations";

interface MigrationRow {
  readonly version: string;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly isTTY?: boolean;
  readonly pipedInput?: string;
  readonly yes?: boolean;
  readonly confirm?: boolean;
  readonly rows?: ReadonlyArray<MigrationRow>;
  readonly resolveFails?: boolean;
  /** Raw argv seen by `resolveLegacyDbTargetFlags` (e.g. to exercise a flag conflict). */
  readonly cliArgs?: ReadonlyArray<string>;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm === undefined ? undefined : [opts.confirm],
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (_flags: LegacyDbConfigFlags) =>
      opts.resolveFails === true
        ? Effect.fail(
            new LegacyDbConfigLoadError({
              message: "failed to parse config: invalid connection string",
            }),
          )
        : Effect.succeed({
            conn: {
              host: "127.0.0.1",
              port: 54322,
              user: "postgres",
              password: "x",
              database: "postgres",
            },
            isLocal: false,
            ref: Option.some(LEGACY_VALID_REF),
          } satisfies LegacyResolvedDbConfig),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        exec: () => Effect.void,
        query: (sql: string) =>
          Effect.suspend(() =>
            sql === SELECT_SQL
              ? Effect.succeed((opts.rows ?? []).map((r) => ({ ...r })))
              : Effect.succeed([]),
          ),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
      }),
  });

  // `loadProjectRef` gives an explicit `--project-ref` flag top precedence, same
  // as Go's `flags.LoadProjectRef` — mirror that so a test can prove the flag
  // (not just the hardcoded `LEGACY_VALID_REF` fallback) drives the linked ref.
  const projectRef = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(LEGACY_VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Effect.succeed(
        Option.isSome(flagValue) && flagValue.value.length > 0 ? flagValue.value : LEGACY_VALID_REF,
      ),
    promptProjectRef: () => Effect.succeed(LEGACY_VALID_REF),
  });

  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    resolver,
    connection,
    projectRef,
    mockLegacyCliConfig({ workdir }),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(CliArgs, { args: opts.cliArgs ?? [] }),
    mockTty({ stdinIsTty: opts.isTTY ?? true }),
    mockStdin(
      opts.isTTY ?? true,
      // Migration prompts read stdin directly, so a confirm answer is
      // supplied via piped stdin rather than the Output prompt mock.
      opts.pipedInput ?? (opts.confirm === undefined ? undefined : opts.confirm ? "y\n" : "n\n"),
    ),
    BunServices.layer,
  );
  return { layer, out, telemetry, cache };
}

const flags = (over: Partial<LegacyMigrationFetchFlags> = {}): LegacyMigrationFetchFlags => ({
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? true,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
});

const migrationsDir = (workdir: string) => join(workdir, "supabase", "migrations");
const tmp = useLegacyTempWorkdir();

describe("legacy migration fetch", () => {
  it.live("writes migration files joined with the Go separator when the dir is empty", () => {
    const { layer, out } = setup(tmp.current, {
      rows: [
        {
          version: "20240101000000",
          name: "init",
          statements: ["create table a", "create index b"],
        },
      ],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      // The connection banner prints to stderr before dialing.
      expect(out.stderrText).toContain("Connecting to remote database...");
      const dir = migrationsDir(tmp.current);
      const files = readdirSync(dir);
      expect(files).toEqual(["20240101000000_init.sql"]);
      expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("create table a;\ncreate index b;\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("writes a lone separator for a row with no statements (Go parity)", () => {
    // A `schema_migrations` row can legally have a NULL/empty `statements` array
    // (older projects, manually-inserted rows). Joining statements with ";\n"
    // plus a trailing ";\n" means an empty array yields exactly ";\n" — a file with a stray
    // semicolon, not an empty file. This port keeps these bytes; lock it
    // so a future "emit an empty file instead" refactor is a conscious divergence.
    const { layer } = setup(tmp.current, {
      rows: [{ version: "20240101000000", name: "empty", statements: [] }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      const dir = migrationsDir(tmp.current);
      expect(readFileSync(join(dir, "20240101000000_empty.sql"), "utf8")).toBe(";\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("prompts before overwriting a non-empty directory and proceeds on yes", () => {
    mkdirSync(migrationsDir(tmp.current), { recursive: true });
    writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
    const { layer } = setup(tmp.current, {
      confirm: true,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      expect(readdirSync(migrationsDir(tmp.current))).toContain("20240101000000_init.sql");
    }).pipe(Effect.provide(layer));
  });

  it.live("cancels with context canceled when the overwrite prompt is declined", () => {
    mkdirSync(migrationsDir(tmp.current), { recursive: true });
    writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
    const { layer } = setup(tmp.current, {
      confirm: false,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyOperationCanceledError");
      }
      // No new file written on cancel.
      expect(readdirSync(migrationsDir(tmp.current))).toEqual(["existing.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors a piped 'n' answer without a TTY (cancels the overwrite)", () => {
    // The overwrite prompt defaults to YES; piped stdin is read even when non-interactive,
    // so a piped `n` overrides the default and cancels. Proves the
    // non-TTY path reads the answer instead of blindly taking the default.
    mkdirSync(migrationsDir(tmp.current), { recursive: true });
    writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
    const { layer } = setup(tmp.current, {
      isTTY: false,
      pipedInput: "n\n",
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyOperationCanceledError");
      }
      expect(readdirSync(migrationsDir(tmp.current))).toEqual(["existing.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("bypasses the overwrite prompt with --yes (echoes the auto-answer)", () => {
    mkdirSync(migrationsDir(tmp.current), { recursive: true });
    writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
    const { layer, out } = setup(tmp.current, {
      yes: true,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      expect(out.stderrText).toContain("[Y/n] y");
      expect(readdirSync(migrationsDir(tmp.current))).toContain("20240101000000_init.sql");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "auto-confirms the overwrite prompt from SUPABASE_YES in the project .env (Go loadNestedEnv)",
    () => {
      // SUPABASE_YES lives only in supabase/.env, not the shell — `fetch` defaults to
      // `--linked`, and the project `.env` files load before the overwrite prompt, so the
      // overwrite auto-confirms with no --yes flag and no piped stdin answer (CLI-1878).
      mkdirSync(migrationsDir(tmp.current), { recursive: true });
      writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
      writeFileSync(join(tmp.current, "supabase", ".env"), "SUPABASE_YES=true\n");
      const { layer, out } = setup(tmp.current, {
        rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
      });
      return Effect.gen(function* () {
        yield* legacyMigrationFetch(flags());
        expect(out.stderrText).toContain("[Y/n] y");
        expect(readdirSync(migrationsDir(tmp.current))).toContain("20240101000000_init.sql");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("still prompts on stderr in json mode and proceeds on a piped yes", () => {
    // The prompt writes to stderr and reads stdin regardless of --output,
    // so --output-format json must NOT silently auto-accept: the overwrite prompt fires on
    // stderr and a piped `y` proceeds, while the json result still goes to stdout.
    mkdirSync(migrationsDir(tmp.current), { recursive: true });
    writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
    const { layer, out } = setup(tmp.current, {
      format: "json",
      pipedInput: "y\n",
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      // The prompt label reached stderr (it was NOT format-gated into a silent default).
      expect(out.stderrText).toContain("[Y/n]");
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migration history fetched",
          data: { files: [join(migrationsDir(tmp.current), "20240101000000_init.sql")] },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("honors a piped no in json mode (cancels the overwrite, no auto-accept)", () => {
    // Regression guard: before the fix, json mode routed through the non-interactive Output
    // prompt and auto-accepted (default YES), overwriting. Now a piped `n` is honored.
    mkdirSync(migrationsDir(tmp.current), { recursive: true });
    writeFileSync(join(migrationsDir(tmp.current), "existing.sql"), "select 1;\n");
    const { layer } = setup(tmp.current, {
      format: "json",
      pipedInput: "n\n",
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyOperationCanceledError");
      }
      expect(readdirSync(migrationsDir(tmp.current))).toEqual(["existing.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a hostile version/name from the history table (path traversal guard)", () => {
    // A tampered remote `schema_migrations` row could use `..`/separators to
    // escape the migrations dir (CWE-22). The guard rejects it before writing.
    const { layer } = setup(tmp.current, {
      rows: [{ version: "20240101000000", name: "../../../etc/passwd", statements: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyMigrationFetchWriteError");
      }
      // Nothing is written when the guard fires.
      expect(readdirSync(migrationsDir(tmp.current))).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes a Go-valid signed version verbatim (no all-digits requirement)", () => {
    // The raw `version` column writes into `<version>_<name>.sql` with no digit check,
    // so a malformed-but-safe value like `-1`
    // (listable/repairable) must fetch, not abort the whole run.
    const { layer } = setup(tmp.current, {
      rows: [{ version: "-1", name: "legacy", statements: ["select 1"] }],
    });
    return Effect.gen(function* () {
      yield* legacyMigrationFetch(flags());
      expect(readdirSync(migrationsDir(tmp.current))).toEqual(["-1_legacy.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a hostile version from the history table (traversal guard on version)", () => {
    // The traversal hardening covers the `version` field too: a separator/`..` there is
    // rejected even though it is no longer required to be all-digits.
    const { layer } = setup(tmp.current, {
      rows: [{ version: "../../etc", name: "x", statements: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyMigrationFetchWriteError");
      }
      expect(readdirSync(migrationsDir(tmp.current))).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a write failure", () => {
    // A file at <workdir>/supabase/migrations makes `makeDirectory` fail. `supabase` itself
    // must stay a real directory here: the handler's project-env load (CLI-1878)
    // reads `<workdir>/supabase/.env*` before this mkdir, and a plain
    // file at `<workdir>/supabase` would make that read fail first (ENOTDIR) instead.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations"), "not a directory");
    const { layer } = setup(tmp.current, { rows: [] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyMigrationFetchWriteError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves DB config before creating the migrations dir or prompting", () => {
    // The DB config resolves before any filesystem/prompt side effect,
    // so an invalid target fails first. With the resolver
    // failing, the supabase/migrations dir must NOT be created and no prompt is shown.
    const { layer, out } = setup(tmp.current, { resolveFails: true });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("LegacyDbConfigLoadError");
      }
      // The config failed before any side effect: no migrations dir, no overwrite prompt.
      expect(existsSync(migrationsDir(tmp.current))).toBe(false);
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "rejects --db-url combined with --linked before reading the project .env (CLI-1878)",
    () => {
      // Cobra's `MarkFlagsMutuallyExclusive` validates at parse time, ahead of the root
      // `PersistentPreRunE` that runs `ParseDatabaseConfig`/`loadNestedEnv` — so a flag
      // conflict must surface even when `supabase/.env` is malformed (which would abort a
      // project-env load with a DIFFERENT error, `LegacyDbConfigLoadError`, if the env load
      // ran first). Locks in the fix that reordered the project-env load in `fetch.handler.ts`
      // to run after this flag-group check.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", ".env"), "!=broken\n");
      const { layer } = setup(tmp.current, {
        cliArgs: ["--db-url", "postgresql://x", "--linked"],
      });
      return Effect.gen(function* () {
        const exit = yield* legacyMigrationFetch(
          flags({ dbUrl: Option.some("postgresql://x") }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && failure.value._tag).toBe(
            "LegacyMigrationTargetFlagsError",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "fetches from the project given via --project-ref, overriding the default linked ref",
    () => {
      // The fake resolver's own fallback (LEGACY_VALID_REF) represents whatever
      // the workdir would resolve to absent the flag — the flag must win over it
      // and drive the cached ref.
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, cache } = setup(tmp.current, { rows: [] });
      return Effect.gen(function* () {
        yield* legacyMigrationFetch(flags({ projectRef: Option.some(FLAG_REF) }));
        expect(cache.cached).toBe(true);
        expect(cache.cachedRef).toBe(FLAG_REF);
        expect(cache.cachedRef).not.toBe(LEGACY_VALID_REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, out, cache } = setup(tmp.current, { cliArgs: ["--local"] });
    return Effect.gen(function* () {
      const exit = yield* legacyMigrationFetch(
        flags({ linked: false, local: true, projectRef: Option.some(FLAG_REF) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe(
          "LegacyMigrationTargetFlagsError",
        );
        expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        );
      }
      // The guard fires before any connection resolution, filesystem write, or
      // cache write.
      expect(existsSync(migrationsDir(tmp.current))).toBe(false);
      expect(out.promptConfirmCalls.length).toBe(0);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
