import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import {
  VALID_REF,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { migrationFetch } from "./fetch.handler.ts";
import type { MigrationFetchFlags } from "./fetch.command.ts";

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
  /** Raw argv seen by `resolveDbTargetFlags` (e.g. to exercise a flag conflict). */
  readonly cliArgs?: ReadonlyArray<string>;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm === undefined ? undefined : [opts.confirm],
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();

  const resolver = Layer.succeed(DbConfigResolver, {
    resolve: (_flags: DbConfigFlags) =>
      opts.resolveFails === true
        ? Effect.fail(
            new DbConfigLoadError({
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
            ref: Option.some(VALID_REF),
          } satisfies ResolvedDbConfig),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(DbConnection, {
    connect: () =>
      Effect.succeed({
        exec: () => Effect.void,
        execBatch: () => Effect.void,
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
  // (not just the hardcoded `VALID_REF` fallback) drives the linked ref.
  const projectRef = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Effect.succeed(
        Option.isSome(flagValue) && flagValue.value.length > 0 ? flagValue.value : VALID_REF,
      ),
    promptProjectRef: () => Effect.succeed(VALID_REF),
  });

  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    resolver,
    connection,
    projectRef,
    mockCommandSettings({ workdir }),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(YesFlag, opts.yes ?? false),
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

const flags = (over: Partial<MigrationFetchFlags> = {}): MigrationFetchFlags => ({
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? true,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
});

const migrationsDir = (workdir: string) => join(workdir, "supabase", "migrations");
const tmp = useTempWorkdir();

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
      yield* migrationFetch(flags());
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
      yield* migrationFetch(flags());
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
      yield* migrationFetch(flags());
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
      const exit = yield* migrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("OperationCanceledError");
      }
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
      const exit = yield* migrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("OperationCanceledError");
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
      yield* migrationFetch(flags());
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
        yield* migrationFetch(flags());
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
      yield* migrationFetch(flags());
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
      const exit = yield* migrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("OperationCanceledError");
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
      const exit = yield* migrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationFetchWriteError");
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
      yield* migrationFetch(flags());
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
      const exit = yield* migrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationFetchWriteError");
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
      const exit = yield* migrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationFetchWriteError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves DB config before creating the migrations dir or prompting", () => {
    // The DB config resolves before any filesystem/prompt side effect,
    // so an invalid target fails first. With the resolver
    // failing, the supabase/migrations dir must NOT be created and no prompt is shown.
    const { layer, out } = setup(tmp.current, { resolveFails: true });
    return Effect.gen(function* () {
      const exit = yield* migrationFetch(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("DbConfigLoadError");
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
      // project-env load with a DIFFERENT error, `DbConfigLoadError`, if the env load
      // ran first). Locks in the fix that reordered the project-env load in `fetch.handler.ts`
      // to run after this flag-group check.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", ".env"), "!=broken\n");
      const { layer } = setup(tmp.current, {
        cliArgs: ["--db-url", "postgresql://x", "--linked"],
      });
      return Effect.gen(function* () {
        const exit = yield* migrationFetch(flags({ dbUrl: Option.some("postgresql://x") })).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationTargetFlagsError");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "fetches from the project given via --project-ref, overriding the default linked ref",
    () => {
      // The fake resolver's own fallback (VALID_REF) represents whatever
      // the workdir would resolve to absent the flag — the flag must win over it
      // and drive the cached ref.
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, cache } = setup(tmp.current, { rows: [] });
      return Effect.gen(function* () {
        yield* migrationFetch(flags({ projectRef: Option.some(FLAG_REF) }));
        expect(cache.cached).toBe(true);
        expect(cache.cachedRef).toBe(FLAG_REF);
        expect(cache.cachedRef).not.toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, out, cache } = setup(tmp.current, { cliArgs: ["--local"] });
    return Effect.gen(function* () {
      const exit = yield* migrationFetch(
        flags({ linked: false, local: true, projectRef: Option.some(FLAG_REF) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value._tag).toBe("MigrationTargetFlagsError");
        expect(Option.isSome(failure) && (failure.value as { message: string }).message).toBe(
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        );
      }
      expect(existsSync(migrationsDir(tmp.current))).toBe(false);
      expect(out.promptConfirmCalls.length).toBe(0);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
