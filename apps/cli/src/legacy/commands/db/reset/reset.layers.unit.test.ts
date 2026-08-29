/**
 * Layer-exposure test for `legacyDbResetRuntimeLayer`.
 *
 * Regression guard (review CLI-1958): reset code paths can reach
 * `LegacyEdgeRuntimeScript` and `LegacyPgDeltaSslProbe` (today through the shared
 * pg-delta command runtime backing the migra fallback). `legacyDbResetRuntimeLayer`
 * previously omitted both services (and the `LegacyDockerRun` layer the real
 * edge-runtime implementation needs) — unlike `legacyDbPushRuntimeLayer`, which
 * already composes all three. That gap was invisible to `reset.integration.test.ts`
 * because that suite drives `legacyDbReset` directly with its own hand-built layer
 * (which mocks `LegacyEdgeRuntimeScript`/`LegacyPgDeltaSslProbe` in), bypassing
 * `reset.layers.ts` entirely — so a versionless remote reset with pg-delta enabled
 * would crash on a missing-service defect (uncaught by the handler's typed
 * `Effect.catch`) AFTER the remote database was already reset. This test builds
 * the REAL `legacyDbResetRuntimeLayer` (not a mock of the pg-delta services) and
 * asserts both are actually present in its context.
 *
 * See `db/lint/lint.layers.unit.test.ts` for the canonical ambient-stub pattern.
 */

import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";

import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliSettings,
  mockLegacyCredentialsLayer,
  mockLegacyLinkedProjectCacheLayer,
  mockLegacyTelemetryStateLayer,
} from "../../../../../tests/helpers/legacy-mocks.ts";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
} from "../../../../shared/legacy/global-flags.ts";

import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";

import { legacyDbResetRuntimeLayer } from "./reset.layers.ts";

/**
 * Builds a stub ambient layer that satisfies every external service required by
 * `legacyDbResetRuntimeLayer` from the root runtime. Services whose logic is not
 * under test are no-op stubs; `LegacyEdgeRuntimeScript` and `LegacyPgDeltaSslProbe`
 * are deliberately NOT stubbed here — the point of this test is to prove the real
 * `legacyDbResetRuntimeLayer` provides them itself.
 */
function ambientStubs() {
  const analytics = mockAnalytics();
  const out = mockOutput();

  const flagLayers = Layer.mergeAll(
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(LegacyProfileFlag, "supabase"),
    Layer.succeed(LegacyWorkdirFlag, Option.none()),
    Layer.succeed(LegacyOutputFlag, Option.none()),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
    Layer.succeed(LegacyExperimentalFlag, false),
    Layer.succeed(CliArgs, { args: ["db", "reset"] }),
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
    mockStdin(false),
    analytics.layer,
    mockTelemetryRuntime(),
    out.layer,
    flagLayers,
    mockLegacyCliSettings({ workdir: "/tmp/reset-layers-test" }),
    mockLegacyCredentialsLayer,
    mockLegacyLinkedProjectCacheLayer,
    mockLegacyTelemetryStateLayer,
    heavyServiceStubs,
  );
}

describe("legacyDbResetRuntimeLayer — pg-delta service exposure (regression guard, review CLI-1958)", () => {
  it.live(
    "exposes LegacyEdgeRuntimeScript so the post-reset pg-delta catalog cache does not crash on a missing-service defect",
    () => {
      return Effect.gen(function* () {
        const edgeRuntime = yield* Effect.serviceOption(LegacyEdgeRuntimeScript);
        expect(Option.isSome(edgeRuntime)).toBe(true);
      }).pipe(Effect.provide(legacyDbResetRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );

  it.live(
    "exposes LegacyPgDeltaSslProbe so the post-reset pg-delta catalog cache does not crash on a missing-service defect",
    () => {
      return Effect.gen(function* () {
        const sslProbe = yield* Effect.serviceOption(LegacyPgDeltaSslProbe);
        expect(Option.isSome(sslProbe)).toBe(true);
      }).pipe(Effect.provide(legacyDbResetRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );
});
