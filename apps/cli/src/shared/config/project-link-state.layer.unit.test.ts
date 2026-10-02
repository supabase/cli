import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import {
  Cause,
  Effect,
  FileSystem,
  Exit,
  Layer,
  Option,
  Path,
  PlatformError,
  Schema,
} from "effect";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { cliSettingsLayer } from "./cli-settings.layer.ts";
import { cliProjectContextLayer } from "./cli-project-context.layer.ts";
import { cliProjectHomeLayer } from "./cli-project-home.layer.ts";
import { CliProjectHome } from "./cli-project-home.service.ts";
import { projectLinkStateLayer } from "./project-link-state.layer.ts";
import {
  InvalidProjectLinkStateError,
  ProjectLinkState,
  ProjectNotLinkedError,
} from "./project-link-state.service.ts";

const makeTempDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "supabase-project-link-state-" }),
);

function buildLayer(
  path: Path.Path,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    homeDir?: string;
    fs?: Layer.Layer<FileSystem.FileSystem>;
  },
) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.homeDir ?? path.join(opts.cwd, ".home"),
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  const discoveredCliProjectContextLayer = cliProjectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
  const discoveredCliSettingsLayer = cliSettingsLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredCliProjectContextLayer),
  );
  const discoveredCliProjectHomeLayer = cliProjectHomeLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredCliProjectContextLayer),
    Layer.provide(discoveredCliSettingsLayer),
  );
  const discoveredProjectLinkStateLayer = projectLinkStateLayer.pipe(
    Layer.provide(opts.fs ?? BunServices.layer),
    Layer.provide(discoveredCliProjectHomeLayer),
  );

  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    envLayer,
    discoveredCliProjectContextLayer,
    discoveredCliSettingsLayer,
    discoveredCliProjectHomeLayer,
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
  it.live("surfaces a clear permission failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      const linkPath = path.join(projectRoot, ".supabase", "project.json");
      const fsLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          remove: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "remove",
                description: "permission denied",
                pathOrDescriptor: linkPath,
              }),
            ),
        }),
      );

      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      const layer = buildLayer(path, { cwd: projectRoot, fs: fsLayer });
      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

      const exit = yield* Effect.exit(linkState.clear);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) expect(error.value).toBeInstanceOf(PlatformError.PlatformError);
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("saves and loads repo-local project link state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      const supabaseHome = path.join(tempDir, "supabase-home");

      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        'project_id = "repo"\n',
      );

      const layer = buildLayer(path, { cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const cliProjectHome = yield* CliProjectHome.pipe(Effect.provide(layer));
      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

      yield* linkState.save(SAMPLE_STATE);
      const loaded = yield* linkState.load;

      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isSome(loaded)) {
        expect(loaded.value).toEqual(SAMPLE_STATE);
      }

      const rawFile = yield* fs.readFileString(cliProjectHome.projectLinkPath);
      expect(rawFile).toContain('"project":');
      expect(rawFile).toContain('"active_branch":');
      const raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(rawFile);
      expect(raw).toEqual(SAMPLE_STATE);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("clears repo-local link state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      const supabaseHome = path.join(tempDir, "supabase-home");

      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        'project_id = "repo"\n',
      );

      const layer = buildLayer(path, { cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const cliProjectHome = yield* CliProjectHome.pipe(Effect.provide(layer));
      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

      yield* linkState.save(SAMPLE_STATE);
      yield* linkState.clear;
      yield* linkState.clear;

      const loaded = yield* linkState.load;
      expect(Option.isNone(loaded)).toBe(true);
      yield* fs.readFileString(cliProjectHome.projectLinkPath).pipe(Effect.flip, Effect.asVoid);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("fails with a tagged error when repo-local link state is malformed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      const supabaseHome = path.join(tempDir, "supabase-home");

      yield* fs.makeDirectory(path.join(projectRoot, ".supabase"), { recursive: true });

      const layer = buildLayer(path, { cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const { cliProjectHome, linkState } = yield* Effect.gen(function* () {
        return {
          cliProjectHome: yield* CliProjectHome,
          linkState: yield* ProjectLinkState,
        };
      }).pipe(Effect.provide(layer));

      yield* fs.writeFileString(cliProjectHome.projectLinkPath, "{not-json");

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
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("getActiveBranch returns none when not linked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      const supabaseHome = path.join(tempDir, "supabase-home");

      yield* fs.makeDirectory(path.join(projectRoot, ".git"), { recursive: true });

      const layer = buildLayer(path, { cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

      const activeBranch = yield* linkState.getActiveBranch;
      expect(Option.isNone(activeBranch)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("getActiveBranch returns the persisted active_branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      const supabaseHome = path.join(tempDir, "supabase-home");

      yield* fs.makeDirectory(path.join(projectRoot, ".git"), { recursive: true });

      const layer = buildLayer(path, { cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

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
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live(
    "setActiveBranch updates only active_branch, leaving project and versions unchanged",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* makeTempDir;
        const projectRoot = path.join(tempDir, "repo");
        const supabaseHome = path.join(tempDir, "supabase-home");

        yield* fs.makeDirectory(path.join(projectRoot, ".git"), { recursive: true });

        const layer = buildLayer(path, { cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
        const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

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
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("setActiveBranch fails with ProjectNotLinkedError when project is not linked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      const supabaseHome = path.join(tempDir, "supabase-home");

      yield* fs.makeDirectory(path.join(projectRoot, ".git"), { recursive: true });

      const layer = buildLayer(path, { cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const linkState = yield* ProjectLinkState.pipe(Effect.provide(layer));

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
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
