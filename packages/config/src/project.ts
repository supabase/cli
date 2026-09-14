import { Effect, FileSystem } from "effect";
import { CliProjectEnvParseError } from "./errors.ts";
import {
  resolveCliConfigValueAtPath,
  toPathSegments,
  type ResolvedCliConfigValue,
} from "./lib/resolve.ts";
import { findCliProjectPaths, type CliProjectPaths } from "./paths.ts";

const dotEnvLinePattern =
  /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/;

export interface CliProjectEnvironment {
  readonly paths: CliProjectPaths;
  readonly values: Readonly<Record<string, string>>;
  readonly loadedPaths: ReadonlyArray<string>;
  readonly sources: Readonly<Record<string, "ambient" | ".env" | ".env.local">>;
}

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

// Matches a `KEY=<quote>` (or `KEY: <quote>`) opener, used to detect the start of a
// multiline quoted value (e.g. a PEM block) that doesn't close on the same line.
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
): Effect.Effect<Record<string, string>, CliProjectEnvParseError> {
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

      // Detect an unterminated quote before the single-line match: the pattern's unquoted
      // fallback (`[^#\r\n]+`) would otherwise "succeed" with a truncated value instead of
      // signaling a multiline value (e.g. a PEM block spanning several lines). Accumulate
      // subsequent lines until the opened quote closes, then match the joined chunk.
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
        return yield* Effect.fail(new CliProjectEnvParseError({ path, line: index + 1 }));
      }

      const key = match[1];
      const rawValue = match[2] ?? "";

      if (key === undefined) {
        return yield* Effect.fail(new CliProjectEnvParseError({ path, line: index + 1 }));
      }

      values[key] = parseDotEnvValue(rawValue);
      index = consumedThrough;
    }

    return values;
  });
}

/** Parse one explicit dotenv file without applying ambient or project-local precedence. */
export const loadDotEnvFile = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) {
    return {};
  }
  return yield* parseDotEnv(path, yield* fs.readFileString(path));
});

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

export interface LoadCliProjectEnvironmentOptions {
  readonly cwd: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** See {@link FindCliProjectPathsOptions.search}. */
  readonly search?: boolean;
  /**
   * Skip reading/parsing `paths.envLocalPath` (`supabase/.env.local`) entirely, so a
   * malformed or intentionally non-test `.env.local` cannot fail config loading. Defaults
   * to `false`.
   */
  readonly skipEnvLocal?: boolean;
}

/** Not covered by semver — exported from `@supabase/config/internal` only. */
export interface InternalResolveCliConfigOptions {
  /**
   * Opt into viper-style case-agnostic `env()` matching (`^env\((.*)\)$`). Defaults to
   * `false`, which requires SCREAMING_SNAKE_CASE.
   */
  readonly goViperCompat?: boolean;
}

export const loadCliProjectEnvironment = Effect.fnUntraced(function* (
  options: LoadCliProjectEnvironmentOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* findCliProjectPaths(options.cwd, { search: options.search });

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
  } satisfies CliProjectEnvironment;
});

/**
 * Effect-typed counterpart of the plain sync `resolveCliConfigValue` in
 * `./lib/resolve.ts`, additionally accepting the internal-only `goViperCompat` option.
 *
 * Accepts `Pick<CliProjectEnvironment, "values">` so a caller with only a project's env
 * values, not the full loaded object, can pass `{ values }` directly.
 */
export function resolveCliConfigValue<T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  configPath: string,
  options?: InternalResolveCliConfigOptions,
): Effect.Effect<ResolvedCliConfigValue<T>> {
  return Effect.sync(() =>
    resolveCliConfigValueAtPath(
      value,
      cliProjectEnv,
      toPathSegments(configPath),
      options?.goViperCompat ?? false,
    ),
  );
}

/** See {@link resolveCliConfigValue}'s doc comment for why `cliProjectEnv` only needs `.values`. */
export function resolveCliConfigSubtree<T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  pathPrefix: string,
  options?: InternalResolveCliConfigOptions,
): Effect.Effect<ResolvedCliConfigValue<T>> {
  return Effect.sync(() =>
    resolveCliConfigValueAtPath(
      value,
      cliProjectEnv,
      toPathSegments(pathPrefix),
      options?.goViperCompat ?? false,
    ),
  );
}
