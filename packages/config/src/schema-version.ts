import { cliConfigSchemaKey, isObject } from "./config-document.ts";
import type { ConfigFormat } from "./config-format.ts";

export interface CliConfigSchemaDeclaration {
  readonly ref: string;
  /** `undefined` when the reference is not a recognized Supabase config schema URL. */
  readonly version: bigint | undefined;
}

export const SCHEMA_DIRECTIVE_LINE = /^#:schema[ \t]+(\S+)(?=\r?\n|$)/;

const VERSIONED_SCHEMA_URL = /^https:\/\/supabase\.com\/schemas\/config\/v([1-9]\d*)\.json$/;
const LEGACY_SCHEMA_URL = "https://supabase.com/docs/cli/config.schema.json";
const PACKAGE_SCHEMA_PATH = /node_modules[\\/]@supabase[\\/]config[\\/]schema\.json$/;

function versionOfSchemaRef(ref: string): bigint | undefined {
  if (ref === LEGACY_SCHEMA_URL || PACKAGE_SCHEMA_PATH.test(ref)) {
    return 1n;
  }
  const digits = VERSIONED_SCHEMA_URL.exec(ref)?.[1];
  return digits === undefined ? undefined : BigInt(digits);
}

function leadingTomlDirective(text: string): string | undefined {
  for (const line of text.replace(/^﻿/, "").split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.trim() === "") {
      continue;
    }
    if (!trimmed.startsWith("#")) {
      return undefined;
    }
    const match = SCHEMA_DIRECTIVE_LINE.exec(trimmed);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Reads the schema a config file declares: `$schema` in JSON/JSONC, a leading `#:schema` directive
 * (or a top-level `$schema` key) in TOML. Pass `document` as `undefined` before it has been parsed.
 */
export function readCliConfigSchemaDeclaration(
  text: string,
  format: ConfigFormat,
  document: unknown,
): CliConfigSchemaDeclaration | undefined {
  const directive = format === "toml" ? leadingTomlDirective(text) : undefined;
  const key = isObject(document) ? document[cliConfigSchemaKey] : undefined;
  const ref = directive ?? (typeof key === "string" ? key : undefined);
  return ref === undefined ? undefined : { ref, version: versionOfSchemaRef(ref) };
}
