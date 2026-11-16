import type { CliConfigValueOrigin } from "@supabase/config";
import { ENV_CAPTURE_REGEX } from "@supabase/config/internal";
import { Result } from "effect";

import {
  cloneDocumentRecord,
  getDocumentValue,
  isDocumentRecord,
  sameDocumentValue,
  setDocumentValue,
} from "./cli-config-document.ts";
import {
  lookupCliConfigEnv,
  pickCliConfigKey,
  type CliConfigKeyOrigin,
  type CliConfigSources,
  type CliConfigValue,
} from "./cli-config-key.ts";
import {
  cliConfigFamilyKey,
  cliConfigRegistry,
  staticCliConfigFamilyNames,
  type AnyCliConfigKey,
} from "./cli-config-keys.ts";
import type { CliConfigValueError } from "./cli-config.errors.ts";

export interface CliConfigRegistryPassResult {
  readonly declared: Record<string, unknown>;
  readonly materialized: Record<string, unknown>;
  readonly file: Record<string, unknown>;
  readonly origins: ReadonlyMap<string, CliConfigKeyOrigin>;
  readonly failures: ReadonlyArray<CliConfigValueError>;
  readonly resolved: {
    readonly declared: ReadonlyArray<ReadonlyArray<string>>;
    readonly materialized: ReadonlyArray<ReadonlyArray<string>>;
    readonly file: ReadonlyArray<ReadonlyArray<string>>;
  };
  readonly envOrigins: {
    readonly declared: ReadonlyArray<CliConfigValueOrigin>;
    readonly materialized: ReadonlyArray<CliConfigValueOrigin>;
    readonly file: ReadonlyArray<CliConfigValueOrigin>;
  };
}

/** A config-tier value the schema would reject as written: `"TRUE"`, `0` for a bool, `"a,b"` for a list. */
const needsCoercion = (key: AnyCliConfigKey, written: unknown, raw: unknown): boolean =>
  key.codec.kind !== "string" && !sameDocumentValue(written, raw);

/** An `env(NAME)` value, or a list holding one. */
const isEnvReference = (raw: unknown): boolean =>
  Array.isArray(raw)
    ? raw.some(isEnvReference)
    : typeof raw === "string" && ENV_CAPTURE_REGEX.test(raw);

const declaredWrite = (
  key: AnyCliConfigKey,
  picked: CliConfigValue<unknown>,
  raw: unknown,
): unknown => {
  const written = key.toDocument(picked.unnormalized ?? picked.value);
  switch (picked.origin.tier) {
    case "flag":
    case "shell":
    case "projectEnv":
      return written;
    case "config":
      return key.secret === true || isEnvReference(raw) || needsCoercion(key, written, raw)
        ? written
        : undefined;
    case "default":
      return undefined;
  }
};

const materializedWrite = (
  key: AnyCliConfigKey,
  picked: CliConfigValue<unknown>,
  declared: unknown,
): unknown => {
  if (picked.origin.tier === "default") {
    return key.materializeDefault === true || key.normalize !== undefined
      ? key.toDocument(picked.value)
      : undefined;
  }
  return key.normalize === undefined ? declared : key.toDocument(picked.value);
};

/** The coerced config-tier value a file-only view needs, or `undefined` when the file value decodes as written. */
const fileWrite = (key: AnyCliConfigKey, sources: CliConfigSources): unknown => {
  const raw = sources.config(key.segments)?.value;
  if (raw === undefined || key.secret === true) return undefined;
  const picked = pickCliConfigKey(key, sources, { configOnly: true });
  if (Result.isFailure(picked) || picked.success.origin.tier !== "config") return undefined;
  const written = key.toDocument(picked.success.unnormalized ?? picked.success.value);
  return isEnvReference(raw) || needsCoercion(key, written, raw) ? written : undefined;
};

/** The origin the decode would record for a resolved `env()` reference, which a pre-resolved path no longer gets. */
const envOrigin = (
  key: AnyCliConfigKey,
  raw: unknown,
  lookup: (name: string) => string | undefined,
): CliConfigValueOrigin | undefined => {
  const names = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    const name = typeof item === "string" ? ENV_CAPTURE_REGEX.exec(item)?.[1] : undefined;
    if (name !== undefined && lookup(name) !== undefined) names.add(name);
  }
  return names.size === 0
    ? undefined
    : { path: [...key.segments], source: "environment", envVariables: [...names] };
};

/** The entry names a family has in `document`, static ones first. */
export const cliConfigFamilyNames = (document: unknown, id: string): ReadonlyArray<string> => {
  const family = cliConfigRegistry.families.find((candidate) => candidate.id === id);
  if (family === undefined) return [];
  const table = getDocumentValue(document, family.prefix.split("."));
  return [
    ...new Set([
      ...staticCliConfigFamilyNames(family),
      ...(isDocumentRecord(table) ? Object.keys(table) : []),
    ]),
  ];
};

/** Every registry key the document can carry, with one key per family entry it declares. */
export const enumerateCliConfigKeys = (
  document: Record<string, unknown>,
): ReadonlyMap<string, AnyCliConfigKey> => {
  const enumerated = new Map<string, AnyCliConfigKey>(
    cliConfigRegistry.keys
      .filter((key) => key.document !== false)
      .map((key): [string, AnyCliConfigKey] => [key.path, key]),
  );
  for (const family of cliConfigRegistry.families) {
    for (const entry of cliConfigFamilyNames(document, family.id)) {
      for (const field of family.fields) {
        const key = cliConfigFamilyKey(family, entry, field.name);
        if (key !== undefined) enumerated.set(key.path, key);
      }
    }
  }
  return enumerated;
};

/** Picks every registry key and writes the declared, materialized and file views; `configOnly` applies the config-file tier alone. */
export const runCliConfigRegistryPass = (
  document: Record<string, unknown>,
  sources: CliConfigSources,
  options: { readonly configOnly?: boolean } = {},
): CliConfigRegistryPassResult => {
  const configOnly = options.configOnly === true;
  const lookupEnv = (name: string) => lookupCliConfigEnv(sources, name);
  const declaredDraft = cloneDocumentRecord(document);
  const materializedDraft = cloneDocumentRecord(declaredDraft);
  const fileDraft = cloneDocumentRecord(document);
  const origins = new Map<string, CliConfigKeyOrigin>();
  const failures: Array<CliConfigValueError> = [];
  const resolved = {
    declared: [] as Array<ReadonlyArray<string>>,
    materialized: [] as Array<ReadonlyArray<string>>,
    file: [] as Array<ReadonlyArray<string>>,
  };
  const envOrigins = {
    declared: [] as Array<CliConfigValueOrigin>,
    materialized: [] as Array<CliConfigValueOrigin>,
    file: [] as Array<CliConfigValueOrigin>,
  };
  for (const key of enumerateCliConfigKeys(document).values()) {
    const raw = sources.config(key.segments)?.value;
    const configOrigin = configOnly ? undefined : envOrigin(key, raw, lookupEnv);
    const fileValue = fileWrite(key, sources);
    if (fileValue !== undefined) {
      setDocumentValue(fileDraft, key.segments, fileValue);
      resolved.file.push(key.segments);
      if (configOrigin !== undefined) envOrigins.file.push(configOrigin);
    }
    const picked = pickCliConfigKey(key, sources, configOnly ? { configOnly: true } : {});
    if (Result.isFailure(picked)) {
      failures.push(picked.failure);
      continue;
    }
    origins.set(key.path, picked.success.origin);
    const fromConfig = picked.success.origin.tier === "config" ? configOrigin : undefined;
    const declared = declaredWrite(key, picked.success, raw);
    if (declared !== undefined) {
      setDocumentValue(declaredDraft, key.segments, declared);
      resolved.declared.push(key.segments);
      if (fromConfig !== undefined) envOrigins.declared.push(fromConfig);
    }
    const materialized = materializedWrite(key, picked.success, declared);
    if (materialized !== undefined) {
      setDocumentValue(materializedDraft, key.segments, materialized);
      resolved.materialized.push(key.segments);
      if (fromConfig !== undefined) envOrigins.materialized.push(fromConfig);
    }
  }
  return {
    declared: declaredDraft,
    materialized: materializedDraft,
    file: fileDraft,
    origins,
    failures,
    resolved,
    envOrigins,
  };
};
