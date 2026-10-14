import { Config, Effect } from "effect";
import type { ContainerEngine } from "../src/runtime/Container.ts";

/**
 * The container engine real-engine tests run against: `docker` unless `SUPABASE_STACK_TEST_ENGINE`
 * selects `podman`. Resolving it never contacts the engine.
 */
export const testEngine: ContainerEngine = Effect.runSync(
  Config.Literals(["docker", "podman"], "SUPABASE_STACK_TEST_ENGINE").pipe(
    Config.withDefault("docker"),
  ),
);
