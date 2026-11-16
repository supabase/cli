import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { prepareCliArgs } from "../../shared/cli/run.ts";
import { branchesGet } from "./get/get.handler.ts";

const API = "https://api.supabase.com";
const OTHER_REF = "qrstuvwxyzabcdefghij";
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";

const DETAIL = {
  ref: OTHER_REF,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: `db.${OTHER_REF}.supabase.co`,
  db_port: 5432,
  db_user: "postgres",
  db_pass: "secret",
  jwt_secret: "jwt-secret",
};

const listedBranch = {
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

const root = rootCommandForFeatures();
const tempRoot = useTempWorkdir("supabase-branches-remote-operand-int-");

function setup() {
  const api = mockCommandPlatformApi({
    handler: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === `/v1/projects/${VALID_REF}/branches`) {
        return Effect.succeed(jsonResponse(request, 200, [listedBranch]));
      }
      if (pathname === `/v1/projects/${VALID_REF}/branches/feat-x`) {
        return Effect.succeed(jsonResponse(request, 200, listedBranch));
      }
      if (pathname.startsWith("/v1/branches/")) {
        return Effect.succeed(jsonResponse(request, 200, DETAIL));
      }
      return Effect.succeed(jsonResponse(request, 404, { message: "unrouted" }));
    },
  });
  const layer = buildTestRuntime({
    out: mockOutput(),
    api,
    cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    commandPath: ["branches", "get"],
  });
  return { api, layer };
}

const getBranch = (argv: ReadonlyArray<string>, name: string) =>
  branchesGet({
    name: Option.some(name),
    remote: Option.some({ _tag: "Linked" }),
    projectRef: Option.none(),
  }).pipe(Effect.provide(Layer.succeed(CliArgs, prepareCliArgs(root, argv))));

const requested = (api: { readonly requests: ReadonlyArray<{ method: string; url: string }> }) =>
  api.requests.map(({ method, url }) => `${method} ${url}`);

describe("a bare --remote followed by a word on a parent-scoped command", () => {
  it.effect("fails a project-ref-shaped word with both readings, before any request", () => {
    const { api, layer } = setup();
    return Effect.gen(function* () {
      const error = yield* getBranch(["branches", "get", "--remote", OTHER_REF], OTHER_REF).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "TargetRemoteAmbiguousError",
        message: `"${OTHER_REF}" after --remote looks like a project ref. For that project: supabase branches get --remote=${OTHER_REF}. To keep it as an operand, put --remote last: supabase branches get <operands> --remote`,
      });
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a project-ref-shaped operand when --remote comes last", () => {
    const { api, layer } = setup();
    return Effect.gen(function* () {
      yield* getBranch(["branches", "get", OTHER_REF, "--remote"], OTHER_REF);
      expect(requested(api)).toEqual([`GET ${API}/v1/branches/${OTHER_REF}`]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads a branch-name word as the operand without listing branches to check it", () => {
    const { api, layer } = setup();
    return Effect.gen(function* () {
      yield* getBranch(["branches", "get", "--remote", "feat-x"], "feat-x");
      expect(requested(api)).toEqual([
        `GET ${API}/v1/projects/${VALID_REF}/branches/feat-x`,
        `GET ${API}/v1/branches/${BRANCH_UUID}`,
      ]);
    }).pipe(Effect.provide(layer));
  });
});
