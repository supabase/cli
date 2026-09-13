import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCAL_HOST = "127.0.0.1";
const LOOPBACK_NO_PROXY = `localhost,${LOCAL_HOST},[::1]`;

/** Docker CLI's name for the default context, which has no context-store entry. */
const DEFAULT_CONTEXT_NAME = "default";

/**
 * Docker CLI's config directory (`$DOCKER_CONFIG` or `~/.docker`), read
 * directly since this module only needs the on-disk config and context-store
 * files, not a full Docker client.
 */
function dockerConfigDir(): string {
  const override = process.env["DOCKER_CONFIG"];
  return override !== undefined && override.length > 0 ? override : join(homedir(), ".docker");
}

/**
 * Resolves the active Docker CLI context: `DOCKER_CONTEXT` env, else the
 * config file's `currentContext`, else `"default"`. Only called when
 * `DOCKER_HOST` is unset; {@link getHostname} handles that case separately.
 */
function currentDockerContextName(): string {
  const fromEnv = process.env["DOCKER_CONTEXT"];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const config = JSON.parse(readFileSync(join(dockerConfigDir(), "config.json"), "utf8")) as {
      currentContext?: unknown;
    };
    if (typeof config.currentContext === "string" && config.currentContext.length > 0) {
      return config.currentContext;
    }
  } catch {
    // Missing or malformed config.json falls back to the default context.
  }
  return DEFAULT_CONTEXT_NAME;
}

/**
 * Reads a non-default context's daemon endpoint from Docker CLI's context
 * store: `<configDir>/contexts/meta/<sha256hex(name)>/meta.json`'s
 * `Endpoints.docker.Host`. The `"default"` context has no store entry, so
 * it's never looked up here.
 */
function dockerContextEndpointHost(contextName: string): string | undefined {
  if (contextName === DEFAULT_CONTEXT_NAME) {
    return undefined;
  }
  try {
    const contextId = createHash("sha256").update(contextName).digest("hex");
    const metaPath = join(dockerConfigDir(), "contexts", "meta", contextId, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      readonly Endpoints?: { readonly docker?: { readonly Host?: unknown } };
    };
    const host = meta.Endpoints?.docker?.Host;
    return typeof host === "string" && host.length > 0 ? host : undefined;
  } catch {
    // Missing or malformed context store entry: treat as unresolvable.
    return undefined;
  }
}

/**
 * Extracts the bare host from a `tcp://host:port` daemon endpoint. Returns
 * `undefined` for a non-`tcp://` endpoint (e.g. `unix://`, `npipe://`) or an
 * unparseable one.
 */
function hostFromTcpEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "tcp:" || url.hostname.length === 0) {
      return undefined;
    }
    // WHATWG URL.hostname brackets IPv6 (`[::1]`); strip the brackets so the
    // returned host matches IPv4/named hosts' unbracketed form.
    const host = url.hostname;
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch {
    return undefined;
  }
}

/**
 * The platform's default Docker daemon socket, which the `"default"` context stands for.
 */
export function platformDefaultDockerHost(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";
}

/**
 * The daemon endpoint the `docker` CLI itself would dial, without spawning it: `DOCKER_HOST`, else
 * the active context's stored endpoint (`"default"` meaning the platform socket). `undefined` for
 * an unreadable non-default context, in which case direct-transport callers fall back to the CLI.
 */
export function resolveDockerDaemonEndpoint(): string | undefined {
  const dockerHost = process.env["DOCKER_HOST"];
  if (dockerHost !== undefined && dockerHost.length > 0) {
    return dockerHost;
  }
  const contextName = currentDockerContextName();
  if (contextName === DEFAULT_CONTEXT_NAME) {
    return platformDefaultDockerHost();
  }
  return dockerContextEndpointHost(contextName);
}

/**
 * Resolves the hostname used for local Supabase service connections:
 *
 * 1. `SUPABASE_SERVICES_HOSTNAME` env override, for dev containers or when the Docker daemon
 *    isn't reachable on the container's own loopback.
 * 2. The active daemon endpoint's host when it is `tcp://host:port`, resolved by
 *    {@link resolveDockerDaemonEndpoint} the same way the `docker`/`podman` binary resolves it, so
 *    a remote daemon is never inspected correctly while printing unusable `127.0.0.1` URLs.
 * 3. `127.0.0.1` otherwise (default unix-socket daemon, non-tcp endpoint, or unresolvable context).
 *
 * Shared by every command that connects to the local Supabase stack.
 */
export function getHostname(): string {
  const override = process.env["SUPABASE_SERVICES_HOSTNAME"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const endpoint = resolveDockerDaemonEndpoint();
  if (endpoint !== undefined) {
    const host = hostFromTcpEndpoint(endpoint);
    if (host !== undefined) {
      return host;
    }
  }
  return LOCAL_HOST;
}

/** Keeps Bun from proxying the CLI's loopback HTTP requests. */
export function configureLoopbackProxyBypass(env: NodeJS.ProcessEnv = process.env): void {
  const key = (env["no_proxy"]?.length ?? 0) > 0 ? "no_proxy" : "NO_PROXY";
  const current = env[key];
  env[key] = current ? `${current},${LOOPBACK_NO_PROXY}` : LOOPBACK_NO_PROXY;
}
