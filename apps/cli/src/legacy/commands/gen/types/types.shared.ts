import { Effect } from "effect";
import { dockerfileServiceImage } from "../../../../shared/services/dockerfile-images.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import {
  LegacyInvalidGenTypesDatabaseUrlError,
  LegacyInvalidGenTypesDurationError,
} from "./types.errors.ts";
import caProd2021 from "./templates/prod-ca-2021.ts";
import caProd2025 from "./templates/prod-ca-2025.ts";
import caStaging2021 from "./templates/staging-ca-2021.ts";

// Local Docker resource ids are hoisted to `legacy/shared` so the declarative seam
// can derive the same `supabase_db_<id>` name when checking the local stack.
export { localDbContainerId, localNetworkId } from "../../../shared/legacy-docker-ids.ts";

const LEGACY_DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

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
  const defaultImage = dockerfileServiceImage("pgmeta");
  if (versionOverride === undefined || versionOverride.trim().length === 0) {
    return legacyGetRegistryImageUrl(defaultImage);
  }
  return legacyGetRegistryImageUrl(
    replaceImageTag(defaultImage, `v${versionOverride.trim().replace(/^v/i, "")}`),
  );
}

export function legacyRootCaBundle() {
  return `${caStaging2021}${caProd2021}${caProd2025}`;
}

function replaceImageTag(image: string, tag: string): string {
  const tagSeparator = image.lastIndexOf(":");
  if (tagSeparator === -1) {
    return image;
  }
  return `${image.slice(0, tagSeparator + 1)}${tag}`;
}
