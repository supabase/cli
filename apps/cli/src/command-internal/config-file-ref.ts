import { findCliProjectPaths } from "@supabase/config/effect";
import { Effect, Option, Path } from "effect";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import { configFileRefFromPath, configFileRefOf, DEFAULT_CONFIG_FILE } from "./config-advice.ts";

/** The workdir's config file, from the memoised resolved config; a failed load reads as no file. */
export const loadConfigFileRef = Effect.fnUntraced(function* (workdir: string) {
  const path = yield* Path.Path;
  const values = yield* CliConfigValues;
  return yield* values.load({ workdir, projectRef: Option.none() }).pipe(
    Effect.map((resolvedConfig) => configFileRefOf(path, workdir, resolvedConfig)),
    Effect.orElseSucceed(() => DEFAULT_CONFIG_FILE),
  );
});

/** The workdir's config file found on disk (no resolved-config load); no file reads as the default. */
export const findConfigFileRef = Effect.fnUntraced(function* (workdir: string) {
  const path = yield* Path.Path;
  const found = yield* findCliProjectPaths(workdir, { search: false }).pipe(
    Effect.orElseSucceed(() => null),
  );
  return configFileRefFromPath(path, workdir, found?.configPath);
});
