import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
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
import { cliProjectLocalServiceVersionsLayer } from "./cli-project-local-service-versions.layer.ts";
import { CliProjectHome } from "./cli-project-home.service.ts";
import { CliProjectLocalServiceVersions } from "./cli-project-local-service-versions.service.ts";

const makeTempDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "supabase-project-local-versions-" }),
);

const PrettyJsonString = Schema.fromJsonString(Schema.Unknown, { space: 2 });

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
  const discoveredCliProjectLocalServiceVersionsLayer = cliProjectLocalServiceVersionsLayer.pipe(
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
    discoveredCliProjectLocalServiceVersionsLayer,
  );
}

describe("cliProjectLocalServiceVersionsLayer", () => {
  it.live("surfaces a filesystem read permission failure", () => {
    const fsLayer = Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readFileString",
              description: "permission denied",
            }),
          ),
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(projectRoot, "supabase", "config.toml"), "");

      const layer = buildLayer(path, { cwd: projectRoot, fs: fsLayer });
      const localVersions = yield* CliProjectLocalServiceVersions.pipe(Effect.provide(layer));

      const exit = yield* Effect.exit(localVersions.load);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(PlatformError.PlatformError);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.live("fails with a tagged error when local service versions are malformed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(projectRoot, "supabase", "config.toml"), "");

      const layer = buildLayer(path, { cwd: projectRoot });
      const { cliProjectHome, localVersions } = yield* Effect.gen(function* () {
        return {
          cliProjectHome: yield* CliProjectHome,
          localVersions: yield* CliProjectLocalServiceVersions,
        };
      }).pipe(Effect.provide(layer));

      yield* cliProjectHome.ensureCliProjectHomeDir;
      yield* fs.writeFileString(cliProjectHome.projectLocalVersionsPath, "{not-json");

      const exit = yield* Effect.exit(localVersions.load);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toMatchObject({ _tag: "InvalidLocalServiceVersionsStateError" });
        }
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("loads local service version overrides from repo-local state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      const supabaseHome = path.join(tempDir, "supabase-home");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(projectRoot, "supabase", "config.toml"), "");

      const layer = buildLayer(path, { cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const { cliProjectHome, localVersions } = yield* Effect.gen(function* () {
        return {
          cliProjectHome: yield* CliProjectHome,
          localVersions: yield* CliProjectLocalServiceVersions,
        };
      }).pipe(Effect.provide(layer));

      yield* cliProjectHome.ensureCliProjectHomeDir;
      yield* fs.writeFileString(
        cliProjectHome.projectLocalVersionsPath,
        yield* Schema.encodeEffect(PrettyJsonString)({
          updatedAt: "2026-03-21T12:00:00.000Z",
          versions: {
            auth: "v2.180.0",
            storage: "1.40.0",
          },
        }),
      );

      const loaded = yield* localVersions.load;
      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isSome(loaded)) {
        expect(loaded.value.versions).toEqual({
          auth: "v2.180.0",
          storage: "1.40.0",
        });
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("returns none when no local override file exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* makeTempDir;
      const projectRoot = path.join(tempDir, "repo");
      const supabaseHome = path.join(tempDir, "supabase-home");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(projectRoot, "supabase", "config.toml"), "");

      const layer = buildLayer(path, { cwd: projectRoot, env: { SUPABASE_HOME: supabaseHome } });
      const localVersions = yield* CliProjectLocalServiceVersions.pipe(Effect.provide(layer));

      const loaded = yield* localVersions.load;
      expect(Option.isNone(loaded)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
