import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { V1ListAllProjectsOutput } from "@supabase/api/effect";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import {
  VALID_REF,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../tests/helpers/command-mocks.ts";
import { mockOutput, mockTty } from "../../tests/helpers/mocks.ts";
import { assertDriftAgainst } from "../../tests/helpers/permission-drift.ts";
import { projectRefLayer, projectRefPicker } from "./project-ref.layer.ts";
import { mapped } from "../command-internal/command-permissions/model.ts";
import { ProjectRefResolver } from "./project-ref.service.ts";

type Projects = typeof V1ListAllProjectsOutput.Type;

const PROJECT: Projects[number] = {
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

const declared = { _tag: "Declared", permissions: mapped(projectRefPicker) } as const;

describe("projectRefLayer Management API requests", () => {
  const workdir = useTempWorkdir("project-ref-api-");

  function setup(opts: { readonly projectId?: string }) {
    const api = mockCommandPlatformApi({ response: { status: 200, body: [PROJECT] } });
    const output = mockOutput({ promptSelectResponses: [VALID_REF] });
    const layer = projectRefLayer.pipe(
      Layer.provide(
        mockCommandSettings({
          workdir: workdir.current,
          projectId: opts.projectId === undefined ? Option.none() : Option.some(opts.projectId),
        }),
      ),
      Layer.provide(mockTty({ stdinIsTty: true })),
      Layer.provide(output.layer),
      Layer.provide(api.factoryLayer),
      Layer.provide(BunServices.layer),
    );
    return { api, layer };
  }

  it.effect("lists projects for the interactive picker when no ref is configured", () => {
    const { api, layer } = setup({});
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
      ]);
      assertDriftAgainst(declared, {
        command: "project-ref picker block",
        activeFlags: {},
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("requests nothing when --project-ref names the project", () => {
    const { api, layer } = setup({});
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const ref = yield* resolve(Option.some(VALID_REF));
      expect(ref).toBe(VALID_REF);
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("requests nothing when SUPABASE_PROJECT_ID names the project", () => {
    const { api, layer } = setup({ projectId: VALID_REF });
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("requests nothing when supabase/.temp/project-ref links the project", () => {
    const tempDir = join(workdir.current, "supabase", ".temp");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "project-ref"), VALID_REF);
    const { api, layer } = setup({});
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
