import { Effect, FileSystem, Redacted } from "effect";
import { ProjectConfigSchema } from "./base.ts";
import { ProjectEnvParseError } from "./errors.ts";
import { ENV_CAPTURE_REGEX, ENV_CAPTURE_REGEX_STRICT, isEnvReference } from "./lib/env.ts";
import { findProjectPaths, type ProjectPaths } from "./paths.ts";

const dotEnvLinePattern =
  /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/;

export interface ProjectEnvironment {
  readonly paths: ProjectPaths;
  readonly values: Readonly<Record<string, string>>;
  readonly loadedPaths: ReadonlyArray<string>;
  readonly sources: Readonly<Record<string, "ambient" | ".env" | ".env.local">>;
}

type ResolvedString = string | Redacted.Redacted<string>;

export type ResolvedProjectValue<T> = T extends string
  ? ResolvedString
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<ResolvedProjectValue<U>>
    : T extends Array<infer U>
      ? Array<ResolvedProjectValue<U>>
      : T extends Record<string, infer V>
        ? { readonly [K in keyof T]: ResolvedProjectValue<T[K]> } & {
            readonly [key: string]: ResolvedProjectValue<V>;
          }
        : T extends object
          ? { readonly [K in keyof T]: ResolvedProjectValue<T[K]> }
          : T;

function normalizeAmbientEnv(
  baseEnv: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (value !== undefined) {
      values[key] = value;
    }
  }

  return values;
}

// Detects a line of the form `KEY=<quote>...` (or `KEY: <quote>...`) whose
// quoted value does NOT close on that same physical line — the start of a
// godotenv-style multiline quoted value (e.g. a PEM block). Returns the quote
// character and the index of the opening quote within `line`, or `null` if
// the line doesn't open an unterminated quote (either no quote at all, or one
// that already closes on this line).
const dotEnvValueOpenerPattern = /^\s*(?:export\s+)?[\w.-]+(?:\s*=\s*?|:\s+?)(['"`])/;

function findUnescapedQuoteIndex(text: string, quote: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === quote && text[i - 1] !== "\\") {
      return i;
    }
  }
  return -1;
}

function detectOpenQuoteStart(line: string): { quote: string; openIndex: number } | null {
  const openerMatch = dotEnvValueOpenerPattern.exec(line);
  if (openerMatch === null) {
    return null;
  }
  const quote = openerMatch[1];
  if (quote === undefined) {
    return null;
  }
  const openIndex = openerMatch[0].length - 1;
  if (findUnescapedQuoteIndex(line, quote, openIndex + 1) !== -1) {
    // Already closes on this same line — this isn't the multiline case, so
    // whatever made the outer match fail is a genuine parse error.
    return null;
  }
  return { quote, openIndex };
}

function parseDotEnvValue(rawValue: string): string {
  let value = rawValue.trim();
  const maybeQuote = value[0];

  value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");

  if (maybeQuote === '"') {
    value = value.replace(/\\n/g, "\n");
    value = value.replace(/\\r/g, "\r");
  }

  return value;
}

function parseDotEnv(
  path: string,
  contents: string,
): Effect.Effect<Record<string, string>, ProjectEnvParseError> {
  return Effect.gen(function* () {
    const values: Record<string, string> = {};
    const lines = contents.replace(/\r\n?/g, "\n").split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) {
        continue;
      }
      const trimmed = line.trim();

      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }

      let candidate = line;
      let consumedThrough = index;

      // Check for an unterminated quote BEFORE attempting the single-line
      // match: `dotEnvLinePattern`'s value alternatives fall back to an
      // unquoted match (`[^#\r\n]+`) when none of the quoted alternatives
      // close on this line, which would otherwise "succeed" with a truncated,
      // still-quote-prefixed value instead of signaling a multiline value —
      // masking the real bug rather than triggering accumulation. This is a
      // godotenv-style quoted value spanning multiple physical lines (e.g. a
      // PEM block); Go's `loadNestedEnv` parses this fine (`godotenv@v1.5.1`'s
      // cursor-based scanner never splits into lines up front; see
      // `legacy-dotenv.ts` for the Go-compatible reference implementation used
      // elsewhere in this repo). Accumulate subsequent lines until the opened
      // quote closes (or EOF), then match the same per-line pattern against
      // the joined multiline chunk — its quoted-value alternatives use
      // negated character classes (`[^"]` etc.), which already match embedded
      // newlines once given the full span.
      const opener = detectOpenQuoteStart(line);
      if (opener !== null) {
        for (let next = index + 1; next < lines.length; next += 1) {
          const nextLine = lines[next];
          if (nextLine === undefined) {
            continue;
          }
          candidate += "\n" + nextLine;
          consumedThrough = next;
          if (findUnescapedQuoteIndex(candidate, opener.quote, opener.openIndex + 1) !== -1) {
            break;
          }
        }
      }

      const match = dotEnvLinePattern.exec(candidate);

      if (match === null) {
        return yield* Effect.fail(new ProjectEnvParseError({ path, line: index + 1 }));
      }

      const key = match[1];
      const rawValue = match[2] ?? "";

      if (key === undefined) {
        return yield* Effect.fail(new ProjectEnvParseError({ path, line: index + 1 }));
      }

      values[key] = parseDotEnvValue(rawValue);
      index = consumedThrough;
    }

    return values;
  });
}

function applySource(
  target: Record<string, string>,
  sources: Record<string, "ambient" | ".env" | ".env.local">,
  values: Readonly<Record<string, string>>,
  source: "ambient" | ".env" | ".env.local",
) {
  for (const [key, value] of Object.entries(values)) {
    target[key] = value;
    sources[key] = source;
  }
}

export interface LoadProjectEnvironmentOptions {
  readonly cwd: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** See {@link FindProjectPathsOptions.search}. */
  readonly search?: boolean;
  /**
   * Skip reading/parsing `paths.envLocalPath` (`supabase/.env.local`)
   * entirely. Mirrors Go's `loadDefaultEnv` (`apps/cli-go/pkg/config/
   * config.go:1243-1250`), which omits `.env.local` from its candidate
   * filename list whenever `SUPABASE_ENV=test` — so a malformed or
   * intentionally non-test `.env.local` is invisible to Go in that mode and
   * must not fail config loading here either. Defaults to `false` so
   * existing callers that don't have a `SUPABASE_ENV` gate of their own
   * (`next/`, `secrets set`) are unaffected.
   */
  readonly skipEnvLocal?: boolean;
}

export interface ResolveProjectOptions {
  /**
   * Opt into Go/viper-parity `env()` matching (case-agnostic
   * `^env\((.*)\)$`). Defaults to `false`, which uses the pre-PR-#5765 strict
   * SCREAMING_SNAKE_CASE matcher (`ENV_CAPTURE_REGEX_STRICT`). Only the
   * Go-parity legacy shell sets this to `true`.
   */
  readonly goViperCompat?: boolean;
}

export const loadProjectEnvironment = Effect.fnUntraced(function* (
  options: LoadProjectEnvironmentOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* findProjectPaths(options.cwd, { search: options.search });

  if (paths === null) {
    return null;
  }

  const values: Record<string, string> = {};
  const sources: Record<string, "ambient" | ".env" | ".env.local"> = {};
  const loadedPaths: string[] = [];

  if (yield* fs.exists(paths.envPath)) {
    const contents = yield* fs.readFileString(paths.envPath);
    const parsed = yield* parseDotEnv(paths.envPath, contents);
    applySource(values, sources, parsed, ".env");
    loadedPaths.push(paths.envPath);
  }

  if (!options.skipEnvLocal && (yield* fs.exists(paths.envLocalPath))) {
    const contents = yield* fs.readFileString(paths.envLocalPath);
    const parsed = yield* parseDotEnv(paths.envLocalPath, contents);
    applySource(values, sources, parsed, ".env.local");
    loadedPaths.push(paths.envLocalPath);
  }

  applySource(values, sources, normalizeAmbientEnv(options.baseEnv), "ambient");

  return {
    paths,
    values,
    loadedPaths,
    sources,
  } satisfies ProjectEnvironment;
});

function collectSecretPathPatterns(
  node: {
    readonly annotations?: Record<string, unknown>;
    readonly propertySignatures?: ReadonlyArray<{
      readonly name: string;
      readonly type: unknown;
    }>;
    readonly indexSignatures?: ReadonlyArray<{
      readonly type: unknown;
    }>;
  },
  prefix: ReadonlyArray<string> = [],
): Array<ReadonlyArray<string>> {
  const patterns: Array<ReadonlyArray<string>> = [];

  if (node.annotations?.["x-secret"] === true) {
    patterns.push(prefix);
  }

  for (const property of node.propertySignatures ?? []) {
    patterns.push(
      ...collectSecretPathPatterns(
        property.type as Parameters<typeof collectSecretPathPatterns>[0],
        [...prefix, property.name],
      ),
    );
  }

  for (const indexSignature of node.indexSignatures ?? []) {
    patterns.push(
      ...collectSecretPathPatterns(
        indexSignature.type as Parameters<typeof collectSecretPathPatterns>[0],
        [...prefix, "*"],
      ),
    );
  }

  return patterns;
}

const secretPathPatterns = collectSecretPathPatterns(ProjectConfigSchema.ast as never);

function matchesPathPattern(
  pattern: ReadonlyArray<string>,
  actual: ReadonlyArray<string>,
): boolean {
  if (pattern.length !== actual.length) {
    return false;
  }

  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== "*" && pattern[index] !== actual[index]) {
      return false;
    }
  }

  return true;
}

function isSecretPath(path: ReadonlyArray<string>): boolean {
  return secretPathPatterns.some((pattern) => matchesPathPattern(pattern, path));
}

function interpolateLeafValue(
  value: string,
  env: Readonly<Record<string, string>>,
  goViperCompat: boolean,
): string {
  const match = (goViperCompat ? ENV_CAPTURE_REGEX : ENV_CAPTURE_REGEX_STRICT).exec(value);
  const envName = match?.[1];

  if (envName === undefined) {
    return value;
  }

  const resolved = env[envName];
  // Preserve the literal `env(VAR)` verbatim when VAR is unset OR present but
  // empty (e.g. a dotenv `KEY=` line). Matches Go's `LoadEnvHook`
  // (`apps/cli-go/pkg/config/decode_hooks.go:19-24`: `len(env) > 0`), which
  // only substitutes a non-empty value — same gate as `substituteEnvLeaf` in
  // `lib/env.ts`. Without this, a present-but-empty `env(...)` secret (e.g.
  // `edge_runtime.secrets.FOO = "env(EMPTY)"`) resolves to `""` here, gets
  // redacted by `redactValue` as a real value instead of skipped as an
  // unresolved literal, and `secrets set` uploads a blank secret Go would
  // never send.
  if (resolved === undefined || resolved === "") {
    return value;
  }

  return resolved;
}

function toPathSegments(path: string): ReadonlyArray<string> {
  if (path === "") {
    return [];
  }

  return path.split(".").filter((segment) => segment.length > 0);
}

function interpolateValue(
  value: unknown,
  env: Readonly<Record<string, string>>,
  goViperCompat: boolean,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, env, goViperCompat));
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      result[key] = interpolateValue(child, env, goViperCompat);
    }

    return result;
  }

  if (typeof value === "string") {
    return interpolateLeafValue(value, env, goViperCompat);
  }

  return value;
}

function redactValue(value: unknown, path: ReadonlyArray<string>, goViperCompat: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, [...path, String(index)], goViperCompat));
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      result[key] = redactValue(child, [...path, key], goViperCompat);
    }

    return result;
  }

  if (typeof value === "string" && isSecretPath(path) && !isEnvReference(value, goViperCompat)) {
    return Redacted.make(value, { label: path.join(".") });
  }

  return value;
}

function resolveProjectValueAtPath(
  value: unknown,
  projectEnv: ProjectEnvironment,
  path: ReadonlyArray<string>,
  goViperCompat: boolean,
): unknown {
  const interpolated = interpolateValue(value, projectEnv.values, goViperCompat);
  return redactValue(interpolated, path, goViperCompat);
}

export function resolveProjectValue<T>(
  value: T,
  projectEnv: ProjectEnvironment,
  configPath: string,
  options?: ResolveProjectOptions,
): Effect.Effect<ResolvedProjectValue<T>> {
  return Effect.sync(
    () =>
      resolveProjectValueAtPath(
        value,
        projectEnv,
        toPathSegments(configPath),
        options?.goViperCompat ?? false,
      ) as ResolvedProjectValue<T>,
  );
}

export function resolveProjectSubtree<T>(
  value: T,
  projectEnv: ProjectEnvironment,
  pathPrefix: string,
  options?: ResolveProjectOptions,
): Effect.Effect<ResolvedProjectValue<T>> {
  return Effect.sync(
    () =>
      resolveProjectValueAtPath(
        value,
        projectEnv,
        toPathSegments(pathPrefix),
        options?.goViperCompat ?? false,
      ) as ResolvedProjectValue<T>,
  );
}
