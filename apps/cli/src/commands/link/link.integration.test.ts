import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import {
  mockAnalytics,
  mockOutput,
  mockProjectLinkRemote,
  mockRuntimeInfo,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { cliConfigLayer } from "../../config/cli-config.layer.ts";
import { projectContextLayer } from "../../config/project-context.layer.ts";
import { projectHomeLayer } from "../../config/project-home.layer.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { ProjectLinkState } from "../../config/project-link-state.service.ts";
import { NoAccessibleProjectsError, ProjectRefRequiredError } from "./link.errors.ts";
import { link } from "./link.handler.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-link-command-"));
}

function buildLayer(opts: {
  cwd: string;
  env?: Record<string, string>;
  remoteProjectRef?: string;
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
  it.live("writes only cached link state and leaves project config unchanged", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const projectRef = "abcdefghijklmnopqrst";
    const initialConfig = 'project_id = "legacy-project"\n';

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, "supabase", "config.toml"), initialConfig),
      );

      const { layer, out, analytics } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProjectRef: projectRef,
      });

      yield* link({ projectRef: Option.some(projectRef) }).pipe(Effect.provide(layer));

      const configContent = yield* Effect.tryPromise(() =>
        readFile(join(projectRoot, "supabase", "config.toml"), "utf8"),
      );
      expect(configContent).toBe(initialConfig);
      expect(
        yield* Effect.tryPromise(() => readFile(join(projectRoot, ".gitignore"), "utf8")),
      ).toContain(".supabase/");

      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));
      const cached = yield* linkState.load;
      expect(Option.isSome(cached)).toBe(true);
      if (Option.isSome(cached)) {
        expect(cached.value.ref).toBe(projectRef);
        expect(cached.value.name).toBe("Linked Project");
        expect(cached.value.organization_slug).toBe("supabase");
        expect(cached.value.organization_id).toBe("org_123");
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
        groupKey: "supabase",
        properties: {
          organization_id: "org_123",
          organization_slug: "supabase",
        },
      });
      expect(analytics.groupIdentified).toContainEqual({
        groupType: "project",
        groupKey: projectRef,
        properties: {
          project_name: "Linked Project",
          project_ref: projectRef,
          organization_slug: "supabase",
        },
      });
      expect(analytics.captured).toContainEqual({
        event: "cli_project_linked",
        properties: {
          project_ref: projectRef,
          project_name: "Linked Project",
          organization_slug: "supabase",
        },
      });
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("links successfully without requiring a local Supabase config", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const projectRef = "abcdefghijklmnopqrst";

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));

      const { layer } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProjectRef: projectRef,
      });

      yield* link({ projectRef: Option.some(projectRef) }).pipe(Effect.provide(layer));

      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));
      const cached = yield* linkState.load;
      expect(Option.isSome(cached)).toBe(true);
      expect(Option.isSome(cached) && cached.value.ref).toBe(projectRef);

      expect(
        yield* Effect.tryPromise(() => readFile(join(projectRoot, ".gitignore"), "utf8")),
      ).toContain(".supabase/");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("selects an accessible project interactively when no project ref is provided", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const selectedProjectRef = "abcdefghijklmnopqrst";
    const initialConfig = "# local project config\n";

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, "supabase", "config.toml"), initialConfig),
      );

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

      const configContent = yield* Effect.tryPromise(() =>
        readFile(join(projectRoot, "supabase", "config.toml"), "utf8"),
      );
      expect(configContent).toBe(initialConfig);

      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));
      const cached = yield* linkState.load;
      expect(Option.isSome(cached)).toBe(true);
      if (Option.isSome(cached)) {
        expect(cached.value.ref).toBe(selectedProjectRef);
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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("prompts before refreshing an existing interactive link", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const projectRef = "abcdefghijklmnopqrst";

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));

      const { layer, out } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProjectRef: projectRef,
        interactive: true,
      });

      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));

      yield* linkState.save({
        ref: projectRef,
        name: "Linked Project",
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
        expect(cached.value.ref).toBe(projectRef);
        expect(cached.value.name).toBe("Linked Project");
        expect(cached.value.versions).toEqual({
          postgres: "17.6.1.090",
          postgrest: "v14.5",
          auth: "v2.187.0",
          storage: "v1.39.2",
        });
      }
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("allows choosing a different project when already linked interactively", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const originalProjectRef = "abcdefghijklmnopqrst";
    const newProjectRef = "qrstabcdefghijklmnop";

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));

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

      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));

      yield* linkState.save({
        ref: originalProjectRef,
        name: "Alpha Project",
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
        expect(cached.value.ref).toBe(newProjectRef);
        expect(cached.value.name).toBe("Linked Project");
      }
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails in non-interactive mode when no project ref is available", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(join(projectRoot, "supabase", "config.toml"), ""));

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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("makes cached-link refresh explicit in non-interactive mode", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const projectRef = "abcdefghijklmnopqrst";

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));

      const { layer, out } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProjectRef: projectRef,
      });

      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));

      yield* linkState.save({
        ref: projectRef,
        name: "Linked Project",
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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails with NoAccessibleProjectsError when interactive selection has no projects", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(join(projectRoot, "supabase", "config.toml"), ""));

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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
