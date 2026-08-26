import { Data, Effect, FileSystem } from "effect";
import { parse as parseYaml } from "yaml";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import {
  legacyApiUrl,
  legacyDashboardUrl,
  legacyIsBuiltinProfileName,
  legacyPoolerHost,
  legacyProjectHost,
} from "./legacy-profile.ts";

// `LoadProfile`, run from the root
// `PersistentPreRunE` immediately BEFORE
// `ChangeWorkDir` — so a profile Go cannot load aborts before the workdir
// check, `ValidateRequiredFlags`, `ValidateFlagGroups`, and `RunE`, with no
// API call ever made. Raised by `legacyCliSettingsLayer` on every command's
// profile resolution (supabase/cli#6091) and by the sso pflag reconciliation
// (PR #5974 round 7). Message byte-matches Go for the deterministic failure
// classes.
export class LegacyProfileLoadError extends Data.TaggedError("LegacyProfileLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Emulates `LoadProfile`
 * for a resolved profile token, returning the profile's endpoint set
 * (`LegacyLoadedProfile`) or failing exactly where — and, for the
 * deterministic classes, byte-for-byte how — the Go binary fails. Go runs
 * this from the root `PersistentPreRunE` BEFORE
 * `ChangeWorkDir`, so a load failure aborts the command before the workdir
 * check, the required-flag check, the mutex check, and any API request.
 *
 * Resolution, mirroring Go (binary-verified, PR #5974 review round 7):
 *
 * 1. A token that case-insensitively (`strings.EqualFold`) matches a built-in
 * profile name resolves to that profile's API URL.
 * 2. Anything else is a config-file path handed to viper (`SetConfigFile` +
 * `ReadInConfig`):
 * - viper ignores an empty path and falls into search mode, which fails
 * with `Config File "config" Not Found in "[]"`;
 * - a path whose extension (Go `filepath.Ext` semantics: last `.` in the
 * final path segment, ANY position — `.yml` alone is extension `yml`)
 * is not in viper's `SupportedExts` fails with
 * `Unsupported Config Type "<ext>"`;
 * - an unreadable path fails with the OS error
 * (`open <path>: no such file or directory`, `read <path>: is a
 * directory`, …).
 * 3. The content is parsed and decoded into `Profile` struct with
 * `UnmarshalExact` — unknown keys fail with mapstructure's
 * `'utils.Profile' has invalid keys: <sorted keys>` block. Viper decodes
 * with `WeaklyTypedInput`, so scalar YAML values (numbers, booleans) are
 * stringified, not rejected (binary-verified: `api_url: 123` reaches the
 * validator and fails the `http_url` tag, not decoding).
 * 4. `validator.StructCtx` checks the struct tags in field order and fails
 * with one `Key: 'Profile.<Field>' Error:Field validation for '<Field>'
 * failed on the '<tag>' tag` line per failing field.
 *
 * Multi-line Go errors are rendered with every line padded to the longest
 * line's width (lipgloss block layout, binary-verified) — the padding is baked
 * into the message so stderr matches the Go binary byte-for-byte. One caveat:
 * the shared error normalizer (`normalize-error.ts` `readString`) trims the
 * message ends, so the FINAL line's trailing padding is stripped before
 * rendering; interior lines (including blank ones) keep it. Binary-diffed:
 * only that final-line whitespace differs, on inputs where both CLIs already
 * exit 1 with zero requests.
 *
 * Accepted micro-divergences (all fail-closed: both sides exit 1 with no API
 * request; only the detail text can differ):
 * - YAML parse-failure detail text comes from the JS `yaml` package, not
 * go-yaml (the `failed to read profile: While parsing config: ` prefix
 * matches).
 * - Non-YAML/JSON `SupportedExts` contents (`.toml`, `.env`, `.ini`, …) are
 * parsed as YAML rather than with their native viper codecs.
 * - Array/object values on string fields render the offending value
 * approximately (`%v` formatting emulated, not guaranteed).
 * - The `http_url`/`hostname_rfc1123`/`uuid4` tag checks approximate
 * go-playground/validator with WHATWG `URL` parsing and the validator's own
 * published regexes.
 */
export interface LegacyLoadedProfile {
  readonly apiUrl: string;
  /**
   * `CurrentProfile.Name` — the canonical built-in name (EqualFold
   * match) or the file's required `name:` field. Credential resolution keys
   * the keyring account on this name, so the
   * reconciled request must read the reconciled profile's token, not the
   * config layer's (review r3684153345).
   */
  readonly name: string;
  /** `Profile.ProjectHost` (`required`). */
  readonly projectHost: string;
  /**
   * `Profile.PoolerHost` (`omitempty`): "" when absent, disabling the
   * linked pooler MITM domain assertion — never falls back to `supabase.com`.
   */
  readonly poolerHost: string;
  /** `Profile.DashboardURL` (`required`). */
  readonly dashboardUrl: string;
}

export function legacyLoadProfile(
  token: string,
  fs: FileSystem.FileSystem,
): Effect.Effect<LegacyLoadedProfile, LegacyProfileLoadError> {
  return Effect.gen(function* () {
    // Go: `strings.EqualFold(p.Name, prof)` — the built-in names are all
    // ASCII lower-case, so folding is plain lower-casing here.
    const folded = token.toLowerCase();
    if (legacyIsBuiltinProfileName(folded)) {
      return {
        apiUrl: legacyApiUrl(folded),
        name: folded,
        projectHost: legacyProjectHost(folded),
        poolerHost: legacyPoolerHost(folded),
        dashboardUrl: legacyDashboardUrl(folded),
      };
    }

    // viper `SetConfigFile("")` is a no-op, so `ReadInConfig` falls back to
    // its (empty) search-path mode — byte-exact per the Go binary.
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
      // Go: yaml unmarshals into `map[string]interface{}` and rejects
      // non-mapping documents. Detail text is best-effort (see doc comment).
      return yield* failRead(
        `While parsing config: yaml: unmarshal errors:\n  cannot unmarshal into map[string]interface {}`,
      );
    }
    // Viper lowercases configuration keys before decoding
    // (`insensitiviseMap`), so `API_URL:` / `Name:` decode exactly like
    // their lowercase spellings, and UnmarshalExact reports unknown keys
    // LOWERCASED (probed: `BOGUS_KEY` → `bogus_key`; review r3689635101).
    // A same-key case collision is nondeterministic in Go (map iteration
    // order) — document order (last wins) is used here.
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      config[key.toLowerCase()] = value;
    }

    // `UnmarshalExact` — unknown keys abort decoding. mapstructure reports
    // them sorted, in a padded multi-line block (binary-verified).
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
      return yield* fail(legacyPadGoErrorBlock(`invalid profile: ${validationErrors.join("\n")}`));
    }

    // All `required` fields passed validation above; `pooler_host` stays ""
    // when absent (omitempty).
    return {
      apiUrl: values.get("api_url") ?? "",
      name: values.get("name") ?? "",
      projectHost: values.get("project_host") ?? "",
      poolerHost: values.get("pooler_host") ?? "",
      dashboardUrl: values.get("dashboard_url") ?? "",
    };
  });
}

const fail = (message: string) => Effect.fail(new LegacyProfileLoadError({ message }));

const failRead = (detail: string) => fail(`failed to read profile: ${detail}`);

/** mapstructure's aggregate error template (`Decode` → `joinedError`). */
const failDecode = (detail: string) =>
  fail(
    legacyPadGoErrorBlock(
      `failed to parse profile: decoding failed due to the following error(s):\n\n${detail}`,
    ),
  );

/** viper v1.21 `SupportedExts` (checked case-sensitively, like viper). */
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
 * Go `filepath.Ext` minus the leading dot: scans the final path segment from
 * the end and returns everything after the last `.` — including for
 * dot-files (`.yml` → `yml`), where Node's `path.extname` returns `""`.
 */
function goFilepathExt(token: string): string {
  for (let i = token.length - 1; i >= 0 && token[i] !== "/"; i--) {
    if (token[i] === ".") {
      return token.slice(i + 1);
    }
  }
  return "";
}

/** Every mapstructure key of `Profile` struct. */
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
 * `Profile` string fields in struct order with
 * their `validate:` tags — the order determines the order of the validator's
 * error lines. `regions` (a slice, no validate tag) is exempt from weak
 * string decoding and never validated, matching Go.
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

/** validator v10's `hostnameRegexRFC1123`, copied verbatim. */
const HOSTNAME_RFC1123 = /^([a-zA-Z0-9][a-zA-Z0-9-]{0,62})(\.[a-zA-Z0-9][a-zA-Z0-9-]{0,62})*?$/;

/** validator v10's `uuid4Regex`, copied verbatim (lower-case only). */
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
 * mapstructure `WeaklyTypedInput` string decoding: strings pass through,
 * bools become `"1"`/`"0"`, numbers are stringified, `null` decodes to the
 * zero value. Arrays/objects are unconvertible → `undefined` (decode error).
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

/** Approximates `%v` for the YAML values reachable here. */
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
 * Go renders these multi-line errors through a lipgloss block, which pads
 * every line (including blank ones) with trailing spaces to the longest
 * line's width (binary-verified via `od`). Baked into the message so the
 * final stderr bytes match the Go binary exactly.
 */
export function legacyPadGoErrorBlock(message: string): string {
  const lines = message.split("\n");
  const width = Math.max(...lines.map((line) => line.length));
  return lines.map((line) => line.padEnd(width)).join("\n");
}

function parseDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
