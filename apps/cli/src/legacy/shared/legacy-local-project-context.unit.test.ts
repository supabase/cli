import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Config, ConfigProvider, Effect, FileSystem, Layer, Option, Path } from "effect";

import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import { makeLegacyViperEnvLayer } from "../../shared/legacy/legacy-viper-env.ts";
import { LegacyViperEnv } from "../../shared/legacy/legacy-viper-env.ts";
import { legacyResolveLocalConfigValues } from "./legacy-local-config-values.ts";
import { legacyLoadLocalProjectContext } from "./legacy-local-project-context.ts";

/**
 * `DOCKER_HOST` stands in for the whole Docker-client key set (`legacyIsDockerClientEnvKey`,
 * `db-bootstrap/docker-create-args.ts`) here — `legacyLoadLocalProjectContext` deliberately does
 * NOT install any of these from a project `.env` (see its own doc comment; review:
 * PRRT_kwDOErm0O86WXFqw): Go's Docker connectivity is the package-level
 * `var Docker = NewDocker()`, frozen at binary
 * startup, well before `godotenv.Load` ever runs — so a project-dotenv-only override can never
 * reach it, and installing it here would retarget native commands' Docker daemon relative to Go.
 */
const DOCKER_HOST_KEY = "DOCKER_HOST";

/**
 * `BITBUCKET_CLONE_DIR` remains in the resolved project environment map so
 * container boundaries can consume it without mutating global process state.
 */
const BITBUCKET_CLONE_DIR_KEY = "BITBUCKET_CLONE_DIR";

function testLayer(env: Readonly<Record<string, string>> = {}) {
  const provider = ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });
  return Layer.mergeAll(
    BunServices.layer,
    ConfigProvider.layer(provider),
    makeLegacyViperEnvLayer(provider),
  );
}

function writeDotEnv(workdir: string, contents: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(workdir, { recursive: true });
    yield* fs.writeFileString(path.join(workdir, ".env"), contents);
  });
}

function writeConfigToml(workdir: string, contents: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const supabaseDir = path.join(workdir, "supabase");
    yield* fs.makeDirectory(supabaseDir, { recursive: true });
    yield* fs.writeFileString(path.join(supabaseDir, "config.toml"), contents);
  });
}

const tempRoot = useLegacyTempWorkdir("supabase-legacy-project-context-");

describe("legacyLoadLocalProjectContext", () => {
  it.effect("resolves nested env references while ignoring TOML comments", () => {
    const workdir = tempRoot.current;
    const queried: Array<string> = [];
    const provider = ConfigProvider.fromEnv({
      env: { COMMENT_ONLY: "9999", NESTED_PORT: "5544" },
      preserveEmptyStrings: true,
    });
    const layer = Layer.mergeAll(
      BunServices.layer,
      ConfigProvider.layer(provider),
      Layer.succeed(LegacyViperEnv, {
        get: (name) =>
          Effect.sync(() => {
            queried.push(name);
            const value = { COMMENT_ONLY: "9999", NESTED_PORT: "5544" }[name];
            return value === undefined ? Option.none() : Option.some(value);
          }),
        entries: () => Effect.succeed({}),
      }),
    );
    return Effect.gen(function* () {
      yield* writeConfigToml(
        workdir,
        [
          "# env(COMMENT_ONLY) is documentation, not a config reference",
          'project_id = "nested-project"',
          "[api]",
          'port = "env(NESTED_PORT)"',
          "",
        ].join("\n"),
      );
      const context = yield* legacyLoadLocalProjectContext(
        workdir,
        (message) => new Cause.UnknownError(undefined, String(message)),
      );
      expect(context.config.api.port).toBe(5544);
      expect(queried).toContain("NESTED_PORT");
      expect(queried).not.toContain("COMMENT_ONLY");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "prefers a matched [remotes.<ref>]'s project_id over a conflicting SUPABASE_PROJECT_ID",
    () => {
      // Regression (review: PRRT_kwDOErm0O86XHGDL) — `loadProjectConfig`'s own remote merge
      // (`packages/config/src/io.ts`) already installs the matched block's `project_id` at
      // Go's viper override tier before this reads it; letting an unrelated
      // `SUPABASE_PROJECT_ID` win here would resolve the WRONG project id for the shadow's
      // own network id/container labels on a linked `db diff`/`db pull`.
      const ref = "abcdefghijklmnopqrst";
      const workdir = tempRoot.current;
      return Effect.gen(function* () {
        yield* writeConfigToml(
          workdir,
          ['project_id = "toml-project"', "[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"),
        );
        const context = yield* legacyLoadLocalProjectContext(
          workdir,
          (message) => new Cause.UnknownError(undefined, String(message)),
          ref,
        );
        expect(context.loaded?.appliedRemote).toBe("prod");
        expect(context.projectId).toBe(ref);
      }).pipe(Effect.provide(testLayer({ SUPABASE_PROJECT_ID: "local" })));
    },
  );

  it.effect("still applies SUPABASE_PROJECT_ID when no [remotes.*] block matches the ref", () => {
    const ref = "abcdefghijklmnopqrst";
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));
      const context = yield* legacyLoadLocalProjectContext(
        workdir,
        (message) => new Cause.UnknownError(undefined, String(message)),
        ref,
      );
      expect(context.loaded?.appliedRemote).toBeUndefined();
      expect(context.projectId).toBe("env-project");
    }).pipe(Effect.provide(testLayer({ SUPABASE_PROJECT_ID: "env-project" })));
  });

  it.effect("preserves ambient API and DB port overrides without config.toml", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      const context = yield* legacyLoadLocalProjectContext(
        workdir,
        (message) => new Cause.UnknownError(undefined, String(message)),
      );
      const values = yield* legacyResolveLocalConfigValues(
        context.config,
        context.hostname,
        workdir,
        context.projectEnvValues,
        context.loaded?.document,
      );
      expect(values.apiPort).toBe(65431);
      expect(values.dbPort).toBe(65432);
    }).pipe(Effect.provide(testLayer({ SUPABASE_API_PORT: "65431", SUPABASE_DB_PORT: "65432" })));
  });

  it.effect(
    "does NOT install a project .env's DOCKER_HOST into process.env, matching Go's Docker client being frozen at binary startup, before godotenv.Load ever runs",
    () => {
      const workdir = tempRoot.current;
      return Effect.gen(function* () {
        yield* writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);
        yield* legacyLoadLocalProjectContext(
          workdir,
          (message) => new Cause.UnknownError(undefined, String(message)),
        );
        const dockerHost = yield* Config.option(Config.string(DOCKER_HOST_KEY));
        expect(Option.isNone(dockerHost)).toBe(true);
      }).pipe(Effect.provide(testLayer()));
    },
  );

  it.effect(
    "leaves an already-set shell DOCKER_HOST untouched regardless of a conflicting project .env value",
    () => {
      const workdir = tempRoot.current;
      return Effect.gen(function* () {
        yield* writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);
        yield* legacyLoadLocalProjectContext(
          workdir,
          (message) => new Cause.UnknownError(undefined, String(message)),
        );
        const dockerHost = yield* Config.option(Config.string(DOCKER_HOST_KEY));
        expect(Option.getOrUndefined(dockerHost)).toBe("tcp://real-shell-host:2375");
      }).pipe(Effect.provide(testLayer({ [DOCKER_HOST_KEY]: "tcp://real-shell-host:2375" })));
    },
  );

  it.effect("resolves a project .env's BITBUCKET_CLONE_DIR for container boundaries", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);
      const context = yield* legacyLoadLocalProjectContext(
        workdir,
        (message) => new Cause.UnknownError(undefined, String(message)),
      );
      expect(context.projectEnvValues[BITBUCKET_CLONE_DIR_KEY]).toBe(
        "/opt/atlassian/pipelines/agent/build",
      );
    }).pipe(Effect.provide(testLayer()));
  });

  it.effect(
    "preserves an ambient BITBUCKET_CLONE_DIR over a conflicting project dotenv value",
    () => {
      const workdir = tempRoot.current;
      return Effect.gen(function* () {
        yield* writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);
        const context = yield* legacyLoadLocalProjectContext(
          workdir,
          (message) => new Cause.UnknownError(undefined, String(message)),
        );
        expect(context.projectEnvValues[BITBUCKET_CLONE_DIR_KEY]).toBe("/real-shell-clone-dir");
      }).pipe(Effect.provide(testLayer({ BITBUCKET_CLONE_DIR: "/real-shell-clone-dir" })));
    },
  );

  it.effect("captures ambient unprefixed start service overrides", () => {
    const workdir = tempRoot.current;
    const overrides = {
      KONG_NGINX_WORKER_PROCESSES: "auto",
      VECTOR_ENABLED: "false",
      VECTOR_BUCKET_PROVIDER: "custom",
      VECTOR_STORE_MIGRATIONS_ENABLED: "false",
      VECTOR_DATABASE_URL: "postgresql://vector.example.test/postgres",
    };
    return Effect.gen(function* () {
      const context = yield* legacyLoadLocalProjectContext(
        workdir,
        (message) => new Cause.UnknownError(undefined, String(message)),
      );
      expect(context.projectEnvValues).toMatchObject(overrides);
    }).pipe(Effect.provide(testLayer(overrides)));
  });
});
