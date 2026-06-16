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
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    promptConfirmResponses: opts.promptConfirmResponses,
    promptSelectResponses: opts.promptSelectResponses,
    promptTextResponses: opts.promptTextResponses,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const seamCalls: LegacyCatalogMode[] = [];
  const seam = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: ({ mode }) => {
      seamCalls.push(mode);
      return Effect.succeed("supabase/.temp/pgdelta/base.json");
    },
    execInherit: () => Effect.succeed(0),
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
    mockLegacyCliConfig({ workdir, projectId: Option.some("test") }),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? true),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    BunServices.layer,
  );
  return { layer, out, seamCalls, edgeCalls, resolverCalls, proxyCalls };
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
