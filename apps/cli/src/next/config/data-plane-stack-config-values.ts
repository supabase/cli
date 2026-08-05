import type { ProjectEnvironment } from "@supabase/config";
import { Data } from "effect";

export class DataPlaneStackConfigError extends Data.TaggedError("DataPlaneStackConfigError")<{
  readonly detail: string;
  readonly suggestion: string;
  readonly paths: ReadonlyArray<string>;
}> {}

export function invalidDataPlaneConfig(
  path: string,
  suggestion: string,
): DataPlaneStackConfigError {
  return new DataPlaneStackConfigError({
    detail: `Invalid local stack configuration at ${path}.`,
    suggestion,
    paths: [path],
  });
}

export function environmentOverride(
  name: string,
  configured: string | undefined,
  environment: ProjectEnvironment | null,
): string | undefined {
  const override = environment?.values[name];
  const value = override === undefined || override.length === 0 ? configured : override;
  if (value === undefined) return undefined;

  const match = /^env\(([^)]+)\)$/.exec(value);
  const referencedName = match?.[1];
  if (referencedName === undefined) return value;
  const referenced = environment?.values[referencedName];
  return referenced === undefined || referenced.length === 0 ? value : referenced;
}

/** Mirrors Go's direct os.LookupEnv calls, where a present empty value is significant. */
export function rawEnvironmentOverride(
  name: string,
  fallback: string | undefined,
  environment: ProjectEnvironment | null,
): string | undefined {
  return environment?.values[name] ?? fallback;
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

export function resolveBooleanOverride(input: {
  readonly environment: ProjectEnvironment | null;
  readonly envName: string;
  readonly configured: boolean;
  readonly path: string;
}): boolean {
  const override = environmentOverride(input.envName, undefined, input.environment);
  if (override === undefined) return input.configured;
  const value = GO_BOOLEAN_VALUES[override];
  if (value === undefined) {
    throw invalidDataPlaneConfig(
      input.path,
      "Use a Go-compatible boolean such as true, false, 1, or 0.",
    );
  }
  return value;
}

function parseBaseZeroUint(value: string): bigint | undefined {
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
    return BigInt(literal);
  } catch {
    return undefined;
  }
}

export function resolveUintOverride(input: {
  readonly environment: ProjectEnvironment | null;
  readonly envName: string;
  readonly configured: number;
  readonly path: string;
}): number {
  const override = environmentOverride(input.envName, undefined, input.environment);
  if (override === undefined) return input.configured;
  const parsed = parseBaseZeroUint(override);
  if (parsed === undefined || parsed > 4_294_967_295n) {
    throw invalidDataPlaneConfig(input.path, "Use a non-negative 32-bit integer.");
  }
  return Number(parsed);
}

export function resolveEnumOverride<const Value extends string>(input: {
  readonly environment: ProjectEnvironment | null;
  readonly envName: string;
  readonly configured: string;
  readonly path: string;
  readonly values: ReadonlyArray<Value>;
}): Value {
  const resolved = environmentOverride(input.envName, input.configured, input.environment);
  const value = input.values.find((candidate) => candidate === resolved);
  if (value === undefined) {
    throw invalidDataPlaneConfig(input.path, `Use one of: ${input.values.join(", ")}.`);
  }
  return value;
}
