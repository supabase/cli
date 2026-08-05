import type { LoadedProjectConfig, ProjectEnvironment } from "@supabase/config";
import { Data } from "effect";
import {
  effectiveEnvironmentOverride,
  parseGoBoolean,
  parseGoUint32,
  resolveEnvironmentReference,
} from "./local-stack-config-values.ts";

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
  path: string,
  configured: string | undefined,
  environment: ProjectEnvironment | null,
  loaded: LoadedProjectConfig | null,
): string | undefined {
  const value = effectiveEnvironmentOverride({ loaded, environment, path }) ?? configured;
  return value === undefined ? undefined : resolveEnvironmentReference(value, environment);
}

/** Mirrors Go's direct os.LookupEnv calls, where a present empty value is significant. */
export function rawEnvironmentOverride(
  name: string,
  fallback: string | undefined,
  environment: ProjectEnvironment | null,
): string | undefined {
  return environment?.values[name] ?? fallback;
}

export function resolveBooleanOverride(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly environment: ProjectEnvironment | null;
  readonly configured: boolean;
  readonly path: string;
}): boolean {
  const override = effectiveEnvironmentOverride(input);
  if (override === undefined) return input.configured;
  const value = parseGoBoolean(override);
  if (value === undefined) {
    throw invalidDataPlaneConfig(
      input.path,
      "Use a Go-compatible boolean such as true, false, 1, or 0.",
    );
  }
  return value;
}

export function resolveUintOverride(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly environment: ProjectEnvironment | null;
  readonly configured: number;
  readonly path: string;
}): number {
  const override = effectiveEnvironmentOverride(input);
  if (override === undefined) return input.configured;
  const parsed = parseGoUint32(override);
  if (parsed === undefined) {
    throw invalidDataPlaneConfig(input.path, "Use a non-negative 32-bit integer.");
  }
  return parsed;
}

export function resolveEnumOverride<const Value extends string>(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly environment: ProjectEnvironment | null;
  readonly configured: string;
  readonly path: string;
  readonly values: ReadonlyArray<Value>;
}): Value {
  const resolved = environmentOverride(
    input.path,
    input.configured,
    input.environment,
    input.loaded,
  );
  const value = input.values.find((candidate) => candidate === resolved);
  if (value === undefined) {
    throw invalidDataPlaneConfig(input.path, `Use one of: ${input.values.join(", ")}.`);
  }
  return value;
}
