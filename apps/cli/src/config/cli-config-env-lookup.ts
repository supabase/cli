import { Effect } from "effect";

import {
  loadCliProjectEnvFiles,
  readShellEnvironment,
  type CliShellEnvironment,
} from "../shared/config/cli-config-env.ts";
import { collectDotenvPrivateKeys } from "../shared/config/vault-decrypt.ts";
import { collectEnvReferences } from "./cli-config-document.ts";
import { lookupCliConfigEnv } from "./cli-config-key.ts";

export type CliConfigEnvState =
  | { readonly state: "set"; readonly value: string }
  | { readonly state: "empty"; readonly source: "shell" | "file" }
  | { readonly state: "unset" };

export interface CliConfigEnvLookup {
  readonly lookup: (name: string) => CliConfigEnvState;
  /** The `DOTENV_PRIVATE_KEY*` values from the shell and project `.env*` files, for `CliConfigSources.dotenvPrivateKeys`. */
  readonly dotenvPrivateKeys: ReadonlyArray<string>;
}

interface LoadedCliConfigEnv extends CliConfigEnvLookup {
  readonly shell: CliShellEnvironment;
  readonly projectEnv: Effect.Success<ReturnType<typeof loadCliProjectEnvFiles>>;
}

/** Reads the shell and the project `.env*` files for `names`, shell first, and resolves `env()` references inside the values. */
export const loadCliConfigEnvLookup = Effect.fn("CliConfigEnvLookup.load")(function* (
  workdir: string,
  names: ReadonlyArray<string>,
) {
  const shell = yield* readShellEnvironment({
    names,
    namesWithPrefix: ["DOTENV_PRIVATE_KEY"],
  });
  const projectEnv = yield* loadCliProjectEnvFiles(workdir, { shell });
  const valueReferences = new Set<string>();
  collectEnvReferences(Object.values(projectEnv.values), valueReferences);
  collectEnvReferences([...shell.entries().values()], valueReferences);
  yield* shell.load(valueReferences);

  const sources = {
    shell: (name: string) => shell.get(name),
    projectEnv: (name: string) => {
      const value = projectEnv.values[name];
      return value === undefined ? undefined : { value };
    },
  };
  const lookup = (name: string): CliConfigEnvState => {
    const value = lookupCliConfigEnv(sources, name);
    if (value !== undefined) return { state: "set", value };
    if (shell.get(name) === "") return { state: "empty", source: "shell" };
    return projectEnv.values[name] === "" ? { state: "empty", source: "file" } : { state: "unset" };
  };
  const dotenvPrivateKeys = collectDotenvPrivateKeys({
    ...projectEnv.values,
    ...Object.fromEntries(shell.entries()),
  });

  return {
    lookup,
    dotenvPrivateKeys,
    shell,
    projectEnv,
  } satisfies LoadedCliConfigEnv;
});
