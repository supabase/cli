import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
} from "effect";

import { useTempWorkdir, withConfigEnv, withEnvVar } from "../../tests/helpers/command-mocks.ts";
import { loadLocalProjectContext } from "./local-project-context.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";

/** Stands in for the whole Docker-client env-key set, which a project dotenv file never reaches. */
const DOCKER_HOST_KEY = "DOCKER_HOST";

/** Unlike Docker-client keys, this one is read at container-spawn time, so a project dotenv file can still set it. */
const BITBUCKET_CLONE_DIR_KEY = "BITBUCKET_CLONE_DIR";

class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

const writeDotEnv = Effect.fnUntraced(function* (workdir: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(workdir, { recursive: true });
  yield* fs.writeFileString(path.join(workdir, ".env"), contents);
});

const writeConfigToml = Effect.fnUntraced(function* (workdir: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const supabaseDir = path.join(workdir, "supabase");
  yield* fs.makeDirectory(supabaseDir, { recursive: true });
  yield* fs.writeFileString(path.join(supabaseDir, "config.toml"), contents);
});

const processEnvValue = (name: string) =>
  Effect.suspend(() =>
    Config.option(Config.String(name)).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
      ),
    ),
  );

const tempRoot = useTempWorkdir("supabase-project-context-");

describe("loadLocalProjectContext", () => {
  it.effect(
    "prefers a matched [remotes.<ref>]'s project_id over a conflicting SUPABASE_PROJECT_ID",
    () => {
      const ref = "abcdefghijklmnopqrst";
      const workdir = tempRoot.current;
      return Effect.gen(function* () {
        yield* writeConfigToml(
          workdir,
          ['project_id = "toml-project"', "[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"),
        );

        const context = yield* loadLocalProjectContext(
          workdir,
          (message) => new TestError({ message }),
          ref,
        );
        expect(context.loaded?.appliedRemote).toBe("prod");
        expect(context.projectId).toBe(ref);
      }).pipe(
        (body) => withEnvVar("SUPABASE_PROJECT_ID", "local", body),
        (body) => withConfigEnv({ SUPABASE_PROJECT_ID: "local" }, body),
        Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
      );
    },
  );

  it.effect("still applies SUPABASE_PROJECT_ID when no [remotes.*] block matches the ref", () => {
    const ref = "abcdefghijklmnopqrst";
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));

      const context = yield* loadLocalProjectContext(
        workdir,
        (message) => new TestError({ message }),
        ref,
      );
      expect(context.loaded?.appliedRemote).toBeUndefined();
      expect(context.projectId).toBe("env-project");
    }).pipe(
      (body) => withEnvVar("SUPABASE_PROJECT_ID", "env-project", body),
      (body) => withConfigEnv({ SUPABASE_PROJECT_ID: "env-project" }, body),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });

  it.effect(
    "does NOT install a project .env's DOCKER_HOST into process.env, matching Go's Docker client being frozen at binary startup, before godotenv.Load ever runs",
    () => {
      const workdir = tempRoot.current;
      return Effect.gen(function* () {
        yield* writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

        yield* loadLocalProjectContext(workdir, (message) => new TestError({ message }));
        expect(yield* processEnvValue(DOCKER_HOST_KEY)).toBeUndefined();
      }).pipe(
        (body) => withEnvVar(DOCKER_HOST_KEY, undefined, body),
        Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
      );
    },
  );

  it.effect(
    "leaves an already-set shell DOCKER_HOST untouched regardless of a conflicting project .env value",
    () => {
      const workdir = tempRoot.current;
      return Effect.gen(function* () {
        yield* writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

        yield* loadLocalProjectContext(workdir, (message) => new TestError({ message }));
        expect(yield* processEnvValue(DOCKER_HOST_KEY)).toBe("tcp://real-shell-host:2375");
      }).pipe(
        (body) => withEnvVar(DOCKER_HOST_KEY, "tcp://real-shell-host:2375", body),
        Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
      );
    },
  );

  it.effect("keeps a project's Bitbucket marker in its resolved environment", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);

      const context = yield* loadLocalProjectContext(
        workdir,
        (message) => new TestError({ message }),
      );
      expect(context.projectEnvValues[BITBUCKET_CLONE_DIR_KEY]).toBe(
        "/opt/atlassian/pipelines/agent/build",
      );
      expect(yield* processEnvValue(BITBUCKET_CLONE_DIR_KEY)).toBeUndefined();
    }).pipe(
      (body) => withEnvVar(BITBUCKET_CLONE_DIR_KEY, undefined, body),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });

  it.effect("keeps the shell Bitbucket marker ahead of the project value", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);

      const context = yield* loadLocalProjectContext(
        workdir,
        (message) => new TestError({ message }),
      );
      expect(context.projectEnvValues[BITBUCKET_CLONE_DIR_KEY]).toBe("/real-shell-clone-dir");
      expect(yield* processEnvValue(BITBUCKET_CLONE_DIR_KEY)).toBe("/real-shell-clone-dir");
    }).pipe(
      (body) => withEnvVar(BITBUCKET_CLONE_DIR_KEY, "/real-shell-clone-dir", body),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });

  it.effect("falls back to config.toml's project_id when SUPABASE_PROJECT_ID is empty", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));

      const context = yield* loadLocalProjectContext(
        workdir,
        (message) => new TestError({ message }),
      );
      expect(context.projectId).toBe("toml-project");
    }).pipe(
      (body) => withEnvVar("SUPABASE_PROJECT_ID", "", body),
      (body) => withConfigEnv({ SUPABASE_PROJECT_ID: "" }, body),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });

  it.effect(
    "falls back to config.toml's project_id when only Config sees an empty SUPABASE_PROJECT_ID",
    () => {
      // Windows env lookups are case-insensitive, so a lowercase `supabase_project_id=` reaches the
      // Config read with "" while the ambient values only carry the lowercase key.
      const workdir = tempRoot.current;
      return Effect.gen(function* () {
        yield* writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));

        const context = yield* loadLocalProjectContext(
          workdir,
          (message) => new TestError({ message }),
        );
        expect(context.projectId).toBe("toml-project");
      }).pipe(
        (body) => withEnvVar("SUPABASE_PROJECT_ID", undefined, body),
        (body) => withConfigEnv({ SUPABASE_PROJECT_ID: "" }, body),
        Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
      );
    },
  );

  it.effect("loads the development dotenv files when SUPABASE_ENV is empty", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));
      yield* fs.writeFileString(
        path.join(workdir, "supabase", ".env.development"),
        "SUPABASE_AUTH_JWT_SECRET=dev-secret\n",
      );

      const context = yield* loadLocalProjectContext(
        workdir,
        (message) => new TestError({ message }),
      );
      expect(context.projectEnvValues["SUPABASE_AUTH_JWT_SECRET"]).toBe("dev-secret");
    }).pipe(
      (body) => withEnvVar("SUPABASE_AUTH_JWT_SECRET", undefined, body),
      (body) => withConfigEnv({ SUPABASE_ENV: "" }, body),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });

  it.effect("skips an unparseable supabase/.env.local when SUPABASE_ENV is test", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));
      yield* fs.writeFileString(path.join(workdir, "supabase", ".env.local"), "not a valid line\n");

      const exit = yield* loadLocalProjectContext(
        workdir,
        (message) => new TestError({ message }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(
      (body) => withConfigEnv({ SUPABASE_ENV: "test" }, body),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });

  it.effect("fails on an unparseable supabase/.env.local outside the test environment", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));
      yield* fs.writeFileString(path.join(workdir, "supabase", ".env.local"), "not a valid line\n");

      const error = yield* loadLocalProjectContext(
        workdir,
        (message) => new TestError({ message }),
      ).pipe(Effect.flip);
      expect(error.message).toMatch(/^failed to read config: /);
    }).pipe(
      (body) => withConfigEnv({ SUPABASE_ENV: "development" }, body),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });

  it.effect("keeps the Error: prefix when a project-root .env is malformed", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeDotEnv(workdir, "not a valid line\n");

      const error = yield* loadLocalProjectContext(
        workdir,
        (message) => new TestError({ message }),
      ).pipe(Effect.flip);
      expect(error.message).toMatch(
        /^failed to read config: Error: failed to parse environment file: /,
      );
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)));
  });

  it.effect("fails with a typed error when SUPABASE_ENV cannot be resolved", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      const error = yield* loadLocalProjectContext(
        workdir,
        (message) => new TestError({ message }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TestError);
      expect(error.message).toBe("failed to resolve environment variable: SUPABASE_ENV");
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.make(() =>
          Effect.fail(new ConfigProvider.SourceError({ message: "injected" })),
        ),
      ),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });

  it.effect("fails with a typed error when SUPABASE_PROJECT_ID cannot be resolved", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      const error = yield* loadLocalProjectContext(
        workdir,
        (message) => new TestError({ message }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TestError);
      expect(error.message).toBe("failed to resolve environment variable: SUPABASE_PROJECT_ID");
    }).pipe(
      (body) => withEnvVar("SUPABASE_PROJECT_ID", undefined, body),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.make((path) =>
          path[0] === "SUPABASE_PROJECT_ID"
            ? Effect.fail(new ConfigProvider.SourceError({ message: "injected" }))
            : ConfigProvider.fromEnvRecord({}).load(path),
        ),
      ),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });
});
