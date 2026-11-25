import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option } from "effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import { describeDbTargetSelection } from "../../../../tests/helpers/db-target-selection.ts";
import { VALID_REF, VALID_TOKEN, useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import {
  lintRow,
  setupAdvisors,
  SETUP_SQL,
  QUERY_SQL,
  type AdvisorTestOptions,
} from "../../../../tests/helpers/advisors.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  asRecordedRequests,
  provideEnv,
  serveLinkedDatabase,
  stubManagementApi,
  type StubbedRequest,
} from "../../../../tests/helpers/permission-real-layers.ts";
import {
  DbAdvisorsFailOnError,
  DbAdvisorsInvalidTokenError,
  DbAdvisorsNotLoggedInError,
} from "../../../command-internal/advisors/advisors.errors.ts";
import {
  encodeAdvisorLints,
  scanAdvisorLintRow,
} from "../../../command-internal/advisors/advisors.format.ts";
import { dbAdvisors } from "./advisors.handler.ts";
import type { DbAdvisorsFlags } from "./advisors.command.ts";

const tempRoot = useTempWorkdir("supabase-db-advisors-int-");
const setup = (opts?: AdvisorTestOptions) => setupAdvisors(tempRoot.current, opts);

const REMOTE_LINKED: DbAdvisorsFlags["remote"] = Option.some({ _tag: "Linked" });

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
  it.effect.each([
    {
      name: "configured schemas",
      config: '[api]\nschemas = ["app", "public"]',
      env: { SUPABASE_API_SCHEMAS: "" },
      expected: "app,public",
    },
    {
      name: "Data API disabled",
      config: "[api]\nenabled = false",
      env: { SUPABASE_API_SCHEMAS: "" },
      expected: "",
    },
    {
      name: "environment schemas",
      config: '[api]\nschemas = ["public"]',
      env: { SUPABASE_API_SCHEMAS: "app,public" },
      expected: "app,public",
    },
    {
      name: "default schemas",
      config: undefined,
      env: { SUPABASE_API_SCHEMAS: "" },
      expected: "public,graphql_public",
    },
  ])("sets exposure before lint setup: $name", ({ config, env, expected }) => {
    const { layer, connection } = setup({ realLayers: true, realEnv: env });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (config !== undefined) {
        yield* fs.makeDirectory(`${tempRoot.current}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${tempRoot.current}/supabase/config.toml`, config);
      }
      yield* dbAdvisors(flags());
      expect(connection.calls).toEqual([
        { kind: "exec", sql: "begin" },
        {
          kind: "query",
          sql: "select set_config('pgrst.db_schemas', $1, true)",
          params: [expected],
        },
        { kind: "exec", sql: SETUP_SQL },
        { kind: "query", sql: QUERY_SQL, params: undefined },
        { kind: "exec", sql: "rollback" },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(layer, BunServices.layer)), provideEnv(env));
  });

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

  it.effect(
    "rolls back and fails with 'failed to prepare lint session' when exposure fails",
    () => {
      const env = { SUPABASE_API_SCHEMAS: "" };
      const { layer, connection } = setup({
        exposureFails: true,
        realLayers: true,
        realEnv: env,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(dbAdvisors(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("failed to prepare lint session");
        }
        expect(connection.execs).toEqual(["begin", "rollback"]);
      }).pipe(Effect.provide(Layer.mergeAll(layer, BunServices.layer)), provideEnv(env));
    },
  );

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

  it.effect("emits a success envelope in json mode and writes nothing raw to stdout", () => {
    const { layer, out } = setup({ format: "json", rows: [lintRow()] });
    return Effect.gen(function* () {
      yield* dbAdvisors(flags());
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "db advisors" }),
      );
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toContain(
        "supabase db advisors is planned for deprecation in a future release. It remains supported; consider supabase issues for security, performance, and health checks.",
      );
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
});

const linkedFlags = (over: Partial<DbAdvisorsFlags> = {}) =>
  flags({ remote: REMOTE_LINKED, ...over });

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
    "fetches both advisors and fills the cache through the real layers without minting a login role",
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
        yield* dbAdvisors(
          linkedFlags({ remote: Option.some({ _tag: "Ref", ref: VALID_REF } as const) }),
        );
        expect(resolverRequests).toEqual([]);
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
          activeFlags: { remote: VALID_REF },
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

  it.effect(
    "makes no Management API request for the default local target through the real layers",
    () => {
      const { layer, api } = setup({
        rows: [],
        realLayers: true,
      });
      const resolverRequests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* stubManagementApi(resolverRequests, () => undefined);
        yield* dbAdvisors(flags());
        expect(resolverRequests).toEqual([]);
        expect(api.requests).toEqual([]);
        expect(yield* fs.exists(`${tempRoot.current}/supabase/.temp/linked-project.json`)).toBe(
          false,
        );
        assertPermissionDrift({
          command: "db advisors",
          activeFlags: {},
          requests: [],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(layer, BunServices.layer)),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    },
  );

  it.effect(
    "fails on a 403 from the security advisors without asking for the performance ones",
    () => {
      const { layer, api, cache } = setup({ securityStatus: 403 });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(dbAdvisors(linkedFlags({ type: Option.some("all") })));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("unexpected security advisors status 403");
        }
        expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          `GET https://api.supabase.com/v1/projects/${VALID_REF}/advisors/security`,
        ]);
        expect(cache.cached).toBe(true);
        assertPermissionDrift({
          command: "db advisors",
          activeFlags: { remote: true, type: "all" },
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
        activeFlags: { remote: true, type: "all", level: true },
        requests: api.requests,
        exact: true,
      });
      expect(out.stdoutText).toContain("rls_disabled_in_public");
      expect(out.stdoutText).toContain("unindexed_foreign_keys");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "fetches advisors for the project given via --remote=<ref>, overriding the workdir's own ref",
    () => {
      // The fake resolver's own fallback (VALID_REF) represents whatever the workdir would
      // resolve to absent the flag; the flag must win over it and drive both API and cache.
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, api, cache } = setup({
        securityLints: [securityLint],
      });
      return Effect.gen(function* () {
        yield* dbAdvisors(
          flags({
            type: Option.some("security"),
            remote: Option.some({ _tag: "Ref", ref: FLAG_REF } as const),
          }),
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

  it.effect("never resolves a database connection for linked advisors", () => {
    const { layer, resolver, api, cache } = setup({
      ipv6Error: true,
      securityLints: [securityLint],
    });
    return Effect.gen(function* () {
      yield* dbAdvisors(linkedFlags({ type: Option.some("security") }));
      expect(resolver.resolveInputs).toEqual([]);
      expect(api.requests.some((r) => r.url.includes("/advisors/security"))).toBe(true);
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
        activeFlags: { remote: true, type: "security" },
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
        activeFlags: { remote: true, type: "performance" },
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

describeDbTargetSelection("db advisors", {
  dbUrl: true,
  workdir: () => tempRoot.current,
  attempt: ({ target }) => {
    const ctx = setup({ rows: [], securityLints: [], performanceLints: [] });
    return {
      layer: ctx.layer,
      out: ctx.out,
      run: dbAdvisors(flags(target)),
      target: () => {
        const hostedRef = ctx.api.requests
          .map(({ url }) => /\/v1\/projects\/([^/]+)\/advisors\//u.exec(url)?.[1])
          .find((ref) => ref !== undefined);
        return hostedRef === undefined
          ? ctx.resolver.resolveInputs[0]?.target
          : { kind: "linked", ref: hostedRef };
      },
      cachedRef: () => ctx.cache.cachedRef,
      branchLookups: () => ctx.api.requests.filter(({ url }) => url.endsWith("/branches")),
      apiRequests: () => ctx.api.requests,
    };
  },
});
