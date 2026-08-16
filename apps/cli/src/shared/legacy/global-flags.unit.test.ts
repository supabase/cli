import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { CliArgs } from "../cli/cli-args.service.ts";
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
  LegacyRemoteFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
  legacyGlobalFlagValues,
  legacyResolveDebugWithProjectEnv,
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
        Layer.succeed(LegacyRemoteFlag, Option.some("staging")),
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
              remote: Option.some("staging"),
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

describe("legacyResolveDebugWithProjectEnv", () => {
  it.live(
    "ignores a --debug=false-style token after the -- operand terminator (not an explicit false)",
    () => {
      // `LegacyDebugFlag: true` stands in for a REAL `--debug` occurrence before the `--`
      // terminator; the trailing `--debug=false` is a positional operand (e.g. a migration
      // name that happens to look like a flag) — `legacyDebugFlagExplicitlyFalse`'s
      // `argsBeforeOperandTerminator` guard must never see it, so the resolved value stays
      // the flag's own `true` rather than being flipped to `false`.
      const layer = Layer.mergeAll(
        Layer.succeed(LegacyDebugFlag, true),
        Layer.succeed(CliArgs, { args: ["db", "pull", "--", "--debug=false"] }),
      );
      return legacyResolveDebugWithProjectEnv({}).pipe(
        Effect.provide(layer),
        Effect.tap((resolved) =>
          Effect.sync(() => {
            expect(resolved).toBe(true);
          }),
        ),
      );
    },
  );

  it.live(
    "ignores a --debug=false token consumed as another flag's value (e.g. --password)",
    () => {
      // `--password` is a `VALUE_CONSUMING_LONG_FLAGS` entry, so real pflag semantics parse
      // `--password --debug=false` as `--password`'s space-separated value being the literal
      // string `"--debug=false"`, not a changed `--debug` — `nonValueConsumedTokens` must skip
      // it, so the resolved value stays the flag's own `true`.
      const layer = Layer.mergeAll(
        Layer.succeed(LegacyDebugFlag, true),
        Layer.succeed(CliArgs, { args: ["db", "pull", "--password", "--debug=false"] }),
      );
      return legacyResolveDebugWithProjectEnv({}).pipe(
        Effect.provide(layer),
        Effect.tap((resolved) =>
          Effect.sync(() => {
            expect(resolved).toBe(true);
          }),
        ),
      );
    },
  );
});
