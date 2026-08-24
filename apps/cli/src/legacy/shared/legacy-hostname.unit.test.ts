import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Crypto, Effect, Encoding, FileSystem, Layer, Path } from "effect";

import { legacyGetHostname } from "./legacy-hostname.ts";
import { makeLegacyViperEnvLayer } from "../../shared/legacy/legacy-viper-env.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";

interface DockerFixture {
  readonly currentContext?: string;
  readonly contexts?: Readonly<Record<string, string>>;
}

function runHostname(
  env: Readonly<Record<string, string | undefined>>,
  fixture?: DockerFixture,
  homeVariable?: "HOME" | "USERPROFILE",
  useRuntimeHomeFallback = false,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    return yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: "legacy-hostname-docker-config-" }),
      (dir) => {
        const providerEnv: Record<string, string> = {};
        const fixtureEnv =
          fixture === undefined
            ? env
            : homeVariable === undefined
              ? useRuntimeHomeFallback
                ? { ...env, DOCKER_CONFIG: undefined }
                : { ...env, DOCKER_CONFIG: dir }
              : { ...env, [homeVariable]: dir, DOCKER_CONFIG: undefined };
        const configDir =
          fixture === undefined || (!useRuntimeHomeFallback && homeVariable === undefined)
            ? dir
            : path.join(dir, ".docker");
        for (const [key, value] of Object.entries(fixtureEnv)) {
          if (value !== undefined) providerEnv[key] = value;
        }
        const envLayer = makeLegacyViperEnvLayer(
          ConfigProvider.fromEnv({
            env: providerEnv,
            preserveEmptyStrings: true,
          }),
        );
        return Effect.gen(function* () {
          yield* fs.makeDirectory(configDir, { recursive: true });
          if (fixture?.currentContext !== undefined) {
            yield* fs.writeFileString(
              path.join(configDir, "config.json"),
              `{"currentContext":"${fixture.currentContext}"}`,
            );
          }
          for (const [name, host] of Object.entries(fixture?.contexts ?? {})) {
            const contextId = Encoding.encodeHex(
              yield* crypto.digest("SHA-256", new TextEncoder().encode(name)),
            );
            const metaDir = path.join(configDir, "contexts", "meta", contextId);
            yield* fs.makeDirectory(metaDir, { recursive: true });
            yield* fs.writeFileString(
              path.join(metaDir, "meta.json"),
              `{"Endpoints":{"docker":{"Host":"${host}"}}}`,
            );
          }
          return yield* legacyGetHostname;
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              envLayer,
              Layer.succeed(
                RuntimeInfo,
                RuntimeInfo.of({
                  cwd: dir,
                  platform: "linux",
                  arch: "arm64",
                  homeDir: dir,
                  execPath: "/test/supabase",
                  pid: 1,
                }),
              ),
            ),
          ),
        );
      },
      (dir) => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore),
    );
  }).pipe(Effect.provide(BunServices.layer));
}

describe("legacyGetHostname", () => {
  it.effect("prefers SUPABASE_SERVICES_HOSTNAME over everything else", () =>
    runHostname({
      SUPABASE_SERVICES_HOSTNAME: "db.internal",
      DOCKER_HOST: "tcp://docker:2375",
    }).pipe(Effect.tap((host) => Effect.sync(() => expect(host).toBe("db.internal")))),
  );

  it.effect("derives the host from a tcp:// DOCKER_HOST when no override is set", () =>
    runHostname({ DOCKER_HOST: "tcp://docker-host:2375" }).pipe(
      Effect.tap((host) => Effect.sync(() => expect(host).toBe("docker-host"))),
    ),
  );

  it.effect("strips brackets from an IPv6 tcp:// DOCKER_HOST", () =>
    runHostname({ DOCKER_HOST: "tcp://[::1]:2375" }).pipe(
      Effect.tap((host) => Effect.sync(() => expect(host).toBe("::1"))),
    ),
  );

  it.effect("falls back to 127.0.0.1 for a unix-socket DOCKER_HOST", () =>
    runHostname({ DOCKER_HOST: "unix:///var/run/docker.sock" }).pipe(
      Effect.tap((host) => Effect.sync(() => expect(host).toBe("127.0.0.1"))),
    ),
  );

  it.effect("falls back to 127.0.0.1 when neither env var is set", () =>
    runHostname({}).pipe(Effect.tap((host) => Effect.sync(() => expect(host).toBe("127.0.0.1")))),
  );

  it.effect("resolves the active context's tcp endpoint", () =>
    runHostname(
      {},
      { currentContext: "remote", contexts: { remote: "tcp://remote-host:2375" } },
    ).pipe(Effect.tap((host) => Effect.sync(() => expect(host).toBe("remote-host")))),
  );

  it.effect("uses USERPROFILE for Docker config discovery when HOME is absent", () =>
    runHostname(
      {},
      { currentContext: "remote", contexts: { remote: "tcp://remote-host:2375" } },
      "USERPROFILE",
    ).pipe(Effect.tap((host) => Effect.sync(() => expect(host).toBe("remote-host")))),
  );

  it.effect("uses RuntimeInfo.homeDir for Docker config discovery when env homes are absent", () =>
    runHostname(
      {},
      { currentContext: "remote", contexts: { remote: "tcp://remote-host:2375" } },
      undefined,
      true,
    ).pipe(Effect.tap((host) => Effect.sync(() => expect(host).toBe("remote-host")))),
  );

  it.effect("prefers DOCKER_CONTEXT over config.json's currentContext", () =>
    runHostname(
      { DOCKER_CONTEXT: "envctx" },
      {
        currentContext: "other",
        contexts: {
          envctx: "tcp://envctx-host:2375",
          other: "tcp://other-host:2375",
        },
      },
    ).pipe(Effect.tap((host) => Effect.sync(() => expect(host).toBe("envctx-host")))),
  );

  it.effect("strips brackets from an IPv6 context endpoint", () =>
    runHostname({}, { currentContext: "remote", contexts: { remote: "tcp://[::1]:2375" } }).pipe(
      Effect.tap((host) => Effect.sync(() => expect(host).toBe("::1"))),
    ),
  );

  it.effect("falls back when the active context endpoint is not tcp://", () =>
    runHostname(
      {},
      { currentContext: "remote", contexts: { remote: "unix:///var/run/docker.sock" } },
    ).pipe(Effect.tap((host) => Effect.sync(() => expect(host).toBe("127.0.0.1")))),
  );

  it.effect("falls back when the context store entry is missing", () =>
    runHostname({}, { currentContext: "ghost" }).pipe(
      Effect.tap((host) => Effect.sync(() => expect(host).toBe("127.0.0.1"))),
    ),
  );

  it.effect("falls back when config.json is missing", () =>
    runHostname({}).pipe(Effect.tap((host) => Effect.sync(() => expect(host).toBe("127.0.0.1")))),
  );

  it.effect("does not consult the context store for the default context", () =>
    runHostname(
      {},
      { currentContext: "default", contexts: { default: "tcp://should-never-be-read:2375" } },
    ).pipe(Effect.tap((host) => Effect.sync(() => expect(host).toBe("127.0.0.1")))),
  );

  it.effect("prefers DOCKER_HOST over an active non-default context", () =>
    runHostname(
      { DOCKER_HOST: "tcp://direct-host:2375" },
      { currentContext: "remote", contexts: { remote: "tcp://context-host:2375" } },
    ).pipe(Effect.tap((host) => Effect.sync(() => expect(host).toBe("direct-host")))),
  );
});
