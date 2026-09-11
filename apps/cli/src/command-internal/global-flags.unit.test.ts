import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import {
  GLOBAL_FLAGS,
  AgentFlag,
  CreateTicketFlag,
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
  YesFlag,
  globalFlagValues,
  resolveDebugWithProjectEnv,
} from "./global-flags.ts";

describe("globalFlagValues", () => {
  it.live(
    "resolves every flag declared in GLOBAL_FLAGS by id (CLI-1896 drift guard: an 11th global flag added here without a matching read in globalFlagValues fails this test instead of silently redacting forever)",
    () => {
      const layer = Layer.mergeAll(
        Layer.succeed(AgentFlag, "yes" as const),
        Layer.succeed(CreateTicketFlag, true),
        Layer.succeed(DebugFlag, true),
        Layer.succeed(DnsResolverFlag, "https" as const),
        Layer.succeed(ExperimentalFlag, true),
        Layer.succeed(NetworkIdFlag, Option.some("my-network")),
        Layer.succeed(OutputFlag, Option.some("json" as const)),
        Layer.succeed(ProfileFlag, "custom-profile"),
        Layer.succeed(WorkdirFlag, Option.some("/tmp/project")),
        Layer.succeed(YesFlag, true),
      );

      return globalFlagValues.pipe(
        Effect.provide(layer),
        Effect.tap((values) =>
          Effect.sync(() => {
            expect(Object.keys(values).sort()).toEqual(GLOBAL_FLAGS.map((flag) => flag.id).sort());
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
    return globalFlagValues.pipe(
      Effect.tap((values) =>
        Effect.sync(() => {
          expect(values).toEqual({});
        }),
      ),
    );
  });

  it.live("only includes flags whose service was actually provided", () => {
    return globalFlagValues.pipe(
      Effect.provide(Layer.succeed(DebugFlag, true)),
      Effect.tap((values) =>
        Effect.sync(() => {
          expect(values).toEqual({ debug: true });
        }),
      ),
    );
  });
});

describe("resolveDebugWithProjectEnv", () => {
  it.live(
    "ignores a --debug=false-style token after the -- operand terminator (not an explicit false)",
    () => {
      // `DebugFlag: true` stands in for a real `--debug` before the `--`; the trailing
      // `--debug=false` is a positional operand (e.g. a migration name).
      const layer = Layer.mergeAll(
        Layer.succeed(DebugFlag, true),
        Layer.succeed(CliArgs, { args: ["db", "pull", "--", "--debug=false"] }),
      );
      return resolveDebugWithProjectEnv({}).pipe(
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
      // `--password` is a `VALUE_CONSUMING_LONG_FLAGS` entry, so `--debug=false` here is its
      // space-separated value, not a changed `--debug`.
      const layer = Layer.mergeAll(
        Layer.succeed(DebugFlag, true),
        Layer.succeed(CliArgs, { args: ["db", "pull", "--password", "--debug=false"] }),
      );
      return resolveDebugWithProjectEnv({}).pipe(
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
