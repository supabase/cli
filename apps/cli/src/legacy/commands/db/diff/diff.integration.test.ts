import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { stripAnsi } from "../../../../../tests/helpers/ansi.ts";
import {
  legacyFailWriteStringOnNthCallFsLayer,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import {
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { LegacyEdgeRuntimeScriptError } from "../../../shared/legacy-edge-runtime-script.errors.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import {
  LegacyPgDeltaEngine,
  type LegacyPgDeltaDatabaseDiffInput,
  type LegacyPgDeltaExplicitDiffInput,
} from "../shared/legacy-pgdelta-engine.service.ts";
import { LegacyDeclarativeSeam } from "../shared/legacy-pgdelta.seam.service.ts";
import type { LegacyDbDiffFlags } from "./diff.command.ts";
import { legacyDbDiff } from "./diff.handler.ts";

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly isLocal?: boolean;
  readonly linkedRef?: string;
  readonly diffSql?: string;
  // When set, the pg-delta strategy mock returns one rendered file per entry.
  readonly diffFiles?: ReadonlyArray<{ readonly name: string; readonly sql: string }>;
  // Exact suffixes returned by the next renderer, parallel to `diffFiles`.
  readonly diffSuffixes?: ReadonlyArray<string | null>;
  readonly pgDeltaImplementation?: "legacy" | "next";
  readonly oom?: boolean; // edge-runtime OOMs; the bash fallback returns `diffSql`
  readonly delegateStdout?: string; // stdout returned by a captured Go-delegate run
  readonly networkId?: string; // --network-id value forwarded to docker runs
  // When set, the Nth `writeFileString` fails, exercising cleanup-on-failure.
  readonly failWriteOnCall?: number;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const provisionCalls: Array<{
    mode: string;
    projectRef?: string;
  }> = [];
  const removedContainers: string[] = [];
  const seam = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: () => Effect.succeed("supabase/.temp/pgdelta/migrations.json"),
    ensureLocalDatabaseStarted: () => Effect.void,
    ensureLocalPostgresImageCurrent: () => Effect.void,
    provisionShadow: ({ mode, projectRef }) => {
      provisionCalls.push({ mode, projectRef });
      return Effect.succeed({
        container: "shadow-1",
        sourceUrl: "postgres://postgres:postgres@127.0.0.1:54320/postgres",
      });
    },
    provisionNextShadow: () => Effect.die("provisionNextShadow not used"),
    removeShadowContainer: (container) =>
      Effect.sync(() => {
        removedContainers.push(container);
      }),
  });

  const explicitDiffCalls: LegacyPgDeltaExplicitDiffInput[] = [];
  const databaseDiffCalls: LegacyPgDeltaDatabaseDiffInput[] = [];
  const pgDeltaResult = () => {
    const sql = opts.diffSql ?? "";
    const files =
      opts.diffFiles !== undefined
        ? opts.diffFiles.map((file, index) => ({
            sequence: index + 1,
            name: file.name,
            ...(opts.diffSuffixes?.[index] !== undefined
              ? { suffix: opts.diffSuffixes[index] }
              : {}),
            sql: file.sql,
            transactionMode: "transactional" as const,
          }))
        : sql.length > 0
          ? [
              {
                sequence: 1,
                name: "schema_changes",
                sql,
                transactionMode: "transactional" as const,
              },
            ]
          : [];
    return {
      changes: files.length > 0,
      sql: opts.diffFiles !== undefined ? files.map((file) => file.sql).join("\n\n") : sql,
      files,
    };
  };
  const pgDeltaEngine = Layer.succeed(
    LegacyPgDeltaEngine,
    LegacyPgDeltaEngine.of({
      // The handler must route through this strategy even when the selected
      // implementation is legacy; the strategy owns edge runtime and shadows.
      implementation: opts.pgDeltaImplementation ?? "legacy",
      diffExplicit: (input) =>
        Effect.sync(() => {
          explicitDiffCalls.push(input);
          return pgDeltaResult();
        }),
      diffDatabase: (input) =>
        Effect.sync(() => {
          databaseDiffCalls.push(input);
          return pgDeltaResult();
        }),
      exportDeclarativeSchema: () => Effect.die("exportDeclarativeSchema unused"),
      planDeclarativeSchema: () => Effect.die("planDeclarativeSchema unused"),
    }),
  );

  const edgeCalls: LegacyEdgeRuntimeRunOpts[] = [];
  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      edgeCalls.push(runOpts);
      if (opts.oom) {
        return Effect.fail(
          new LegacyEdgeRuntimeScriptError({ message: "Fatal JavaScript out of memory" }),
        );
      }
      return Effect.succeed({ stdout: opts.diffSql ?? "", stderr: "" });
    },
  });

  // Exercised only by the migra OOM bash fallback.
  const dockerCalls: unknown[] = [];
  const docker = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: (dockerOpts) => {
      dockerCalls.push(dockerOpts);
      return Effect.succeed({
        exitCode: 0,
        stdout: new TextEncoder().encode(opts.diffSql ?? ""),
        stderr: "",
      });
    },
    runStream: () => Effect.die("runStream unused"),
  });

  const dbConnection = Layer.succeed(LegacyDbConnection, {
    connect: () => Effect.die("connect unused"),
  });

  const resolverCalls: unknown[] = [];
  const resolver = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (resolveFlags) => {
      resolverCalls.push(resolveFlags);
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "postgres",
          database: "postgres",
        },
        isLocal: opts.isLocal ?? true,
        ref: opts.linkedRef !== undefined ? Option.some(opts.linkedRef) : Option.none(),
      });
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const proxyCalls: Array<{ args: ReadonlyArray<string>; env?: Record<string, string> }> = [];
  const proxyCaptureCalls: Array<{ args: ReadonlyArray<string>; env?: Record<string, string> }> =
    [];
  const proxy = Layer.succeed(LegacyGoProxy, {
    exec: (args, execOpts) => Effect.sync(() => void proxyCalls.push({ args, env: execOpts?.env })),
    execCapture: (args, execOpts) =>
      Effect.sync(() => {
        proxyCaptureCalls.push({ args, env: execOpts?.env });
        return opts.delegateStdout ?? "";
      }),
  });

  const baseLayer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    cache.layer,
    seam,
    pgDeltaEngine,
    edge,
    docker,
    dbConnection,
    resolver,
    proxy,
    mockLegacyCliConfig({ workdir, projectId: Option.some("test") }),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(
      LegacyNetworkIdFlag,
      opts.networkId === undefined ? Option.none() : Option.some(opts.networkId),
    ),
    Layer.succeed(LegacyPgDeltaSslProbe, {
      requireSsl: () => Effect.succeed(false),
      requireSslForHost: () => Effect.succeed(false),
    }),
    mockRuntimeInfo(),
    BunServices.layer,
  );
  // Merged last so its `FileSystem` overrides `BunServices` (last-wins); `Path`
  // still resolves from `BunServices`.
  const layer =
    opts.failWriteOnCall === undefined
      ? baseLayer
      : Layer.merge(baseLayer, legacyFailWriteStringOnNthCallFsLayer(opts.failWriteOnCall));

  return {
    layer,
    out,
    cache,
    telemetry,
    provisionCalls,
    removedContainers,
    explicitDiffCalls,
    databaseDiffCalls,
    edgeCalls,
    resolverCalls,
    proxyCalls,
    proxyCaptureCalls,
    dockerCalls,
  };
}

const flags = (over: Partial<LegacyDbDiffFlags> = {}): LegacyDbDiffFlags => ({
  useMigra: over.useMigra ?? Option.none(),
  usePgAdmin: over.usePgAdmin ?? Option.none(),
  usePgSchema: over.usePgSchema ?? Option.none(),
  usePgDelta: over.usePgDelta ?? Option.none(),
  strictCoverage: over.strictCoverage ?? false,
  from: over.from ?? Option.none(),
  to: over.to ?? Option.none(),
  output: over.output ?? Option.none(),
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? Option.none(),
  local: over.local ?? Option.none(),
  file: over.file ?? Option.none(),
  schema: over.schema ?? [],
});

const stdout = (out: ReturnType<typeof mockOutput>) =>
  stripAnsi(
    out.rawChunks
      .filter((c) => c.stream === "stdout")
      .map((c) => c.text)
      .join(""),
  );
const stderr = (out: ReturnType<typeof mockOutput>) =>
  stripAnsi(
    out.rawChunks
      .filter((c) => c.stream === "stderr")
      .map((c) => c.text)
      .join(""),
  );

const tmp = useLegacyTempWorkdir();

describe("legacy db diff", () => {
  it.effect("diffs local with the default migra engine and prints SQL to stdout", () => {
    const s = setup(tmp.current, { diffSql: "create table players ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(s.provisionCalls).toEqual([{ mode: "diff", projectRef: undefined }]);
      expect(stdout(s.out)).toBe("create table players ();\n\n");
      expect(stderr(s.out)).toContain("Creating shadow database...");
      expect(stderr(s.out)).toContain("Diffing schemas...");
      expect(stderr(s.out)).toContain("Finished supabase db diff on branch");
      expect(s.removedContainers).toEqual(["shadow-1"]);
      expect(s.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("diffs local with pgdelta when --use-pg-delta is set", () => {
    const s = setup(tmp.current, { diffSql: "create table p ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({ usePgDelta: Option.some(true), strictCoverage: true, schema: ["public"] }),
      );
      expect(s.provisionCalls).toEqual([]);
      expect(s.databaseDiffCalls).toHaveLength(1);
      expect(s.databaseDiffCalls[0]).toMatchObject({
        schema: ["public"],
        strictCoverage: true,
        target: {
          kind: "database",
          connection: {
            host: "127.0.0.1",
            port: 54322,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
      });
      // Even the legacy implementation is hidden behind LegacyPgDeltaEngine;
      // the handler no longer invokes edge runtime itself.
      expect(s.edgeCalls).toEqual([]);
      expect(stderr(s.out)).toContain("Diffing schemas: public");
      expect(stdout(s.out)).toBe("create table p ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("next local diff ignores schema_paths and declarative files", () => {
    mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db.migrations]",
        'schema_paths = ["configured.sql"]',
        "",
        "[experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    writeFileSync(join(tmp.current, "supabase", "configured.sql"), "create table configured ();\n");
    writeFileSync(
      join(tmp.current, "supabase", "database", "ignored.sql"),
      "create table ignored ();\n",
    );
    const s = setup(tmp.current, {
      pgDeltaImplementation: "next",
      diffSql: "create table result ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true) }));
      expect(s.databaseDiffCalls[0]).not.toHaveProperty("declarativeFiles");
      expect(s.databaseDiffCalls[0]).not.toHaveProperty("declarativeManifest");
      expect(stderr(s.out)).toContain("schema_paths no longer changes the migrations baseline");
      expect(stderr(s.out)).not.toContain("db diff -f uses supabase/migrations");
      expect(stdout(s.out)).toBe("create table result ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a linked [remotes.<ref>] block enabling pg-delta selects the pg-delta engine", () => {
    // Go loads the project ref before LoadConfig on the linked path, merging the
    // matching [remotes.<ref>] block before experimental.pgdelta.enabled is read
    // (flags/db_url.go:87-97). The default db diff target is local (no merge), so
    // this only applies with --linked; base config disables pg-delta, the remote
    // override enables it, so the diff must pick the pg-delta engine.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[experimental.pgdelta]",
        "enabled = false",
        "",
        "[remotes.staging]",
        'project_id = "abcdefghijklmnopqrst"',
        "",
        "[remotes.staging.experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "alter table x;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ linked: Option.some(true) }));
      expect(s.provisionCalls).toEqual([]);
      expect(s.databaseDiffCalls[0]?.projectRef).toBe("abcdefghijklmnopqrst");
      expect(s.databaseDiffCalls[0]?.target.connectOptions.isLocal).toBe(false);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("the base config (default local target) does not merge a remote block", () => {
    // The default db diff target is local; Go never calls LoadProjectRef for local,
    // so a [remotes.<ref>] override must be ignored and the base engine (migra) wins.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[experimental.pgdelta]",
        "enabled = false",
        "",
        "[remotes.staging]",
        'project_id = "abcdefghijklmnopqrst"',
        "",
        "[remotes.staging.experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, { diffSql: "create table players ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      // The local default never passes a ref, so the shadow uses base config.
      expect(s.provisionCalls[0]?.projectRef).toBeUndefined();
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("diffs the linked project and writes the linked-project cache", () => {
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "alter table x;\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ linked: Option.some(true) }));
      expect(s.provisionCalls[0]?.projectRef).toBe("abcdefghijklmnopqrst");
      expect(s.cache.cached).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("uses the selected local database as the migra target", () => {
    const s = setup(tmp.current, { diffSql: "create table o ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(stdout(s.out)).toBe("create table o ();\n\n");
      expect(s.removedContainers).toEqual(["shadow-1"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("delegates --use-pgadmin to the Go binary (telemetry disabled on the child)", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
      expect(s.proxyCalls).toHaveLength(1);
      expect(s.proxyCalls[0]?.args).toEqual(["db", "diff", "--use-pgadmin"]);
      expect(s.proxyCalls[0]?.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: "1" });
      expect(s.provisionCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a delegated --use-pgadmin does not validate the base config first", () => {
    // The delegate forwards the whole command to the Go child, which loads config
    // itself (with the linked ref). So the TS path must NOT read/validate the base
    // config up front — otherwise a project that's only valid after a [remotes.<ref>]
    // merge (here: base db.major_version=16 is invalid) fails before delegating,
    // even though Go validates the remote-merged config and succeeds.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\nmajor_version = 16\n");
    const s = setup(tmp.current, { isLocal: false, linkedRef: "abcdefghijklmnopqrst" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), linked: Option.some(true) }));
      expect(s.proxyCalls).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("a native local diff still validates the base config", () => {
    // Control for the delegate case: the local/db-url native path reads the base
    // config (Go's local LoadConfig, no remote merge), so an invalid base value
    // (db.major_version=16) must still fail — matching Go.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "config.toml"), "[db]\nmajor_version = 16\n");
    const s = setup(tmp.current, { diffSql: "create table x ();\n" });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(flags()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("re-quotes a comma-containing schema when delegating the diff", () => {
    // flags.schema holds the single parsed value `tenant,one`; forwarding it raw
    // would let the Go child's pflag StringSlice CSV-split it into two schemas, so
    // it must be re-encoded as a quoted CSV field.
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), schema: ["tenant,one"] }));
      const args = s.proxyCalls[0]?.args ?? [];
      const idx = args.indexOf("--schema");
      expect(args[idx + 1]).toBe('"tenant,one"');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "delegates --use-pg-schema to the Go binary, printing a deprecation warning without duplicating Go's own warning",
    () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgSchema: Option.some(true) }));
        // CLI-1960: the TS wrapper prints its own deprecation notice pointing at
        // pg-delta / the default migra engine, additive to (not a replacement for)
        // the delegated Go child's own "experimental" warning (`cmd/db.go:121`,
        // unchanged, printed by the real Go binary rather than this mocked proxy).
        // Assert on a stable substring so future wording tweaks don't require
        // touching every test site.
        expect(stderr(s.out)).toContain('"--use-pg-schema" is deprecated');
        // The TS wrapper must not print a second copy of Go's own warning.
        expect(stderr(s.out)).not.toContain("--use-pg-schema flag is experimental");
        // Delegation to Go is unchanged besides the new warning.
        expect(s.proxyCalls[0]?.args).toEqual(["db", "diff", "--use-pg-schema"]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("does not print the --use-pg-schema deprecation warning on other diff paths", () => {
    const s = setup(tmp.current, { diffSql: "create table g ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(stderr(s.out)).not.toContain('"--use-pg-schema" is deprecated');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "does not print the --use-pg-schema deprecation warning when delegating --use-pgadmin",
    () => {
      const s = setup(tmp.current);
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
        expect(stderr(s.out)).not.toContain('"--use-pg-schema" is deprecated');
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("--use-pgadmin in json mode wraps the captured SQL in a structured envelope", () => {
    // Regression: the delegated child inherited stdout and returned without
    // output.success, so machine-mode stdout carried the Go child's raw SQL
    // instead of a JSON envelope (CLI-1546). Now the child's stdout is captured
    // and re-emitted as the structured payload.
    const s = setup(tmp.current, { format: "json", delegateStdout: "create table d ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true) }));
      // stdout stays payload-only; the child's SQL was captured, not inherited.
      expect(stdout(s.out)).toBe("");
      expect(s.proxyCalls).toHaveLength(0);
      expect(s.proxyCaptureCalls).toHaveLength(1);
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({
        diff: "create table d ();\n",
        file: null,
        engine: "pgadmin",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("--use-pg-schema in json mode wraps the captured SQL in a structured envelope", () => {
    const s = setup(tmp.current, { format: "json", delegateStdout: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgSchema: Option.some(true) }));
      expect(stdout(s.out)).toBe("");
      expect(s.proxyCaptureCalls).toHaveLength(1);
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ diff: "create table e ();\n", engine: "pg-schema" });
      // CLI-1960: the deprecation notice is a diagnostic, so it must still reach
      // stderr in machine output mode (CLI-1546) rather than being dropped or
      // leaking into the stdout payload.
      expect(stderr(s.out)).toContain('"--use-pg-schema" is deprecated');
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes live-only SQL with --file even when declarative targets are configured", () => {
    mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db.migrations]",
        'schema_paths = ["database/*.sql"]',
        "",
        "[experimental.pgdelta]",
        "enabled = true",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(tmp.current, "supabase", "database", "declarative.sql"),
      "create table declarative_only ();\n",
    );
    const s = setup(tmp.current, {
      pgDeltaImplementation: "next",
      diffSql: "create table live_only ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      expect(stdout(s.out)).toBe("");
      expect(stderr(s.out)).toContain("schema_paths no longer changes the migrations baseline");
      expect(stderr(s.out)).toContain("db diff -f uses supabase/migrations as its baseline");
      expect(stderr(s.out)).toContain("-f names the migration; it does not filter objects");
      expect(stderr(s.out)).toContain("WARNING: The diff tool is not foolproof");
      const dir = join(tmp.current, "supabase", "migrations");
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{14}_my_diff\.sql$/);
      expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("create table live_only ();\n");
    }).pipe(Effect.provide(s.layer));
  });

  for (const format of ["json", "stream-json"] as const) {
    it.effect(`includes the ignored declarative baseline advisory in ${format} output`, () => {
      mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "database", "items.sql"),
        "create table items ();\n",
      );
      const s = setup(tmp.current, {
        format,
        pgDeltaImplementation: "next",
        diffSql: "create table dogfood_note ();\n",
      });
      return Effect.gen(function* () {
        yield* legacyDbDiff(
          flags({ usePgDelta: Option.some(true), file: Option.some("dogfood_note") }),
        );
        const success = s.out.messages.find((message) => message.type === "success");
        expect(success?.data).toMatchObject({
          diff: "create table dogfood_note ();\n",
          engine: "pg-delta",
          advisories: [
            {
              code: "DeclarativeSchemaNotUsedAsDiffBaseline",
              severity: "info",
              context: {
                baseline: "supabase/migrations",
                declarativePath: "supabase/database",
                fileFlagFiltersObjects: false,
              },
            },
          ],
        });
        expect(stderr(s.out)).toContain("db diff -f uses supabase/migrations as its baseline");
        const written = readdirSync(join(tmp.current, "supabase", "migrations"));
        expect(written).toHaveLength(1);
        expect(readFileSync(join(tmp.current, "supabase", "migrations", written[0]!), "utf8")).toBe(
          "create table dogfood_note ();\n",
        );
      }).pipe(Effect.provide(s.layer));
    });
  }

  it.effect("does not emit the advisory for the legacy pg-delta implementation", () => {
    mkdirSync(join(tmp.current, "supabase", "database"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "database", "items.sql"),
      "create table items ();\n",
    );
    const s = setup(tmp.current, {
      format: "json",
      pgDeltaImplementation: "legacy",
      diffSql: "create table dogfood_note ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({ usePgDelta: Option.some(true), file: Option.some("dogfood_note") }),
      );
      const success = s.out.messages.find((message) => message.type === "success");
      expect(success?.data).not.toHaveProperty("advisories");
      expect(stderr(s.out)).not.toContain("db diff -f uses supabase/migrations");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("ignores declarative inspection errors without changing diff success", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[experimental.pgdelta]",
        "enabled = true",
        'declarative_schema_path = "not-a-directory.sql"',
        "",
      ].join("\n"),
    );
    writeFileSync(join(tmp.current, "supabase", "not-a-directory.sql"), "select 1;\n");
    const s = setup(tmp.current, {
      format: "json",
      pgDeltaImplementation: "next",
      diffSql: "create table dogfood_note ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({ usePgDelta: Option.some(true), file: Option.some("dogfood_note") }),
      );
      const success = s.out.messages.find((message) => message.type === "success");
      expect(success?.data).not.toHaveProperty("advisories");
      expect(success?.data).toMatchObject({ diff: "create table dogfood_note ();\n" });
      expect(stderr(s.out)).not.toContain("db diff -f uses supabase/migrations");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("writes one migration file per unit for a multi-unit pg-delta plan", () => {
    // A pg-delta plan that crosses a transaction boundary yields more than one
    // ordered unit; writing them into one migration would fail when db push/reset
    // applies it as a single transaction. Each unit becomes its own file (Go's
    // WritePgDeltaMigrations), named `<name>_<unit>` with strictly increasing
    // timestamps, and the machine payload's `files` lists them all.
    const s = setup(tmp.current, {
      format: "json",
      diffFiles: [
        { name: "schema_changes", sql: "alter type mood add value 'ok';" },
        { name: "after_enum_values", sql: "insert into t values ('ok');" },
      ],
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      const dir = join(tmp.current, "supabase", "migrations");
      const files = readdirSync(dir).sort();
      expect(files).toHaveLength(2);
      expect(files[0]).toMatch(/^\d{14}_my_diff_schema_changes\.sql$/);
      expect(files[1]).toMatch(/^\d{14}_my_diff_after_enum_values\.sql$/);
      // Each unit's file carries only that unit's SQL, terminated with a newline.
      expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("alter type mood add value 'ok';\n");
      const success = s.out.messages.find((m) => m.type === "success");
      const data = success?.data as { file: string; files: ReadonlyArray<string> };
      expect(data.files).toHaveLength(2);
      // `file` stays the first written path for released string-field consumers.
      expect(data.file).toBe(data.files[0]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("uses exact next-renderer suffixes for multi-file migration names", () => {
    const s = setup(tmp.current, {
      diffFiles: [
        { name: "ignored_legacy_name", sql: "a" },
        { name: "ignored_legacy_name", sql: "b" },
      ],
      diffSuffixes: ["_1", "_2"],
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      const dir = join(tmp.current, "supabase", "migrations");
      expect(readdirSync(dir).sort()).toEqual([
        "19700101000000_my_diff_1.sql",
        "19700101000001_my_diff_2.sql",
      ]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("creates nested parent directories for a nested single-unit --file name", () => {
    // `db diff -f snapshots/remote` must create the `<ts>_snapshots/` parent dir
    // before writing, mirroring Go's `utils.WriteFile`.
    const s = setup(tmp.current, { diffSql: "create table g ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ file: Option.some("snapshots/remote") }));
      const migrationsRoot = join(tmp.current, "supabase", "migrations");
      const dirs = readdirSync(migrationsRoot);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toMatch(/^\d{14}_snapshots$/);
      expect(readdirSync(join(migrationsRoot, dirs[0]!))).toEqual(["remote.sql"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("creates nested parent directories for a nested multi-unit --file name", () => {
    const s = setup(tmp.current, {
      format: "json",
      diffFiles: [
        { name: "schema_changes", sql: "alter type mood add value 'ok';" },
        { name: "after_enum_values", sql: "insert into t values ('ok');" },
      ],
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({ usePgDelta: Option.some(true), file: Option.some("snapshots/remote") }),
      );
      const success = s.out.messages.find((m) => m.type === "success");
      const data = success?.data as { files: ReadonlyArray<string> };
      expect(data.files).toHaveLength(2);
      for (const written of data.files) expect(existsSync(written)).toBe(true);
      expect(data.files[0]).toMatch(/\d{14}_snapshots\/remote_schema_changes\.sql$/u);
      expect(data.files[1]).toMatch(/\d{14}_snapshots\/remote_after_enum_values\.sql$/u);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("bumps the version set when a target migration file already exists", () => {
    // The full generated set is collision-checked before writing; if any target
    // exists the base advances one second so the new files stay strictly ascending
    // AND never overwrite the pre-existing migration.
    const s = setup(tmp.current, {
      format: "json",
      diffFiles: [
        { name: "schema_changes", sql: "a" },
        { name: "after_enum_values", sql: "b" },
      ],
    });
    return Effect.gen(function* () {
      const dir = join(tmp.current, "supabase", "migrations");
      mkdirSync(dir, { recursive: true });
      // TestClock starts at epoch 0, so the first version the writer tries is
      // 19700101000000; pre-seed a colliding file at that version.
      const clashing = join(dir, "19700101000000_my_diff_schema_changes.sql");
      writeFileSync(clashing, "-- pre-existing\n");
      yield* legacyDbDiff(flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }));
      expect(readdirSync(dir).sort()).toEqual([
        "19700101000000_my_diff_schema_changes.sql",
        "19700101000001_my_diff_schema_changes.sql",
        "19700101000002_my_diff_after_enum_values.sql",
      ]);
      // The pre-existing file was never overwritten.
      expect(readFileSync(clashing, "utf8")).toBe("-- pre-existing\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("removes already-written unit files when a later unit write fails", () => {
    // A mid-loop write failure best-effort removes every file this invocation
    // already wrote, so no partial multi-file migration is left behind.
    const s = setup(tmp.current, {
      format: "json",
      failWriteOnCall: 2,
      diffFiles: [
        { name: "schema_changes", sql: "a" },
        { name: "after_enum_values", sql: "b" },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(
        flags({ usePgDelta: Option.some(true), file: Option.some("my_diff") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const dir = join(tmp.current, "supabase", "migrations");
      const remaining = existsSync(dir) ? readdirSync(dir) : [];
      expect(remaining).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to linked prints the diff to stdout", () => {
    const s = setup(tmp.current, { isLocal: false, diffSql: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("local"), to: Option.some("linked") }));
      // Explicit mode is pg-delta and never provisions a shadow.
      expect(s.provisionCalls).toEqual([]);
      expect(s.explicitDiffCalls[0]).toMatchObject({
        source: {
          kind: "database",
          connection: {
            host: "127.0.0.1",
            user: "postgres",
            database: "postgres",
          },
          connectOptions: { isLocal: true, dnsResolver: "native" },
        },
        desired: {
          kind: "database",
          connection: {
            host: "127.0.0.1",
            port: 54322,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          connectOptions: { isLocal: false, dnsResolver: "native" },
        },
      });
      expect(stdout(s.out)).toBe("create table e ();\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit URL endpoints retain the raw ref and remote connection options", () => {
    const s = setup(tmp.current, { diffSql: "create table u ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({
          from: Option.some("postgresql://source.example/postgres"),
          to: Option.some("postgresql://desired.example/postgres"),
        }),
      );
      expect(s.explicitDiffCalls[0]?.source).toEqual({
        kind: "database",
        ref: "postgresql://source.example/postgres",
        connectOptions: { isLocal: false, dnsResolver: "native" },
      });
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "database",
        ref: "postgresql://desired.example/postgres",
        connectOptions: { isLocal: false, dnsResolver: "native" },
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --output writes raw SQL to the given path", () => {
    const s = setup(tmp.current, { diffSql: "create table w ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("local"),
          output: Option.some("out.sql"),
        }),
      );
      expect(existsSync(join(tmp.current, "out.sql"))).toBe(true);
      expect(stdout(s.out)).toBe("");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("forwards an explicit --linked=false target flag to the delegated child", () => {
    // Target flags are selectors keyed on flag.Changed in Go; dropping Some(false)
    // would make the child default to local instead of the linked target the
    // native path selected.
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ usePgAdmin: Option.some(true), linked: Option.some(false) }));
      expect(s.proxyCalls[0]?.args).toEqual(["db", "diff", "--use-pgadmin", "--linked=false"]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect(
    "an empty --file value prints to stdout instead of writing a nameless migration",
    () => {
      // Go's SaveDiff gates the file write on len(file) > 0; an empty --file (e.g.
      // an unset shell var) falls through to stdout rather than writing
      // `<timestamp>_.sql`.
      const s = setup(tmp.current, { diffSql: "create table y ();\n" });
      return Effect.gen(function* () {
        yield* legacyDbDiff(flags({ file: Option.some("") }));
        expect(stdout(s.out)).toContain("create table y ();");
        const migrationsDir = join(tmp.current, "supabase", "migrations");
        expect(existsSync(migrationsDir) ? readdirSync(migrationsDir) : []).toEqual([]);
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect(
    "explicit --output with an empty value prints to stdout instead of writing a file",
    () => {
      // Go gates the file write on len(outputPath) > 0; an empty value falls through
      // to stdout rather than writing SQL into the project directory.
      const s = setup(tmp.current, { diffSql: "create table z ();\n" });
      return Effect.gen(function* () {
        yield* legacyDbDiff(
          flags({ from: Option.some("local"), to: Option.some("local"), output: Option.some("") }),
        );
        // Reaching stdout proves it didn't try to write SQL to the resolved workdir.
        expect(stdout(s.out)).toBe("create table z ();\n");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.effect("explicit --from migrations routes the migrations endpoint to the strategy", () => {
    const s = setup(tmp.current, { diffSql: "create table m ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("migrations"), to: Option.some("local") }));
      expect(s.explicitDiffCalls[0]?.source).toEqual({ kind: "migrations" });
      expect(s.edgeCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from linked --to migrations passes the linked ref to the strategy", () => {
    // Go resolves linked first (LoadConfig merges [remotes.<ref>]), so the later
    // migrations catalog is built from the remote-merged config (explicit.go).
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("linked"), to: Option.some("migrations") }));
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "migrations",
        projectRef: "abcdefghijklmnopqrst",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from migrations --to linked passes base config to the strategy", () => {
    // Migrations is resolved BEFORE linked here, so Go's LoadConfig(ref) hasn't run
    // yet — the catalog must use base config (no ref forwarded), matching order.
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some("migrations"), to: Option.some("linked") }));
      expect(s.explicitDiffCalls[0]?.source).toEqual({ kind: "migrations" });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to migrations --linked seeds the merged config", () => {
    // Go's root ParseDatabaseConfig runs LoadProjectRef+LoadConfig for a changed
    // --linked before RunExplicit, leaving the config remote-merged — so the
    // migrations catalog (and local refs/format options) use the linked override
    // even though neither explicit ref is itself `linked`.
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("migrations"),
          linked: Option.some(true),
        }),
      );
      expect(s.explicitDiffCalls[0]?.desired).toEqual({
        kind: "migrations",
        projectRef: "abcdefghijklmnopqrst",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit --from local --to migrations --linked validates the merged config", () => {
    // The explicit base config read is deferred until after the linked preflight, so
    // a base config that's only valid after the [remotes.<ref>] merge (base
    // major_version=16, override=15) does not fail before the ref is resolved —
    // matching Go's stateful pre-run (LoadConfig after LoadProjectRef on --linked).
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "config.toml"),
      [
        "[db]",
        "major_version = 16",
        "",
        "[remotes.staging]",
        'project_id = "abcdefghijklmnopqrst"',
        "",
        "[remotes.staging.db]",
        "major_version = 15",
        "",
      ].join("\n"),
    );
    const s = setup(tmp.current, {
      isLocal: false,
      linkedRef: "abcdefghijklmnopqrst",
      diffSql: "create table m ();\n",
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("migrations"),
          linked: Option.some(true),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("empty --from/--to (shell vars) fall through to the normal diff", () => {
    // Go gates explicit mode on len(diffFrom)>0 || len(diffTo)>0; `--from "" --to ""`
    // is unset and runs the normal local diff, not an unknown-target error.
    const s = setup(tmp.current, { diffSql: "create table e ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ from: Option.some(""), to: Option.some("") }));
      // Reaching the native path proves it didn't enter explicit mode and error.
      expect(s.provisionCalls).toHaveLength(1);
      expect(stdout(s.out)).toBe("create table e ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("an explicit --from with an empty --to still errors 'must set both'", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(
        flags({ from: Option.some("local"), to: Option.some("") }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("explicit mode still runs the target-flag preflight on a changed --db-url", () => {
    // Go runs ParseDatabaseConfig in PreRun before RunExplicit (cmd/root.go:118),
    // so a changed target flag is still validated/loaded even when the explicit
    // refs drive the diff. The preflight resolves the --db-url target (connType
    // db-url); a real bad URL would surface the resolver's parse error.
    const s = setup(tmp.current, { diffSql: "create table p ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(
        flags({
          from: Option.some("local"),
          to: Option.some("local"),
          dbUrl: Option.some("postgresql://x"),
        }),
      );
      expect(s.resolverCalls).toContainEqual(expect.objectContaining({ connType: "db-url" }));
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails when --from is set without --to", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(flags({ from: Option.some("local") })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails on engine-flag conflict (--use-migra with --use-pg-delta)", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(
        flags({ useMigra: Option.some(true), usePgDelta: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("fails on target mutex (--linked with --local)", () => {
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* legacyDbDiff(
        flags({ linked: Option.some(true), local: Option.some(true) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("warns on drop statements in the diff", () => {
    const s = setup(tmp.current, { diffSql: "drop table gone;\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(stderr(s.out)).toContain("Found drop statements in schema diff");
      expect(stderr(s.out)).toContain("drop table gone");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("emits a json envelope with --output-format json (payload-only stdout)", () => {
    const s = setup(tmp.current, { format: "json", diffSql: "create table j ();\n" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      // No raw SQL on stdout in machine mode; the envelope carries it instead.
      expect(stdout(s.out)).toBe("");
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({
        diff: "create table j ();\n",
        file: null,
        engine: "migra",
      });
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("prints 'No schema changes found' and exits 0 on an empty diff", () => {
    const s = setup(tmp.current, { diffSql: "" });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags());
      expect(stderr(s.out)).toContain("No schema changes found");
      expect(stdout(s.out)).toBe("");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("falls back to the migra Docker image when edge-runtime OOMs", () => {
    const s = setup(tmp.current, { oom: true, diffSql: "create table fb ();\n", isLocal: true });
    return Effect.gen(function* () {
      // Pass --schema so the fallback does not need a live DB to list schemas.
      yield* legacyDbDiff(flags({ schema: ["public"] }));
      expect(s.dockerCalls).toHaveLength(1);
      expect(stdout(s.out)).toBe("create table fb ();\n\n");
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("the migra OOM fallback honors --network-id over host networking", () => {
    // Go's bash fallback routes through DockerStart, which overrides the requested
    // host network with --network-id when set (internal/utils/docker.go:266-271).
    const s = setup(tmp.current, {
      oom: true,
      diffSql: "create table fb ();\n",
      isLocal: true,
      networkId: "my-net",
    });
    return Effect.gen(function* () {
      yield* legacyDbDiff(flags({ schema: ["public"] }));
      expect(s.dockerCalls).toHaveLength(1);
      expect((s.dockerCalls[0] as { network: unknown }).network).toEqual({
        _tag: "named",
        name: "my-net",
      });
    }).pipe(Effect.provide(s.layer));
  });
});
