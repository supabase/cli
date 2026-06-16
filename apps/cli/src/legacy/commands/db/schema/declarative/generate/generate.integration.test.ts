import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput, mockTty } from "../../../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../../../shared/legacy/go-proxy.service.ts";
import { LegacyDbConfigResolver } from "../../../../../shared/legacy-db-config.service.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../../../shared/legacy-edge-runtime-script.service.ts";
import { type LegacyCatalogMode, LegacyDeclarativeSeam } from "../declarative.seam.service.ts";
import type { LegacyDbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";
import { legacyDbSchemaDeclarativeGenerate } from "./generate.handler.ts";

const EXPORT_JSON = JSON.stringify({
  version: 1,
  mode: "declarative",
  files: [
    {
      path: "schemas/public/tables/players.sql",
      order: 0,
      statements: 1,
      sql: "create table players ();",
    },
  ],
});

interface SetupOpts {
  experimental?: boolean;
  yes?: boolean;
  stdinIsTty?: boolean;
  promptConfirmResponses?: ReadonlyArray<boolean>;
  promptSelectResponses?: ReadonlyArray<string>;
  promptTextResponses?: ReadonlyArray<string>;
  exportJson?: string;
  resetExitCode?: number;
  networkId?: Option.Option<string>;
  projectId?: Option.Option<string>;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    promptConfirmResponses: opts.promptConfirmResponses,
    promptSelectResponses: opts.promptSelectResponses,
    promptTextResponses: opts.promptTextResponses,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const seamCalls: LegacyCatalogMode[] = [];
  const execInheritCalls: ReadonlyArray<string>[] = [];
  let ensureStartedCalls = 0;
  const seam = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: ({ mode }) => {
      seamCalls.push(mode);
      return Effect.succeed("supabase/.temp/pgdelta/base.json");
    },
    execInherit: (args) => {
      execInheritCalls.push(args);
      return Effect.succeed(opts.resetExitCode ?? 0);
    },
    ensureLocalDatabaseStarted: () =>
      Effect.sync(() => {
        ensureStartedCalls += 1;
      }),
  });
  const edgeCalls: LegacyEdgeRuntimeRunOpts[] = [];
  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      edgeCalls.push(runOpts);
      return Effect.succeed({ stdout: opts.exportJson ?? EXPORT_JSON, stderr: "" });
    },
  });
  const resolverCalls: unknown[] = [];
  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (flags) => {
      resolverCalls.push(flags);
      return Effect.succeed({
        conn: {
          host: "db.remote",
          port: 5432,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: false,
      });
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  const proxyCalls: ReadonlyArray<string>[] = [];
  const proxy = Layer.succeed(LegacyGoProxy, {
    exec: (args) => Effect.sync(() => void proxyCalls.push(args)),
  });
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    seam,
    edge,
    resolver,
    proxy,
    mockLegacyCliConfig({ workdir, projectId: opts.projectId ?? Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? true),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyNetworkIdFlag, opts.networkId ?? Option.none()),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    BunServices.layer,
  );
  return {
    layer,
    out,
    seamCalls,
    execInheritCalls,
    edgeCalls,
    resolverCalls,
    proxyCalls,
    get ensureStartedCalls() {
      return ensureStartedCalls;
    },
  };
}

const flags = (
  over: Partial<LegacyDbSchemaDeclarativeGenerateFlags> = {},
): LegacyDbSchemaDeclarativeGenerateFlags => ({
  noCache: over.noCache ?? false,
  overwrite: over.overwrite ?? false,
  reset: over.reset ?? false,
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  password: over.password ?? Option.none(),
});

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("legacy db schema declarative generate integration", () => {
  const tmp = useLegacyTempWorkdir();

  it.effect("gate: fails when neither --experimental nor config enables pg-delta", () => {
    const { layer } = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeGenerate(flags({ local: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeNotEnabledError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects conflicting targets (--local --linked) before the pg-delta gate", () => {
    // cobra MarkFlagsMutuallyExclusive("db-url", "linked", "local") runs before
    // PreRunE, so this fails even when pg-delta is not enabled.
    const { layer } = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbSchemaDeclarativeGenerate(flags({ local: true, linked: true })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeMutuallyExclusiveFlagsError",
        message:
          "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("explicit --local: provisions baseline, exports, writes declarative files", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ local: true }));
      expect(s.seamCalls).toEqual(["baseline"]);
      // TARGET is the local DB URL (passthrough); SOURCE is the baseline catalog.
      expect(s.edgeCalls[0]!.env["TARGET"]).toContain(
        "postgresql://postgres:postgres@127.0.0.1:54322",
      );
      const written = yield* Effect.promise(async () =>
        (await import("node:fs")).readFileSync(
          join(tmp.current, "supabase", "database", "schemas", "public", "tables", "players.sql"),
          "utf8",
        ),
      );
      expect(written).toBe("create table players ();");
      expect(s.out.rawChunks.some((c) => c.text.includes("Declarative schema written to"))).toBe(
        true,
      );
      // Go runs ensureLocalDatabaseStarted before generating from local.
      expect(s.ensureStartedCalls).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("honors --yes to overwrite existing declarative files without prompting", () => {
    // Pre-seed the declarative dir so the overwrite branch is reached. With --yes,
    // Go's confirmOverwrite returns true immediately (Console.PromptYesNo); the
    // handler must skip the prompt and overwrite. No promptConfirmResponses are
    // queued, so reaching the prompt would error — success proves --yes bypassed it.
    mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "database", "existing.sql"), "create table x ();");
    const s = setup(tmp.current, { experimental: true, yes: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ local: true }));
      const written = yield* Effect.promise(async () =>
        (await import("node:fs")).readFileSync(
          join(tmp.current, "supabase", "database", "schemas", "public", "tables", "players.sql"),
          "utf8",
        ),
      );
      expect(written).toBe("create table players ();");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --db-url: resolves the remote URL via the resolver", () => {
    const s = setup(tmp.current, { experimental: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(
        flags({ dbUrl: Option.some("postgres://remote/db") }),
      );
      expect(s.resolverCalls.length).toBe(1);
      expect(s.edgeCalls[0]!.env["TARGET"]).toContain("@db.remote:5432");
      // Remote target → the local stack is never started.
      expect(s.ensureStartedCalls).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --linked applies a matching [remotes.<ref>] schema-path override", () => {
    // Go re-loads config with the linked ref (root ParseDatabaseConfig), so a matching
    // [remotes.<ref>] block overrides experimental.pgdelta.declarative_schema_path —
    // the declarative files must land under the remote-overridden path.
    const ref = "abcdefghijklmnopqrst";
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        'project_id = "base"',
        "[experimental.pgdelta]",
        "enabled = true",
        "[remotes.prod]",
        `project_id = "${ref}"`,
        "[remotes.prod.experimental.pgdelta]",
        'declarative_schema_path = "remote_schema"',
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, { experimental: true, projectId: Option.some(ref) });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags({ linked: true }));
      const written = yield* Effect.promise(async () =>
        (await import("node:fs")).readFileSync(
          join(
            tmp.current,
            "supabase",
            "remote_schema",
            "schemas",
            "public",
            "tables",
            "players.sql",
          ),
          "utf8",
        ),
      );
      expect(written).toBe("create table players ();");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: non-TTY without --yes fails with the target hint", () => {
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect((failError(exit) as { message: string }).message).toContain(
        "in non-interactive mode, specify a target",
      );
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: existing files + decline regenerate → skips", () => {
    const declDir = join(tmp.current, "supabase", "database");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "existing.sql"), "-- existing");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptConfirmResponses: [false],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      expect(s.seamCalls).toEqual([]);
      expect(
        s.out.rawChunks.some((c) => c.text.includes("Skipped generating declarative schema")),
      ).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: --yes regenerates over existing files without prompting", () => {
    // Go's overwrite question goes through Console.PromptYesNo, which auto-accepts
    // under --yes, so existing declarative files are regenerated (not skipped) and
    // no prompt is shown. No migrations → the smart target resolves to local without
    // a further prompt. No promptConfirmResponses are queued, so a prompt would throw.
    const declDir = join(tmp.current, "supabase", "database");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "existing.sql"), "-- existing");
    const s = setup(tmp.current, { experimental: true, stdinIsTty: false, yes: true });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      expect(s.seamCalls).toEqual(["baseline"]);
      expect(
        s.out.rawChunks.some((c) => c.text.includes("Skipped generating declarative schema")),
      ).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: propagates a reset failure instead of exiting the process", () => {
    // Go runs reset in-process and returns the error; using the non-exiting seam,
    // a non-zero reset must fail the effect (so telemetry flush / error handling run)
    // rather than process.exit via LegacyGoProxy.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptSelectResponses: ["local"],
      resetExitCode: 1,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeGenerate(flags({ reset: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({ message: "database reset failed (exit 1)" });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: offers and resolves the linked project when the workdir is linked", () => {
    // Go's runDeclarativeGenerate adds a "Linked project" choice when LoadProjectRef
    // succeeds; selecting it builds the URL via NewDbConfigWithPassword (the --linked
    // path). Use a valid 20-char ref so the choice is shown.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      projectId: Option.some("abcdefghijklmnopqrst"),
      promptSelectResponses: ["linked"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      // The prompt offered the linked choice, and selecting it routed through the
      // resolver's --linked branch.
      const options = s.out.promptSelectCalls[0]?.options ?? [];
      expect(options.map((o) => o.value)).toEqual(["local", "linked", "custom"]);
      expect(s.resolverCalls).toContainEqual(expect.objectContaining({ linked: true }));
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: hides the linked choice when the workdir is not linked", () => {
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      projectId: Option.none(),
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      const options = s.out.promptSelectCalls[0]?.options ?? [];
      expect(options.map((o) => o.value)).toEqual(["local", "custom"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: --yes auto-resets the local database without prompting", () => {
    // Go's Console.PromptYesNo auto-returns true under the global --yes flag, so the
    // "Reset local database to match migrations first?" prompt must be skipped and the
    // reset must run. No promptConfirmResponses are supplied, so a prompt would throw.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      yes: true,
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      expect(s.execInheritCalls).toEqual([["db", "reset", "--local"]]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: forwards --network-id to the local reset", () => {
    // Go's in-process reset.Run honors the root viper network-id, so the spawned
    // reset must carry `--network-id` to stay on a custom Docker network.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      yes: true,
      networkId: Option.some("my-net"),
      promptSelectResponses: ["local"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      expect(s.execInheritCalls).toEqual([["db", "reset", "--local", "--network-id", "my-net"]]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: rejects a malformed custom database URL", () => {
    // Go parses the custom URL with pgconn.ParseConfig and fails with
    // "failed to parse connection string: ..." rather than passing it to pg-delta.
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptSelectResponses: ["custom"],
      promptTextResponses: ["not a url"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeGenerate(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeInvalidDbUrlError",
        message: "failed to parse connection string: not a url",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("smart mode: normalizes a valid custom database URL before pg-delta", () => {
    mkdirSync(join(tmp.current, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "migrations", "0001_init.sql"), "select 1;");
    const s = setup(tmp.current, {
      experimental: true,
      stdinIsTty: true,
      promptSelectResponses: ["custom"],
      promptTextResponses: ["postgres://user:secret@db.example.com:5432/app"],
    });
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeGenerate(flags());
      // Normalized via ToPostgresURL → connect_timeout appended, like Go.
      expect(s.edgeCalls[0]!.env["TARGET"]).toContain("@db.example.com:5432/app?connect_timeout=");
    }).pipe(Effect.provide(s.layer));
  });
});
