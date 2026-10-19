import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Redacted } from "effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import { cliConfigValuesTestLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { mockOutput, mockProcessControl } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  sequentialExecBatch,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  asRecordedRequests,
  projectResponse,
  provideEnv,
  realDbConfigResolver,
  realLinkedProjectCache,
  serveLinkedDatabase,
  stubManagementApi,
  type StubbedRequest,
} from "../../../../tests/helpers/permission-real-layers.ts";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import { CommandCredentials } from "../../../auth/command-credentials.service.ts";
import { InvalidAccessTokenError } from "../../../auth/errors.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigIpv6Error } from "../../../command-internal/db-config.errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import {
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
} from "../../../command-internal/target/target.errors.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import {
  DbConnection,
  type PgConnInput,
  type DbSession,
} from "../../../command-internal/db-connection.service.ts";
import {
  DbAdvisorsFailOnError,
  DbAdvisorsInvalidTokenError,
  DbAdvisorsNotLoggedInError,
} from "./advisors.errors.ts";
import { encodeAdvisorLints, scanAdvisorLintRow } from "./advisors.format.ts";
import { dbAdvisors } from "./advisors.handler.ts";
import { splitLintsSql } from "./advisors.lints-sql.ts";
import type { DbAdvisorsFlags } from "./advisors.command.ts";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

const [SETUP_SQL, QUERY_SQL] = splitLintsSql();

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
  const resolveInputs: Array<DbConnectionInput> = [];
  const layer = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) =>
      Effect.gen(function* () {
        resolveInputs.push(input);
        if (opts.ipv6Error === true) {
          return yield* new DbConfigIpv6Error({
            message: "IPv6 is not supported on your current network",
            suggestion: "Run supabase link --project-ref abc to setup IPv4 connection.",
          });
        }
        return {
          conn: LOCAL_CONN,
          isLocal: input.target.kind !== "linked",
          ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
          target: input.target,
        } satisfies ResolvedDbConnection;
      }),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  return {
    layer,
    get resolveInputs() {
      return resolveInputs;
    },
  };
}

function mockConnection(opts: {
  rows?: ReadonlyArray<Record<string, unknown>>;
  setupFails?: boolean;
  queryFails?: boolean;
}) {
  const execs: Array<string> = [];
  const layer = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            if (sql === SETUP_SQL && opts.setupFails === true) {
              return Effect.fail(new DbExecError({ message: "syntax error at set" }));
            }
            return Effect.void;
          }),
        query: (sql: string) =>
          Effect.suspend(() => {
            if (sql === QUERY_SQL && opts.queryFails === true) {
              return Effect.fail(new DbExecError({ message: "syntax error" }));
            }
            return Effect.succeed(opts.rows ?? []);
          }),
        // A migration file's statements arrive as one batch; replay them through
        // `exec`/`query` so this suite's recordings and failure injection still apply.
        execBatch: (statements) => sequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
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
  const layer = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    // An explicit `--project-ref` wins over the workdir's own ref, so a test can prove the flag
    // (not just the fallback) drives the linked ref.
    resolveRef: (flagValue: Option.Option<string>) =>
      Effect.sync(() => {
        calls.push("resolveRef");
        return {
          ref: Option.getOrElse(flagValue, () => VALID_REF),
          source: Option.isSome(flagValue) ? ("flag" as const) : ("file" as const),
          matchesLinkedRef: Option.isNone(flagValue),
        };
      }),
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    promptProjectRef: () => Effect.succeed(VALID_REF),
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

/** Validating credentials mock — the advisors `--linked` token gate calls
 *  `CommandCredentials.getAccessToken`, which fails hard on a malformed token
 *  and returns None when no token is present. */
function mockCredentials(opts: { token?: "valid" | "none" | "invalid" } = {}) {
  const state = opts.token ?? "valid";
  const getAccessToken =
    state === "invalid"
      ? Effect.fail(
          new InvalidAccessTokenError({
            message: "Invalid access token format. Must be like `sbp_0102...1920`.",
          }),
        )
      : state === "none"
        ? Effect.sync(() => Option.none<Redacted.Redacted<string>>())
        : Effect.sync(() => Option.some(Redacted.make(VALID_TOKEN)));
  const layer = Layer.succeed(CommandCredentials, {
    getAccessToken,
    saveAccessToken: () => Effect.die("unexpected credentials write in advisors test"),
    deleteAccessToken: Effect.die("unexpected credentials delete in advisors test"),
    deleteAllProjectCredentials: Effect.die("unexpected project-credential sweep in advisors test"),
    deleteProjectCredential: () =>
      Effect.die("unexpected project-credential delete in advisors test"),
  });
  return { layer };
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
  securityRawBody?: string;
  securityLints?: ReadonlyArray<Record<string, unknown>>;
  performanceLints?: ReadonlyArray<Record<string, unknown>>;
  /** Runs the real `DbConfigResolver` and linked-project cache against the temp `workdir`. */
  realLayers?: boolean;
}

const tempRoot = useTempWorkdir("supabase-db-advisors-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const resolver = mockResolver({ ipv6Error: opts.ipv6Error });
  const connection = mockConnection({
    rows: opts.rows,
    setupFails: opts.setupFails,
    queryFails: opts.queryFails,
  });
  const telemetry = mockTelemetryStateTracked();
  const processControl = mockProcessControl();
  const projectRef = mockProjectRef();
  const cache = mockLinkedProjectCacheTracked();

  const api = mockCommandPlatformApi({
    handler: (request) => {
      const url = request.url;
      if (url.includes("/advisors/security")) {
        const status = opts.securityStatus ?? 200;
        if (status !== 200) {
          return Effect.succeed(jsonResponse(request, status, { message: "boom" }));
        }
        if (opts.securityRawBody !== undefined) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(opts.securityRawBody, {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        }
        return Effect.succeed(jsonResponse(request, 200, { lints: opts.securityLints ?? [] }));
      }
      if (url.includes("/advisors/performance")) {
        return Effect.succeed(jsonResponse(request, 200, { lints: opts.performanceLints ?? [] }));
      }
      if (request.method === "GET" && url.endsWith(`/v1/projects/${VALID_REF}`)) {
        return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
      }
      return Effect.succeed(jsonResponse(request, 404, {}));
    },
  });

  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    accessToken: opts.loggedIn === false ? Option.none() : undefined,
  });
  const credentials = mockCredentials({
    token: opts.invalidToken === true ? "invalid" : opts.loggedIn === false ? "none" : "valid",
  });

  const layer = Layer.mergeAll(
    out.layer,
    opts.realLayers !== true
      ? resolver.layer
      : realDbConfigResolver({
          workdir: tempRoot.current,
          dbConnection: connection.layer,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        }),
    connection.layer,
    telemetry.layer,
    processControl.layer,
    projectRef.layer,
    opts.realLayers !== true
      ? cache.layer
      : realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    cliSettings,
    credentials.layer,
    api.factoryLayer,
    cliConfigValuesTestLayer,
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    Layer.succeed(YesFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: [] }),
    BunServices.layer,
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
    resolver,
  };
}

const flags = (over: Partial<DbAdvisorsFlags> = {}): DbAdvisorsFlags => ({
  dbUrl: over.dbUrl ?? Option.none<string>(),
  remote: over.remote ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none<string>(),
  type: over.type ?? Option.none<"all" | "security" | "performance">(),
  level: over.level ?? Option.none<"info" | "warn" | "error">(),
  failOn: over.failOn ?? Option.none<"none" | "info" | "warn" | "error">(),
});

describe("db advisors — local", () => {
  it.effect("queries the local database and prints the pretty JSON array", () => {
    const { layer, out, connection, api } = setup({ rows: [lintRow()] });
    return Effect.gen(function* () {
      yield* dbAdvisors(flags());
      assertPermissionDrift({
        command: "db advisors",
        requests: api.requests,
        exact: true,
      });
      const expected = encodeAdvisorLints([scanAdvisorLintRow(lintRow())]);
      expect(out.stdoutText).toBe(expected);
      expect(connection.execs).toEqual(["begin", SETUP_SQL, "rollback"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints 'No issues found' to stderr and nothing to stdout when empty", () => {
    const { layer, out } = setup({ rows: [] });
    return Effect.gen(function* () {
      yield* dbAdvisors(flags());
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toContain("No issues found");
    }).pipe(Effect.provide(layer));
  });

  it.effect("filters by --type security locally", () => {
    const { layer, out } = setup({
      rows: [
        lintRow({ name: "sec", categories: ["SECURITY"] }),
        lintRow({ name: "perf", categories: ["PERFORMANCE"], level: "INFO" }),
      ],
    });
    return Effect.gen(function* () {
      yield* dbAdvisors(flags({ type: Option.some("security"), level: Option.some("info") }));
      expect(out.stdoutText).toContain("sec");
      expect(out.stdoutText).not.toContain('"name": "perf"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with 'failed to prepare lint session' on a setup error", () => {
    const { layer } = setup({ setupFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbAdvisors(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to prepare lint session");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with 'failed to query lints' on a query error", () => {
    const { layer } = setup({ queryFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbAdvisors(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to query lints");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("exits non-zero when --fail-on error and an error-level lint exists", () => {
    const { layer } = setup({ rows: [lintRow({ level: "ERROR" })] });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        dbAdvisors(flags({ failOn: Option.some("error"), level: Option.some("info") })),
      );
      expect(error).toBeInstanceOf(DbAdvisorsFailOnError);
      expect(error.message).toBe("fail-on is set to error, non-zero exit");
    }).pipe(Effect.provide(layer));
  });

  it.effect("echoes the raw --fail-on value in the message (warn, not warning)", () => {
    // advisors uses the raw flag value, unlike lint which uses the canonical
    // level name — guard that asymmetry.
    const { layer } = setup({ rows: [lintRow({ level: "WARN" })] });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        dbAdvisors(flags({ failOn: Option.some("warn"), level: Option.some("info") })),
      );
      expect(error.message).toBe("fail-on is set to warn, non-zero exit");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --db-url together with --local", () => {
    const { layer, connection } = setup();
    return Effect.gen(function* () {
      const error = yield* dbAdvisors(
        flags({ dbUrl: Option.some("postgres://x"), local: true }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetSelectorConflictError);
      expect(connection.execs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a success envelope in json mode and writes nothing raw to stdout", () => {
    const { layer, out } = setup({ format: "json", rows: [lintRow()] });
    return Effect.gen(function* () {
      yield* dbAdvisors(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "db advisors" }),
      );
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sets exit code 1 without failing the effect on fail-on in json mode", () => {
    const { layer, processControl } = setup({
      format: "json",
      rows: [lintRow({ level: "ERROR" })],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbAdvisors(flags({ failOn: Option.some("error"), level: Option.some("info") })),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry on completion", () => {
    const { layer, telemetry } = setup({ rows: [] });
    return Effect.gen(function* () {
      yield* dbAdvisors(flags());
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats --linked=false as absent and queries the local database", () => {
    const { layer, resolver, cache } = setup({ rows: [] });
    return Effect.gen(function* () {
      yield* dbAdvisors(flags({ linked: false }));
      expect(resolver.resolveInputs.map((input) => input.target.kind)).toEqual(["local"]);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("targets the linked project for a bare --remote", () => {
    const { layer, resolver, cache } = setup({ securityLints: [], performanceLints: [] });
    return Effect.gen(function* () {
      yield* dbAdvisors(flags({ remote: Option.some({ _tag: "Linked" } as const) }));
      expect(resolver.resolveInputs.map((input) => input.target.kind)).toEqual(["linked"]);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

const linkedFlags = (over: Partial<DbAdvisorsFlags> = {}) => flags({ linked: true, ...over });

describe("db advisors — linked", () => {
  const securityLint = {
    name: "rls_disabled_in_public",
    title: "RLS disabled",
    level: "ERROR",
    facing: "EXTERNAL",
    categories: ["SECURITY"],
    description: "Detects tables without RLS.",
    detail: "Table public.users has RLS disabled",
    remediation: "https://supabase.com/docs",
    cache_key: "sec",
  };
  const performanceLint = {
    name: "unindexed_foreign_keys",
    title: "Unindexed FK",
    level: "INFO",
    facing: "EXTERNAL",
    categories: ["PERFORMANCE"],
    description: "Detects unindexed foreign keys.",
    detail: "Table public.posts has an unindexed foreign key",
    remediation: "https://supabase.com/docs",
    cache_key: "perf",
  };

  it.effect(
    "mints a login role, fetches both advisors and fills the cache through the real layers",
    () => {
      const { layer, api } = setup({
        securityLints: [securityLint],
        performanceLints: [performanceLint],
        realLayers: true,
      });
      const resolverRequests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* stubManagementApi(resolverRequests, serveLinkedDatabase(VALID_REF));
        yield* dbAdvisors(linkedFlags({ projectRef: Option.some(VALID_REF) }));
        expect(resolverRequests.map(({ method, path }) => `${method} ${path}`)).toEqual([
          `GET /v1/projects/${VALID_REF}/config/database/pooler`,
          `POST /v1/projects/${VALID_REF}/cli/login-role`,
        ]);
        expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          `GET https://api.supabase.com/v1/projects/${VALID_REF}/advisors/security`,
          `GET https://api.supabase.com/v1/projects/${VALID_REF}/advisors/performance`,
          `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
        ]);
        expect(yield* fs.exists(`${tempRoot.current}/supabase/.temp/linked-project.json`)).toBe(
          true,
        );
        assertPermissionDrift({
          command: "db advisors",
          activeFlags: { linked: true, "project-ref": VALID_REF },
          requests: [...asRecordedRequests(resolverRequests), ...api.requests],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(layer, BunServices.layer)),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    },
  );

  it.effect("makes no Management API request for --local through the real layers", () => {
    const { layer, api } = setup({
      rows: [],
      realLayers: true,
    });
    const resolverRequests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(resolverRequests, () => undefined);
      yield* dbAdvisors(flags({ local: true }));
      expect(resolverRequests).toEqual([]);
      expect(api.requests).toEqual([]);
      expect(yield* fs.exists(`${tempRoot.current}/supabase/.temp/linked-project.json`)).toBe(
        false,
      );
      assertPermissionDrift({
        command: "db advisors",
        activeFlags: { local: true },
        requests: [],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layer, BunServices.layer)),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect(
    "fails on a 403 from the security advisors without asking for the performance ones",
    () => {
      const { layer, api } = setup({ securityStatus: 403 });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(dbAdvisors(linkedFlags({ type: Option.some("all") })));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("unexpected security advisors status 403");
        }
        expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          `GET https://api.supabase.com/v1/projects/${VALID_REF}/advisors/security`,
        ]);
        assertPermissionDrift({
          command: "db advisors",
          activeFlags: { linked: true, type: "all" },
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("fetches both security and performance advisors for --type all", () => {
    const { layer, out, api, cache } = setup({
      securityLints: [securityLint],
      performanceLints: [performanceLint],
    });
    return Effect.gen(function* () {
      yield* dbAdvisors(linkedFlags({ type: Option.some("all"), level: Option.some("info") }));
      const urls = api.requests.map((r) => r.url);
      expect(urls.some((u) => u.includes("/advisors/security"))).toBe(true);
      expect(urls.some((u) => u.includes("/advisors/performance"))).toBe(true);
      assertPermissionDrift({
        command: "db advisors",
        activeFlags: { linked: true, type: "all", level: true },
        requests: api.requests,
        exact: true,
      });
      expect(out.stdoutText).toContain("rls_disabled_in_public");
      expect(out.stdoutText).toContain("unindexed_foreign_keys");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "fetches advisors for the project given via --project-ref, overriding the workdir's own ref",
    () => {
      // The fake resolver's own fallback (VALID_REF) represents whatever the workdir would
      // resolve to absent the flag; the flag must win over it and drive both API and cache.
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, api, cache } = setup({
        securityLints: [securityLint],
      });
      return Effect.gen(function* () {
        yield* dbAdvisors(
          flags({ type: Option.some("security"), projectRef: Option.some(FLAG_REF) }),
        );
        expect(
          api.requests.some((r) => r.url.includes(`/v1/projects/${FLAG_REF}/advisors/security`)),
        ).toBe(true);
        expect(cache.cached).toBe(true);
        expect(cache.cachedRef).toBe(FLAG_REF);
        expect(cache.cachedRef).not.toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("rejects --project-ref together with --local", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, connection, api, cache } = setup({ rows: [] });
    return Effect.gen(function* () {
      const error = yield* dbAdvisors(
        flags({ local: true, projectRef: Option.some(FLAG_REF) }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetProjectRefConflictError);
      expect(connection.execs).toEqual([]);
      expect(api.requests).toEqual([]);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the linked DB config before fetching advisors", () => {
    // Resolved even though the linked lint-gathering path discards the connection.
    const { layer, resolver, api } = setup({
      securityLints: [securityLint],
    });
    return Effect.gen(function* () {
      yield* dbAdvisors(linkedFlags({ type: Option.some("security") }));
      expect(resolver.resolveInputs.some((input) => input.target.kind === "linked")).toBe(true);
      expect(api.requests.some((r) => r.url.includes("/advisors/security"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails on the linked DB-config error before any advisor API call", () => {
    // The DB-config resolve fails before the linked lint-gathering path runs, so the advisors
    // API is never reached — but the ref was already loaded and cached unconditionally on the
    // error path.
    const { layer, api, cache } = setup({ ipv6Error: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbAdvisors(linkedFlags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("IPv6 is not supported");
      }
      expect(api.requests).toHaveLength(0);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the linked ref through the shared target chain", () => {
    const { layer, projectRef } = setup({ securityLints: [securityLint] });
    return Effect.gen(function* () {
      yield* dbAdvisors(linkedFlags({ type: Option.some("security") }));
      expect(projectRef.calls).toEqual(["resolveRef"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fetches only the security endpoint for --type security", () => {
    const { layer, api } = setup({ securityLints: [securityLint] });
    return Effect.gen(function* () {
      yield* dbAdvisors(linkedFlags({ type: Option.some("security") }));
      const urls = api.requests.map((r) => r.url);
      expect(urls.some((u) => u.includes("/advisors/security"))).toBe(true);
      expect(urls.some((u) => u.includes("/advisors/performance"))).toBe(false);
      assertPermissionDrift({
        command: "db advisors",
        activeFlags: { linked: true, type: "security" },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fetches only the performance endpoint for --type performance", () => {
    const { layer, api } = setup({ performanceLints: [performanceLint] });
    return Effect.gen(function* () {
      yield* dbAdvisors(linkedFlags({ type: Option.some("performance") }));
      const urls = api.requests.map((r) => r.url);
      expect(urls.some((u) => u.includes("/advisors/performance"))).toBe(true);
      expect(urls.some((u) => u.includes("/advisors/security"))).toBe(false);
      assertPermissionDrift({
        command: "db advisors",
        activeFlags: { linked: true, type: "performance" },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with a login suggestion when no access token is available", () => {
    const { layer } = setup({ loggedIn: false });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(dbAdvisors(linkedFlags()));
      expect(error).toBeInstanceOf(DbAdvisorsNotLoggedInError);
      expect(error).toMatchObject({
        message: expect.stringContaining("Access token not provided"),
        suggestion: expect.stringContaining("supabase login"),
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with the invalid-token message before any API call", () => {
    const { layer, api } = setup({ invalidToken: true });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(dbAdvisors(linkedFlags()));
      expect(error).toBeInstanceOf(DbAdvisorsInvalidTokenError);
      expect(error).toMatchObject({
        message: expect.stringContaining("Invalid access token format"),
        suggestion: expect.stringContaining("supabase login"),
      });
      // The token gate fails before any advisors request is made.
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with a status-200 error when the advisors body is not JSON", () => {
    const { layer } = setup({ securityRawBody: "<html>gateway</html>" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbAdvisors(linkedFlags({ type: Option.some("security") })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "DbAdvisorsSecurityStatusError",
          status: 200,
        });
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails as a decode error when the advisors body has the wrong shape", () => {
    const { layer } = setup({ securityRawBody: '{"lints":"nope"}' });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbAdvisors(linkedFlags({ type: Option.some("security") })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "DbAdvisorsSecurityNetworkError",
          decode: true,
        });
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders advisors whose name and metadata type the contract does not list", () => {
    const { layer, out } = setup({
      format: "json",
      securityLints: [
        {
          ...securityLint,
          name: "public_bucket_allows_listing",
          categories: ["SECURITY", "COMPLIANCE"],
          metadata: { name: "avatars", type: "bucket", extra: "dropped" },
        },
      ],
    });
    return Effect.gen(function* () {
      yield* dbAdvisors(linkedFlags({ type: Option.some("security") }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: {
            results: [
              expect.objectContaining({
                name: "public_bucket_allows_listing",
                categories: ["SECURITY", "COMPLIANCE"],
                metadata: { name: "avatars", type: "bucket" },
              }),
            ],
          },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when the advisors API returns a non-200 status", () => {
    const { layer } = setup({ securityStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbAdvisors(linkedFlags({ type: Option.some("security") })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("unexpected security advisors status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a result event in stream-json mode", () => {
    const { layer, out } = setup({
      format: "stream-json",
      securityLints: [securityLint],
    });
    return Effect.gen(function* () {
      yield* dbAdvisors(linkedFlags({ type: Option.some("security") }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "db advisors" }),
      );
    }).pipe(Effect.provide(layer));
  });
});
