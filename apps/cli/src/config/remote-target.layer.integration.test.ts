import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { V1ListAllProjectsOutput } from "@supabase/api/effect";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Tracer } from "effect";

import {
  VALID_REF,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../tests/helpers/command-mocks.ts";
import { mockOutput, mockTty } from "../../tests/helpers/mocks.ts";
import { assertBlockDrift } from "../../tests/helpers/permission-drift.ts";
import { writeProjectLink } from "../command-internal/project-link.ts";
import { projectStateModeLayer } from "../command-internal/project-state-mode.ts";
import { remoteTargetLayer, projectRefPicker } from "./remote-target.layer.ts";
import { RemoteTarget } from "./remote-target.service.ts";

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

describe("remoteTargetLayer Management API requests", () => {
  const workdir = useTempWorkdir("project-ref-api-");

  function setup(opts: { readonly projectId?: string }) {
    const api = mockCommandPlatformApi({ response: { status: 200, body: [PROJECT] } });
    const output = mockOutput({ promptSelectResponses: [VALID_REF] });
    const layer = remoteTargetLayer.pipe(
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
      const { resolve } = yield* RemoteTarget;
      const { ref } = yield* resolve(Option.none());
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
      const { resolve } = yield* RemoteTarget;
      const { ref } = yield* resolve(Option.some(""));
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
      const { resolve } = yield* RemoteTarget;
      const { ref } = yield* resolve(Option.some(VALID_REF));
      expect(ref).toBe(VALID_REF);
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("requests nothing when SUPABASE_PROJECT_ID names the project", () => {
    const { api, layer } = setup({ projectId: VALID_REF });
    return Effect.gen(function* () {
      const { resolve } = yield* RemoteTarget;
      const { ref } = yield* resolve(Option.none());
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
      const { resolve } = yield* RemoteTarget;
      const { ref } = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

describe("remoteTargetLayer in stack mode", () => {
  const workdir = useTempWorkdir("remote-target-stack-");
  const FLAG_REF = "flagflagflagflagflag";
  const ENV_REF = "zyxwvutsrqponmlkjihg";
  const BRANCH_REF = "branchbranchbranchbr";
  const POOLER_URL = `postgres://postgres.${BRANCH_REF}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

  const linkWith = (activeBranch: { ref: string; name?: string; pooler_url?: string }) =>
    writeProjectLink(workdir.current, {
      project: { ref: VALID_REF },
      active_branch: activeBranch,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    }).pipe(Effect.provide(BunServices.layer));

  const inStackMode = <A, E>(
    effect: Effect.Effect<A, E, RemoteTarget>,
    projectId?: string,
  ): Effect.Effect<A, E> => {
    const api = mockCommandPlatformApi({ response: { status: 200, body: [] } });
    const layer = remoteTargetLayer.pipe(
      Layer.provide(
        mockCommandSettings({
          workdir: workdir.current,
          projectId: projectId === undefined ? Option.none() : Option.some(projectId),
        }),
      ),
      Layer.provide(mockTty({ stdinIsTty: false })),
      Layer.provide(mockOutput().layer),
      Layer.provide(api.factoryLayer),
      Layer.provide(BunServices.layer),
    );
    return effect.pipe(Effect.provide(layer), Effect.provide(projectStateModeLayer("stack")));
  };

  const resolveWith = (flag: Option.Option<string>, projectId?: string) =>
    inStackMode(
      Effect.gen(function* () {
        const remoteTarget = yield* RemoteTarget;
        return yield* remoteTarget.resolve(flag);
      }),
      projectId,
    );

  it.effect("resolves the flag before the env and the link", () =>
    Effect.gen(function* () {
      yield* linkWith({ ref: VALID_REF });
      const target = yield* resolveWith(Option.some(FLAG_REF), ENV_REF);
      expect(target).toMatchObject({ ref: FLAG_REF, source: "flag" });
    }),
  );

  it.effect("resolves the env before the link", () =>
    Effect.gen(function* () {
      yield* linkWith({ ref: VALID_REF });
      const target = yield* resolveWith(Option.none(), ENV_REF);
      expect(target).toMatchObject({ ref: ENV_REF, source: "env" });
    }),
  );

  it.effect("resolves the link when no flag or env names a project", () =>
    Effect.gen(function* () {
      yield* linkWith({ ref: VALID_REF });
      const target = yield* resolveWith(Option.none());
      expect(target).toEqual({ ref: VALID_REF, source: "link" });
    }),
  );

  it.effect("reports a linked branch with its parent project and name", () =>
    Effect.gen(function* () {
      yield* linkWith({ ref: BRANCH_REF, name: "feature-x" });
      const { target, parent } = yield* inStackMode(
        Effect.gen(function* () {
          const remoteTarget = yield* RemoteTarget;
          return {
            target: yield* remoteTarget.resolve(Option.none()),
            parent: yield* remoteTarget.parent,
          };
        }),
      );
      expect(target).toEqual({
        ref: BRANCH_REF,
        source: "link",
        parentRef: VALID_REF,
        branchName: "feature-x",
      });
      expect(parent).toEqual({ kind: "resolved", ref: VALID_REF, source: "link" });
    }),
  );

  it.effect("carries the link's pooler URL to the linked ref only", () =>
    Effect.gen(function* () {
      yield* linkWith({ ref: BRANCH_REF, name: "feature-x", pooler_url: POOLER_URL });
      const { linked, other } = yield* inStackMode(
        Effect.gen(function* () {
          const remoteTarget = yield* RemoteTarget;
          return {
            linked: yield* remoteTarget.load(Option.some(BRANCH_REF)),
            other: yield* remoteTarget.load(Option.some(FLAG_REF)),
          };
        }),
      );
      expect(linked.poolerUrl).toBe(POOLER_URL);
      expect(other).toEqual({ ref: FLAG_REF, source: "flag" });
    }),
  );

  it.effect("reads the link once for repeated resolution", () =>
    Effect.gen(function* () {
      yield* linkWith({ ref: VALID_REF });
      const spans: Array<string> = [];
      const tracer = Tracer.make({
        span: (options) => {
          spans.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
      yield* inStackMode(
        Effect.gen(function* () {
          const remoteTarget = yield* RemoteTarget;
          yield* remoteTarget.resolve(Option.none());
          yield* remoteTarget.resolve(Option.none());
        }),
      ).pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));
      expect(spans.filter((name) => name === "RemoteTarget.resolve")).toHaveLength(1);
      expect(spans.filter((name) => name === "LinkSnapshot.readStack")).toHaveLength(1);
    }),
  );
});
