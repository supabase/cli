import { Config, Crypto, Effect, Encoding, FileSystem, Option, Path, Schema } from "effect";
import type * as PlatformError from "effect/PlatformError";

import { LegacyViperEnv } from "../../shared/legacy/legacy-viper-env.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_CONTEXT_NAME = "default";

const DockerConfigSchema = Schema.Struct({
  currentContext: Schema.optional(Schema.String),
});

const DockerContextSchema = Schema.Struct({
  Endpoints: Schema.optional(
    Schema.Struct({
      docker: Schema.optional(
        Schema.Struct({
          Host: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});

interface HostEnvironment {
  readonly servicesHostname: string | undefined;
  readonly dockerHost: string | undefined;
  readonly dockerContext: string | undefined;
  readonly dockerConfig: string | undefined;
  readonly home: string | undefined;
}

function readDockerConfig(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Option.Option<Schema.Schema.Type<typeof DockerConfigSchema>>> {
  return fs.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DockerConfigSchema))),
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none()),
  );
}

function readDockerContext(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Option.Option<Schema.Schema.Type<typeof DockerContextSchema>>> {
  return fs.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DockerContextSchema))),
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none()),
  );
}

function readHostEnvironment(): Effect.Effect<HostEnvironment, Config.ConfigError, LegacyViperEnv> {
  const fallback: HostEnvironment = {
    servicesHostname: undefined,
    dockerHost: undefined,
    dockerContext: undefined,
    dockerConfig: undefined,
    home: undefined,
  };
  return Effect.gen(function* () {
    const env = yield* LegacyViperEnv;
    const runtimeInfo = yield* Effect.serviceOption(RuntimeInfo);
    const values = yield* Effect.all({
      servicesHostname: env.get("SUPABASE_SERVICES_HOSTNAME"),
      dockerHost: env.get("DOCKER_HOST"),
      dockerContext: env.get("DOCKER_CONTEXT"),
      dockerConfig: env.get("DOCKER_CONFIG"),
      home: env.get("HOME"),
      userProfile: env.get("USERPROFILE"),
    });
    const home = Option.getOrUndefined(values.home);
    const userProfile = Option.getOrUndefined(values.userProfile);
    const runtimeHome = Option.match(runtimeInfo, {
      onNone: () => undefined,
      onSome: (value) => value.homeDir,
    });
    return {
      servicesHostname: Option.getOrUndefined(values.servicesHostname),
      dockerHost: Option.getOrUndefined(values.dockerHost),
      dockerContext: Option.getOrUndefined(values.dockerContext),
      dockerConfig: Option.getOrUndefined(values.dockerConfig),
      home:
        home !== undefined && home.length > 0
          ? home
          : userProfile !== undefined && userProfile.length > 0
            ? userProfile
            : runtimeHome !== undefined && runtimeHome.length > 0
              ? runtimeHome
              : undefined,
    };
  }).pipe(Effect.orElseSucceed(() => fallback));
}

function dockerConfigDir(env: HostEnvironment, path: Path.Path): string | undefined {
  if (env.dockerConfig !== undefined && env.dockerConfig.length > 0) {
    return env.dockerConfig;
  }
  return env.home === undefined ? undefined : path.join(env.home, ".docker");
}

function currentDockerContextName(
  env: HostEnvironment,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<string> {
  if (env.dockerContext !== undefined && env.dockerContext.length > 0) {
    return Effect.succeed(env.dockerContext);
  }
  const configDir = dockerConfigDir(env, path);
  if (configDir === undefined) {
    return Effect.void.pipe(Effect.as(DEFAULT_CONTEXT_NAME));
  }
  return readDockerConfig(fs, path.join(configDir, "config.json")).pipe(
    Effect.map((config) =>
      Option.isSome(config) &&
      config.value.currentContext !== undefined &&
      config.value.currentContext.length > 0
        ? config.value.currentContext
        : DEFAULT_CONTEXT_NAME,
    ),
  );
}

function dockerContextEndpointHost(
  contextName: string,
  env: HostEnvironment,
  crypto: Crypto.Crypto,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<string | undefined, PlatformError.PlatformError> {
  if (contextName === DEFAULT_CONTEXT_NAME) {
    return Effect.void.pipe(Effect.as(undefined));
  }
  const configDir = dockerConfigDir(env, path);
  if (configDir === undefined) {
    return Effect.void.pipe(Effect.as(undefined));
  }
  return crypto.digest("SHA-256", new TextEncoder().encode(contextName)).pipe(
    Effect.map(Encoding.encodeHex),
    Effect.flatMap((contextId) => {
      const contextPath = path.join(configDir, "contexts", "meta", contextId, "meta.json");
      return readDockerContext(fs, contextPath);
    }),
    Effect.map((meta) => (Option.isSome(meta) ? meta.value.Endpoints?.docker?.Host : undefined)),
  );
}

function hostFromTcpEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "tcp:" || url.hostname.length === 0) {
      return undefined;
    }
    const host = url.hostname;
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the hostname used for local Supabase service connections.
 *
 * The resolver mirrors Go's `utils.GetHostname`: an explicit
 * `SUPABASE_SERVICES_HOSTNAME` wins, followed by a TCP `DOCKER_HOST`, then the
 * active Docker context's TCP endpoint, and finally loopback. Environment and
 * filesystem access are injected so concurrent commands and tests do not
 * mutate or snapshot process globals.
 */
const legacyGetHostnameEffect = Effect.gen(function* () {
  const env = yield* readHostEnvironment();
  if (env.servicesHostname !== undefined && env.servicesHostname.length > 0) {
    return env.servicesHostname;
  }
  if (env.dockerHost !== undefined && env.dockerHost.length > 0) {
    return hostFromTcpEndpoint(env.dockerHost) ?? LOCAL_HOST;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const contextName = yield* currentDockerContextName(env, fs, path);
  const contextEndpoint = yield* dockerContextEndpointHost(contextName, env, crypto, fs, path);
  return contextEndpoint === undefined
    ? LOCAL_HOST
    : (hostFromTcpEndpoint(contextEndpoint) ?? LOCAL_HOST);
});

export const legacyGetHostname = legacyGetHostnameEffect.pipe(
  Effect.orElseSucceed(() => LOCAL_HOST),
);
