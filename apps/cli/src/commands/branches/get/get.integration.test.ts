import type {
  V1GetABranchConfigOutput,
  V1GetABranchOutput,
  V1GetPoolerConfigOutput,
  V1GetProjectApiKeysOutput,
  V1ListAllBranchesOutput,
  V1ListAllProjectsOutput,
} from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import type { BranchesGetFlags } from "./get.command.ts";
import { branchesGet } from "./get.handler.ts";

type BranchDetail = typeof V1GetABranchConfigOutput.Type;
type FindResponse = typeof V1GetABranchOutput.Type;
type Pooler = typeof V1GetPoolerConfigOutput.Type;
type ApiKeys = typeof V1GetProjectApiKeysOutput.Type;

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

// A UUID keeps `branch_id_or_ref`'s oneOf union unambiguous; a 20-lowercase ref could match
// either variant.
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";
const BRANCH_REF = "cccccccccccccccccccc";

const DETAIL: BranchDetail = {
  ref: BRANCH_REF,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "db.cccccccccccccccccccc.supabase.co",
  db_port: 5432,
  db_user: "postgres",
  db_pass: "secret",
  jwt_secret: "jwt-secret",
};

const DETAIL_MASKED: BranchDetail = {
  ref: BRANCH_REF,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "db.cccccccccccccccccccc.supabase.co",
  db_port: 5432,
};

// project_ref is a UUID here so the downstream getABranchConfig call passes the same union.
const FIND: FindResponse = {
  id: BRANCH_UUID,
  name: "feat-x",
  project_ref: BRANCH_UUID,
  parent_project_ref: VALID_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  with_data: false,
};

const PRIMARY_POOLER: Pooler[number] = {
  identifier: "id",
  database_type: "PRIMARY",
  is_using_scram_auth: true,
  db_user: "postgres.cccccccccccccccccccc",
  db_host: "aws-0-us-east-1.pooler.supabase.com",
  db_port: 6543,
  db_name: "postgres",
  connection_string:
    "postgresql://postgres.cccccccccccccccccccc:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
  connectionString: "n/a",
  default_pool_size: null,
  max_client_conn: null,
  pool_mode: "transaction",
};

const POOLER: Pooler = [PRIMARY_POOLER];

const KEYS: ApiKeys = [
  { name: "anon", api_key: "anon-key" },
  { name: "service_role", api_key: "sr-key" },
];

const PROJECT: (typeof V1ListAllProjectsOutput.Type)[number] = {
  id: VALID_REF,
  ref: VALID_REF,
  organization_id: "org-123",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  created_at: "2026-05-27T01:02:03Z",
  status: "ACTIVE_HEALTHY",
  database: {
    host: "db.alpha.supabase.co",
    version: "15.1",
    postgres_engine: "15",
    release_channel: "ga",
  },
};

const LISTED_BRANCH: (typeof V1ListAllBranchesOutput.Type)[number] = {
  id: BRANCH_UUID,
  name: "feat-x",
  project_ref: BRANCH_REF,
  parent_project_ref: VALID_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  with_data: false,
};

const API = "https://api.supabase.com";
const DETAIL_REQUEST = `GET ${API}/v1/branches/${BRANCH_UUID}`;
const API_KEYS_REQUEST = `GET ${API}/v1/projects/${BRANCH_REF}/api-keys`;
const POOLER_REQUEST = `GET ${API}/v1/projects/${BRANCH_REF}/config/database/pooler`;

const tempRoot = useTempWorkdir("supabase-branches-get-int-");

interface SetupOpts {
  readonly format?: "text" | "json";
  readonly outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml" | "table";
  readonly findStatus?: number;
  readonly detailStatus?: number;
  readonly detailBody?: BranchDetail;
  readonly poolerStatus?: number;
  readonly poolerBody?: Pooler;
  readonly apiKeysStatus?: number;
  readonly apiKeysBody?: ApiKeys;
  readonly skipPrimary?: boolean;
}

function buildApi(opts: SetupOpts) {
  const findStatus = opts.findStatus ?? 200;
  const detailStatus = opts.detailStatus ?? 200;
  const detailBody = opts.detailBody ?? DETAIL;
  const poolerStatus = opts.poolerStatus ?? 200;
  const poolerBody = opts.poolerBody ?? POOLER;
  const apiKeysStatus = opts.apiKeysStatus ?? 200;
  const apiKeysBody = opts.apiKeysBody ?? KEYS;
  return mockCommandPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (
          request.method === "GET" &&
          request.url.includes(`/v1/projects/${VALID_REF}/branches/`)
        ) {
          return jsonResponse(request, findStatus, findStatus === 200 ? FIND : { err: 1 });
        }
        if (request.method === "GET" && request.url.includes("/v1/branches/")) {
          return jsonResponse(
            request,
            detailStatus,
            detailStatus === 200 ? detailBody : { err: 1 },
          );
        }
        if (request.method === "GET" && request.url.includes("/api-keys")) {
          return jsonResponse(request, apiKeysStatus, apiKeysStatus === 200 ? apiKeysBody : []);
        }
        if (request.method === "GET" && request.url.includes("/config/database/pooler")) {
          const body = opts.skipPrimary
            ? poolerBody.filter((p) => p.database_type !== "PRIMARY")
            : poolerBody;
          return jsonResponse(request, poolerStatus, poolerStatus === 200 ? body : []);
        }
        return jsonResponse(request, 200, null);
      }),
  });
}

function requested(api: { readonly requests: ReadonlyArray<{ method: string; url: string }> }) {
  return api.requests.map(({ method, url }) => `${method} ${url}`);
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = buildApi(opts);
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
  });
  return { layer, out, api };
}

const baseFlags: BranchesGetFlags = {
  name: Option.none(),
  remote: Option.none(),
  projectRef: Option.none(),
  reveal: false,
};

describe("branches get integration", () => {
  it.effect("picks the project and branch on a TTY and fills the linked-project cache", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF, BRANCH_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.succeed(
          request.url === `${API}/v1/projects`
            ? jsonResponse(request, 200, [PROJECT])
            : request.url === `${API}/v1/projects/${VALID_REF}/branches`
              ? jsonResponse(request, 200, [LISTED_BRANCH])
              : request.url === `${API}/v1/branches/${BRANCH_REF}`
                ? jsonResponse(request, 200, DETAIL)
                : request.url === `${API}/v1/projects/${VALID_REF}`
                  ? jsonResponse(request, 200, PROJECT)
                  : jsonResponse(request, 404, { message: "unrouted" }),
        ),
    });
    const cliSettings = mockCommandSettings({
      workdir: tempRoot.current,
      projectId: Option.none(),
    });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings,
      tty: mockTty({ stdinIsTty: true }),
      linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* branchesGet(baseFlags);
      expect(requested(api)).toEqual([
        `GET ${API}/v1/projects`,
        `GET ${API}/v1/projects/${VALID_REF}/branches`,
        `GET ${API}/v1/branches/${BRANCH_REF}`,
        `GET ${API}/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stdoutText).toContain("db.cccccccccccccccccccc.supabase.co");
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "branches get",
        activeFlags: { reveal: false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fetches branch detail directly when input is a UUID (no lookup)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(api.requests.some((r) => r.url.includes(`/v1/branches/${BRANCH_UUID}`))).toBe(true);
      expect(
        api.requests.some((r) =>
          r.url.includes(`/v1/projects/${VALID_REF}/branches/${BRANCH_UUID}`),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("performs lookup-then-detail when input is a plain name", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some("feat-x") });
      expect(
        api.requests.some((r) => r.url.includes(`/v1/projects/${VALID_REF}/branches/feat-x`)),
      ).toBe(true);
      expect(api.requests.some((r) => r.url.includes(`/v1/branches/${BRANCH_UUID}`))).toBe(true);
      assertPermissionDrift({
        command: "branches get",
        activeFlags: { reveal: false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders pretty 7-col table with masked ****** for missing credentials", () => {
    const { layer, out, api } = setup({ detailBody: DETAIL_MASKED });
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(out.stdoutText).toContain("HOST");
      expect(out.stdoutText).toContain("******");
      expect(out.stdoutText).toContain("ACTIVE_HEALTHY");
      expect(requested(api)).toEqual([DETAIL_REQUEST]);
      assertPermissionDrift({
        command: "branches get",
        activeFlags: { reveal: false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips api keys and pooler config for --output pretty", () => {
    const { layer, out, api } = setup({ outputFlag: "pretty" });
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(out.stdoutText).toContain("HOST");
      expect(requested(api)).toEqual([DETAIL_REQUEST]);
      assertPermissionDrift({
        command: "branches get",
        activeFlags: { output: "pretty", reveal: false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits standard-env map for --output-format=json", () => {
    const { layer, out, api } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(requested(api)).toEqual([DETAIL_REQUEST, API_KEYS_REQUEST, POOLER_REQUEST]);
      assertPermissionDrift({
        command: "branches get",
        activeFlags: { "output-format": "json", reveal: false },
        requests: api.requests,
        exact: true,
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toHaveProperty("POSTGRES_URL");
      expect(success?.data).toHaveProperty("POSTGRES_URL_NON_POOLING");
      expect(success?.data).toHaveProperty("SUPABASE_URL");
      expect(success?.data).toHaveProperty("SUPABASE_JWT_SECRET");
      expect(success?.data).toHaveProperty("SUPABASE_ANON_KEY");
      expect(success?.data).toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits SUPABASE_PUBLISHABLE_KEY for new-format api keys", () => {
    const newFormatKeys: ApiKeys = [
      {
        name: "default",
        type: "publishable",
        api_key: "sb_publishable_test",
      },
      {
        name: "default",
        type: "secret",
        api_key: "sb_secret_test",
      },
    ];
    const { layer, out } = setup({ format: "json", apiKeysBody: newFormatKeys });
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
        SUPABASE_DEFAULT_KEY: "sb_secret_test",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "keeps env-map keys verbatim for --output toml (map payload, exempt from CLI-1975)",
    () => {
      const { layer, out, api } = setup({ outputFlag: "toml" });
      return Effect.gen(function* () {
        yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
        assertPermissionDrift({
          command: "branches get",
          activeFlags: { output: "toml", reveal: false },
          requests: api.requests,
          exact: true,
        });
        // Map payloads are exempt from the struct-field PascalCase key remap; keys stay verbatim.
        expect(out.stdoutText).toContain('SUPABASE_URL = "');
        expect(out.stdoutText).toContain('POSTGRES_URL = "');
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("emits standard-env map for --output env (env-format encoder)", () => {
    const { layer, out, api } = setup({ outputFlag: "env" });
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(out.stdoutText).toContain("SUPABASE_URL=");
      expect(out.stdoutText).toContain("SUPABASE_ANON_KEY=");
      expect(requested(api)).toEqual([DETAIL_REQUEST, API_KEYS_REQUEST, POOLER_REQUEST]);
      assertPermissionDrift({
        command: "branches get",
        activeFlags: { output: "env", reveal: false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fetches api keys and pooler config and prints JSON for -o table", () => {
    const { layer, out, api } = setup({ outputFlag: "table" });
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(requested(api)).toEqual([DETAIL_REQUEST, API_KEYS_REQUEST, POOLER_REQUEST]);
      expect(yield* decodeJson(out.stdoutText)).toMatchObject({
        SUPABASE_ANON_KEY: "anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "sr-key",
      });
      assertPermissionDrift({
        command: "branches get",
        activeFlags: { output: "table", reveal: false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  for (const agent of ["auto", "yes"] as const) {
    it.effect(
      `fetches api keys and pooler config when --agent ${agent} yields json output (format simulated)`,
      () => {
        const { layer, out, api } = setup({ format: "json" });
        return Effect.gen(function* () {
          yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
          expect(requested(api)).toEqual([DETAIL_REQUEST, API_KEYS_REQUEST, POOLER_REQUEST]);
          expect(out.messages.find((m) => m.type === "success")?.data).toHaveProperty(
            "SUPABASE_ANON_KEY",
            "anon-key",
          );
          assertPermissionDrift({
            command: "branches get",
            activeFlags: { agent, reveal: false },
            requests: api.requests,
            exact: true,
          });
        }).pipe(Effect.provide(layer));
      },
    );
  }

  it.effect("writes WARNING to stderr when pooler parse fails in text mode", () => {
    const broken: Pooler = [
      {
        ...PRIMARY_POOLER,
        connection_string: "not a url",
      },
    ];
    const { layer, out } = setup({ outputFlag: "yaml", poolerBody: broken });
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(out.stderrText).toContain("WARNING:");
      expect(out.stderrText).toContain("failed to parse pooler URL");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesPrimaryNotFoundError when no PRIMARY pooler entry", () => {
    const { layer } = setup({ outputFlag: "json", skipPrimary: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesPrimaryNotFoundError");
        expect(causeText).toContain("primary database not found");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesFindUnexpectedStatusError on lookup 404", () => {
    const { layer } = setup({ findStatus: 404 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(branchesGet({ ...baseFlags, name: Option.some("feat-x") }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesFindUnexpectedStatusError");
        expect(causeText).toContain("unexpected find branch status 404");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesGetUnexpectedStatusError on detail 503", () => {
    const { layer } = setup({ detailStatus: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesGetUnexpectedStatusError");
        expect(causeText).toContain("unexpected get branch status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesApiKeysUnexpectedStatusError on api-keys 403", () => {
    const { layer, api } = setup({ outputFlag: "json", apiKeysStatus: 403 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesApiKeysUnexpectedStatusError");
        expect(causeText).toContain("unexpected get api keys status 403");
      }
      expect(requested(api)).toEqual([DETAIL_REQUEST, API_KEYS_REQUEST]);
      assertPermissionDrift({
        command: "branches get",
        activeFlags: { output: "json", reveal: false },
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("omits the reveal query param by default", () => {
    const { layer, api } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      const apiKeysReq = api.requests.find((r) => r.url.includes("/api-keys"));
      expect(apiKeysReq).toBeDefined();
      expect(apiKeysReq?.urlWithParams).not.toContain("reveal");
      assertPermissionDrift({
        command: "branches get",
        activeFlags: { output: "json", reveal: false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends reveal=true when --reveal is passed", () => {
    const { layer, api } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID), reveal: true });
      const apiKeysReq = api.requests.find((r) => r.url.includes("/api-keys"));
      expect(apiKeysReq).toBeDefined();
      expect(apiKeysReq?.urlWithParams).toContain("reveal=true");
      assertPermissionDrift({
        command: "branches get",
        activeFlags: { output: "json", reveal: true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("masks secret keys by default when api_key is null", () => {
    const maskedKeys: ApiKeys = [
      { name: "default", type: "publishable", api_key: "sb_publishable_test" },
      { name: "default", type: "secret", api_key: null },
      { name: "service_role", type: "secret", api_key: null },
    ];
    const { layer, out } = setup({ outputFlag: "json", apiKeysBody: maskedKeys });
    return Effect.gen(function* () {
      yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      const envs = yield* decodeJson(out.stdoutText);
      expect(envs).toMatchObject({
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
        SUPABASE_DEFAULT_KEY: "******",
        SUPABASE_SERVICE_ROLE_KEY: "******",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "reveals secret keys in full with --reveal across all structured formats (json, env, toml, yaml)",
    () => {
      const revealedKeys: ApiKeys = [
        { name: "default", type: "publishable", api_key: "sb_publishable_test" },
        { name: "default", type: "secret", api_key: "sb_secret_revealed_test" },
        { name: "service_role", type: "secret", api_key: "sb_secret_sr_revealed" },
      ];
      return Effect.gen(function* () {
        // json
        {
          const { layer, out, api } = setup({ outputFlag: "json", apiKeysBody: revealedKeys });
          yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID), reveal: true }).pipe(
            Effect.provide(layer),
          );
          const envs = yield* decodeJson(out.stdoutText);
          expect(envs).toMatchObject({
            SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
            SUPABASE_DEFAULT_KEY: "sb_secret_revealed_test",
            SUPABASE_SERVICE_ROLE_KEY: "sb_secret_sr_revealed",
          });
          assertPermissionDrift({
            command: "branches get",
            activeFlags: { output: "json", reveal: true },
            requests: api.requests,
            exact: true,
          });
        }
        // env
        {
          const { layer, out, api } = setup({ outputFlag: "env", apiKeysBody: revealedKeys });
          yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID), reveal: true }).pipe(
            Effect.provide(layer),
          );
          expect(out.stdoutText).toContain('SUPABASE_DEFAULT_KEY="sb_secret_revealed_test"');
          expect(out.stdoutText).toContain('SUPABASE_SERVICE_ROLE_KEY="sb_secret_sr_revealed"');
          assertPermissionDrift({
            command: "branches get",
            activeFlags: { output: "env", reveal: true },
            requests: api.requests,
            exact: true,
          });
        }
        // toml
        {
          const { layer, out, api } = setup({ outputFlag: "toml", apiKeysBody: revealedKeys });
          yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID), reveal: true }).pipe(
            Effect.provide(layer),
          );
          expect(out.stdoutText).toContain('SUPABASE_DEFAULT_KEY = "sb_secret_revealed_test"');
          expect(out.stdoutText).toContain('SUPABASE_SERVICE_ROLE_KEY = "sb_secret_sr_revealed"');
          assertPermissionDrift({
            command: "branches get",
            activeFlags: { output: "toml", reveal: true },
            requests: api.requests,
            exact: true,
          });
        }
        // yaml
        {
          const { layer, out, api } = setup({ outputFlag: "yaml", apiKeysBody: revealedKeys });
          yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID), reveal: true }).pipe(
            Effect.provide(layer),
          );
          expect(out.stdoutText).toContain("SUPABASE_DEFAULT_KEY: sb_secret_revealed_test");
          expect(out.stdoutText).toContain("SUPABASE_SERVICE_ROLE_KEY: sb_secret_sr_revealed");
          assertPermissionDrift({
            command: "branches get",
            activeFlags: { output: "yaml", reveal: true },
            requests: api.requests,
            exact: true,
          });
        }
      });
    },
  );

  it.effect(
    "fails with BranchesApiKeysUnexpectedStatusError on api-keys 403 when --reveal is passed",
    () => {
      const { layer, api } = setup({ outputFlag: "json", apiKeysStatus: 403 });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID), reveal: true }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("BranchesApiKeysUnexpectedStatusError");
          expect(causeText).toContain("unexpected get api keys status 403");
        }
        expect(requested(api)).toEqual([DETAIL_REQUEST, API_KEYS_REQUEST]);
        expect(api.requests[1]?.urlWithParams).toContain("reveal=true");
        assertPermissionDrift({
          command: "branches get",
          activeFlags: { output: "json", reveal: true },
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "reveals secret keys on main branch while leaving database credentials unpopulated",
    () => {
      const mainBranchDetail: BranchDetail = {
        ...DETAIL,
        db_pass: undefined,
        db_user: undefined,
      };
      const revealedKeys: ApiKeys = [
        { name: "default", type: "secret", api_key: "sb_secret_main_branch" },
      ];
      const { layer, out } = setup({
        outputFlag: "json",
        detailBody: mainBranchDetail,
        apiKeysBody: revealedKeys,
      });
      return Effect.gen(function* () {
        yield* branchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID), reveal: true });
        const envs = yield* decodeJson(out.stdoutText);
        expect(envs).toMatchObject({
          SUPABASE_DEFAULT_KEY: "sb_secret_main_branch",
        });
        // Database password remains masked because main branch credentials cannot be retrieved via API
        expect((envs as Record<string, string>)["POSTGRES_URL"]).toContain("******");
        expect((envs as Record<string, string>)["POSTGRES_URL_NON_POOLING"]).toContain("******");
      }).pipe(Effect.provide(layer));
    },
  );
});
