import { resolveCliConfigSubtree } from "@supabase/config/internal";
import { Effect } from "effect";

import { envReferenceNames } from "./cli-config-document.ts";
import type { ResolvedCliConfig } from "./cli-config-values.service.ts";

/** Resolves `env()` references against `values` and wraps secret leaves in `Redacted` for a subtree the registry does not model. */
export const resolveCliSubtree = <T>(
  tree: T,
  values: Readonly<Record<string, string>>,
  path: string,
) => resolveCliConfigSubtree(tree, { values }, path, { cliCompat: true });

/** {@link resolveCliSubtree} with the values the resolved config's shell and project `.env*` supply. */
export const resolveConfigSubtree = Effect.fn("CliConfigSubtree.resolve")(function* <T>(
  resolvedConfig: ResolvedCliConfig,
  tree: T,
  path: string,
) {
  const values = yield* resolvedConfig.envValues(envReferenceNames(tree));
  return yield* resolveCliSubtree(tree, values, path);
});
