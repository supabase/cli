import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiClient } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option } from "effect";
import { afterEach, beforeEach } from "vitest";

import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";
import { mockOutput, mockTty } from "../../../tests/helpers/mocks.ts";
import { LegacyCliConfig } from "./legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "./legacy-project-ref.service.ts";
import { legacyProjectRefLayer } from "./legacy-project-ref.layer.ts";

const VALID_REF = "abcdefghijklmnopqrst";
const ANOTHER_REF = "qrstuvwxyzabcdefghij";

function mockCliConfig(opts: { workdir: string; projectId?: string }) {
  return Layer.succeed(LegacyCliConfig, {
    profile: "supabase",
    apiUrl: "https://api.supabase.com",
    projectHost: "supabase.co",
    poolerHost: "supabase.com",
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
}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptSelectResponses: opts.promptSelectResponses,
  });
  const layer = legacyProjectRefLayer.pipe(
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
  return { layer, out };
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "supabase-legacy-project-ref-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeRefFile(workdir: string, content: string) {
  const tempDir = join(workdir, "supabase", ".temp");
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, "project-ref"), content);
}

describe("legacyProjectRefLayer", () => {
  it.effect("prefers --project-ref flag over env and file", () => {
    writeRefFile(tempRoot, ANOTHER_REF);
    const { layer } = makeLayer({ workdir: tempRoot, projectId: ANOTHER_REF });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const ref = yield* resolve(Option.some(VALID_REF));
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses SUPABASE_PROJECT_ID when flag is unset", () => {
    writeRefFile(tempRoot, ANOTHER_REF);
    const { layer } = makeLayer({ workdir: tempRoot, projectId: VALID_REF });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads <workdir>/supabase/.temp/project-ref when env and flag are unset", () => {
    writeRefFile(tempRoot, VALID_REF);
    const { layer } = makeLayer({ workdir: tempRoot });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("trims whitespace from the temp/project-ref file content", () => {
    writeRefFile(tempRoot, `  ${VALID_REF}\n\n`);
    const { layer } = makeLayer({ workdir: tempRoot });
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
      workdir: tempRoot,
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
    const refPath = join(tempRoot, "supabase", ".temp", "project-ref");
    const { layer } = makeLayer({
      workdir: tempRoot,
      stdinIsTty: true,
      projects,
      promptSelectResponses: [VALID_REF],
    });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      yield* resolve(Option.none());
      // The resolver must not write the file — only `supabase link` does.
      expect(existsSync(refPath)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with LegacyProjectNotLinkedError on non-TTY with no source", () => {
    const { layer } = makeLayer({ workdir: tempRoot });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyProjectNotLinkedError");
        expect(errorJson).toContain("supabase link");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with LegacyInvalidProjectRefError when the resolved ref is malformed", () => {
    const { layer } = makeLayer({ workdir: tempRoot, projectId: "not-a-valid-ref" });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyInvalidProjectRefError");
        expect(errorJson).toContain("Invalid project ref format");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects invalid ref from --project-ref flag", () => {
    const { layer } = makeLayer({ workdir: tempRoot });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.some("BADREF")));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects invalid ref from temp/project-ref file", () => {
    writeRefFile(tempRoot, "BADREF");
    const { layer } = makeLayer({ workdir: tempRoot });
    return Effect.gen(function* () {
      const { resolve } = yield* LegacyProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  describe("resolveOptional", () => {
    it.effect("prefers the flag value", () => {
      writeRefFile(tempRoot, ANOTHER_REF);
      const { layer } = makeLayer({ workdir: tempRoot, projectId: ANOTHER_REF });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveOptional(Option.some(VALID_REF));
        expect(ref).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("falls back to projectId then the ref file", () => {
      const { layer } = makeLayer({ workdir: tempRoot, projectId: VALID_REF });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveOptional(Option.none());
        expect(ref).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("reads the ref file when flag and projectId are unset", () => {
      writeRefFile(tempRoot, VALID_REF);
      const { layer } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveOptional(Option.none());
        expect(ref).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None and never fails when nothing resolves", () => {
      const { layer } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveOptional(Option.none());
        expect(Option.isNone(ref)).toBe(true);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("resolveForLink", () => {
    it.effect("prefers the --project-ref flag", () => {
      const { layer } = makeLayer({ workdir: tempRoot, projectId: ANOTHER_REF });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveForLink(Option.some(VALID_REF));
        expect(ref).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("uses SUPABASE_PROJECT_ID when the flag is unset", () => {
      const { layer } = makeLayer({ workdir: tempRoot, projectId: VALID_REF });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* LegacyProjectRefResolver;
        const ref = yield* resolveForLink(Option.none());
        expect(ref).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("skips the ref file (Go MemMapFs) and fails off-TTY with no flag/projectId", () => {
      // A ref file is present, but link must ignore it and fail like cobra's
      // required-flag check would.
      writeRefFile(tempRoot, VALID_REF);
      const { layer } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* LegacyProjectRefResolver;
        const exit = yield* Effect.exit(resolveForLink(Option.none()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
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
        workdir: tempRoot,
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
      const { layer } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* LegacyProjectRefResolver;
        const exit = yield* Effect.exit(resolveForLink(Option.some("BADREF")));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
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
        workdir: tempRoot,
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
