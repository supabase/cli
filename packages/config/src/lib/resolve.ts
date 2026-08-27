import { Redacted } from "effect";
import { isEnvReference, ENV_CAPTURE_REGEX, ENV_CAPTURE_REGEX_STRICT } from "./env.ts";
import { isSecretPath } from "./secret-paths.ts";
import type { CliProjectEnvironment } from "../project.ts";

type ResolvedString = string | Redacted.Redacted<string>;

export type ResolvedCliConfigValue<T> = T extends string
  ? ResolvedString
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<ResolvedCliConfigValue<U>>
    : T extends Array<infer U>
      ? Array<ResolvedCliConfigValue<U>>
      : T extends Record<string, infer V>
        ? { readonly [K in keyof T]: ResolvedCliConfigValue<T[K]> } & {
            readonly [key: string]: ResolvedCliConfigValue<V>;
          }
        : T extends object
          ? { readonly [K in keyof T]: ResolvedCliConfigValue<T[K]> }
          : T;

export function toPathSegments(path: string): ReadonlyArray<string> {
  if (path === "") {
    return [];
  }

  return path.split(".").filter((segment) => segment.length > 0);
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
  // `./env.ts`. Without this, a present-but-empty `env(...)` secret (e.g.
  // `edge_runtime.secrets.FOO = "env(EMPTY)"`) resolves to `""` here, gets
  // redacted by `redactValue` as a real value instead of skipped as an
  // unresolved literal, and `secrets set` uploads a blank secret Go would
  // never send.
  if (resolved === undefined || resolved === "") {
    return value;
  }

  return resolved;
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

/**
 * Shared by the plain sync resolvers below and `../project.ts`'s
 * Effect-typed `resolveCliConfigValue`/`resolveCliConfigSubtree` (which wrap
 * this in `Effect.sync` and additionally accept the internal-only
 * `goViperCompat` option).
 *
 * Declared as an overload pair rather than a single generic signature: the
 * body's `unknown`-typed implementation signature is what lets
 * `interpolateValue`/`redactValue` (both genuinely `unknown -> unknown`,
 * since the recursion branches on runtime shape, not on `T`) flow straight
 * through to the return without an `as` cast — callers only ever see the
 * generic overload above, which resolves `T` from the argument and returns
 * `ResolvedCliConfigValue<T>` directly.
 */
export function resolveCliConfigValueAtPath<T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  path: ReadonlyArray<string>,
  goViperCompat: boolean,
): ResolvedCliConfigValue<T>;
export function resolveCliConfigValueAtPath(
  value: unknown,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  path: ReadonlyArray<string>,
  goViperCompat: boolean,
): unknown {
  const interpolated = interpolateValue(value, cliProjectEnv.values, goViperCompat);
  return redactValue(interpolated, path, goViperCompat);
}

/**
 * Plain synchronous counterpart of `../project.ts`'s Effect-typed
 * `resolveCliConfigValue`, exported from `.` under the same name — `./effect`
 * re-exports the Effect-typed variant explicitly, which wins over this one's
 * star re-export through `./index.ts` (see `../effect.ts`'s doc comment).
 *
 * `cliProjectEnv` only needs `.values` (`Pick<CliProjectEnvironment, "values">`) —
 * a caller that already has a project's env values but not the full
 * `CliProjectEnvironment` shape (e.g. `paths`/`loadedPaths`/`sources`) can pass
 * `{ values }` directly instead of threading through the whole loaded object.
 *
 * Has no options parameter: this package's one resolver knob (`goViperCompat`)
 * is internal-only — see `InternalResolveCliConfigOptions` in `../project.ts`,
 * exported from `@supabase/config/internal`. Adding a public knob later is a
 * non-breaking, additive change.
 */
export function resolveCliConfigValue<T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  configPath: string,
): ResolvedCliConfigValue<T> {
  return resolveCliConfigValueAtPath(value, cliProjectEnv, toPathSegments(configPath), false);
}

/** See {@link resolveCliConfigValue}'s doc comment for why `cliProjectEnv` only needs `.values`. */
export function resolveCliConfigSubtree<T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  pathPrefix: string,
): ResolvedCliConfigValue<T> {
  return resolveCliConfigValueAtPath(value, cliProjectEnv, toPathSegments(pathPrefix), false);
}
