import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import type { PersistedStackState } from "./StackState.ts";
import { Effect } from "effect";
import { StackStateInvalidError } from "../public/Errors.ts";

/** A plain object in the persisted, materialized settings document. */
export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns one capability's persisted settings without applying defaults. */
export const settingsFor = (state: PersistedStackState, capability: CapabilityName): unknown =>
  state.definition?.capabilities[capability].settings;

/** Resolves a persisted secret slot to the value supplied to a workload. */
export const secret = (state: PersistedStackState, slot: string): string =>
  state.secrets[slot]?.value ?? "";

/** Converts a materialized setting leaf into the string form expected by workloads. */
export const settingValue = (state: PersistedStackState, value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map((entry) => settingValue(state, entry)).join(",");
  if (isRecord(value) && typeof value.slot === "string" && Object.keys(value).length === 1)
    return secret(state, value.slot);
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- dynamic persisted settings are stringified for workload env values
  return JSON.stringify(value) ?? "";
};

/** Flattens nested materialized settings into environment-style keys. */
export const flattenSettings = (
  state: PersistedStackState,
  value: unknown,
  prefix: string,
  out: Record<string, string>,
): void => {
  if (value === null || value === undefined) return;
  if (isRecord(value) && typeof value.slot === "string" && Object.keys(value).length === 1) {
    out[prefix] = secret(state, value.slot);
    return;
  }
  if (Array.isArray(value)) {
    out[prefix] = value.map((entry) => settingValue(state, entry)).join(",");
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
      flattenSettings(
        state,
        entry,
        prefix.length === 0 ? normalized : `${prefix}_${normalized}`,
        out,
      );
    }
    return;
  }
  out[prefix] = settingValue(state, value);
};

/** Reads a dotted path from one capability's materialized settings. */
export const valueAt = (
  state: PersistedStackState,
  capability: CapabilityName,
  path: string,
): string => {
  let current: unknown = settingsFor(state, capability);
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return "";
    current = current[segment];
  }
  return settingValue(state, current);
};

/** Ensures every materialized secret slot is present before runtime mutation. */
export const validateMaterializedSecrets = (
  state: PersistedStackState,
  capability?: CapabilityName,
): Effect.Effect<void, StackStateInvalidError> => {
  const visit = (value: unknown, path: string): StackStateInvalidError | undefined => {
    if (isRecord(value) && typeof value.slot === "string" && Object.keys(value).length === 1) {
      return state.secrets[value.slot] === undefined
        ? new StackStateInvalidError({
            message: `Missing materialized secret slot ${value.slot} at ${path}`,
            slot: value.slot,
          })
        : undefined;
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        const failure = visit(entry, `${path}[${index}]`);
        if (failure !== undefined) return failure;
      }
    } else if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        const failure = visit(entry, path.length === 0 ? key : `${path}.${key}`);
        if (failure !== undefined) return failure;
      }
    }
    return undefined;
  };
  const names = capability === undefined ? CAPABILITY_NAMES : [capability];
  for (const name of names) {
    const settings = state.definition?.capabilities[name]?.settings;
    const failure = visit(settings, `${name}.settings`);
    if (failure !== undefined) return Effect.fail(failure);
  }
  return Effect.void;
};
