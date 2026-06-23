/**
 * Layer-exposure tests for `legacyDbLintRuntimeLayer` and
 * `legacyDbAdvisorsRuntimeLayer`.
 *
 * These tests verify that `LegacyIdentityStitch` is exposed at the top level of
 * each runtime layer (i.e., is a member of the layer's provided-services set)
 * so that `withLegacyCommandInstrumentation` can read `stitchedDistinctId()` via
 * `Effect.serviceOption(LegacyIdentityStitch)` and attribute the
 * `cli_command_executed` event to the gotrue id.
 *
 * The bug this guards against: `Layer.provide(A, B)` satisfies A's dep on B but
 * does NOT expose B to sibling layers inside a `Layer.mergeAll`. If
 * `legacyIdentityStitchLayer` is only provided to child layers (db-config,
 * linked-project-cache, platform-api-factory) and NOT added to the top-level
 * `Layer.mergeAll`, then `serviceOption(LegacyIdentityStitch)` returns `None`
 * and the event is mis-attributed to the device id.
 *
 * In-process runtime construction: we stub every ambient service the layers
 * require from the root runtime (Analytics, TelemetryRuntime, FileSystem, Path,
 * RuntimeInfo, Tty, Output, and all legacy flag services) so the full composed
 * layer can be built and queried without a real Postgres connection, API, or
 * filesystem state.
 */

import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";

import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyCredentialsLayer,
  mockLegacyLinkedProjectCacheLayer,
  mockLegacyTelemetryStateLayer,
} from "../../../../../tests/helpers/legacy-mocks.ts";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyOutputFlag,
  LegacyWorkdirFlag,
  LegacyProfileFlag,
} from "../../../../shared/legacy/global-flags.ts";

import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyIdentityStitch } from "../../../shared/legacy-identity-stitch.ts";

import { legacyDbAdvisorsRuntimeLayer } from "../advisors/advisors.layers.ts";
import { legacyDbLintRuntimeLayer } from "./lint.layers.ts";

/**
 * Builds a stub ambient layer that satisfies every external service required by
 * `legacyDbLintRuntimeLayer` and `legacyDbAdvisorsRuntimeLayer` from the root
 * runtime. Services whose logic is not under test are no-op stubs.
 */
function ambientStubs() {
  const analytics = mockAnalytics();
  const out = mockOutput();

  // Flag services — runtime layers consume these via legacyCliConfigLayer /
  // legacyDebugLoggerLayer / legacyHttpClientLayer.
  const flagLayers = Layer.mergeAll(
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(LegacyProfileFlag, "supabase"),
    Layer.succeed(LegacyWorkdirFlag, Option.none()),
    Layer.succeed(LegacyOutputFlag, Option.none()),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: [] }),
  );

  // Stub out the heavy service layers so layer construction doesn't require a
  // real DB, real API, or real credentials.
  const heavyServiceStubs = Layer.mergeAll(
    Layer.succeed(LegacyDbConnection, {
      connect: () => Effect.die("db-connection not needed for layer-exposure test"),
    }),
    Layer.succeed(LegacyDbConfigResolver, {
      resolve: () => Effect.die("db-config-resolver not needed for layer-exposure test"),
      resolvePoolerFallback: () =>
        Effect.die("db-config-resolver not needed for layer-exposure test"),
    }),
    Layer.succeed(LegacyProjectRefResolver, {
      resolve: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      resolveForLink: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      resolveOptional: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      loadProjectRef: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      promptProjectRef: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
    }),
    Layer.succeed(LegacyPlatformApiFactory, {
      make: Effect.die("platform-api-factory not needed for layer-exposure test"),
    }),
  );

  return Layer.mergeAll(
    BunServices.layer,
    mockRuntimeInfo(),
    mockTty(),
    mockProcessControl().layer,
    analytics.layer,
    mockTelemetryRuntime(),
    out.layer,
    flagLayers,
    mockLegacyCliConfig({ workdir: "/tmp/lint-layers-test" }),
    mockLegacyCredentialsLayer,
    mockLegacyLinkedProjectCacheLayer,
    mockLegacyTelemetryStateLayer,
    heavyServiceStubs,
  );
}

describe("legacyDbLintRuntimeLayer — LegacyIdentityStitch exposure", () => {
  it.live(
    "exposes LegacyIdentityStitch at top level so withLegacyCommandInstrumentation can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(LegacyIdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(legacyDbLintRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );
});

describe("legacyDbAdvisorsRuntimeLayer — LegacyIdentityStitch exposure (regression guard)", () => {
  it.live(
    "exposes LegacyIdentityStitch at top level so withLegacyCommandInstrumentation can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(LegacyIdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(legacyDbAdvisorsRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );
});
