import { Effect, FileSystem, Redacted } from "effect";
import { ProjectConfigSchema } from "./base.ts";
import { ProjectEnvParseError } from "./errors.ts";
import { ENV_CAPTURE_REGEX, isEnvReference } from "./lib/env.ts";
import { findProjectPaths, type ProjectPaths } from "./paths.ts";

const envReferencePattern = ENV_CAPTURE_REGEX;
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

      const match = dotEnvLinePattern.exec(line);

      if (match === null) {
        return yield* Effect.fail(new ProjectEnvParseError({ path, line: index + 1 }));
      }

      const key = match[1];
      const rawValue = match[2] ?? "";

      if (key === undefined) {
        return yield* Effect.fail(new ProjectEnvParseError({ path, line: index + 1 }));
      }

      values[key] = parseDotEnvValue(rawValue);
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
}

export const loadProjectEnvironment = Effect.fnUntraced(function* (
  options: LoadProjectEnvironmentOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* findProjectPaths(options.cwd);

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

  if (yield* fs.exists(paths.envLocalPath)) {
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

function interpolateLeafValue(value: string, env: Readonly<Record<string, string>>): string {
  const match = envReferencePattern.exec(value);
  const envName = match?.[1];

  if (envName === undefined) {
    return value;
  }

  // Preserve the literal `env(VAR)` verbatim when VAR is unset. Matches Go's
  // `apps/cli-go/pkg/config/decode_hooks.go:14-21` (LoadEnvHook).
  if (!Object.prototype.hasOwnProperty.call(env, envName)) {
    return value;
  }

  return env[envName] ?? value;
}

function toPathSegments(path: string): ReadonlyArray<string> {
  if (path === "") {
    return [];
  }

  return path.split(".").filter((segment) => segment.length > 0);
}

function interpolateValue(value: unknown, env: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, env));
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      result[key] = interpolateValue(child, env);
    }

    return result;
  }

  if (typeof value === "string") {
    return interpolateLeafValue(value, env);
  }

  return value;
}

function redactValue(value: unknown, path: ReadonlyArray<string> = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, [...path, String(index)]));
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      result[key] = redactValue(child, [...path, key]);
    }

    return result;
  }

  if (typeof value === "string" && isSecretPath(path) && !isEnvReference(value)) {
    return Redacted.make(value, { label: path.join(".") });
  }

  return value;
}

function resolveProjectValueAtPath(
  value: unknown,
  projectEnv: ProjectEnvironment,
  path: ReadonlyArray<string>,
): unknown {
  const interpolated = interpolateValue(value, projectEnv.values);
  return redactValue(interpolated, path);
}

export function resolveProjectValue<T>(
  value: T,
  projectEnv: ProjectEnvironment,
  configPath: string,
): Effect.Effect<ResolvedProjectValue<T>> {
  return Effect.sync(
    () =>
      resolveProjectValueAtPath(
        value,
        projectEnv,
        toPathSegments(configPath),
      ) as ResolvedProjectValue<T>,
  );
}

export function resolveProjectSubtree<T>(
  value: T,
  projectEnv: ProjectEnvironment,
  pathPrefix: string,
): Effect.Effect<ResolvedProjectValue<T>> {
  return Effect.sync(
    () =>
      resolveProjectValueAtPath(
        value,
        projectEnv,
        toPathSegments(pathPrefix),
      ) as ResolvedProjectValue<T>,
  );
}
