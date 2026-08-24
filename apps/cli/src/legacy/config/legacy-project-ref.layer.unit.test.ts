import type { ApiClient } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { BunPath, BunServices } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Formatter, Layer, Option, Path } from "effect";

import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";
import { mockOutput, mockTty } from "../../../tests/helpers/mocks.ts";
import { LegacyCliConfig } from "./legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "./legacy-project-ref.service.ts";
import { legacyProjectRefLayer } from "./legacy-project-ref.layer.ts";
import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";

const VALID_REF = "abcdefghijklmnopqrst";
const ANOTHER_REF = "qrstuvwxyzabcdefghij";

function mockCliConfig(opts: { workdir: string; projectId?: string }) {
  return Layer.succeed(LegacyCliConfig, {
    profile: "supabase",
    apiUrl: "https://api.supabase.com",
    projectHost: "supabase.co",
    poolerHost: "supabase.com",
    dashboardUrl: "https://supabase.com/dashboard",
    accessToken: Option.none(),
    projectId: opts.projectId === undefined ? Option.none() : Option.some(opts.projectId),
    workdir: opts.workdir,
    userAgent: "SupabaseCLI/0.0.0-dev",
  });
}

function mockPlatformApi(
  projects: ReadonlyArray<{
    id: string;
    name: string;
    organization_slug: string;
    region: string;
  }>,
) {
  const api = {
    v1: {
      listAllProjects: () => Effect.succeed(projects),
    },
  } as unknown as ApiClient;
  return Layer.succeed(LegacyPlatformApi, api);
}

function makeLayer(opts: {
  workdir: string;
  projectId?: string;
  stdinIsTty?: boolean;
  format?: "text" | "json" | "stream-json";
  projects?: ReadonlyArray<{
    id: string;
    name: string;
    organization_slug: string;
    region: string;
  }>;
  promptSelectResponses?: ReadonlyArray<string>;
  refFile?: string;
}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptSelectResponses: opts.promptSelectResponses,
  });
  const baseLayer = legacyProjectRefLayer.pipe(
    Layer.provide(mockCliConfig(opts)),
    Layer.provide(mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false })),
    Layer.provide(out.layer),
    Layer.provide(
      Layer.succeed(LegacyPlatformApiFactory, {
        make: LegacyPlatformApi.pipe(Effect.provide(mockPlatformApi(opts.projects ?? []))),
      }),
    ),
    Layer.provide(BunServices.layer),
  );
  const refFile = opts.refFile;
  const refFileLayer =
    refFile === undefined
      ? Layer.empty
      : Layer.effectDiscard(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const refPath = path.join(opts.workdir, "supabase", ".temp", "project-ref");
            yield* fs.makeDirectory(path.dirname(refPath), { recursive: true });
            yield* fs.writeFileString(refPath, refFile);
          }).pipe(Effect.provide(BunServices.layer)),
        );
  const layer = Layer.mergeAll(baseLayer.pipe(Layer.provide(refFileLayer)), BunServices.layer);
  return { layer, out };
}

const tempRoot = useLegacyTempWorkdir("supabase-legacy-project-ref-");
const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));

describe("legacyProjectRefLayer", () => {
  it.effect("prefers --project-ref flag over env and file", () => {
    const { layer } = makeLayer({
      workdir: tempRoot.current,
      projectId: ANOTHER_REF,
      refFile: ANOTHER_REF,
    });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const ref = yield* resolve(Option.some(VALID_REF));
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses SUPABASE_PROJECT_ID when flag is unset", () => {
    const { layer } = makeLayer({
      workdir: tempRoot.current,
      projectId: VALID_REF,
      refFile: ANOTHER_REF,
    });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads <workdir>/supabase/.temp/project-ref when env and flag are unset", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current, refFile: VALID_REF });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("trims whitespace from the temp/project-ref file content", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current, refFile: `  ${VALID_REF}\n\n` });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("prompts via Output.promptSelect when on a TTY with no other source", () => {
    const projects = [
      { id: VALID_REF, name: "alpha", organization_slug: "acme", region: "us-east-1" },
      { id: ANOTHER_REF, name: "beta", organization_slug: "acme", region: "eu-west-1" },
    ];
    const { layer, out } = makeLayer({
      workdir: tempRoot.current,
      stdinIsTty: true,
      projects,
      promptSelectResponses: [ANOTHER_REF],
    });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(ANOTHER_REF);
      const call = out.promptSelectCalls[0];
      expect(call?.message).toBe("Select a project:");
      expect(call?.options[0]).toEqual({
        value: VALID_REF,
        label: VALID_REF,
        hint: "name: alpha, org: acme, region: us-east-1",
      });
      // "Selected project: ..." is emitted via output.info (-> stderr in text mode).
      const infos = out.messages.filter((m) => m.type === "info").map((m) => m.message);
      expect(infos).toContain(`Selected project: ${ANOTHER_REF}`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not persist the selected ref to the temp file (Go parity)", () => {
    const projects = [
      { id: VALID_REF, name: "alpha", organization_slug: "acme", region: "us-east-1" },
    ];
    const refPath = path.join(tempRoot.current, "supabase", ".temp", "project-ref");
    const { layer } = makeLayer({
      workdir: tempRoot.current,
      stdinIsTty: true,
      projects,
      promptSelectResponses: [VALID_REF],
    });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      yield* resolve(Option.none());
      // The resolver must not write the file — only `supabase link` does.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(refPath)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with LegacyProjectNotLinkedError on non-TTY with no source", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = Formatter.formatJson(exit.cause);
        expect(errorJson).toContain("LegacyProjectNotLinkedError");
        expect(errorJson).toContain("supabase link");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with LegacyInvalidProjectRefError when the resolved ref is malformed", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current, projectId: "not-a-valid-ref" });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = Formatter.formatJson(exit.cause);
        expect(errorJson).toContain("LegacyInvalidProjectRefError");
        expect(errorJson).toContain("Invalid project ref format");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects invalid ref from --project-ref flag", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.some("BADREF")));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects invalid ref from temp/project-ref file", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current, refFile: "BADREF" });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  describe("resolveOptional", () => {
    it.effect("prefers the flag value", () => {
      const { layer } = makeLayer({
        workdir: tempRoot.current,
        projectId: ANOTHER_REF,
        refFile: ANOTHER_REF,
      });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveOptional(Option.some(VALID_REF));
        expect(ref).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("falls back to projectId then the ref file", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, projectId: VALID_REF });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveOptional(Option.none());
        expect(ref).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("reads the ref file when flag and projectId are unset", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, refFile: VALID_REF });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveOptional(Option.none());
        expect(ref).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None and never fails when nothing resolves", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveOptional(Option.none());
        expect(Option.isNone(ref)).toBe(true);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("loadProjectRef (Go flags.LoadProjectRef — non-prompting)", () => {
    it.effect("prefers flag, then projectId, then the ref file", () => {
      const { layer } = makeLayer({
        workdir: tempRoot.current,
        projectId: ANOTHER_REF,
        refFile: ANOTHER_REF,
      });
      return Effect.gen(function* () {
        const { loadProjectRef } = yield* LegacyProjectRefResolver;
        expect(yield* loadProjectRef(Option.some(VALID_REF))).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("reads the ref file when flag and projectId are unset", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, refFile: VALID_REF });
      return Effect.gen(function* () {
        const { loadProjectRef } = yield* LegacyProjectRefResolver;
        expect(yield* loadProjectRef(Option.none())).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("fails fast with LegacyProjectNotLinkedError and never prompts on a TTY", () => {
      // Even on an interactive TTY with projects available, loadProjectRef
      // must NOT open the picker (that is `resolve`'s job). `db
      // lint`/`db advisors --linked` use loadProjectRef, which fails with
      // LegacyProjectNotLinkedError instead of prompting.
      const { layer, out } = makeLayer({
        workdir: tempRoot.current,
        stdinIsTty: true,
        projects: [
          { id: VALID_REF, name: "alpha", organization_slug: "acme", region: "us-east-1" },
        ],
        promptSelectResponses: [VALID_REF],
      });
      return Effect.gen(function* () {
        const { loadProjectRef } = yield* LegacyProjectRefResolver;
        const exit = yield* Effect.exit(loadProjectRef(Option.none()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = Formatter.formatJson(exit.cause);
          expect(errorJson).toContain("LegacyProjectNotLinkedError");
          expect(errorJson).toContain("supabase link");
        }
        expect(out.promptSelectCalls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("validates the resolved ref format", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, projectId: "not-a-valid-ref" });
      return Effect.gen(function* () {
        const { loadProjectRef } = yield* LegacyProjectRefResolver;
        const exit = yield* Effect.exit(loadProjectRef(Option.none()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Formatter.formatJson(exit.cause)).toContain("LegacyInvalidProjectRefError");
        }
      }).pipe(Effect.provide(layer));
    });
  });

  describe("resolveForLink", () => {
    it.effect("prefers the --project-ref flag", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, projectId: ANOTHER_REF });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveForLink(Option.some(VALID_REF));
        expect(ref).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("uses SUPABASE_PROJECT_ID when the flag is unset", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, projectId: VALID_REF });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveForLink(Option.none());
        expect(ref).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("skips the ref file (Go MemMapFs) and fails off-TTY with no flag/projectId", () => {
      // A ref file is present, but link must ignore it and fail like cobra's
      // required-flag check would.
      const { layer } = makeLayer({ workdir: tempRoot.current, refFile: VALID_REF });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* LegacyProjectRefResolver;
        const exit = yield* Effect.exit(resolveForLink(Option.none()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = Formatter.formatJson(exit.cause);
          expect(errorJson).toContain("LegacyProjectRefRequiredError");
          expect(errorJson).toContain(`required flag(s) \\"project-ref\\" not set`);
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect("prompts via Output.promptSelect on a TTY with no other source", () => {
      const projects = [
        { id: VALID_REF, name: "alpha", organization_slug: "acme", region: "us-east-1" },
      ];
      const { layer, out } = makeLayer({
        workdir: tempRoot.current,
        stdinIsTty: true,
        projects,
        promptSelectResponses: [VALID_REF],
      });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveForLink(Option.none());
        expect(ref).toBe(VALID_REF);
        expect(out.promptSelectCalls[0]?.message).toBe("Select a project:");
      }).pipe(Effect.provide(layer));
    });

    it.effect("rejects an invalid --project-ref flag", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* LegacyProjectRefResolver;
        const exit = yield* Effect.exit(resolveForLink(Option.some("BADREF")));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Formatter.formatJson(exit.cause)).toContain("LegacyInvalidProjectRefError");
        }
      }).pipe(Effect.provide(layer));
    });
  });

  describe("promptProjectRef", () => {
    it.effect("prompts with the given title, returns the choice, and echoes it", () => {
      const projects = [
        { id: VALID_REF, name: "alpha", organization_slug: "acme", region: "us-east-1" },
        { id: ANOTHER_REF, name: "beta", organization_slug: "acme", region: "eu-west-1" },
      ];
      const { layer, out } = makeLayer({
        workdir: tempRoot.current,
        stdinIsTty: true,
        projects,
        promptSelectResponses: [ANOTHER_REF],
      });
      return Effect.gen(function* () {
        const { promptProjectRef } = yield* LegacyProjectRefResolver;
        const ref = yield* promptProjectRef("Which project do you want to delete?");
        expect(ref).toBe(ANOTHER_REF);
        expect(out.promptSelectCalls[0]?.message).toBe("Which project do you want to delete?");
        const infos = out.messages.filter((m) => m.type === "info").map((m) => m.message);
        expect(infos).toContain(`Selected project: ${ANOTHER_REF}`);
      }).pipe(Effect.provide(layer));
    });
  });
});
