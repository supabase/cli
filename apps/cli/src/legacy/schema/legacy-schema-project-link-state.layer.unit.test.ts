import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option } from "effect";
import { ProjectHome } from "../../next/config/project-home.service.ts";
import { ProjectLinkState } from "../../next/config/project-link-state.service.ts";
import { LEGACY_VALID_REF, mockLegacyCliConfig } from "../../../tests/helpers/legacy-mocks.ts";
import { legacySchemaProjectLinkStateLayer } from "./legacy-schema-project-link-state.layer.ts";

function tempWorkdir() {
  const workdir = mkdtempSync(join(tmpdir(), "legacy-schema-link-"));
  const supabaseDir = join(workdir, "supabase");
  const projectHomeDir = join(workdir, ".supabase");
  mkdirSync(join(supabaseDir, ".temp"), { recursive: true });
  mkdirSync(projectHomeDir, { recursive: true });
  return { workdir, supabaseDir, projectHomeDir };
}

function projectHomeLayer(workdir: string, projectHomeDir: string, supabaseDir: string) {
  return Layer.succeed(
    ProjectHome,
    ProjectHome.of({
      projectRoot: workdir,
      supabaseDir,
      projectHomeDir,
      projectLinkPath: join(projectHomeDir, "project.json"),
      projectLocalVersionsPath: join(projectHomeDir, "local-versions.json"),
      ensureProjectHomeDir: Effect.void,
      stackDir: (name: string) => join(projectHomeDir, "stacks", name),
      stackStatePath: (name: string) => join(projectHomeDir, "stacks", name, "state.json"),
      stackMetadataPath: (name: string) => join(projectHomeDir, "stacks", name, "stack.json"),
      stackDataDir: (name: string) => join(projectHomeDir, "stacks", name, "data"),
      stackLogsDir: (name: string) => join(projectHomeDir, "stacks", name, "logs"),
    }),
  );
}

function setup(workdir: string, projectHomeDir: string, supabaseDir: string) {
  return legacySchemaProjectLinkStateLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(mockLegacyCliConfig({ workdir, projectId: Option.none() })),
    Layer.provide(projectHomeLayer(workdir, projectHomeDir, supabaseDir)),
  );
}

describe("legacySchemaProjectLinkStateLayer", () => {
  it.live("loads a stable link from supabase/.temp/project-ref", () => {
    const { workdir, supabaseDir, projectHomeDir } = tempWorkdir();
    writeFileSync(join(supabaseDir, ".temp", "project-ref"), `${LEGACY_VALID_REF}\n`);
    writeFileSync(
      join(supabaseDir, ".temp", "linked-project.json"),
      JSON.stringify({
        ref: LEGACY_VALID_REF,
        name: "Demo",
        organization_id: "org-1",
        organization_slug: "demo-org",
      }),
    );
    return Effect.gen(function* () {
      const link = yield* ProjectLinkState;
      const state = yield* link.load;
      expect(Option.isSome(state)).toBe(true);
      if (Option.isNone(state)) return;
      expect(state.value.project.ref).toBe(LEGACY_VALID_REF);
      expect(state.value.project.name).toBe("Demo");
      expect(state.value.project.organization_slug).toBe("demo-org");
    }).pipe(Effect.provide(setup(workdir, projectHomeDir, supabaseDir)));
  });

  it.live("prefers next project.json when both link files exist", () => {
    const { workdir, supabaseDir, projectHomeDir } = tempWorkdir();
    writeFileSync(join(supabaseDir, ".temp", "project-ref"), `${LEGACY_VALID_REF}\n`);
    writeFileSync(
      join(projectHomeDir, "project.json"),
      `${JSON.stringify({
        project: {
          ref: "zzzzzzzzzzzzzzzzzzzz",
          name: "Next",
          organization_id: "org-next",
          organization_slug: "next-org",
        },
        active_branch: { ref: "zzzzzzzzzzzzzzzzzzzz", name: "main", is_default: true },
        fetchedAt: "2026-01-01T00:00:00.000Z",
        versions: {},
      })}\n`,
    );
    return Effect.gen(function* () {
      const link = yield* ProjectLinkState;
      const state = yield* link.load;
      expect(Option.isSome(state)).toBe(true);
      if (Option.isNone(state)) return;
      expect(state.value.project.ref).toBe("zzzzzzzzzzzzzzzzzzzz");
      expect(state.value.project.name).toBe("Next");
    }).pipe(Effect.provide(setup(workdir, projectHomeDir, supabaseDir)));
  });

  it.live("fails closed when project.json has an invalid project ref", () => {
    const { workdir, supabaseDir, projectHomeDir } = tempWorkdir();
    writeFileSync(join(supabaseDir, ".temp", "project-ref"), `${LEGACY_VALID_REF}\n`);
    writeFileSync(
      join(projectHomeDir, "project.json"),
      `${JSON.stringify({
        project: {
          ref: "not-a-ref",
          name: "Broken",
          organization_id: "org-1",
          organization_slug: "broken",
        },
        active_branch: { ref: "not-a-ref", name: "main", is_default: true },
        fetchedAt: "2026-01-01T00:00:00.000Z",
        versions: {},
      })}\n`,
    );
    return Effect.gen(function* () {
      const link = yield* ProjectLinkState;
      const exit = yield* link.load.pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(setup(workdir, projectHomeDir, supabaseDir)));
  });

  it.live("fails closed when SUPABASE_PROJECT_ID is present but invalid", () => {
    const { workdir, supabaseDir, projectHomeDir } = tempWorkdir();
    writeFileSync(join(supabaseDir, ".temp", "project-ref"), `${LEGACY_VALID_REF}\n`);
    const layer = legacySchemaProjectLinkStateLayer.pipe(
      Layer.provide(BunServices.layer),
      Layer.provide(mockLegacyCliConfig({ workdir, projectId: Option.some("not-a-ref") })),
      Layer.provide(projectHomeLayer(workdir, projectHomeDir, supabaseDir)),
    );
    return Effect.gen(function* () {
      const link = yield* ProjectLinkState;
      const exit = yield* link.load.pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses SUPABASE_PROJECT_ID even when supabase/.temp/project-ref is invalid", () => {
    const { workdir, supabaseDir, projectHomeDir } = tempWorkdir();
    writeFileSync(join(supabaseDir, ".temp", "project-ref"), "not-a-ref\n");
    const layer = legacySchemaProjectLinkStateLayer.pipe(
      Layer.provide(BunServices.layer),
      Layer.provide(mockLegacyCliConfig({ workdir, projectId: Option.some(LEGACY_VALID_REF) })),
      Layer.provide(projectHomeLayer(workdir, projectHomeDir, supabaseDir)),
    );
    return Effect.gen(function* () {
      const link = yield* ProjectLinkState;
      const state = yield* link.load;
      expect(Option.isSome(state)).toBe(true);
      if (Option.isNone(state)) return;
      expect(state.value.project.ref).toBe(LEGACY_VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails closed when supabase/.temp/project-ref is present but invalid", () => {
    const { workdir, supabaseDir, projectHomeDir } = tempWorkdir();
    writeFileSync(join(supabaseDir, ".temp", "project-ref"), "not-a-ref\n");
    return Effect.gen(function* () {
      const link = yield* ProjectLinkState;
      const exit = yield* link.load.pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(setup(workdir, projectHomeDir, supabaseDir)));
  });

  it.live("returns none when the workdir is not linked", () => {
    const { workdir, supabaseDir, projectHomeDir } = tempWorkdir();
    return Effect.gen(function* () {
      const link = yield* ProjectLinkState;
      const state = yield* link.load;
      expect(Option.isNone(state)).toBe(true);
    }).pipe(Effect.provide(setup(workdir, projectHomeDir, supabaseDir)));
  });
});
