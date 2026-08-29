import { describe, expect, it } from "@effect/vitest";
import { makeApiClient } from "@supabase/api/effect";
import { Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import {
  emptyEnv,
  mockCliProjectHome,
  mockOutput,
  mockProjectLinkState,
} from "../../../../../tests/helpers/mocks.ts";
import { switchBranch } from "./switch.handler.ts";
import { StackIdSchema } from "@supabase/stack/effect";

const MAIN = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "main",
  project_ref: "mainrefghijklmnopqrst",
  parent_project_ref: "parentrefabcdefghijk",
  is_default: true,
  persistent: true,
  status: "MIGRATIONS_PASSED",
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
  with_data: false,
} as const;
const DEV = {
  ...MAIN,
  id: "00000000-0000-4000-8000-000000000002",
  name: "dev",
  project_ref: "devrefghijklmnopqrst",
  is_default: false,
} as const;
const LINK = {
  project: {
    ref: "parentrefabcdefghijk",
    name: "my-project",
    organization_id: "org123",
    organization_slug: "my-org",
  },
  active_branch: { ref: MAIN.project_ref, name: MAIN.name, is_default: MAIN.is_default },
  fetchedAt: "2024-01-01T00:00:00.000Z",
  versions: {},
};

function setup() {
  const out = mockOutput({ format: "text", interactive: false });
  const api = Layer.effect(
    PlatformApi,
    makeApiClient({
      baseUrl: "https://api.supabase.com",
      accessToken: "test-token",
      userAgent: "supabase",
    }),
  ).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify([MAIN, DEV]))),
          ),
        ),
      ),
    ),
  );
  return {
    out,
    layer: Layer.mergeAll(
      emptyEnv(),
      out.layer,
      mockCliProjectHome({ projectRoot: process.cwd() }),
      mockProjectLinkState(LINK),
      api,
    ),
  };
}

describe("branches switch handler", () => {
  it.live("switches to a branch by name and updates the active branch", () => {
    const { out, layer } = setup();
    return switchBranch({ name: Option.some("dev") }).pipe(
      Effect.provide(layer),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(out.messages).toContainEqual(
            expect.objectContaining({ type: "outro", message: "Switched to branch 'dev'." }),
          );
        }),
      ),
    );
  });

  it.live("requires a branch name in non-interactive mode", () => {
    const { layer } = setup();
    return switchBranch({ name: Option.none() }).pipe(
      Effect.provide(layer),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
    );
  });

  it.live("guides a running stack to restart after switching branches", () => {
    const { out, layer } = setup();
    const operations = {
      findStack: () =>
        Effect.succeed(
          Option.some({
            id: StackIdSchema.make(
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            ),
            projectRoot: process.cwd(),
            name: "default",
            branchContext: "refs/heads/main",
            runtime: { kind: "native" as const },
            desiredLifecycle: "running" as const,
          }),
        ),
    };
    return switchBranch({ name: Option.some("dev") }, operations).pipe(
      Effect.provide(layer),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(out.messages.some((message) => message.message.includes("supabase restart"))).toBe(
            true,
          );
        }),
      ),
    );
  });
});
