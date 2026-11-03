import type { V1ListAllProjectsOutput } from "@supabase/api/effect";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import {
  VALID_REF,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../tests/helpers/command-mocks.ts";
import { mockOutput, mockTty } from "../../tests/helpers/mocks.ts";
import { assertBlockDrift } from "../../tests/helpers/permission-drift.ts";
import { resolveLinkedParentRef } from "../command-internal/parent-project-ref.ts";
import { writeProjectLink } from "../shared/config/project-link.ts";
import {
  type ProjectStateMode,
  projectStateModeLayer,
} from "../shared/config/project-state-mode.ts";
import { commandTargetLayer } from "../shared/output/command-target.layer.ts";
import { projectRefLayer, projectRefPicker } from "./project-ref.layer.ts";
import { CommandSettings } from "./command-settings.service.ts";
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
      Layer.provide(commandTargetLayer.pipe(Layer.provide(output.layer))),
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
      assertBlockDrift(projectRefPicker, {
        activeFlags: {},
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists projects for the picker when --project-ref is empty", () => {
    const { api, layer } = setup({});
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const ref = yield* resolve(Option.some(""));
      expect(ref).toBe(VALID_REF);
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
      ]);
      assertBlockDrift(projectRefPicker, {
        activeFlags: { "project-ref": "" },
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
    const { api, layer } = setup({});
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = path.join(workdir.current, "supabase", ".temp");
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(path.join(tempDir, "project-ref"), VALID_REF);
      const { resolve } = yield* ProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide([layer, BunServices.layer]));
  });
});

describe("projectRefLayer reads the checkout's link", () => {
  const workdir = useTempWorkdir("project-ref-link-");
  const FLAG_REF = "flagflagflagflagflag";
  const BRANCH_REF = "branchbranchbranchbr";
  const poolerUrlFor = (ref: string) =>
    `postgres://postgres.${ref}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

  const inMode = <A, E>(
    mode: ProjectStateMode,
    effect: Effect.Effect<
      A,
      E,
      ProjectRefResolver | CommandSettings | FileSystem.FileSystem | Path.Path
    >,
  ) => {
    const output = mockOutput();
    const settings = mockCommandSettings({ workdir: workdir.current, projectId: Option.none() });
    const layer = projectRefLayer.pipe(
      Layer.provide(settings),
      Layer.provide(mockTty({ stdinIsTty: false })),
      Layer.provide(output.layer),
      Layer.provide(commandTargetLayer.pipe(Layer.provide(output.layer))),
      Layer.provide(mockCommandPlatformApi({ response: { status: 200, body: [] } }).factoryLayer),
      Layer.provide(BunServices.layer),
    );
    return effect.pipe(
      Effect.provide(
        Layer.mergeAll(layer, settings, BunServices.layer, projectStateModeLayer(mode)),
      ),
      Effect.map((value) => ({ value, stderr: output.stderrText })),
    );
  };

  const resolveBoth = Effect.gen(function* () {
    const { resolveRef } = yield* ProjectRefResolver;
    return {
      linked: yield* resolveRef(Option.none()),
      other: yield* resolveRef(Option.some(FLAG_REF)),
    };
  });

  it.effect("carries the legacy saved pooler URL to the linked ref only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = path.join(workdir.current, "supabase", ".temp");
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(path.join(tempDir, "project-ref"), VALID_REF);
      yield* fs.writeFileString(path.join(tempDir, "pooler-url"), poolerUrlFor(VALID_REF));

      const { value } = yield* inMode("legacy", resolveBoth);

      expect(value.linked).toEqual({
        ref: VALID_REF,
        source: "file",
        matchesLinkedRef: true,
        poolerUrl: poolerUrlFor(VALID_REF),
      });
      expect(value.other).toEqual({ ref: FLAG_REF, source: "flag", matchesLinkedRef: false });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("resolves the stack-mode link and carries its pooler URL to the linked ref only", () =>
    Effect.gen(function* () {
      yield* writeProjectLink(workdir.current, {
        project: { ref: VALID_REF },
        active_branch: { ref: VALID_REF, pooler_url: poolerUrlFor(VALID_REF) },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });

      const { value } = yield* inMode("stack", resolveBoth);

      expect(value.linked).toEqual({
        ref: VALID_REF,
        source: "file",
        matchesLinkedRef: true,
        poolerUrl: poolerUrlFor(VALID_REF),
      });
      expect(value.other).toEqual({ ref: FLAG_REF, source: "flag", matchesLinkedRef: false });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("announces a stack-mode linked branch under its parent project", () =>
    Effect.gen(function* () {
      yield* writeProjectLink(workdir.current, {
        project: { ref: VALID_REF, name: "alpha" },
        active_branch: { ref: BRANCH_REF, name: "feature-x" },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });

      const { value, stderr } = yield* inMode(
        "stack",
        Effect.gen(function* () {
          const { resolve } = yield* ProjectRefResolver;
          return { ref: yield* resolve(Option.none()), parent: yield* resolveLinkedParentRef() };
        }),
      );

      expect(value).toEqual({
        ref: BRANCH_REF,
        parent: { kind: "resolved", ref: VALID_REF, linkedRef: BRANCH_REF },
      });
      expect(stderr).toContain(`project alpha (${VALID_REF}) · branch feature-x (${BRANCH_REF})`);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
