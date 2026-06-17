import { connect as connectSocket } from "node:net";
import { DEFAULT_VERSIONS, dockerImageForService } from "@supabase/stack/effect";
import { Effect } from "effect";
import {
  LegacyInvalidGenTypesDatabaseUrlError,
  LegacyInvalidGenTypesDurationError,
} from "./types.errors.ts";
import caProd2021 from "./templates/prod-ca-2021.ts";
import caProd2025 from "./templates/prod-ca-2025.ts";
import caStaging2021 from "./templates/staging-ca-2021.ts";

const LEGACY_DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const INVALID_PROJECT_ID = /[^a-zA-Z0-9_.-]+/g;
const MAX_PROJECT_ID_LENGTH = 40;

const DURATION_UNITS_TO_MILLIS = {
  ns: 1 / 1_000_000,
  us: 1 / 1_000,
  "\u00b5s": 1 / 1_000,
  "\u03bcs": 1 / 1_000,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const;

const DURATION_PART_PATTERN = new RegExp(
  String.raw`([+-]?(?:\d+\.?\d*|\.\d+))(ns|us|\u00b5s|\u03bcs|ms|s|m|h)`,
  "g",
);

export interface LegacyGenTypesDbTarget {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly networkMode: "host" | string;
}

function truncateText(text: string, maxLength: number) {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeProjectId(src: string) {
  const sanitized = src.replaceAll(INVALID_PROJECT_ID, "_").replace(/^[_.-]+/, "");
  return truncateText(sanitized, MAX_PROJECT_ID_LENGTH);
}

function localDockerId(name: string, projectId: string) {
  return `supabase_${name}_${sanitizeProjectId(projectId)}`;
}

export function defaultSchemas(extraSchemas: ReadonlyArray<string> = []) {
  return [...new Set(["public", ...extraSchemas])];
}

export function parseQueryTimeoutSeconds(
  raw: string,
): Effect.Effect<number, LegacyInvalidGenTypesDurationError> {
  return Effect.gen(function* () {
    const input = raw.trim();
    if (input.length === 0) {
      return yield* Effect.fail(
        new LegacyInvalidGenTypesDurationError({
          message: `invalid duration ${JSON.stringify(raw)}`,
        }),
      );
    }

    let totalMillis = 0;
    let consumed = 0;
    DURATION_PART_PATTERN.lastIndex = 0;
    for (const match of input.matchAll(DURATION_PART_PATTERN)) {
      const [token, rawNumber, rawUnit] = match;
      if (
        token === undefined ||
        rawNumber === undefined ||
        rawUnit === undefined ||
        match.index === undefined
      ) {
        continue;
      }
      if (match.index !== consumed) {
        return yield* Effect.fail(
          new LegacyInvalidGenTypesDurationError({
            message: `invalid duration ${JSON.stringify(raw)}`,
          }),
        );
      }
      const amount = Number.parseFloat(rawNumber);
      const unitMillis = DURATION_UNITS_TO_MILLIS[rawUnit as keyof typeof DURATION_UNITS_TO_MILLIS];
      totalMillis += amount * unitMillis;
      consumed += token.length;
    }

    if (!Number.isFinite(totalMillis) || consumed !== input.length || totalMillis < 0) {
      return yield* Effect.fail(
        new LegacyInvalidGenTypesDurationError({
          message: `invalid duration ${JSON.stringify(raw)}`,
        }),
      );
    }

    return Math.round(totalMillis / 1_000);
  });
}

/**
 * The default generated docker network name for a local project (Go's `utils.NetId`
 * fallback, `GetId("network")`). The `--network-id` override is applied at the docker
 * invocation site, mirroring Go's `DockerStart`.
 */
export function localNetworkId(projectId: string) {
  return localDockerId("network", projectId);
}

export function localDbContainerId(projectId: string) {
  return localDockerId("db", projectId);
}

export function localDbPassword() {
  return process.env["SUPABASE_DB_PASSWORD"] ?? "postgres";
}

export function parseDatabaseUrl(
  url: string,
): Effect.Effect<LegacyGenTypesDbTarget, LegacyInvalidGenTypesDatabaseUrlError> {
  return Effect.try({
    try: () => {
      const parsed = new URL(url);
      if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
        throw new Error(`unsupported scheme ${parsed.protocol}`);
      }
      if (parsed.pathname.length === 0 || parsed.pathname === "/") {
        parsed.pathname = "/postgres";
      }
      return {
        url: parsed.toString(),
        host: parsed.hostname,
        port: parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 5432,
        networkMode: "host" as const,
      } satisfies LegacyGenTypesDbTarget;
    },
    catch: (cause) =>
      new LegacyInvalidGenTypesDatabaseUrlError({
        message: `failed to parse connection string: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

export function buildPostgresUrl(input: {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}) {
  const host =
    input.host.includes(":") && !input.host.startsWith("[") ? `[${input.host}]` : input.host;
  return (
    `postgresql://${encodeURIComponent(input.user)}:${encodeURIComponent(input.password)}` +
    `@${host}:${input.port}/${encodeURIComponent(input.database)}` +
    `?connect_timeout=${LEGACY_DEFAULT_CONNECT_TIMEOUT_SECONDS}`
  );
}

export function resolvePgmetaImage(versionOverride?: string) {
  const version =
    versionOverride && versionOverride.trim().length > 0
      ? versionOverride.trim().replace(/^v/i, "")
      : DEFAULT_VERSIONS.pgmeta;
  const registry = process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]?.toLowerCase();
  if (registry === "docker.io") {
    return `supabase/postgres-meta:v${version}`;
  }
  return dockerImageForService("pgmeta", version);
}

export function legacyRootCaBundle() {
  return `${caStaging2021}${caProd2021}${caProd2025}`;
}

export function probeTlsSupport(host: string, port: number): Effect.Effect<boolean, Error> {
  return Effect.tryPromise({
    try: () =>
      new Promise<boolean>((resolve, reject) => {
        let settled = false;
        const socket = connectSocket({ host, port });

        const finish = (result: boolean | Error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (result instanceof Error) {
            reject(result);
            return;
          }
          resolve(result);
        };

        socket.setTimeout(5_000);
        socket.once("connect", () => {
          const packet = Buffer.alloc(8);
          packet.writeInt32BE(8, 0);
          packet.writeInt32BE(80877103, 4);
          socket.write(packet);
        });
        socket.once("data", (chunk) => {
          const response = Number(chunk.at(0) ?? 0);
          if (response === 0x53) {
            finish(true);
            return;
          }
          if (response === 0x4e) {
            finish(false);
            return;
          }
          finish(new Error(`unexpected SSL probe response: ${String.fromCharCode(response ?? 0)}`));
        });
        socket.once("timeout", () => finish(new Error("i/o timeout")));
        socket.once("error", (error) => finish(error));
        socket.once("close", () => {
          if (!settled) {
            finish(new Error("connection closed during SSL probe"));
          }
        });
      }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}
