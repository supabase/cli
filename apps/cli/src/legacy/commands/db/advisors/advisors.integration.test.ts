import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Redacted } from "effect";

import { mockOutput, mockProcessControl } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  LEGACY_VALID_TOKEN,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCredentials } from "../../../auth/legacy-credentials.service.ts";
import { LegacyInvalidAccessTokenError } from "../../../auth/legacy-errors.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigIpv6Error } from "../../../shared/legacy-db-config.errors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyIdentityStitch } from "../../../shared/legacy-identity-stitch.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import {
  LegacyDbAdvisorsFailOnError,
  LegacyDbAdvisorsInvalidTokenError,
  LegacyDbAdvisorsNotLoggedInError,
} from "./advisors.errors.ts";
import { encodeLegacyAdvisorLints, scanLegacyAdvisorLintRow } from "./advisors.format.ts";
import { legacyDbAdvisors } from "./advisors.handler.ts";
import { splitLegacyLintsSql } from "./advisors.lints-sql.ts";
import type { LegacyDbAdvisorsFlags } from "./advisors.command.ts";

const LOCAL_CONN: LegacyPgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

const [SETUP_SQL, QUERY_SQL] = splitLegacyLintsSql();

/** A local lint row keyed by the column names the `lints.sql` query aliases. */
function lintRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    name: "rls_disabled_in_public",
    title: "RLS disabled in public",
    level: "ERROR",
    facing: "EXTERNAL",
    categories: ["SECURITY"],
    description: "Detects tables without RLS.",
    detail: "Table public.users has RLS disabled",
    remediation: "https://supabase.com/docs",
    metadata: { schema: "public", name: "users", type: "table" },
    cache_key: "rls_disabled_in_public_public_users",
    ...over,
  };
}

function mockResolver(opts: { ipv6Error?: boolean } = {}) {
  const resolveFlags: Array<LegacyDbConfigFlags> = [];
  const layer = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (flags: LegacyDbConfigFlags) =>
      Effect.gen(function* () {
        resolveFlags.push(flags);
        if (opts.ipv6Error === true) {
          return yield* Effect.fail(
            new LegacyDbConfigIpv6Error({
              message: "IPv6 is not supported on your current network",
              suggestion: "Run supabase link --project-ref abc to setup IPv4 connection.",
            }),
          );
        }
        return {
          conn: LOCAL_CONN,
          isLocal: flags.connType !== "linked",
        } satisfies LegacyResolvedDbConfig;
      }),
  });
  return {
    layer,
    get resolveFlags() {
      return resolveFlags;
    },
  };
}

function mockConnection(opts: {
  rows?: ReadonlyArray<Record<string, unknown>>;
  setupFails?: boolean;
  queryFails?: boolean;
}) {
  const execs: Array<string> = [];
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            if (sql === SETUP_SQL && opts.setupFails === true) {
              return Effect.fail(new LegacyDbExecError({ message: "syntax error at set" }));
            }
            return Effect.void;
          }),
        query: (sql: string) =>
          Effect.suspend(() => {
            if (sql === QUERY_SQL && opts.queryFails === true) {
              return Effect.fail(new LegacyDbExecError({ message: "syntax error" }));
            }
            return Effect.succeed(opts.rows ?? []);
          }),
      }),
  });
  return {
    layer,
    get execs() {
      return execs;
    },
  };
}

function mockProjectRef() {
  const calls: Array<string> = [];
  const layer = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () =>
      Effect.sync(() => {
        calls.push("resolve");
        return LEGACY_VALID_REF;
      }),
    resolveForLink: () => Effect.succeed(LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(LEGACY_VALID_REF)),
    loadProjectRef: () =>
      Effect.sync(() => {
        calls.push("loadProjectRef");
        return LEGACY_VALID_REF;
      }),
    promptProjectRef: () => Effect.succeed(LEGACY_VALID_REF),
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

/** Validating credentials mock — the advisors `--linked` token gate calls
 *  `LegacyCredentials.getAccessToken` (Go's `LoadAccessTokenFS`), which fails
 *  hard on a malformed token and returns None when no token is present. */
function mockCredentials(opts: { token?: "valid" | "none" | "invalid" } = {}) {
  const state = opts.token ?? "valid";
  const getAccessToken =
    state === "invalid"
      ? Effect.fail(
          new LegacyInvalidAccessTokenError({
            message: "Invalid access token format. Must be like `sbp_0102...1920`.",
          }),
        )
      : state === "none"
        ? Effect.sync(() => Option.none<Redacted.Redacted<string>>())
        : Effect.sync(() => Option.some(Redacted.make(LEGACY_VALID_TOKEN)));
  const layer = Layer.succeed(LegacyCredentials, {
    getAccessToken,
    saveAccessToken: () => Effect.die("unexpected credentials write in advisors test"),
    deleteAccessToken: Effect.die("unexpected credentials delete in advisors test"),
    deleteAllProjectCredentials: Effect.die("unexpected project-credential sweep in advisors test"),
    deleteProjectCredential: () =>
      Effect.die("unexpected project-credential delete in advisors test"),
  });
  return { layer };
}

/** Tracks the raw-HTTP advisor path running Go's identityTransport stitch. */
function mockIdentityStitch() {
  let calls = 0;
  const layer = Layer.succeed(LegacyIdentityStitch, {
    stitch: () =>
      Effect.sync(() => {
        calls += 1;
      }),
    stitchedDistinctId: () => undefined,
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  rows?: ReadonlyArray<Record<string, unknown>>;
  setupFails?: boolean;
  queryFails?: boolean;
  loggedIn?: boolean;
  invalidToken?: boolean;
  ipv6Error?: boolean;
  securityStatus?: number;
  securityNonJson?: boolean;
  securityLints?: ReadonlyArray<Record<string, unknown>>;
  performanceLints?: ReadonlyArray<Record<string, unknown>>;
  /** Raw CLI args for `CliArgs` — drives DB target selection (Changed-based). */
  args?: ReadonlyArray<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const resolver = mockResolver({ ipv6Error: opts.ipv6Error });
  const connection = mockConnection({
    rows: opts.rows,
    setupFails: opts.setupFails,
    queryFails: opts.queryFails,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const processControl = mockProcessControl();
  const projectRef = mockProjectRef();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const api = mockLegacyPlatformApi({
    handler: (request) => {
      const url = request.url;
      if (url.includes("/advisors/security")) {
        const status = opts.securityStatus ?? 200;
        if (status !== 200) {
          return Effect.succeed(legacyJsonResponse(request, status, { message: "boom" }));
        }
        if (opts.securityNonJson === true) {
          // 200 with a non-JSON content-type (proxy/header regression).
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ lints: [] }), {
                status: 200,
                headers: { "content-type": "text/plain" },
              }),
            ),
          );
        }
        return Effect.succeed(
          legacyJsonResponse(request, 200, { lints: opts.securityLints ?? [] }),
        );
      }
      if (url.includes("/advisors/performance")) {
        return Effect.succeed(
          legacyJsonResponse(request, 200, { lints: opts.performanceLints ?? [] }),
        );
      }
      return Effect.succeed(legacyJsonResponse(request, 404, {}));
    },
  });

  const cliConfig = mockLegacyCliConfig({
    workdir: "/tmp/advisors-int",
    accessToken: opts.loggedIn === false ? Option.none() : undefined,
  });
  const credentials = mockCredentials({
    token: opts.invalidToken === true ? "invalid" : opts.loggedIn === false ? "none" : "valid",
  });
  const identityStitch = mockIdentityStitch();

  const layer = Layer.mergeAll(
    out.layer,
    resolver.layer,
    connection.layer,
    telemetry.layer,
    processControl.layer,
    projectRef.layer,
    cache.layer,
    cliConfig,
    credentials.layer,
    identityStitch.layer,
    api.httpClientLayer,
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
  );
  return {
    layer,
    out,
    connection,
    telemetry,
    processControl,
    cache,
    api,
    projectRef,
    identityStitch,
    resolver,
  };
}

const flags = (over: Partial<LegacyDbAdvisorsFlags> = {}): LegacyDbAdvisorsFlags => ({
  dbUrl: over.dbUrl ?? Option.none<string>(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  type: over.type ?? Option.none<"all" | "security" | "performance">(),
  level: over.level ?? Option.none<"info" | "warn" | "error">(),
  failOn: over.failOn ?? Option.none<"none" | "info" | "warn" | "error">(),
});

describe("legacy db advisors — local", () => {
  it.live("queries the local database and prints the Go pretty JSON array", () => {
    const { layer, out, connection } = setup({ rows: [lintRow()] });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags());
      const expected = encodeLegacyAdvisorLints([scanLegacyAdvisorLintRow(lintRow())]);
      expect(out.stdoutText).toBe(expected);
      expect(out.stderrText).toContain("Connecting to local database...");
      expect(connection.execs).toEqual(["begin", SETUP_SQL, "rollback"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("prints 'No issues found' to stderr and nothing to stdout when empty", () => {
    const { layer, out } = setup({ rows: [] });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags());
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toContain("No issues found");
    }).pipe(Effect.provide(layer));
  });

  it.live("filters by --type security locally", () => {
    const { layer, out } = setup({
      rows: [
        lintRow({ name: "sec", categories: ["SECURITY"] }),
        lintRow({ name: "perf", categories: ["PERFORMANCE"], level: "INFO" }),
      ],
    });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags({ type: Option.some("security"), level: Option.some("info") }));
      expect(out.stdoutText).toContain("sec");
      expect(out.stdoutText).not.toContain('"name": "perf"');
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with 'failed to prepare lint session' on a setup error", () => {
    const { layer } = setup({ setupFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbAdvisors(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to prepare lint session");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with 'failed to query lints' on a query error", () => {
    const { layer } = setup({ queryFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbAdvisors(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to query lints");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("exits non-zero when --fail-on error and an error-level lint exists", () => {
    const { layer } = setup({ rows: [lintRow({ level: "ERROR" })] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbAdvisors(flags({ failOn: Option.some("error"), level: Option.some("info") })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(LegacyDbAdvisorsFailOnError);
          expect((failure.value as LegacyDbAdvisorsFailOnError).message).toBe(
            "fail-on is set to error, non-zero exit",
          );
        }
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("echoes the raw --fail-on value in the message (warn, not warning)", () => {
    // advisors uses the raw flag value (advisors.go:257), unlike lint which uses
    // the canonical level name — guard that asymmetry.
    const { layer } = setup({ rows: [lintRow({ level: "WARN" })] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbAdvisors(flags({ failOn: Option.some("warn"), level: Option.some("info") })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        if (Option.isSome(failure)) {
          expect((failure.value as LegacyDbAdvisorsFailOnError).message).toBe(
            "fail-on is set to warn, non-zero exit",
          );
        }
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --db-url together with --local (via args Changed detection)", () => {
    const { layer } = setup({ args: ["--db-url=postgres://x", "--local"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbAdvisors(flags({ dbUrl: Option.some("postgres://x") })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "if any flags in the group [db-url linked local] are set none of the others can be",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success envelope in json mode and writes nothing raw to stdout", () => {
    const { layer, out } = setup({ format: "json", rows: [lintRow()] });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "db advisors" }),
      );
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("sets exit code 1 without failing the effect on fail-on in json mode", () => {
    const { layer, processControl } = setup({
      format: "json",
      rows: [lintRow({ level: "ERROR" })],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbAdvisors(flags({ failOn: Option.some("error"), level: Option.some("info") })),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry on completion", () => {
    const { layer, telemetry } = setup({ rows: [] });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags());
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  // ── Changed-based routing parity (Go pflag.Changed semantics) ────────────

  it.live("--linked=false routes to the linked branch (Changed, not value)", () => {
    // cobra's Changed fires when the flag appears on the command line regardless
    // of its value: `--linked=false` is still "explicitly set" → linked branch.
    const { layer, projectRef, cache } = setup({
      args: ["--linked=false"],
      securityLints: [],
      performanceLints: [],
    });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags());
      expect(projectRef.calls).toContain("loadProjectRef");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("--no-linked routes to the linked branch (boolean negation is still Changed)", () => {
    const { layer, projectRef, cache } = setup({
      args: ["--no-linked"],
      securityLints: [],
      performanceLints: [],
    });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags());
      expect(projectRef.calls).toContain("loadProjectRef");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("--local=false --linked fails with mutual-exclusion (sorted set [linked local])", () => {
    // Both flags are Changed → mutual exclusion fires with cobra's sorted set.
    const { layer } = setup({ args: ["--local=false", "--linked"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbAdvisors(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--local=false alone routes to the local branch (Changed local, connType=local)", () => {
    // `--local=false` is Changed for `local` → connType="local".
    const { layer, out, cache } = setup({ rows: [], args: ["--local=false"] });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags());
      expect(out.stderrText).toContain("Connecting to local database...");
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});

describe("legacy db advisors — linked", () => {
  const securityLint = {
    name: "rls_disabled_in_public",
    title: "RLS disabled",
    level: "ERROR",
    facing: "EXTERNAL",
    categories: ["SECURITY"],
    cache_key: "sec",
  };
  const performanceLint = {
    name: "unindexed_foreign_keys",
    title: "Unindexed FK",
    level: "INFO",
    facing: "EXTERNAL",
    categories: ["PERFORMANCE"],
    cache_key: "perf",
  };

  it.live("fetches both security and performance advisors for --type all", () => {
    const { layer, out, api, cache } = setup({
      securityLints: [securityLint],
      performanceLints: [performanceLint],
      args: ["--linked"],
    });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags({ level: Option.some("info") }));
      const urls = api.requests.map((r) => r.url);
      expect(urls.some((u) => u.includes("/advisors/security"))).toBe(true);
      expect(urls.some((u) => u.includes("/advisors/performance"))).toBe(true);
      expect(out.stdoutText).toContain("rls_disabled_in_public");
      expect(out.stdoutText).toContain("unindexed_foreign_keys");
      // Linked runs write the linked-project cache (Go PersistentPostRun).
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "resolves the linked DB config before fetching advisors (Go root PersistentPreRunE)",
    () => {
      // Go's root PersistentPreRunE runs ParseDatabaseConfig for db advisors too,
      // resolving (and on failure aborting) the linked DB config before RunLinked
      // hits the Management API — even though RunLinked discards the connection.
      const { layer, resolver, api } = setup({
        securityLints: [securityLint],
        args: ["--linked"],
      });
      return Effect.gen(function* () {
        yield* legacyDbAdvisors(flags({ type: Option.some("security") }));
        expect(resolver.resolveFlags.some((f) => f.connType === "linked")).toBe(true);
        // The fetch still ran after a successful resolve.
        expect(api.requests.some((r) => r.url.includes("/advisors/security"))).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails on the linked DB-config error before any advisor API call", () => {
    // Unreachable direct host + no pooler: Go's ParseDatabaseConfig fails with the
    // IPv6 error before RunLinked, so the advisors API is never reached. But the
    // ref was already loaded, and Go's Execute runs ensureProjectGroupsCached on
    // the error path — so the linked-project cache is still written.
    const { layer, api, cache } = setup({ ipv6Error: true, args: ["--linked"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbAdvisors(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("IPv6 is not supported");
      }
      expect(api.requests).toHaveLength(0);
      // Cache written despite the DB-config failure (ref was loaded first).
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("runs the identity stitch on each advisor response (Go identityTransport)", () => {
    // Go wraps every Management API response in identityTransport → OnGotrueID →
    // StitchLogin. The raw-HTTP advisor path must run the same stitch (once per
    // response) rather than silently skipping session-identity stitching.
    const { layer, identityStitch } = setup({
      securityLints: [securityLint],
      performanceLints: [performanceLint],
      args: ["--linked"],
    });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags({ level: Option.some("info") }));
      expect(identityStitch.calls).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves the linked ref via the non-prompting load (Go LoadProjectRef)", () => {
    // Go's advisors PreRunE uses `flags.LoadProjectRef`, not the prompting
    // `ParseProjectRef`, so `--linked` must take the fail-fast/non-interactive
    // path rather than `resolve` (which opens a project picker on a TTY).
    const { layer, projectRef } = setup({
      securityLints: [securityLint],
      args: ["--linked"],
    });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags({ type: Option.some("security") }));
      expect(projectRef.calls).toContain("loadProjectRef");
      expect(projectRef.calls).not.toContain("resolve");
    }).pipe(Effect.provide(layer));
  });

  it.live("fetches only the security endpoint for --type security", () => {
    const { layer, api } = setup({ securityLints: [securityLint], args: ["--linked"] });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags({ type: Option.some("security") }));
      const urls = api.requests.map((r) => r.url);
      expect(urls.some((u) => u.includes("/advisors/security"))).toBe(true);
      expect(urls.some((u) => u.includes("/advisors/performance"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("fetches only the performance endpoint for --type performance", () => {
    const { layer, api } = setup({ performanceLints: [performanceLint], args: ["--linked"] });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags({ type: Option.some("performance") }));
      const urls = api.requests.map((r) => r.url);
      expect(urls.some((u) => u.includes("/advisors/performance"))).toBe(true);
      expect(urls.some((u) => u.includes("/advisors/security"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a login suggestion when no access token is available", () => {
    const { layer } = setup({ loggedIn: false, args: ["--linked"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbAdvisors(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(LegacyDbAdvisorsNotLoggedInError);
          const error = failure.value as LegacyDbAdvisorsNotLoggedInError;
          expect(error.message).toContain("Access token not provided");
          expect(error.suggestion).toContain("supabase login");
        }
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with the invalid-token message before any API call (Go LoadAccessTokenFS)", () => {
    const { layer, api } = setup({ invalidToken: true, args: ["--linked"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbAdvisors(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(LegacyDbAdvisorsInvalidTokenError);
          const error = failure.value as LegacyDbAdvisorsInvalidTokenError;
          expect(error.message).toContain("Invalid access token format");
          expect(error.suggestion).toContain("supabase login");
        }
      }
      // The token gate fails before any advisors request is made.
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails on a 200 with a non-JSON content type (Go requires json header)", () => {
    // Go's generated parser only decodes when Content-Type contains "json";
    // otherwise JSON200 is nil and the fetcher returns the status-200 error.
    const { layer } = setup({ securityNonJson: true, args: ["--linked"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbAdvisors(flags({ type: Option.some("security") })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("unexpected security advisors status 200");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the advisors API returns a non-200 status", () => {
    const { layer } = setup({ securityStatus: 500, args: ["--linked"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbAdvisors(flags({ type: Option.some("security") })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("unexpected security advisors status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event in stream-json mode", () => {
    const { layer, out } = setup({
      format: "stream-json",
      securityLints: [securityLint],
      args: ["--linked"],
    });
    return Effect.gen(function* () {
      yield* legacyDbAdvisors(flags({ type: Option.some("security") }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "db advisors" }),
      );
    }).pipe(Effect.provide(layer));
  });
});
