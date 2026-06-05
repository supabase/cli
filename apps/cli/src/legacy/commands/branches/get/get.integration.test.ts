import type {
  V1GetABranchConfigOutput,
  V1GetABranchOutput,
  V1GetPoolerConfigOutput,
  V1GetProjectApiKeysOutput,
} from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import type { LegacyBranchesGetFlags } from "./get.command.ts";
import { legacyBranchesGet } from "./get.handler.ts";

type BranchDetail = typeof V1GetABranchConfigOutput.Type;
type FindResponse = typeof V1GetABranchOutput.Type;
type Pooler = typeof V1GetPoolerConfigOutput.Type;
type ApiKeys = typeof V1GetProjectApiKeysOutput.Type;

// V1GetABranchConfigInput.branch_id_or_ref is a oneOf [project-ref, uuid] union.
// A 20-lowercase project-ref matches BOTH branches → schema rejects.
// We use a valid v4 UUID for the input so the schema picks exactly one branch.
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";
// project_ref returned by mocks — 20 lowercase, the production shape.
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

// V1GetABranch (named-lookup) returns this — note `project_ref` is a UUID so
// the downstream getABranchConfig({ branch_id_or_ref: UUID }) passes the union.
const FIND: FindResponse = {
  id: BRANCH_UUID,
  name: "feat-x",
  project_ref: BRANCH_UUID,
  parent_project_ref: LEGACY_VALID_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "",
  updated_at: "",
  with_data: false,
};

const POOLER: Pooler = [
  {
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
  },
];

const KEYS: ApiKeys = [
  { name: "anon", api_key: "anon-key" },
  { name: "service_role", api_key: "sr-key" },
];

const tempRoot = useLegacyTempWorkdir("supabase-branches-get-int-");

interface SetupOpts {
  readonly format?: "text" | "json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly findStatus?: number;
  readonly detailStatus?: number;
  readonly detailBody?: BranchDetail;
  readonly poolerStatus?: number;
  readonly poolerBody?: Pooler;
  readonly apiKeysStatus?: number;
  readonly skipPrimary?: boolean;
}

function buildApi(opts: SetupOpts) {
  const findStatus = opts.findStatus ?? 200;
  const detailStatus = opts.detailStatus ?? 200;
  const detailBody = opts.detailBody ?? DETAIL;
  const poolerStatus = opts.poolerStatus ?? 200;
  const poolerBody = opts.poolerBody ?? POOLER;
  const apiKeysStatus = opts.apiKeysStatus ?? 200;
  return mockLegacyPlatformApi({
    handler: (request) =>
      Effect.sync(() => {
        if (
          request.method === "GET" &&
          request.url.includes(`/v1/projects/${LEGACY_VALID_REF}/branches/`)
        ) {
          return legacyJsonResponse(request, findStatus, findStatus === 200 ? FIND : { err: 1 });
        }
        if (request.method === "GET" && request.url.includes("/v1/branches/")) {
          return legacyJsonResponse(
            request,
            detailStatus,
            detailStatus === 200 ? detailBody : { err: 1 },
          );
        }
        if (request.method === "GET" && request.url.includes("/api-keys")) {
          return legacyJsonResponse(request, apiKeysStatus, apiKeysStatus === 200 ? KEYS : []);
        }
        if (request.method === "GET" && request.url.includes("/config/database/pooler")) {
          const body = opts.skipPrimary
            ? poolerBody.filter((p) => p.database_type !== "PRIMARY")
            : poolerBody;
          return legacyJsonResponse(request, poolerStatus, poolerStatus === 200 ? body : []);
        }
        return legacyJsonResponse(request, 200, null);
      }),
  });
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = buildApi(opts);
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api };
}

const baseFlags: LegacyBranchesGetFlags = {
  name: Option.none(),
  projectRef: Option.none(),
};

describe("legacy branches get integration", () => {
  it.live("fetches branch detail directly when input is a UUID (no lookup)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      // Only the detail call hits /v1/branches/<uuid>; no /v1/projects/{ref}/branches/<name> lookup.
      expect(api.requests.some((r) => r.url.includes(`/v1/branches/${BRANCH_UUID}`))).toBe(true);
      expect(
        api.requests.some((r) =>
          r.url.includes(`/v1/projects/${LEGACY_VALID_REF}/branches/${BRANCH_UUID}`),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("performs lookup-then-detail when input is a plain name", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesGet({ ...baseFlags, name: Option.some("feat-x") });
      expect(
        api.requests.some((r) =>
          r.url.includes(`/v1/projects/${LEGACY_VALID_REF}/branches/feat-x`),
        ),
      ).toBe(true);
      expect(api.requests.some((r) => r.url.includes(`/v1/branches/${BRANCH_UUID}`))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("renders pretty 7-col table with masked ****** for missing credentials", () => {
    const { layer, out } = setup({ detailBody: DETAIL_MASKED });
    return Effect.gen(function* () {
      yield* legacyBranchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(out.stdoutText).toContain("HOST");
      expect(out.stdoutText).toContain("******");
      expect(out.stdoutText).toContain("ACTIVE_HEALTHY");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits standard-env map for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyBranchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
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

  it.live("emits standard-env map for --output env (env-format encoder)", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacyBranchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(out.stdoutText).toContain("SUPABASE_URL=");
      expect(out.stdoutText).toContain("SUPABASE_ANON_KEY=");
    }).pipe(Effect.provide(layer));
  });

  it.live("writes WARNING to stderr when pooler parse fails in text mode", () => {
    const broken: Pooler = [
      {
        ...POOLER[0]!,
        connection_string: "not a url",
      },
    ];
    const { layer, out } = setup({ goOutput: "yaml", poolerBody: broken });
    return Effect.gen(function* () {
      yield* legacyBranchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) });
      expect(out.stderrText).toContain("WARNING:");
      expect(out.stderrText).toContain("failed to parse pooler URL");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesPrimaryNotFoundError when no PRIMARY pooler entry", () => {
    const { layer } = setup({ goOutput: "json", skipPrimary: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesPrimaryNotFoundError");
        expect(json).toContain("primary database not found");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesFindUnexpectedStatusError on lookup 404", () => {
    const { layer } = setup({ findStatus: 404 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesGet({ ...baseFlags, name: Option.some("feat-x") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesFindUnexpectedStatusError");
        expect(json).toContain("unexpected find branch status 404");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesGetUnexpectedStatusError on detail 503", () => {
    const { layer } = setup({ detailStatus: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesGetUnexpectedStatusError");
        expect(json).toContain("unexpected get branch status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesApiKeysUnexpectedStatusError on api-keys 403", () => {
    const { layer } = setup({ goOutput: "json", apiKeysStatus: 403 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesGet({ ...baseFlags, name: Option.some(BRANCH_UUID) }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesApiKeysUnexpectedStatusError");
      }
    }).pipe(Effect.provide(layer));
  });
});
