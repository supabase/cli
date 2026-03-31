import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../tests/helpers/mocks.ts";
import { cliConfigLayer } from "./cli-config.layer.ts";
import { projectContextLayer } from "./project-context.layer.ts";
import { projectHomeLayer } from "./project-home.layer.ts";
import { ProjectHome } from "./project-home.service.ts";
import { projectLinkStateLayer } from "./project-link-state.layer.ts";
import {
  InvalidProjectLinkStateError,
  ProjectLinkState,
  ProjectNotLinkedError,
} from "./project-link-state.service.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-project-link-state-"));
}

function buildLayer(opts: { cwd: string; env?: Record<string, string>; homeDir?: string }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir ?? join(opts.cwd, ".home"),
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

  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    envLayer,
    discoveredProjectContextLayer,
    discoveredCliConfigLayer,
    discoveredProjectHomeLayer,
    discoveredProjectLinkStateLayer,
  );
}

const SAMPLE_STATE = {
  project: {
    ref: "abcdefghijklmnopqrst",
    name: "Alpha Project",
    organization_id: "org-id-abc",
    organization_slug: "my-org",
  },
  active_branch: {
    ref: "abcdefghijklmnopqrst",
    name: "main",
    is_default: true,
  },
  fetchedAt: "2026-03-19T12:34:56.000Z",
  versions: {
    postgres: "17.6.1.090",
    postgrest: "v14.5",
    auth: "v2.187.0",
    storage: "v1.39.2",
  },
} as const;

describe("projectLinkStateLayer", () => {
  it.live("saves and loads repo-local project link state", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, "supabase", "config.toml"), 'project_id = "repo"\n'),
      );

      const layer = buildLayer({ cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const projectHome = yield* Effect.gen(function* () {
        return yield* ProjectHome;
      }).pipe(Effect.provide(layer));
      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));

      yield* linkState.save(SAMPLE_STATE);
      const loaded = yield* linkState.load;

      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isSome(loaded)) {
        expect(loaded.value).toEqual(SAMPLE_STATE);
      }

      const rawFile = yield* Effect.tryPromise(() => readFile(projectHome.projectLinkPath, "utf8"));
      expect(rawFile).toContain('"project":');
      expect(rawFile).toContain('"active_branch":');
      const raw = JSON.parse(rawFile) as typeof SAMPLE_STATE;
      expect(raw).toEqual(SAMPLE_STATE);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("clears repo-local link state", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, "supabase", "config.toml"), 'project_id = "repo"\n'),
      );

      const layer = buildLayer({ cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const projectHome = yield* Effect.gen(function* () {
        return yield* ProjectHome;
      }).pipe(Effect.provide(layer));
      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));

      yield* linkState.save(SAMPLE_STATE);
      yield* linkState.clear;

      const loaded = yield* linkState.load;
      expect(Option.isNone(loaded)).toBe(true);
      yield* Effect.tryPromise(() => readFile(projectHome.projectLinkPath, "utf8")).pipe(
        Effect.flip,
        Effect.asVoid,
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails with a tagged error when repo-local link state is malformed", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".supabase"), { recursive: true }));

      const layer = buildLayer({ cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const { projectHome, linkState } = yield* Effect.gen(function* () {
        return {
          projectHome: yield* ProjectHome,
          linkState: yield* ProjectLinkState,
        };
      }).pipe(Effect.provide(layer));

      yield* Effect.tryPromise(() => writeFile(projectHome.projectLinkPath, "{not-json"));

      const exit = yield* linkState.load.pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(InvalidProjectLinkStateError);
          expect(error.value).toMatchObject({
            _tag: "InvalidProjectLinkStateError",
            suggestion: "Fix or remove project.json, then retry the command.",
          });
        }
      }
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("getActiveBranch returns none when not linked", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));

      const layer = buildLayer({ cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));

      const activeBranch = yield* linkState.getActiveBranch;
      expect(Option.isNone(activeBranch)).toBe(true);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("getActiveBranch returns the persisted active_branch", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));

      const layer = buildLayer({ cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));

      yield* linkState.save(SAMPLE_STATE);

      const activeBranch = yield* linkState.getActiveBranch;
      expect(Option.isSome(activeBranch)).toBe(true);
      if (Option.isSome(activeBranch)) {
        expect(activeBranch.value).toEqual({
          ref: "abcdefghijklmnopqrst",
          name: "main",
          is_default: true,
        });
      }
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "setActiveBranch updates only active_branch, leaving project and versions unchanged",
    () => {
      const tempDir = makeTempDir();
      const projectRoot = join(tempDir, "repo");
      const supabaseHome = join(tempDir, "supabase-home");

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));

        const layer = buildLayer({ cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
        const linkState = yield* Effect.gen(function* () {
          return yield* ProjectLinkState;
        }).pipe(Effect.provide(layer));

        yield* linkState.save(SAMPLE_STATE);

        const newBranch = { ref: "branchrefabcdefghijk", name: "feature-x", is_default: false };
        yield* linkState.setActiveBranch(newBranch);

        const loaded = yield* linkState.load;
        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.active_branch).toEqual(newBranch);
          expect(loaded.value.project).toEqual(SAMPLE_STATE.project);
          expect(loaded.value.versions).toEqual(SAMPLE_STATE.versions);
          expect(loaded.value.fetchedAt).toBe(SAMPLE_STATE.fetchedAt);
        }
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live("setActiveBranch fails with ProjectNotLinkedError when project is not linked", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));

      const layer = buildLayer({ cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));

      const exit = yield* linkState
        .setActiveBranch({ ref: "branchrefabcdefghijk", name: "feature-x", is_default: false })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(ProjectNotLinkedError);
          expect(error.value).toMatchObject({
            _tag: "ProjectNotLinkedError",
            suggestion: "Run `supabase link` to link this checkout to a Supabase project first.",
          });
        }
      }
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
