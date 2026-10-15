import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiClient } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option } from "effect";
import { afterEach, beforeEach } from "vitest";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { mockOutput, mockTty } from "../../tests/helpers/mocks.ts";
import { commandTargetLayer } from "../shared/output/command-target.layer.ts";
import { CommandSettings } from "./command-settings.service.ts";
import { ProjectRefResolver } from "./project-ref.service.ts";
import { projectRefLayer } from "./project-ref.layer.ts";

const VALID_REF = "abcdefghijklmnopqrst";
const ANOTHER_REF = "qrstuvwxyzabcdefghij";

function mockCliSettings(opts: { workdir: string; projectId?: string }) {
  return Layer.succeed(CommandSettings, {
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
  const layer = projectRefLayer.pipe(
    Layer.provide(mockCliSettings(opts)),
    Layer.provide(mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false })),
    Layer.provide(out.layer),
    Layer.provide(commandTargetLayer.pipe(Layer.provide(out.layer))),
    Layer.provide(
      Layer.succeed(CommandPlatformApiFactory, {
        make: CommandPlatformApi.pipe(Effect.provide(mockPlatformApi(opts.projects ?? []))),
      }),
    ),
    Layer.provide(BunServices.layer),
  );
  return { layer, out };
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "supabase-project-ref-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeRefFile(workdir: string, content: string) {
  const tempDir = join(workdir, "supabase", ".temp");
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, "project-ref"), content);
}

describe("projectRefLayer", () => {
  it.effect("prefers --project-ref flag over env and file", () => {
    writeRefFile(tempRoot, ANOTHER_REF);
    const { layer } = makeLayer({ workdir: tempRoot, projectId: ANOTHER_REF });
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const ref = yield* resolve(Option.some(VALID_REF));
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses SUPABASE_PROJECT_ID when flag is unset", () => {
    writeRefFile(tempRoot, ANOTHER_REF);
    const { layer } = makeLayer({ workdir: tempRoot, projectId: VALID_REF });
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads <workdir>/supabase/.temp/project-ref when env and flag are unset", () => {
    writeRefFile(tempRoot, VALID_REF);
    const { layer } = makeLayer({ workdir: tempRoot });
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const ref = yield* resolve(Option.none());
      expect(ref).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("trims whitespace from the temp/project-ref file content", () => {
    writeRefFile(tempRoot, `  ${VALID_REF}\n\n`);
    const { layer } = makeLayer({ workdir: tempRoot });
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
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
      const { resolve } = yield* ProjectRefResolver;
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

  it.effect("does not persist the selected ref to the temp file", () => {
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
      const { resolve } = yield* ProjectRefResolver;
      yield* resolve(Option.none());
      expect(existsSync(refPath)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ProjectRefNotLinkedError on non-TTY with no source", () => {
    const { layer } = makeLayer({ workdir: tempRoot });
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("ProjectRefNotLinkedError");
        expect(errorJson).toContain("supabase link");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with InvalidProjectRefError when the resolved ref is malformed", () => {
    const { layer } = makeLayer({ workdir: tempRoot, projectId: "not-a-valid-ref" });
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("InvalidProjectRefError");
        expect(errorJson).toContain("Invalid project ref format");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects invalid ref from --project-ref flag", () => {
    const { layer } = makeLayer({ workdir: tempRoot });
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.some("BADREF")));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects invalid ref from temp/project-ref file", () => {
    writeRefFile(tempRoot, "BADREF");
    const { layer } = makeLayer({ workdir: tempRoot });
    return Effect.gen(function* () {
      const { resolve } = yield* ProjectRefResolver;
      const exit = yield* Effect.exit(resolve(Option.none()));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  describe("resolveOptional", () => {
    it.effect("prefers the flag value", () => {
      writeRefFile(tempRoot, ANOTHER_REF);
      const { layer } = makeLayer({ workdir: tempRoot, projectId: ANOTHER_REF });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* ProjectRefResolver;
        const ref = yield* resolveOptional(Option.some(VALID_REF));
        expect(ref).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("falls back to projectId then the ref file", () => {
      const { layer } = makeLayer({ workdir: tempRoot, projectId: VALID_REF });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* ProjectRefResolver;
        const ref = yield* resolveOptional(Option.none());
        expect(ref).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("reads the ref file when flag and projectId are unset", () => {
      writeRefFile(tempRoot, VALID_REF);
      const { layer } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* ProjectRefResolver;
        const ref = yield* resolveOptional(Option.none());
        expect(ref).toEqual(Option.some(VALID_REF));
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns None and never fails when nothing resolves", () => {
      const { layer } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveOptional } = yield* ProjectRefResolver;
        const ref = yield* resolveOptional(Option.none());
        expect(Option.isNone(ref)).toBe(true);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("resolveForLink", () => {
    it.effect("prefers the --project-ref flag", () => {
      const { layer } = makeLayer({ workdir: tempRoot, projectId: ANOTHER_REF });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* ProjectRefResolver;
        const ref = yield* resolveForLink(Option.some(VALID_REF));
        expect(ref).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("uses SUPABASE_PROJECT_ID when the flag is unset", () => {
      const { layer } = makeLayer({ workdir: tempRoot, projectId: VALID_REF });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* ProjectRefResolver;
        const ref = yield* resolveForLink(Option.none());
        expect(ref).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.effect("skips the ref file and fails off-TTY with no flag/projectId", () => {
      writeRefFile(tempRoot, VALID_REF);
      const { layer } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* ProjectRefResolver;
        const exit = yield* Effect.exit(resolveForLink(Option.none()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
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
        workdir: tempRoot,
        stdinIsTty: true,
        projects,
        promptSelectResponses: [VALID_REF],
      });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* ProjectRefResolver;
        const ref = yield* resolveForLink(Option.none());
        expect(ref).toBe(VALID_REF);
        expect(out.promptSelectCalls[0]?.message).toBe("Select a project:");
      }).pipe(Effect.provide(layer));
    });

    it.effect("rejects an invalid --project-ref flag", () => {
      const { layer } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* ProjectRefResolver;
        const exit = yield* Effect.exit(resolveForLink(Option.some("BADREF")));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("InvalidProjectRefError");
        }
      }).pipe(Effect.provide(layer));
    });
  });

  describe("resolveRef", () => {
    const writeLinkedCache = (workdir: string, cache: { ref: string; name?: string }) => {
      const tempDir = join(workdir, "supabase", ".temp");
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(join(tempDir, "linked-project.json"), JSON.stringify(cache));
    };
    const banner = (text: string) => `Target: ${text}\n`;

    it.effect("reports the flag as its source and announces an unverified project", () => {
      const { layer, out } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        const resolved = yield* resolveRef(Option.some(VALID_REF));
        expect(resolved).toEqual({ ref: VALID_REF, source: "flag", matchesLinkedRef: false });
        expect(out.stderrText).toBe(banner(`project ${VALID_REF}`));
      }).pipe(Effect.provide(layer));
    });

    it.effect("reports SUPABASE_PROJECT_ID as the env source", () => {
      const { layer } = makeLayer({ workdir: tempRoot, projectId: VALID_REF });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        const resolved = yield* resolveRef(Option.none());
        expect(resolved).toEqual({ ref: VALID_REF, source: "env", matchesLinkedRef: false });
      }).pipe(Effect.provide(layer));
    });

    it.effect("names the production project from the linked-project cache", () => {
      writeRefFile(tempRoot, VALID_REF);
      writeLinkedCache(tempRoot, { ref: VALID_REF, name: "alpha" });
      const { layer, out } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        const resolved = yield* resolveRef(Option.none());
        expect(resolved).toEqual({ ref: VALID_REF, source: "file", matchesLinkedRef: true });
        expect(out.stderrText).toBe(banner(`project alpha (${VALID_REF}) · production`));
      }).pipe(Effect.provide(layer));
    });

    it.effect("never calls a saved ref a branch just because the cache names another project", () => {
      writeRefFile(tempRoot, ANOTHER_REF);
      writeLinkedCache(tempRoot, { ref: VALID_REF, name: "alpha" });
      const { layer, out } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        yield* resolveRef(Option.none());
        expect(out.stderrText).toBe(banner(`project ${ANOTHER_REF}`));
      }).pipe(Effect.provide(layer));
    });

    it.effect("says a flag ref outside the linked project is not the linked project", () => {
      writeRefFile(tempRoot, VALID_REF);
      writeLinkedCache(tempRoot, { ref: VALID_REF, name: "alpha" });
      const { layer, out } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        const resolved = yield* resolveRef(Option.some(ANOTHER_REF));
        expect(resolved.matchesLinkedRef).toBe(false);
        expect(out.stderrText).toBe(banner(`project ${ANOTHER_REF} (not the linked project)`));
      }).pipe(Effect.provide(layer));
    });

    it.effect("says an env ref outside the linked project is not the linked project", () => {
      writeRefFile(tempRoot, VALID_REF);
      const { layer, out } = makeLayer({ workdir: tempRoot, projectId: ANOTHER_REF });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        yield* resolveRef(Option.none());
        expect(out.stderrText).toBe(banner(`project ${ANOTHER_REF} (not the linked project)`));
      }).pipe(Effect.provide(layer));
    });

    it.effect("marks a flag ref equal to the saved ref as matching the linked project", () => {
      writeRefFile(tempRoot, VALID_REF);
      const { layer } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        const resolved = yield* resolveRef(Option.some(VALID_REF));
        expect(resolved).toEqual({ ref: VALID_REF, source: "flag", matchesLinkedRef: true });
      }).pipe(Effect.provide(layer));
    });

    it.effect("reports the picker as its source on a TTY", () => {
      const projects = [
        { id: ANOTHER_REF, name: "beta", organization_slug: "acme", region: "eu-west-1" },
      ];
      const { layer } = makeLayer({
        workdir: tempRoot,
        stdinIsTty: true,
        projects,
        promptSelectResponses: [ANOTHER_REF],
      });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        const resolved = yield* resolveRef(Option.none());
        expect(resolved).toEqual({ ref: ANOTHER_REF, source: "picker", matchesLinkedRef: false });
      }).pipe(Effect.provide(layer));
    });

    it.effect("names the project the picker chose in the banner", () => {
      const projects = [
        { id: ANOTHER_REF, name: "beta", organization_slug: "acme", region: "eu-west-1" },
      ];
      const { layer, out } = makeLayer({
        workdir: tempRoot,
        stdinIsTty: true,
        projects,
        promptSelectResponses: [ANOTHER_REF],
      });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        yield* resolveRef(Option.none());
        expect(out.stderrText).toBe(banner(`project beta (${ANOTHER_REF})`));
      }).pipe(Effect.provide(layer));
    });

    it.effect("announces once when the same command resolves twice", () => {
      const { layer, out } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolve } = yield* ProjectRefResolver;
        yield* resolve(Option.some(VALID_REF));
        yield* resolve(Option.some(VALID_REF));
        expect(out.stderrText).toBe(banner(`project ${VALID_REF}`));
      }).pipe(Effect.provide(layer));
    });

    it.effect("surfaces a ref-file read failure instead of reporting not-linked", () => {
      mkdirSync(join(tempRoot, "supabase", ".temp", "project-ref"), { recursive: true });
      const { layer } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        const exit = yield* Effect.exit(resolveRef(Option.none()));
        expect(Exit.isFailure(exit)).toBe(true);
        const errorJson = JSON.stringify(exit);
        expect(errorJson).toContain("failed to load project ref");
        expect(errorJson).not.toContain("Cannot find project ref");
      }).pipe(Effect.provide(layer));
    });

    it.effect("announces nothing when no ref resolves", () => {
      const { layer, out } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveRef } = yield* ProjectRefResolver;
        const exit = yield* Effect.exit(resolveRef(Option.none()));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(out.stderrText).toBe("");
      }).pipe(Effect.provide(layer));
    });

    it.effect("announces the target for resolveForLink", () => {
      const { layer, out } = makeLayer({ workdir: tempRoot });
      return Effect.gen(function* () {
        const { resolveForLink } = yield* ProjectRefResolver;
        yield* resolveForLink(Option.some(VALID_REF));
        expect(out.stderrText).toBe(banner(`project ${VALID_REF}`));
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
        const { promptProjectRef } = yield* ProjectRefResolver;
        const ref = yield* promptProjectRef("Which project do you want to delete?");
        expect(ref).toBe(ANOTHER_REF);
        expect(out.promptSelectCalls[0]?.message).toBe("Which project do you want to delete?");
        const infos = out.messages.filter((m) => m.type === "info").map((m) => m.message);
        expect(infos).toContain(`Selected project: ${ANOTHER_REF}`);
      }).pipe(Effect.provide(layer));
    });
  });
});
