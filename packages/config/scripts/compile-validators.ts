import { Ajv } from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { CliConfigSchema } from "../src/base.ts";
import { buildSchemaIndex } from "../src/cli-config-schema-index.ts";
import {
  CLI_CONFIG_AJV_OPTIONS,
  toCliConfigRuntimeSchemas,
} from "../src/cli-config-runtime-schema.ts";

/** Compiles the runtime schemas to a dependency-free ESM module exporting the `root` and `remotes` validators and the `schemaIndex`. */
export function compileCliConfigValidators(): string {
  const { root, remotes } = toCliConfigRuntimeSchemas();
  const ajv = new Ajv({ ...CLI_CONFIG_AJV_OPTIONS, code: { source: true, esm: true } });
  ajv.addSchema(root, "root");
  ajv.addSchema(remotes, "remotes");
  const validators = standaloneCode(ajv, { root: "root", remotes: "remotes" });
  const source = `${validators}\nexport const schemaIndex = ${JSON.stringify(buildSchemaIndex(CliConfigSchema.ast))};\n`;
  if (/\b(?:require|import)\s*\(|^\s*import\s/m.test(source)) {
    throw new Error("compiled config validators must not import or require anything");
  }
  return source;
}
