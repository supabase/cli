import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import {
  LEGACY_GLOBAL_FLAGS,
  LegacyAgentFlag,
  LegacyCreateTicketFlag,
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
  legacyGlobalFlagValues,
} from "./global-flags.ts";

describe("legacyGlobalFlagValues", () => {
  it.live(
    "resolves every flag declared in LEGACY_GLOBAL_FLAGS by id (CLI-1896 drift guard: an 11th global flag added here without a matching read in legacyGlobalFlagValues fails this test instead of silently redacting forever)",
    () => {
      const layer = Layer.mergeAll(
        Layer.succeed(LegacyAgentFlag, "yes" as const),
        Layer.succeed(LegacyCreateTicketFlag, true),
        Layer.succeed(LegacyDebugFlag, true),
        Layer.succeed(LegacyDnsResolverFlag, "https" as const),
        Layer.succeed(LegacyExperimentalFlag, true),
        Layer.succeed(LegacyNetworkIdFlag, Option.some("my-network")),
        Layer.succeed(LegacyOutputFlag, Option.some("json" as const)),
        Layer.succeed(LegacyProfileFlag, "custom-profile"),
        Layer.succeed(LegacyWorkdirFlag, Option.some("/tmp/project")),
        Layer.succeed(LegacyYesFlag, true),
      );

      return legacyGlobalFlagValues.pipe(
        Effect.provide(layer),
        Effect.tap((values) =>
          Effect.sync(() => {
            // The key set must exactly match LEGACY_GLOBAL_FLAGS's own ids —
            // this is what fails loudly if the array grows without a matching
            // read here.
            expect(Object.keys(values).sort()).toEqual(
              LEGACY_GLOBAL_FLAGS.map((flag) => flag.id).sort(),
            );
            expect(values).toEqual({
              agent: "yes",
              "create-ticket": true,
              debug: true,
              "dns-resolver": "https",
              experimental: true,
              "network-id": Option.some("my-network"),
              output: Option.some("json"),
              profile: "custom-profile",
              workdir: Option.some("/tmp/project"),
              yes: true,
            });
          }),
        ),
      );
    },
  );

  it.live("omits every flag when no global-flag context is provided", () => {
    return legacyGlobalFlagValues.pipe(
      Effect.tap((values) =>
        Effect.sync(() => {
          expect(values).toEqual({});
        }),
      ),
    );
  });

  it.live("only includes flags whose service was actually provided", () => {
    return legacyGlobalFlagValues.pipe(
      Effect.provide(Layer.succeed(LegacyDebugFlag, true)),
      Effect.tap((values) =>
        Effect.sync(() => {
          expect(values).toEqual({ debug: true });
        }),
      ),
    );
  });
});
