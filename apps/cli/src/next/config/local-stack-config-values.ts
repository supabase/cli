import type { LoadedProjectConfig, ProjectEnvironment } from "@supabase/config";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedValue(
  root: Readonly<Record<string, unknown>> | undefined,
  path: ReadonlyArray<string>,
): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Mirrors Viper's `SUPABASE` prefix and dot-to-underscore key replacer. */
function legacyEnvironmentName(path: string): string {
  return `SUPABASE_${path.replaceAll(".", "_").toUpperCase()}`;
}

/**
 * Whether Go's selected remote supplied this path with `viper.Set`. The
 * fallback supports manually constructed LoadedProjectConfig fixtures created
 * before path-only remote provenance was added to `@supabase/config`.
 */
function remoteDefinesConfigPath(loaded: LoadedProjectConfig | null, path: string): boolean {
  if (loaded?.appliedRemote === undefined) return false;
  if (loaded.remoteOverridePaths?.includes(path) === true) return true;
  const remotes = isRecord(loaded.document?.remotes) ? loaded.document.remotes : undefined;
  const remote = remotes?.[loaded.appliedRemote];
  return isRecord(remote) && nestedValue(remote, path.split(".")) !== undefined;
}

export function resolveEnvironmentReference(
  value: string,
  environment: ProjectEnvironment | null,
): string {
  const match = /^env\((.*)\)$/.exec(value);
  const referencedName = match?.[1];
  if (referencedName === undefined) return value;
  const referenced = environment?.values[referencedName];
  return referenced === undefined || referenced.length === 0 ? value : referenced;
}

/**
 * Returns an effective legacy environment binding, excluding empty values and
 * paths owned by an applied remote. No caller needs to retain the value merely
 * to answer presence; use {@link hasEffectiveEnvironmentOverride} for that.
 */
export function effectiveEnvironmentOverride(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly environment: ProjectEnvironment | null;
  readonly path: string;
}): string | undefined {
  if (remoteDefinesConfigPath(input.loaded, input.path)) return undefined;
  const value = input.environment?.values[legacyEnvironmentName(input.path)];
  if (value === undefined || value.length === 0) return undefined;
  return resolveEnvironmentReference(value, input.environment);
}

export function hasEffectiveEnvironmentOverride(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly environment: ProjectEnvironment | null;
  readonly path: string;
}): boolean {
  return effectiveEnvironmentOverride(input) !== undefined;
}

export function effectiveString(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly environment: ProjectEnvironment | null;
  readonly path: string;
  readonly configured: string;
}): string {
  return resolveEnvironmentReference(
    effectiveEnvironmentOverride(input) ?? input.configured,
    input.environment,
  );
}

export function effectiveStringList(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly environment: ProjectEnvironment | null;
  readonly path: string;
  readonly configured: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const override = effectiveEnvironmentOverride(input);
  return override === undefined ? input.configured : override.split(",");
}

export function parseGoUint32(value: string): number | undefined {
  if (value.length === 0 || value.startsWith("+") || value.startsWith("-")) return undefined;

  let literal: string | undefined;
  if (/^0[bB](_?[01])+$/.test(value)) {
    literal = `0b${value.slice(2).replaceAll("_", "")}`;
  } else if (/^0[oO](_?[0-7])+$/.test(value)) {
    literal = `0o${value.slice(2).replaceAll("_", "")}`;
  } else if (/^0[xX](_?[0-9a-fA-F])+$/.test(value)) {
    literal = `0x${value.slice(2).replaceAll("_", "")}`;
  } else if (value.startsWith("0") && value.length > 1) {
    literal = /^[0-7](_?[0-7])*$/.test(value) ? `0o${value.replaceAll("_", "")}` : undefined;
  } else {
    literal = /^[0-9](_?[0-9])*$/.test(value) ? value.replaceAll("_", "") : undefined;
  }
  if (literal === undefined) return undefined;
  try {
    const parsed = BigInt(literal);
    return parsed <= 4_294_967_295n ? Number(parsed) : undefined;
  } catch {
    return undefined;
  }
}

const GO_BOOLEAN_VALUES: Readonly<Record<string, boolean>> = {
  "1": true,
  t: true,
  T: true,
  TRUE: true,
  true: true,
  True: true,
  "0": false,
  f: false,
  F: false,
  FALSE: false,
  false: false,
  False: false,
};

export function parseGoBoolean(value: string): boolean | undefined {
  return GO_BOOLEAN_VALUES[value];
}
