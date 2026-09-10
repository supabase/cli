import { Data, Effect, FileSystem } from "effect";
import { parse as parseYaml } from "yaml";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { apiUrl, dashboardUrl, isBuiltinProfileName, poolerHost, projectHost } from "./profile.ts";

/**
 * A profile that fails to load, checked before the workdir check and any other flag
 * validation or API call. Raised during every command's profile resolution.
 */
export class ProfileLoadError extends Data.TaggedError("ProfileLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Resolves a profile token to its endpoint set, or fails with the CLI's established error
 * text for each deterministic failure class (config-file-not-found, unsupported extension,
 * unreadable file, unknown keys, missing/malformed required fields) — checked before the
 * workdir check, the required-flag check, the mutex check, and any API request. A token that
 * case-insensitively matches a built-in profile name resolves directly; anything else is
 * read as a YAML config-file path.
 */
export interface LoadedProfile {
  readonly apiUrl: string;
  /**
   * The canonical built-in name or the file's required `name:` field. Credential resolution
   * keys the keyring account on this name.
   */
  readonly name: string;
  readonly projectHost: string;
  /**
   * Empty when absent, disabling the linked pooler MITM domain assertion (never falls back
   * to `supabase.com`).
   */
  readonly poolerHost: string;
  readonly dashboardUrl: string;
}

export function loadProfile(
  token: string,
  fs: FileSystem.FileSystem,
): Effect.Effect<LoadedProfile, ProfileLoadError> {
  return Effect.gen(function* () {
    // Built-in names are all ASCII lower-case, so case-insensitive matching is plain
    // lower-casing.
    const folded = token.toLowerCase();
    if (isBuiltinProfileName(folded)) {
      return {
        apiUrl: apiUrl(folded),
        name: folded,
        projectHost: projectHost(folded),
        poolerHost: poolerHost(folded),
        dashboardUrl: dashboardUrl(folded),
      };
    }

    // An empty token falls back to the established "no config file" search-path error.
    if (token === "") {
      return yield* failRead(`Config File "config" Not Found in "[]"`);
    }

    const ext = goFilepathExt(token);
    if (!VIPER_SUPPORTED_EXTS.has(ext)) {
      return yield* failRead(`Unsupported Config Type ${JSON.stringify(ext)}`);
    }

    const content = yield* fs
      .readFileString(token)
      .pipe(
        Effect.catch((error) =>
          failRead(
            error.reason._tag === "NotFound"
              ? `open ${token}: no such file or directory`
              : error.reason._tag === "PermissionDenied"
                ? `open ${token}: permission denied`
                : error.reason._tag === "BadResource"
                  ? `read ${token}: is a directory`
                  : error.message,
          ),
        ),
      );

    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch (cause) {
      return yield* failRead(`While parsing config: ${parseDetail(cause)}`);
    }
    if (parsed === null || parsed === undefined) {
      parsed = {};
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      // A non-mapping YAML document (e.g. a scalar or list) is rejected; detail text is
      // best-effort.
      return yield* failRead(
        `While parsing config: yaml: unmarshal errors:\n  cannot unmarshal into map[string]interface {}`,
      );
    }
    // Configuration keys are lowercased before decoding, so `API_URL:`/`Name:` behave like
    // their lowercase spellings, and unknown-key errors report the lowercased form. A
    // same-key case collision uses document order (last wins).
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      config[key.toLowerCase()] = value;
    }

    // Unknown keys abort decoding, reported sorted in a padded multi-line block.
    const invalidKeys = Object.keys(config)
      .filter((key) => !PROFILE_STRUCT_KEYS.has(key))
      .sort();
    if (invalidKeys.length > 0) {
      return yield* failDecode(`'utils.Profile' has invalid keys: ${invalidKeys.join(", ")}`);
    }

    // Weak scalar decoding + per-field tag validation, in struct field order.
    const decodeErrors: string[] = [];
    const validationErrors: string[] = [];
    const values = new Map<string, string>();
    for (const field of PROFILE_STRING_FIELDS) {
      const raw = config[field.key];
      const weak = weakString(raw);
      if (weak === undefined) {
        decodeErrors.push(
          `'${field.goName}' expected type 'string', got unconvertible type '${goTypeName(raw)}', value: '${goValueString(raw)}'`,
        );
        continue;
      }
      values.set(field.key, weak);
      if (weak === "") {
        if (field.required) {
          validationErrors.push(validatorLine(field.goName, "required"));
        }
        continue;
      }
      if (field.format !== undefined && !FORMAT_TAG_CHECKS[field.format](weak)) {
        validationErrors.push(validatorLine(field.goName, field.format));
      }
    }
    if (decodeErrors.length > 0) {
      return yield* failDecode(decodeErrors.join("\n"));
    }
    if (validationErrors.length > 0) {
      return yield* fail(padGoErrorBlock(`invalid profile: ${validationErrors.join("\n")}`));
    }

    // All required fields passed validation above; pooler_host stays "" when absent.
    return {
      apiUrl: values.get("api_url") ?? "",
      name: values.get("name") ?? "",
      projectHost: values.get("project_host") ?? "",
      poolerHost: values.get("pooler_host") ?? "",
      dashboardUrl: values.get("dashboard_url") ?? "",
    };
  });
}

const fail = (message: string) => Effect.fail(new ProfileLoadError({ message }));

const failRead = (detail: string) => fail(`failed to read profile: ${detail}`);

/** Aggregate decode-error template: multiple failing fields render as one block. */
const failDecode = (detail: string) =>
  fail(
    padGoErrorBlock(
      `failed to parse profile: decoding failed due to the following error(s):\n\n${detail}`,
    ),
  );

/** Recognized config file extensions, checked case-sensitively. */
const VIPER_SUPPORTED_EXTS: ReadonlySet<string> = new Set([
  "json",
  "toml",
  "yaml",
  "yml",
  "properties",
  "props",
  "prop",
  "hcl",
  "tfvars",
  "dotenv",
  "env",
  "ini",
]);

/**
 * Returns everything after the last `.` in the final path segment, including for dot-files
 * (`.yml` → `yml`), where Node's `path.extname` returns `""`.
 */
function goFilepathExt(token: string): string {
  for (let i = token.length - 1; i >= 0 && token[i] !== "/"; i--) {
    if (token[i] === ".") {
      return token.slice(i + 1);
    }
  }
  return "";
}

/** Every recognized profile config key. */
const PROFILE_STRUCT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "api_url",
  "dashboard_url",
  "docs_url",
  "project_host",
  "pooler_host",
  "client_id",
  "studio_image",
  "regions",
]);

type FormatTag = "http_url" | "hostname_rfc1123" | "uuid4";

interface ProfileStringField {
  readonly key: string;
  readonly goName: string;
  readonly required: boolean;
  readonly format?: FormatTag;
}

/**
 * Profile string fields in validation order, which determines the order of error lines.
 * `regions` (a slice) is exempt from weak string decoding and never validated.
 */
const PROFILE_STRING_FIELDS: ReadonlyArray<ProfileStringField> = [
  { key: "name", goName: "Name", required: true },
  { key: "api_url", goName: "APIURL", required: true, format: "http_url" },
  { key: "dashboard_url", goName: "DashboardURL", required: true, format: "http_url" },
  { key: "docs_url", goName: "DocsURL", required: false, format: "http_url" },
  { key: "project_host", goName: "ProjectHost", required: true, format: "hostname_rfc1123" },
  { key: "pooler_host", goName: "PoolerHost", required: false, format: "hostname_rfc1123" },
  { key: "client_id", goName: "AuthClientID", required: false, format: "uuid4" },
  { key: "studio_image", goName: "StudioImage", required: false },
];

function validatorLine(goName: string, tag: string): string {
  return `Key: 'Profile.${goName}' Error:Field validation for '${goName}' failed on the '${tag}' tag`;
}

/** RFC 1123 hostname pattern. */
const HOSTNAME_RFC1123 = /^([a-zA-Z0-9][a-zA-Z0-9-]{0,62})(\.[a-zA-Z0-9][a-zA-Z0-9-]{0,62})*?$/;

/** Lower-case-only UUIDv4 pattern. */
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const FORMAT_TAG_CHECKS: Record<FormatTag, (value: string) => boolean> = {
  http_url: (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (url.protocol === "http:" || url.protocol === "https:") && url.host.length > 0;
  },
  hostname_rfc1123: (value) => HOSTNAME_RFC1123.test(value),
  uuid4: (value) => UUID4.test(value),
};

/**
 * Weak string coercion: strings pass through, booleans become `"1"`/`"0"`, numbers are
 * stringified, and `null`/`undefined` decode to `""`. Arrays/objects are unconvertible
 * (`undefined`, a decode error).
 */
function weakString(value: unknown): string | undefined {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function goTypeName(value: unknown): string {
  if (Array.isArray(value)) return "[]interface {}";
  if (typeof value === "object" && value !== null) return "map[string]interface {}";
  return typeof value;
}

/** Best-effort rendering of an invalid field's value for the error message. */
function goValueString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(goValueString).join(" ")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}:${goValueString(entry)}`)
      .join(" ");
    return `map[${entries}]`;
  }
  return String(value);
}

/**
 * Pads every line (including blank ones) with trailing spaces to the longest line's width, to
 * match the CLI's established multi-line error rendering exactly.
 */
export function padGoErrorBlock(message: string): string {
  const lines = message.split("\n");
  const width = Math.max(...lines.map((line) => line.length));
  return lines.map((line) => line.padEnd(width)).join("\n");
}

function parseDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
