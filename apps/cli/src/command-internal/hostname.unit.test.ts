import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Config, ConfigProvider, Crypto, Effect, FileSystem, Layer, Option, Path } from "effect";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import {
  configureLoopbackProxyBypass,
  getHostname,
  platformDefaultDockerHost,
  resolveDockerDaemonEndpoint,
} from "./hostname.ts";

const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,[::1]";

const runtimeLayer = Layer.succeed(
  RuntimeInfo,
  RuntimeInfo.of({
    cwd: "/tmp",
    platform: "linux",
    arch: "arm64",
    homeDir: "/tmp",
    execPath: "/tmp/supabase",
    pid: 1,
  }),
);

type HostnameServices = RuntimeInfo | FileSystem.FileSystem | Path.Path | Crypto.Crypto;

function configLayer(env: Readonly<Record<string, string | undefined>>) {
  return Layer.mergeAll(
    BunServices.layer,
    runtimeLayer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true })),
  );
}

function writeDockerConfigDir(options: {
  readonly currentContext?: string;
  readonly contexts?: Readonly<Record<string, string>>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "hostname-docker-config-"));
  if (options.currentContext !== undefined) {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ currentContext: options.currentContext }),
    );
  }
  for (const [name, host] of Object.entries(options.contexts ?? {})) {
    const contextId = createHash("sha256").update(name).digest("hex");
    const metaDir = join(dir, "contexts", "meta", contextId);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      join(metaDir, "meta.json"),
      JSON.stringify({ Endpoints: { docker: { Host: host } } }),
    );
  }
  return dir;
}

function withDockerConfig<A>(
  options: Parameters<typeof writeDockerConfigDir>[0],
  env: Readonly<Record<string, string | undefined>>,
  run: () => Effect.Effect<A, Config.ConfigError, HostnameServices>,
): Effect.Effect<A, Config.ConfigError> {
  return Effect.acquireUseRelease(
    Effect.sync(() => writeDockerConfigDir(options)),
    (configDir) => run().pipe(Effect.provide(configLayer({ ...env, DOCKER_CONFIG: configDir }))),
    (configDir) => Effect.sync(() => rmSync(configDir, { recursive: true, force: true })),
  );
}

describe("getHostname", () => {
  it.effect("prefers a project override and preserves an explicit empty value", () =>
    Effect.gen(function* () {
      expect(yield* getHostname({ SUPABASE_SERVICES_HOSTNAME: "db.internal" })).toBe("db.internal");
      expect(yield* getHostname({ SUPABASE_SERVICES_HOSTNAME: "" })).toBe("127.0.0.1");
    }).pipe(Effect.provide(configLayer({}))),
  );

  it.effect("reads ambient DOCKER_HOST and extracts IPv4 and IPv6 hosts", () =>
    Effect.gen(function* () {
      expect(yield* getHostname()).toBe("docker-host");
      expect(yield* getHostname({})).toBe("docker-host");
      expect(yield* getHostname({ DOCKER_HOST: "tcp://[::1]:2375" })).toBe("::1");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          runtimeLayer,
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ DOCKER_HOST: "tcp://docker-host:2375" }),
          ),
        ),
      ),
    ),
  );

  it.effect("uses currentContext from Docker config", () =>
    withDockerConfig(
      { currentContext: "remote", contexts: { remote: "tcp://remote-host:2375" } },
      {},
      () =>
        Effect.gen(function* () {
          expect(yield* getHostname()).toBe("remote-host");
        }),
    ),
  );

  it.effect("prefers DOCKER_CONTEXT over Docker config currentContext", () =>
    withDockerConfig(
      {
        currentContext: "other",
        contexts: { envctx: "tcp://envctx-host:2375", other: "tcp://other-host:2375" },
      },
      { DOCKER_CONTEXT: "envctx" },
      () =>
        Effect.gen(function* () {
          expect(yield* getHostname()).toBe("envctx-host");
        }),
    ),
  );

  it.effect("strips brackets from an IPv6 context endpoint", () =>
    withDockerConfig(
      { currentContext: "remote", contexts: { remote: "tcp://[::1]:2375" } },
      {},
      () =>
        Effect.gen(function* () {
          expect(yield* getHostname()).toBe("::1");
        }),
    ),
  );

  it.effect("falls back for a non-tcp context endpoint", () =>
    withDockerConfig(
      { currentContext: "remote", contexts: { remote: "unix:///var/run/docker.sock" } },
      {},
      () =>
        Effect.gen(function* () {
          expect(yield* getHostname()).toBe("127.0.0.1");
        }),
    ),
  );

  it.effect("falls back when a non-default context store entry is missing", () =>
    withDockerConfig({ currentContext: "ghost" }, {}, () =>
      Effect.gen(function* () {
        expect(yield* resolveDockerDaemonEndpoint()).toEqual(Option.none());
        expect(yield* getHostname()).toBe("127.0.0.1");
      }),
    ),
  );

  it.effect("falls back to the default context when Docker config is missing", () =>
    withDockerConfig({}, {}, () =>
      Effect.gen(function* () {
        expect(yield* getHostname()).toBe("127.0.0.1");
      }),
    ),
  );

  it.effect("does not read the context store for the default context", () =>
    withDockerConfig(
      { currentContext: "default", contexts: { default: "tcp://should-never-be-read:2375" } },
      {},
      () =>
        Effect.gen(function* () {
          expect(yield* resolveDockerDaemonEndpoint()).toEqual(
            Option.some("unix:///var/run/docker.sock"),
          );
          expect(yield* getHostname()).toBe("127.0.0.1");
        }),
    ),
  );

  it.effect("prefers DOCKER_HOST over a selected Docker context", () =>
    withDockerConfig(
      { currentContext: "remote", contexts: { remote: "tcp://context-host:2375" } },
      { DOCKER_HOST: "tcp://direct-host:2375" },
      () =>
        Effect.gen(function* () {
          expect(yield* getHostname()).toBe("direct-host");
        }),
    ),
  );

  it.effect("treats an empty currentContext as the default context", () =>
    withDockerConfig(
      { currentContext: "", contexts: { remote: "tcp://should-not-be-read:2375" } },
      {},
      () =>
        Effect.gen(function* () {
          expect(yield* resolveDockerDaemonEndpoint()).toEqual(
            Option.some("unix:///var/run/docker.sock"),
          );
        }),
    ),
  );

  it.effect("returns loopback for an absent or non-tcp endpoint", () =>
    Effect.gen(function* () {
      expect(yield* getHostname()).toBe("127.0.0.1");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          runtimeLayer,
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ DOCKER_HOST: "unix:///docker.sock" }),
          ),
        ),
      ),
    ),
  );
});

describe("resolveDockerDaemonEndpoint", () => {
  it.effect("returns DOCKER_HOST verbatim, including non-tcp schemes", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveDockerDaemonEndpoint({ DOCKER_HOST: "unix:///custom/engine.sock" }),
      ).toEqual(Option.some("unix:///custom/engine.sock"));
      expect(yield* resolveDockerDaemonEndpoint({ DOCKER_HOST: "tcp://docker-host:2375" })).toEqual(
        Option.some("tcp://docker-host:2375"),
      );
    }).pipe(Effect.provide(configLayer({}))),
  );

  it.effect("maps the default context to the platform default daemon endpoint", () =>
    withDockerConfig({}, {}, () =>
      Effect.gen(function* () {
        expect(yield* resolveDockerDaemonEndpoint()).toEqual(
          Option.some("unix:///var/run/docker.sock"),
        );
      }),
    ),
  );

  it.effect("returns the active context endpoint verbatim", () =>
    withDockerConfig(
      { currentContext: "remote", contexts: { remote: "tcp://remote-host:2375" } },
      {},
      () =>
        Effect.gen(function* () {
          expect(yield* resolveDockerDaemonEndpoint()).toEqual(
            Option.some("tcp://remote-host:2375"),
          );
        }),
    ),
  );

  it.effect("returns none for an unreadable non-default context", () =>
    withDockerConfig({ currentContext: "ghost" }, {}, () =>
      Effect.gen(function* () {
        expect(yield* resolveDockerDaemonEndpoint()).toEqual(Option.none());
      }),
    ),
  );
});

describe("platformDefaultDockerHost", () => {
  it("resolves the unix default off Windows", () => {
    expect(platformDefaultDockerHost("darwin")).toBe("unix:///var/run/docker.sock");
    expect(platformDefaultDockerHost("linux")).toBe("unix:///var/run/docker.sock");
  });
  it("resolves the named-pipe default on Windows", () => {
    expect(platformDefaultDockerHost("win32")).toBe("npipe:////./pipe/docker_engine");
  });
});

describe("configureLoopbackProxyBypass", () => {
  it.each([
    ["sets NO_PROXY when neither spelling is configured", {}, { NO_PROXY: LOOPBACK_NO_PROXY }],
    [
      "preserves an existing NO_PROXY value",
      { NO_PROXY: "example.com" },
      { NO_PROXY: `example.com,${LOOPBACK_NO_PROXY}` },
    ],
    [
      "updates the non-empty lowercase value preferred by Bun",
      { NO_PROXY: "uppercase.example", no_proxy: "lowercase.example" },
      {
        NO_PROXY: "uppercase.example",
        no_proxy: `lowercase.example,${LOOPBACK_NO_PROXY}`,
      },
    ],
    [
      "falls back to NO_PROXY when lowercase no_proxy is empty",
      { NO_PROXY: "example.com", no_proxy: "" },
      { NO_PROXY: `example.com,${LOOPBACK_NO_PROXY}`, no_proxy: "" },
    ],
  ])("%s", (_name, env, expected) => {
    configureLoopbackProxyBypass(env);
    expect(env).toEqual(expected);
  });
});
