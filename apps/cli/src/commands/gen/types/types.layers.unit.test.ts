/**
 * Layer-exposure test for `genTypesRuntimeLayer`. See `db/lint/lint.layers.unit.test.ts` for
 * the canonical pattern.
 */

import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";

import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import {
  isolatedHomeLayer,
  mockCommandSettings,
  mockCommandCredentialsLayer,
  mockLinkedProjectCacheLayer,
  mockTelemetryStateLayer,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  OutputFlag,
  WorkdirFlag,
  ProfileFlag,
} from "../../../command-internal/global-flags.ts";

import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { IdentityStitch } from "../../../command-internal/identity-stitch.ts";

import { genTypesRuntimeLayer } from "./types.layers.ts";
import { stubRemoteTarget } from "../../../../tests/helpers/remote-target.ts";

const tempRoot = useTempWorkdir("supabase-gen-types-layers-");

/**
 * Stub layer satisfying every external service required by
 * `genTypesRuntimeLayer` from the root runtime. Services under test are
 * left as `Effect.die` no-ops — layer construction must not invoke them.
 */
function ambientStubs() {
  const analytics = mockAnalytics();
  const out = mockOutput();

  const flagLayers = Layer.mergeAll(
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ProfileFlag, "supabase"),
    Layer.succeed(WorkdirFlag, Option.none()),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: [] }),
  );

  const heavyServiceStubs = Layer.mergeAll(
    stubRemoteTarget({
      resolve: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      resolveForLink: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      resolveOptional: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      load: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      prompt: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
    }),
    Layer.succeed(CommandPlatformApiFactory, {
      make: Effect.die("platform-api-factory not needed for layer-exposure test"),
    }),
  );

  return Layer.mergeAll(
    NodeServices.layer,
    // Builds the real commandSettingsLayer against the real filesystem — see
    // isolatedHomeLayer's docs.
    isolatedHomeLayer(tempRoot.current),
    mockTty(),
    mockProcessControl().layer,
    analytics.layer,
    mockTelemetryRuntime(),
    out.layer,
    flagLayers,
    mockCommandSettings({ workdir: "/tmp/gen-types-layers-test" }),
    mockCommandCredentialsLayer,
    mockLinkedProjectCacheLayer,
    mockTelemetryStateLayer,
    heavyServiceStubs,
  );
}

describe("genTypesRuntimeLayer — IdentityStitch exposure", () => {
  it.effect(
    "exposes IdentityStitch at top level so withCommandTelemetry can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(IdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(genTypesRuntimeLayer.pipe(Layer.provide(ambientStubs()))));
    },
  );
});
