import type { ApiClient } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { mockOutput, mockTty } from "../../tests/helpers/mocks.ts";
import { CommandSettings } from "./command-settings.service.ts";
import { RemoteTarget } from "./remote-target.service.ts";
import { remoteTargetLayer } from "./remote-target.layer.ts";

const VALID_REF = "abcdefghijklmnopqrst";
const ANOTHER_REF = "qrstuvwxyzabcdefghij";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function mockCliSettings(opts: { workdir: string; projectId?: string }) {
  return Layer.succeed(CommandSettings, {
    dbPassword: Option.none(),
    githubToken: Option.none(),
    workdirEnvValue: Option.none(),
    profile: "supabase",
    profileEnvValue: Option.none(),
    supabaseHome: "/tmp/.supabase",
    apiUrl: "https://api.supabase.com",
    projectHost: "supabase.co",
    poolerHost: "supabase.com",
    dashboardUrl: "https://supabase.com/dashboard",
    accessToken: Option.none(),
    projectId: opts.projectId === undefined ? Option.none() : Option.some(opts.projectId),
    workdir: opts.workdir,
    explicitWorkdir: false,
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
  return Layer.succeed(CommandPlatformApi, api);
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
}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptSelectResponses: opts.promptSelectResponses,
  });
  const layer = remoteTargetLayer.pipe(
    Layer.provide(mockCliSettings(opts)),
    Layer.provide(mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false })),
    Layer.provide(out.layer),
    Layer.provide(
      Layer.succeed(CommandPlatformApiFactory, {
        make: CommandPlatformApi.pipe(Effect.provide(mockPlatformApi(opts.projects ?? []))),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, out };
}

const tempRoot = useTempWorkdir("supabase-project-ref-");

const writeRefFile = Effect.fnUntraced(function* (workdir: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = path.join(workdir, "supabase", ".temp");
  yield* fs.makeDirectory(tempDir, { recursive: true });
  yield* fs.writeFileString(path.join(tempDir, "project-ref"), content);
});

describe("remoteTargetLayer", () => {
  it.effect("prefers --project-ref flag over env and file", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current, projectId: ANOTHER_REF });
    return Effect.gen(function* () {
      yield* writeRefFile(tempRoot.current, ANOTHER_REF);
      const { resolve } = yield* RemoteTarget;
      const { ref } = yield* resolve(Option.some(VALID_REF));
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses SUPABASE_PROJECT_ID when flag is unset", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current, projectId: VALID_REF });
    return Effect.gen(function* () {
      yield* writeRefFile(tempRoot.current, ANOTHER_REF);
      const { resolve } = yield* RemoteTarget;
      const { ref } = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads <workdir>/supabase/.temp/project-ref when env and flag are unset", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current });
    return Effect.gen(function* () {
      yield* writeRefFile(tempRoot.current, VALID_REF);
      const { resolve } = yield* RemoteTarget;
      const { ref } = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("trims whitespace from the temp/project-ref file content", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current });
    return Effect.gen(function* () {
      yield* writeRefFile(tempRoot.current, `  ${VALID_REF}\n\n`);
      const { resolve } = yield* RemoteTarget;
      const { ref } = yield* resolve(Option.none());
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
      const { resolve } = yield* RemoteTarget;
      const { ref } = yield* resolve(Option.none());
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
    const { layer } = makeLayer({
      workdir: tempRoot.current,
      stdinIsTty: true,
      projects,
      promptSelectResponses: [VALID_REF],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const refPath = path.join(tempRoot.current, "supabase", ".temp", "project-ref");
      const { resolve } = yield* RemoteTarget;
      yield* resolve(Option.none());
      expect(yield* fs.exists(refPath)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ProjectRefNotLinkedError on non-TTY with no source", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current });
    return Effect.gen(function* () {
      const { resolve } = yield* RemoteTarget;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = yield* encodeJson(exit.cause);
        expect(errorJson).toContain("ProjectRefNotLinkedError");
        expect(errorJson).toContain("supabase link");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with InvalidProjectRefError when the resolved ref is malformed", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current, projectId: "not-a-valid-ref" });
    return Effect.gen(function* () {
      const { resolve } = yield* RemoteTarget;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = yield* encodeJson(exit.cause);
        expect(errorJson).toContain("InvalidProjectRefError");
        expect(errorJson).toContain("Invalid project ref format");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects invalid ref from --project-ref flag", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current });
    return Effect.gen(function* () {
      const { resolve } = yield* RemoteTarget;
      const exit = yield* Effect.exit(resolve(Option.some("BADREF")));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects invalid ref from temp/project-ref file", () => {
    const { layer } = makeLayer({ workdir: tempRoot.current });
    return Effect.gen(function* () {
      yield* writeRefFile(tempRoot.current, "BADREF");
      const { resolve } = yield* RemoteTarget;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  describe("resolveOptional", () => {
    it.effect("prefers the flag value", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, projectId: ANOTHER_REF });
      return Effect.gen(function* () {
        yield* writeRefFile(tempRoot.current, ANOTHER_REF);
        const { resolveOptional } = yield* RemoteTarget;
        const ref = yield* resolveOptional(Option.some(VALID_REF));
        expect(Option.map(ref, (target) => target.ref)).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("falls back to projectId then the ref file", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, projectId: VALID_REF });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* RemoteTarget;
        const ref = yield* resolveOptional(Option.none());
        expect(Option.map(ref, (target) => target.ref)).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("reads the ref file when flag and projectId are unset", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current });
      return Effect.gen(function* () {
        yield* writeRefFile(tempRoot.current, VALID_REF);
        const { resolveOptional } = yield* RemoteTarget;
        const ref = yield* resolveOptional(Option.none());
        expect(Option.map(ref, (target) => target.ref)).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None and never fails when nothing resolves", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* RemoteTarget;
        const ref = yield* resolveOptional(Option.none());
        expect(Option.isNone(ref)).toBe(true);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("load (Go flags.LoadProjectRef — non-prompting)", () => {
    it.effect("prefers flag, then projectId, then the ref file", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, projectId: ANOTHER_REF });
      return Effect.gen(function* () {
        yield* writeRefFile(tempRoot.current, ANOTHER_REF);
        const { load } = yield* RemoteTarget;
        expect((yield* load(Option.some(VALID_REF))).ref).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("reads the ref file when flag and projectId are unset", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current });
      return Effect.gen(function* () {
        yield* writeRefFile(tempRoot.current, VALID_REF);
        const { load } = yield* RemoteTarget;
        expect((yield* load(Option.none())).ref).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("fails fast with ProjectRefNotLinkedError and never prompts on a TTY", () => {
      const { layer, out } = makeLayer({
        workdir: tempRoot.current,
        stdinIsTty: true,
        projects: [
          { id: VALID_REF, name: "alpha", organization_slug: "acme", region: "us-east-1" },
        ],
        promptSelectResponses: [VALID_REF],
      });
      return Effect.gen(function* () {
        const { load } = yield* RemoteTarget;
        const exit = yield* Effect.exit(load(Option.none()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = yield* encodeJson(exit.cause);
          expect(errorJson).toContain("ProjectRefNotLinkedError");
          expect(errorJson).toContain("supabase link");
        }
        expect(out.promptSelectCalls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("validates the resolved ref format", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, projectId: "not-a-valid-ref" });
      return Effect.gen(function* () {
        const { load } = yield* RemoteTarget;
        const exit = yield* Effect.exit(load(Option.none()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(yield* encodeJson(exit.cause)).toContain("InvalidProjectRefError");
        }
      }).pipe(Effect.provide(layer));
    });
  });

  describe("resolveForLink", () => {
    it.effect("prefers the --project-ref flag", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, projectId: ANOTHER_REF });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* RemoteTarget;
        const { ref } = yield* resolveForLink(Option.some(VALID_REF));
        expect(ref).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("uses SUPABASE_PROJECT_ID when the flag is unset", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current, projectId: VALID_REF });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* RemoteTarget;
        const { ref } = yield* resolveForLink(Option.none());
        expect(ref).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("skips the ref file (Go MemMapFs) and fails off-TTY with no flag/projectId", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current });
      return Effect.gen(function* () {
        yield* writeRefFile(tempRoot.current, VALID_REF);
        const { resolveForLink } = yield* RemoteTarget;
        const exit = yield* Effect.exit(resolveForLink(Option.none()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = yield* encodeJson(exit.cause);
          expect(errorJson).toContain("ProjectRefRequiredError");
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
        const { resolveForLink } = yield* RemoteTarget;
        const { ref } = yield* resolveForLink(Option.none());
        expect(ref).toBe(VALID_REF);
        expect(out.promptSelectCalls[0]?.message).toBe("Select a project:");
      }).pipe(Effect.provide(layer));
    });

    it.effect("rejects an invalid --project-ref flag", () => {
      const { layer } = makeLayer({ workdir: tempRoot.current });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* RemoteTarget;
        const exit = yield* Effect.exit(resolveForLink(Option.some("BADREF")));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(yield* encodeJson(exit.cause)).toContain("InvalidProjectRefError");
        }
      }).pipe(Effect.provide(layer));
    });
  });

  describe("prompt", () => {
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
        const { prompt } = yield* RemoteTarget;
        const ref = yield* prompt("Which project do you want to delete?");
        expect(ref).toBe(ANOTHER_REF);
        expect(out.promptSelectCalls[0]?.message).toBe("Which project do you want to delete?");
        const infos = out.messages.filter((m) => m.type === "info").map((m) => m.message);
        expect(infos).toContain(`Selected project: ${ANOTHER_REF}`);
      }).pipe(Effect.provide(layer));
    });
  });
});
