import { Config, Crypto, Effect, FileSystem, Option, Path, Schema } from "effect";

import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";

const LOCAL_HOST = "127.0.0.1";
const LOOPBACK_NO_PROXY = `localhost,${LOCAL_HOST},[::1]`;
const DEFAULT_CONTEXT_NAME = "default";

type Environment = Readonly<Record<string, string | undefined>>;

const envOption = (
  name: string,
  projectEnvValues?: Environment,
): Effect.Effect<Option.Option<string>, Config.ConfigError> => {
  const projectValue = Option.fromNullishOr(projectEnvValues?.[name]);
  return Option.isSome(projectValue)
    ? Effect.succeed(projectValue)
    : Config.option(Config.string(name));
};

const dockerConfigDir = (
  projectEnvValues?: Environment,
): Effect.Effect<string, Config.ConfigError, RuntimeInfo | Path.Path> =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeInfo;
    const path = yield* Path.Path;
    const configured = yield* envOption("DOCKER_CONFIG", projectEnvValues);
    return Option.getOrElse(configured.pipe(Option.filter((value) => value.length > 0)), () =>
      path.join(runtime.homeDir, ".docker"),
    );
  });

const DockerConfigSchema = Schema.Struct({
  currentContext: Schema.optionalKey(Schema.String),
});
const DockerMetaSchema = Schema.Struct({
  Endpoints: Schema.optionalKey(
    Schema.Struct({
      docker: Schema.optionalKey(Schema.Struct({ Host: Schema.optionalKey(Schema.String) })),
    }),
  ),
});

const decodeDockerConfig = (
  content: string,
): Effect.Effect<Option.Option<Schema.Schema.Type<typeof DockerConfigSchema>>> =>
  Schema.decodeEffect(Schema.fromJsonString(DockerConfigSchema))(content).pipe(Effect.option);

const decodeDockerMeta = (
  content: string,
): Effect.Effect<Option.Option<Schema.Schema.Type<typeof DockerMetaSchema>>> =>
  Schema.decodeEffect(Schema.fromJsonString(DockerMetaSchema))(content).pipe(Effect.option);

const currentDockerContextName = (
  projectEnvValues?: Environment,
): Effect.Effect<string, Config.ConfigError, RuntimeInfo | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fromEnv = yield* envOption("DOCKER_CONTEXT", projectEnvValues);
    if (Option.isSome(fromEnv) && fromEnv.value.length > 0) return fromEnv.value;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* dockerConfigDir(projectEnvValues);

    const configPath = path.join(configDir, "config.json");
    const config = yield* fs.readFileString(configPath).pipe(Effect.option);
    if (Option.isSome(config)) {
      const parsed = yield* decodeDockerConfig(config.value);
      if (Option.isSome(parsed)) {
        const currentContext = parsed.value.currentContext;
        if (currentContext !== undefined && currentContext.length > 0) return currentContext;
      }
    }
    return DEFAULT_CONTEXT_NAME;
  });

const dockerContextEndpointHost = (contextName: string, projectEnvValues?: Environment) => {
  if (contextName === DEFAULT_CONTEXT_NAME) return Effect.succeed(Option.none<string>());
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const configDir = yield* dockerConfigDir(projectEnvValues);
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(contextName))
      .pipe(Effect.option);
    if (Option.isNone(digest)) return Option.none<string>();
    const contextId = Array.from(digest.value, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
    const metaPath = path.join(configDir, "contexts", "meta", contextId, "meta.json");
    const content = yield* fs.readFileString(metaPath).pipe(Effect.option);
    if (Option.isNone(content)) return Option.none<string>();
    const parsed = yield* decodeDockerMeta(content.value);
    if (Option.isNone(parsed)) return Option.none<string>();
    const host = parsed.value.Endpoints?.docker?.Host;
    return host === undefined || host.length === 0 ? Option.none<string>() : Option.some(host);
  });
};

const hostFromTcpEndpoint = (endpoint: string): Effect.Effect<Option.Option<string>> =>
  Effect.try({
    try: () => new URL(endpoint),
    catch: () => undefined,
  }).pipe(
    Effect.option,
    Effect.map(
      Option.flatMap((url) =>
        url.protocol === "tcp:" && url.hostname.length > 0
          ? Option.some(
              url.hostname.startsWith("[") && url.hostname.endsWith("]")
                ? url.hostname.slice(1, -1)
                : url.hostname,
            )
          : Option.none(),
      ),
    ),
  );

/** The platform's default Docker daemon socket. */
export function platformDefaultDockerHost(platform: NodeJS.Platform): string {
  return platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";
}

/** Resolves the daemon endpoint selected by the Docker CLI. */
export const resolveDockerDaemonEndpoint = (
  projectEnvValues?: Environment,
): Effect.Effect<
  Option.Option<string>,
  Config.ConfigError,
  RuntimeInfo | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeInfo;
    const dockerHost = yield* envOption("DOCKER_HOST", projectEnvValues);
    if (Option.isSome(dockerHost) && dockerHost.value.length > 0) return dockerHost;
    const contextName = yield* currentDockerContextName(projectEnvValues);
    if (contextName === DEFAULT_CONTEXT_NAME) {
      return Option.some(platformDefaultDockerHost(runtime.platform));
    }
    return yield* dockerContextEndpointHost(contextName, projectEnvValues);
  });

/** Resolves the hostname used for local Supabase service connections. */
export const getHostname = (
  projectEnvValues?: Environment,
): Effect.Effect<
  string,
  Config.ConfigError,
  RuntimeInfo | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const override = yield* envOption("SUPABASE_SERVICES_HOSTNAME", projectEnvValues);
    if (Option.isSome(override) && override.value.length > 0) return override.value;
    const endpoint = yield* resolveDockerDaemonEndpoint(projectEnvValues);
    if (Option.isSome(endpoint)) {
      const host = yield* hostFromTcpEndpoint(endpoint.value);
      if (Option.isSome(host)) return host.value;
    }
    return LOCAL_HOST;
  });

/** Keeps Bun from proxying the CLI's loopback HTTP requests. */
export function configureLoopbackProxyBypass(env: NodeJS.ProcessEnv = process.env): void {
  const key = (env["no_proxy"]?.length ?? 0) > 0 ? "no_proxy" : "NO_PROXY";
  const current = env[key];
  env[key] = current ? `${current},${LOOPBACK_NO_PROXY}` : LOOPBACK_NO_PROXY;
}
