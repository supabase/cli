import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCAL_HOST = "127.0.0.1";

/** Docker CLI's reserved "no context store entry" name (`docker/cli` `cli/command/cli.go`'s `DefaultContextName`). */
const DEFAULT_CONTEXT_NAME = "default";

/**
 * Docker CLI's config directory: `$DOCKER_CONFIG` or `~/.docker`
 * (`docker/cli` `cliconfig.Dir()`), read from here rather than
 * `client.Client`'s own resolution since this module never spawns a real
 * Docker client — it only needs the same two on-disk files that resolution
 * reads.
 */
function dockerConfigDir(): string {
  const override = process.env["DOCKER_CONFIG"];
  return override !== undefined && override.length > 0 ? override : join(homedir(), ".docker");
}

/**
 * Go's `cli.CurrentContext()` name resolution (`docker/cli`
 * `cli/command/cli.go`'s `resolveContextName`): `DOCKER_CONTEXT` env, else the
 * config file's `currentContext`, else `"default"`. Only reached when
 * `DOCKER_HOST` is unset — `resolveContextName` itself forces `"default"`
 * when `DOCKER_HOST`/`--host` is set, which {@link legacyGetHostname} below
 * already handles as its own, earlier branch.
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
    // Missing/malformed config.json → the default context, same as Go's own
    // silent fallback when it can't load the config file here.
  }
  return DEFAULT_CONTEXT_NAME;
}

/**
 * Reads a non-default context's daemon endpoint from Docker CLI's context
 * store: `<configDir>/contexts/meta/<sha256hex(name)>/meta.json`'s
 * `Endpoints.docker.Host` (`docker/cli` `cli/context/store/metadatastore.go`).
 * The `"default"` context has no store entry (it's Go's synthetic
 * always-available context, resolved without a client, see
 * `cli.Initialize`), so it's never looked up here — matching the earlier
 * `"default"` short-circuit in {@link currentDockerContextName}'s caller.
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
    // Missing/malformed context store entry → treat as unresolvable, same as
    // Go silently falling back to the loopback default below.
    return undefined;
  }
}

/**
 * Extracts the bare host from a `tcp://host:port` daemon endpoint, mirroring
 * Go's `client.ParseHostURL` + `net.SplitHostPort` (`misc.go:307`). Returns
 * `undefined` for a non-`tcp://` endpoint (e.g. `unix://`, `npipe://`) or an
 * unparseable one, in which case the caller falls back to the loopback
 * default, matching Go's `net.SplitHostPort` failure/non-TCP handling.
 */
function hostFromTcpEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "tcp:" || url.hostname.length === 0) {
      return undefined;
    }
    // WHATWG `URL.hostname` returns an IPv6 host bracketed (`[::1]`), but Go's
    // `net.SplitHostPort` (`misc.go:307`) returns the bare host (`::1`). Strip a
    // single surrounding bracket pair so local-stack probes dial/compare the
    // same host Go does; IPv4 and named hosts are returned unchanged.
    const host = url.hostname;
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the hostname used for local Supabase service connections, mirroring
 * Go's `utils.GetHostname` (`apps/cli-go/internal/utils/misc.go:298-311`):
 *
 * 1. `SUPABASE_SERVICES_HOSTNAME` env override — set in dev containers or when
 *    the Docker daemon is not reachable on the container's own loopback.
 * 2. The Docker daemon host when `DOCKER_HOST` is a `tcp://host:port` endpoint
 *    (Go's `Docker.DaemonHost()` + `client.ParseHostURL` + `net.SplitHostPort`).
 * 3. Otherwise, the ACTIVE DOCKER CONTEXT's daemon endpoint, when it's a
 *    `tcp://` one — Go's `Docker.DaemonHost()` comes from a client built via
 *    `command.NewDockerCli()` + `cli.Initialize()` (`apps/cli-go/internal/
 *    utils/docker.go:41-54`), whose endpoint resolution walks `DOCKER_HOST` ->
 *    `DOCKER_CONTEXT` -> the config file's `currentContext` -> the context
 *    store (`docker/cli` `cli/command/cli.go`'s `getDockerEndPoint`/
 *    `resolveContextName`) — not just `DOCKER_HOST`. The `docker`/`podman`
 *    binary this module's callers shell out to for `ps`/`inspect` already
 *    resolves the same active context itself, so without this step `status`
 *    could correctly inspect a remote daemon while printing unusable
 *    `127.0.0.1` API/DB/Studio URLs for it.
 * 4. `127.0.0.1` otherwise (the default unix-socket daemon, or an
 *    unresolvable/malformed context).
 *
 * Shared across legacy commands that connect to the local stack (`gen types`,
 * `test db`, `status`, `stop`, and later `db reset` / `db dump`).
 */
export function legacyGetHostname(): string {
  const override = process.env["SUPABASE_SERVICES_HOSTNAME"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const dockerHost = process.env["DOCKER_HOST"];
  if (dockerHost !== undefined && dockerHost.length > 0) {
    return hostFromTcpEndpoint(dockerHost) ?? LOCAL_HOST;
  }
  const contextEndpoint = dockerContextEndpointHost(currentDockerContextName());
  if (contextEndpoint !== undefined) {
    const host = hostFromTcpEndpoint(contextEndpoint);
    if (host !== undefined) {
      return host;
    }
  }
  return LOCAL_HOST;
}
