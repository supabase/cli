import { readFile } from "node:fs/promises";
import { makeCliConfigPromiseIo } from "./promise-io.ts";

async function loadPublishedSchema(): Promise<object> {
  for (const location of ["./schema.json", "../dist/schema.json"]) {
    try {
      return JSON.parse(await readFile(new URL(location, import.meta.url), "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  throw new Error("@supabase/config: dist/schema.json is missing; run the package build first.");
}

const cliConfigIo = makeCliConfigPromiseIo({ loadSchema: loadPublishedSchema });

export const findCliProjectPaths = cliConfigIo.findCliProjectPaths;
export const findCliProjectRoot = cliConfigIo.findCliProjectRoot;
export const loadCliConfig = cliConfigIo.loadCliConfig;
export const loadCliConfigFile = cliConfigIo.loadCliConfigFile;
export const validateCliConfig = cliConfigIo.validateCliConfig;
export const saveCliConfig = cliConfigIo.saveCliConfig;
export { CliConfigIoError } from "./promise-io.ts";
export type {
  CliConfigDocument,
  CliConfigIoErrorReason,
  CliConfigPromiseIo,
  CliConfigValidationIssue,
  CliProjectPaths,
  LoadCliConfigDocumentOptions,
  LoadedCliConfigDocument,
  SaveCliConfigDocumentOptions,
} from "./promise-io.ts";
