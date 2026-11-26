import { Effect, FileSystem, Path, Schema } from "effect";
import { CliConfigSchema, type CliConfig } from "./base.ts";
import {
  edgeFunctionDenoConfigFileName,
  edgeFunctionEntrypointFileName,
  edgeFunctionsDirectoryName,
  type ResolvedFunctionConfig,
} from "./functions-manifest-model.ts";
import {
  buildFunctionsManifest,
  filesystemFunctionConfig,
  functionSlugPattern,
} from "./functions-manifest-core.ts";
import { loadCliConfig } from "./io.ts";
import { setOwnProperty } from "./lib/own-property.ts";
import { findCliProjectPaths } from "./paths.ts";

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);
const emptyConfig = decodeCliConfig({});

interface InferFunctionsManifestOptions {
  readonly cwd: string;
  readonly config?: CliConfig;
  /** Forwarded to {@link findCliProjectPaths}'s own `search` option — see its doc comment. */
  readonly search?: boolean;
}

export const inferFunctionsManifest = Effect.fn("FunctionsManifest.infer")(function* (
  options: InferFunctionsManifestOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliProjectPaths = yield* findCliProjectPaths(options.cwd, { search: options.search });
  const projectRoot = cliProjectPaths?.projectRoot ?? options.cwd;
  const config =
    options.config ??
    (yield* loadCliConfig(options.cwd).pipe(Effect.map((loaded) => loaded?.config ?? emptyConfig)));
  const functionsDir = path.join(projectRoot, "supabase", edgeFunctionsDirectoryName);
  const filesystemFunctions: Record<string, ResolvedFunctionConfig> = {};

  if (yield* fs.exists(functionsDir)) {
    const entries = yield* fs.readDirectory(functionsDir);
    for (const slug of entries.sort((left, right) => left.localeCompare(right))) {
      if (!functionSlugPattern.test(slug)) {
        continue;
      }

      const entrypointPath = path.join(functionsDir, slug, edgeFunctionEntrypointFileName);
      if (!(yield* fs.exists(entrypointPath))) {
        continue;
      }

      setOwnProperty(
        filesystemFunctions,
        slug,
        filesystemFunctionConfig(
          slug,
          yield* fs.exists(path.join(functionsDir, slug, edgeFunctionDenoConfigFileName)),
        ),
      );
    }
  }

  return buildFunctionsManifest(filesystemFunctions, config.functions);
});
