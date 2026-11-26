import { cliConfigSchemaKey, isObject } from "./lib/document-value.ts";
import { setOwnProperty } from "./lib/own-property.ts";
import { writeProviderSignupPreferredKeys } from "./lib/provider-signup.ts";
import { subtractValue } from "./sparse-core.ts";

const defaultEncodedFunctionConfig = {
  enabled: true,
  verify_jwt: true,
  import_map: "",
  entrypoint: "",
  static_files: [],
  env: {},
};

function stripFunctionRecordDefaults(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }

  const functionsValue = value.functions;
  if (!isObject(functionsValue)) {
    return value;
  }

  const functions: Record<string, unknown> = {};
  for (const [name, functionConfig] of Object.entries(functionsValue)) {
    setOwnProperty(
      functions,
      name,
      subtractValue(functionConfig, defaultEncodedFunctionConfig) ?? {},
    );
  }

  return { ...value, functions };
}

/** The sparse document written to disk: `encoded` minus function-record and schema defaults. */
export function toSparseConfigDocument(
  encoded: unknown,
  encodedDefaults: unknown,
  schemaRef: string | undefined,
): Record<string, unknown> {
  const stripped = subtractValue(stripFunctionRecordDefaults(encoded), encodedDefaults);
  const minimal = writeProviderSignupPreferredKeys(isObject(stripped) ? stripped : {});
  return schemaRef === undefined ? minimal : { [cliConfigSchemaKey]: schemaRef, ...minimal };
}
