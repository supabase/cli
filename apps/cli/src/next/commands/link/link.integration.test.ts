import { describe, expect, it } from "@effect/vitest";
import { BunFileSystem, BunPath, BunServices } from "@effect/platform-bun";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { Cause, Effect, Exit, FileSystem, Layer, Option } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as EffectPath from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { Data } from "effect";
import {
  mockAnalytics,
  mockOutput,
  mockProjectLinkRemote,
  mockRuntimeInfo,
  processEnvLayer,
} from "../../../../tests/helpers/mocks.ts";
import { cliConfigLayer } from "../../config/cli-config.layer.ts";
import { projectContextLayer } from "../../config/project-context.layer.ts";
import { projectHomeLayer } from "../../config/project-home.layer.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { ProjectLinkState } from "../../config/project-link-state.service.ts";
import { NoAccessibleProjectsError, ProjectRefRequiredError } from "./link.errors.ts";
import { link } from "./link.handler.ts";

const { join } = Effect.runSync(EffectPath.Path.pipe(Effect.provide(BunPath.layer)));

function makeTempDir(): string {
  return join(tmpdir(), `supabase-link-command-${randomUUID()}`);
}

class GitCommandFailedError extends Data.TaggedError("GitCommandFailedError")<{
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
}> {}

const withFileSystem = <A>(
  effect: Effect.Effect<A, PlatformError, FileSystem.FileSystem>,
): Effect.Effect<A, PlatformError, never> => effect.pipe(Effect.provide(BunFileSystem.layer));

const mkdir = (path: string, options?: { readonly recursive?: boolean }) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path, options);
    }),
  );

const readFile = (path: string, _encoding?: "utf8") =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(path);
    }),
  );

const writeFile = (path: string, content: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(path, content);
    }),
  );

const rm = (path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path, options);
    }),
  );

const cleanupTempDir = (path: string) =>
  rm(path, { recursive: true, force: true }).pipe(Effect.orDie);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
    if (Number(exitCode) !== 0) {
      return yield* new GitCommandFailedError({ cwd, args, exitCode: Number(exitCode) });
    }
  }).pipe(Effect.provide(BunServices.layer));

const initializeRepository = (projectRoot: string) =>
  Effect.gen(function* () {
    yield* mkdir(projectRoot, { recursive: true });
    yield* runGit(projectRoot, ["init", "--initial-branch=main"]);
    yield* runGit(projectRoot, ["config", "user.email", "stack-tests@supabase.local"]);
    yield* runGit(projectRoot, ["config", "user.name", "Stack Tests"]);
    yield* runGit(projectRoot, ["commit", "--allow-empty", "-m", "initial"]);
  });

function buildLayer(opts: {
  cwd: string;
  env?: Record<string, string>;
  remoteProjectRef?: string;
  remoteOrganizationId?: string;
  remoteOrganizationSlug?: string;
  projects?: ReadonlyArray<{
    ref: string;
    name: string;
    region: string;
    status: string;
  }>;
  interactive?: boolean;
  promptSelectResponses?: ReadonlyArray<string>;
}) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.env?.SUPABASE_HOME ? join(opts.env.SUPABASE_HOME, "..") : join(opts.cwd, ".home"),
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  const discoveredProjectContextLayer = projectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
  const discoveredCliConfigLayer = cliConfigLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredProjectContextLayer),
    Layer.provideMerge(BunServices.layer),
  );
  const discoveredProjectHomeLayer = projectHomeLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredProjectContextLayer),
    Layer.provide(discoveredCliConfigLayer),
  );
  const discoveredProjectLinkStateLayer = projectLinkStateLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(discoveredProjectHomeLayer),
  );
  const out = mockOutput({
    format: "text",
    interactive: opts.interactive ?? false,
    promptSelectResponses: opts.promptSelectResponses,
  });
  const analytics = mockAnalytics();
  const remote = mockProjectLinkRemote({
    projects: opts.projects,
    linkedProject: {
      ref: opts.remoteProjectRef ?? opts.projects?.[0]?.ref ?? "abcdefghijklmnopqrst",
      name: "Linked Project",
      organizationId: opts.remoteOrganizationId ?? "org-id-abc",
      organizationSlug: opts.remoteOrganizationSlug ?? "my-org",
      region: "eu-west-3",
      status: "ACTIVE_HEALTHY",
      versions: {
        postgres: "17.6.1.090",
        postgrest: "v14.5",
        auth: "v2.187.0",
        storage: "v1.39.2",
      },
    },
  });

  return {
    out,
    analytics,
    layer: Layer.mergeAll(
      BunServices.layer,
      runtimeInfoLayer,
      envLayer,
      discoveredProjectContextLayer,
      discoveredCliConfigLayer,
      discoveredProjectHomeLayer,
      discoveredProjectLinkStateLayer,
      out.layer,
      analytics.layer,
      remote,
    ),
  };
}

function expectFailure(
  exit: Exit.Exit<unknown, unknown>,
  tag: string,
): { _tag: string; detail: string; suggestion: string } {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    throw new Error(`Expected failure exit for ${tag}`);
  }

  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) {
    throw new Error(`Expected tagged failure for ${tag}`);
  }

  expect((failure.value as { _tag: string })._tag).toBe(tag);
  return failure.value as { _tag: string; detail: string; suggestion: string };
}

describe("link handler", () => {
  it.live("writes nested link state with project, active_branch, and versions", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const projectRef = "abcdefghijklmnopqrst";
    const initialConfig = 'project_id = "legacy-project"\n';

    return Effect.gen(function* () {
      yield* mkdir(join(projectRoot, "supabase"), { recursive: true });
      yield* initializeRepository(projectRoot);
      yield* writeFile(join(projectRoot, "supabase", "config.toml"), initialConfig);

      const { layer, out, analytics } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProjectRef: projectRef,
        remoteOrganizationId: "org-id-abc",
        remoteOrganizationSlug: "my-org",
      });

      yield* link({ projectRef: Option.some(projectRef) }).pipe(Effect.provide(layer));

      const configContent = yield* readFile(join(projectRoot, "supabase", "config.toml"), "utf8");
      expect(configContent).toBe(initialConfig);
      expect(yield* readFile(join(projectRoot, ".gitignore"), "utf8")).toContain(".supabase/");

      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));
      const cached = yield* linkState.load;
      expect(Option.isSome(cached)).toBe(true);
      if (Option.isSome(cached)) {
        expect(cached.value.project.ref).toBe(projectRef);
        expect(cached.value.project.name).toBe("Linked Project");
        expect(cached.value.project.organization_id).toBe("org-id-abc");
        expect(cached.value.project.organization_slug).toBe("my-org");
        expect(cached.value.active_branch).toEqual({
          ref: projectRef,
          name: "main",
          is_default: true,
        });
        expect(cached.value.versions).toEqual({
          postgres: "17.6.1.090",
          postgrest: "v14.5",
          auth: "v2.187.0",
          storage: "v1.39.2",
        });
      }

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: `Linked to project ${projectRef}.` }),
      );
      expect(analytics.groupIdentified).toContainEqual({
        groupType: "organization",
        groupKey: "my-org",
        properties: {
          organization_id: "org-id-abc",
          organization_slug: "my-org",
        },
      });
      expect(analytics.groupIdentified).toContainEqual({
        groupType: "project",
        groupKey: projectRef,
        properties: {
          project_name: "Linked Project",
          project_ref: projectRef,
          organization_slug: "my-org",
        },
      });
      expect(analytics.captured).toContainEqual({
        event: "cli_project_linked",
        properties: {
          project_ref: projectRef,
          project_name: "Linked Project",
          organization_slug: "my-org",
        },
      });
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("links successfully without requiring a local Supabase config", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const projectRef = "abcdefghijklmnopqrst";

    return Effect.gen(function* () {
      yield* initializeRepository(projectRoot);

      const { layer } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProjectRef: projectRef,
      });

      yield* link({ projectRef: Option.some(projectRef) }).pipe(Effect.provide(layer));

      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));
      const cached = yield* linkState.load;
      expect(Option.isSome(cached)).toBe(true);
      expect(Option.isSome(cached) && cached.value.project.ref).toBe(projectRef);

      expect(yield* readFile(join(projectRoot, ".gitignore"), "utf8")).toContain(".supabase/");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("active_branch.ref matches project.ref on a default fresh link (round-trip)", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const projectRef = "abcdefghijklmnopqrst";

    return Effect.gen(function* () {
      yield* initializeRepository(projectRoot);

      const { layer } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProjectRef: projectRef,
      });

      yield* link({ projectRef: Option.some(projectRef) }).pipe(Effect.provide(layer));

      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

      const activeBranch = yield* linkState.getActiveBranch;
      expect(Option.isSome(activeBranch)).toBe(true);
      if (Option.isSome(activeBranch)) {
        expect(activeBranch.value.ref).toBe(projectRef);
        expect(activeBranch.value.name).toBe("main");
        expect(activeBranch.value.is_default).toBe(true);
      }
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("selects an accessible project interactively when no project ref is provided", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const selectedProjectRef = "abcdefghijklmnopqrst";
    const initialConfig = "# local project config\n";

    return Effect.gen(function* () {
      yield* mkdir(join(projectRoot, "supabase"), { recursive: true });
      yield* writeFile(join(projectRoot, "supabase", "config.toml"), initialConfig);

      const { layer, out } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        projects: [
          {
            ref: selectedProjectRef,
            name: "Alpha Project",
            region: "eu-west-3",
            status: "ACTIVE_HEALTHY",
          },
        ],
        interactive: true,
      });

      yield* link({ projectRef: Option.none() }).pipe(Effect.provide(layer));

      const configContent = yield* readFile(join(projectRoot, "supabase", "config.toml"), "utf8");
      expect(configContent).toBe(initialConfig);

      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));
      const cached = yield* linkState.load;
      expect(Option.isSome(cached)).toBe(true);
      if (Option.isSome(cached)) {
        expect(cached.value.project.ref).toBe(selectedProjectRef);
      }

      expect(out.promptSelectCalls).toEqual([
        {
          message: "Select a Supabase project to link",
          options: [
            {
              value: selectedProjectRef,
              label: "Alpha Project",
              hint: `${selectedProjectRef} | eu-west-3 | ACTIVE_HEALTHY`,
            },
          ],
          behavior: {
            mode: "auto",
            placeholder: "Search projects...",
            maxItems: 10,
          },
        },
      ]);
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("prompts before refreshing an existing interactive link", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const projectRef = "abcdefghijklmnopqrst";

    return Effect.gen(function* () {
      yield* initializeRepository(projectRoot);

      const { layer, out } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProjectRef: projectRef,
        interactive: true,
      });

      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

      yield* linkState.save({
        project: {
          ref: projectRef,
          name: "Linked Project",
          organization_id: "org-id-abc",
          organization_slug: "my-org",
        },
        active_branch: {
          ref: projectRef,
          name: "main",
          is_default: true,
        },
        fetchedAt: "2026-01-01T00:00:00.000Z",
        versions: {
          postgres: "17.6.1.001",
        },
      });

      yield* link({ projectRef: Option.none() }).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: `This local project is already linked to Linked Project (${projectRef}).`,
        }),
      );
      expect(out.promptSelectCalls).toEqual([
        {
          message: "What would you like to do?",
          options: [
            {
              value: "refresh",
              label: "Refresh linked metadata",
              hint: `Refresh the current linked project metadata for Linked Project (${projectRef})`,
            },
            {
              value: "relink",
              label: "Choose a different project",
              hint: "Select another accessible Supabase project",
            },
          ],
          behavior: { mode: "select" },
        },
      ]);

      const cached = yield* linkState.load;
      expect(Option.isSome(cached)).toBe(true);
      if (Option.isSome(cached)) {
        expect(cached.value.project.ref).toBe(projectRef);
        expect(cached.value.project.name).toBe("Linked Project");
        expect(cached.value.versions).toEqual({
          postgres: "17.6.1.090",
          postgrest: "v14.5",
          auth: "v2.187.0",
          storage: "v1.39.2",
        });
      }
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("allows choosing a different project when already linked interactively", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const originalProjectRef = "abcdefghijklmnopqrst";
    const newProjectRef = "qrstabcdefghijklmnop";

    return Effect.gen(function* () {
      yield* initializeRepository(projectRoot);

      const { layer, out } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        projects: [
          {
            ref: newProjectRef,
            name: "Beta Project",
            region: "us-east-1",
            status: "ACTIVE_HEALTHY",
          },
        ],
        interactive: true,
        promptSelectResponses: ["relink", newProjectRef],
      });

      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

      yield* linkState.save({
        project: {
          ref: originalProjectRef,
          name: "Alpha Project",
          organization_id: "org-id-abc",
          organization_slug: "my-org",
        },
        active_branch: {
          ref: originalProjectRef,
          name: "main",
          is_default: true,
        },
        fetchedAt: "2026-01-01T00:00:00.000Z",
        versions: {
          postgres: "17.6.1.001",
        },
      });

      yield* link({ projectRef: Option.none() }).pipe(Effect.provide(layer));

      expect(out.promptSelectCalls).toEqual([
        {
          message: "What would you like to do?",
          options: [
            {
              value: "refresh",
              label: "Refresh linked metadata",
              hint: `Refresh the current linked project metadata for Alpha Project (${originalProjectRef})`,
            },
            {
              value: "relink",
              label: "Choose a different project",
              hint: "Select another accessible Supabase project",
            },
          ],
          behavior: { mode: "select" },
        },
        {
          message: "Select a Supabase project to link",
          options: [
            {
              value: newProjectRef,
              label: "Beta Project",
              hint: `${newProjectRef} | us-east-1 | ACTIVE_HEALTHY`,
            },
          ],
          behavior: {
            mode: "auto",
            placeholder: "Search projects...",
            maxItems: 10,
          },
        },
      ]);

      const cached = yield* linkState.load;
      expect(Option.isSome(cached)).toBe(true);
      if (Option.isSome(cached)) {
        expect(cached.value.project.ref).toBe(newProjectRef);
        expect(cached.value.project.name).toBe("Linked Project");
      }
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("fails in non-interactive mode when no project ref is available", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* mkdir(join(projectRoot, "supabase"), { recursive: true });
      yield* writeFile(join(projectRoot, "supabase", "config.toml"), "");

      const { layer } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProjectRef: "abcdefghijklmnopqrst",
      });
      const exit = yield* link({ projectRef: Option.none() }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      const error = expectFailure(exit, "ProjectRefRequiredError");
      expect(error).toBeInstanceOf(ProjectRefRequiredError);
      expect(error.detail).toBe("A project ref is required in non-interactive mode.");
      expect(error.suggestion).toBe(
        "Pass --project-ref or link this checkout interactively first.",
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("makes cached-link refresh explicit in non-interactive mode", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const projectRef = "abcdefghijklmnopqrst";

    return Effect.gen(function* () {
      yield* initializeRepository(projectRoot);

      const { layer, out } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProjectRef: projectRef,
      });

      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

      yield* linkState.save({
        project: {
          ref: projectRef,
          name: "Linked Project",
          organization_id: "org-id-abc",
          organization_slug: "my-org",
        },
        active_branch: {
          ref: projectRef,
          name: "main",
          is_default: true,
        },
        fetchedAt: "2026-01-01T00:00:00.000Z",
        versions: {
          postgres: "17.6.1.001",
        },
      });

      yield* link({ projectRef: Option.none() }).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: `This local project is already linked to Linked Project (${projectRef}); refreshing linked project metadata.`,
        }),
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("fails with NoAccessibleProjectsError when interactive selection has no projects", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* mkdir(join(projectRoot, "supabase"), { recursive: true });
      yield* writeFile(join(projectRoot, "supabase", "config.toml"), "");

      const { layer } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        projects: [],
        interactive: true,
      });
      const exit = yield* link({ projectRef: Option.none() }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      const error = expectFailure(exit, "NoAccessibleProjectsError");
      expect(error).toBeInstanceOf(NoAccessibleProjectsError);
      expect(error.detail).toBe("No accessible Supabase projects were found for this account.");
      expect(error.suggestion).toBe(
        "Create a project in the dashboard or log in with a different account.",
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });
});
