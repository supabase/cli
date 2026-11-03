import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { withConfigEnv, withEmptyConfigEnv } from "../../tests/helpers/command-mocks.ts";
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
  resolveYesSource,
  resolveYesWithProjectEnv,
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

// `parsed` is what the flag parser yields, which keeps the first occurrence of a repeated flag.
describe("resolveYesSource", () => {
  const resolve = (
    args: ReadonlyArray<string>,
    { parsed, shellYes }: { readonly parsed: boolean; readonly shellYes?: string },
  ) =>
    withEmptyConfigEnv(
      withConfigEnv(shellYes === undefined ? {} : { SUPABASE_YES: shellYes }, resolveYesSource),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(Layer.succeed(YesFlag, parsed), Layer.succeed(CliArgs, { args })),
      ),
    );

  it.effect.each([
    { args: ["--yes=false", "--yes"], parsed: false },
    { args: ["--yes=false", "--yes=true"], parsed: false },
    { args: ["--yes", "false", "--yes"], parsed: false },
    { args: ["--yes", "--", "--yes=false"], parsed: true },
    { args: ["--yes", "--password", "--yes=false"], parsed: true },
  ])("confirms $args because the last --yes is true", ({ args, parsed }) =>
    Effect.gen(function* () {
      expect(yield* resolve(args, { parsed })).toEqual(Option.some({ via: "flag" }));
    }),
  );

  it.effect.each([
    { args: ["--yes", "--yes=false"], parsed: true },
    { args: ["--yes=true", "--yes=false"], parsed: true },
    { args: ["--yes=false"], parsed: false },
    { args: ["--yes", "false"], parsed: false },
    { args: ["--yes=no"], parsed: false },
    { args: ["--yes", "off"], parsed: false },
  ])(
    "denies $args because the last --yes is false, even with SUPABASE_YES set",
    ({ args, parsed }) =>
      Effect.gen(function* () {
        expect(yield* resolve(args, { parsed, shellYes: "1" })).toEqual(Option.none());
      }),
  );

  it.effect("falls back to a shell SUPABASE_YES when --yes never appears", () =>
    Effect.gen(function* () {
      expect(yield* resolve([], { parsed: false, shellYes: "1" })).toEqual(
        Option.some({ via: "env" }),
      );
      expect(yield* resolve([], { parsed: false })).toEqual(Option.none());
    }),
  );
});

describe("resolveYesWithProjectEnv", () => {
  const resolve = (
    args: ReadonlyArray<string>,
    {
      parsed,
      projectEnv,
    }: { readonly parsed: boolean; readonly projectEnv: Record<string, string> },
  ) =>
    withEmptyConfigEnv(resolveYesWithProjectEnv(projectEnv)).pipe(
      Effect.provide(
        Layer.mergeAll(Layer.succeed(YesFlag, parsed), Layer.succeed(CliArgs, { args })),
      ),
    );

  it.effect("lets the last --yes decide, in either order", () =>
    Effect.gen(function* () {
      expect(yield* resolve(["--yes=false", "--yes"], { parsed: false, projectEnv: {} })).toBe(
        true,
      );
      expect(
        yield* resolve(["--yes", "--yes=false"], {
          parsed: true,
          projectEnv: { SUPABASE_YES: "1" },
        }),
      ).toBe(false);
    }),
  );

  it.effect("falls back to the project env when --yes never appears", () =>
    Effect.gen(function* () {
      expect(yield* resolve([], { parsed: false, projectEnv: { SUPABASE_YES: "1" } })).toBe(true);
    }),
  );
});
