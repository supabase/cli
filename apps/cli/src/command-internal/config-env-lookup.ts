import { ENV_CAPTURE_REGEX } from "@supabase/config/internal";
import { Effect, Redacted } from "effect";

import { lookupCliConfigEnv } from "../config/cli-config-key.ts";
import { loadCliProjectEnvFiles, readShellEnvironment } from "../shared/config/cli-config-env.ts";

export const collectEnvReferences = (value: unknown, out: Set<string>): void => {
  if (typeof value === "string") {
    const name = ENV_CAPTURE_REGEX.exec(value)?.[1];
    if (name !== undefined) out.add(name);
  } else if (Redacted.isRedacted(value)) {
    collectEnvReferences(Redacted.value(value), out);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEnvReferences(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectEnvReferences(item, out);
  }
};

/**
 * Shell and project `.env*` values for a config read that needs the raw document rather than a
 * snapshot: `lookup` resolves non-empty values, shell first, for every `env(NAME)` in `trees`
 * and each of `extraNames`.
 */
export const loadConfigEnvLookup = Effect.fn("ConfigEnvLookup.load")(function* (
  workdir: string,
  trees: ReadonlyArray<unknown>,
  extraNames: ReadonlyArray<string> = [],
) {
  const names = new Set(extraNames);
  collectEnvReferences(trees, names);
  const shell = yield* readShellEnvironment();
  yield* shell.load(names);
  const files = yield* loadCliProjectEnvFiles(workdir, { shell });
  const lookup = (name: string) =>
    lookupCliConfigEnv(
      {
        shell: (key) => shell.get(key),
        projectEnv: (key) => {
          const value = files.values[key];
          return value === undefined ? undefined : { value };
        },
      },
      name,
    );
  return { lookup, shell, projectEnvValues: files.values };
});
