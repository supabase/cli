import { Effect, Option } from "effect";
import type { ServiceCreationInput } from "@supabase/stack/effect";
import { resolveFunctionsEnv } from "../shared/functions/functions-config.ts";

/** Adds the project Functions env, plus `debug` when set, to a Functions creation. */
export const withProjectFunctionsConfig = (
  creation: ServiceCreationInput,
  options: { readonly warn: boolean; readonly debug: boolean },
) =>
  creation.service === "functions"
    ? resolveFunctionsEnv({
        secrets: creation.config.env ?? {},
        functionsDir: creation.config.functionsRoot,
        envFile: Option.none(),
        functionSlugs: [],
        warn: options.warn,
      }).pipe(
        Effect.map(({ shared }): ServiceCreationInput => ({
          ...creation,
          config: {
            ...creation.config,
            env: shared,
            ...(options.debug ? { debug: true } : {}),
          },
        })),
      )
    : Effect.succeed(creation);
