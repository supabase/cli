/**
 * Layer-exposure test for `legacyGenTypesRuntimeLayer`.
 *
 * Verifies that `LegacyIdentityStitch` is exposed at the top level of the
 * runtime layer so that `withLegacyCommandInstrumentation` can read
 * `stitchedDistinctId()` via `Effect.serviceOption(LegacyIdentityStitch)` and
 * attribute the `cli_command_executed` event to the gotrue id.
 *
 * See `db/lint/lint.layers.unit.test.ts` for the canonical pattern and a
 * detailed explanation of the bug this guards against.
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
  processEnvLayer,
} from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyCredentialsLayer,
  mockLegacyLinkedProjectCacheLayer,
  mockLegacyTelemetryStateLayer,
  useLegacyTempWorkdir,
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
import { LegacyIdentityStitch } from "../../../shared/legacy-identity-stitch.ts";

import { legacyGenTypesRuntimeLayer } from "./types.layers.ts";

/**
 * Stub layer satisfying every external service required by
 * `legacyGenTypesRuntimeLayer` from the root runtime. Services under test are
 * left as `Effect.die` no-ops — layer construction must not invoke them.
 */
const tempRoot = useLegacyTempWorkdir("supabase-gen-types-layers-");

function ambientStubs() {
  const analytics = mockAnalytics();
  const out = mockOutput();

  const flagLayers = Layer.mergeAll(
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(LegacyProfileFlag, "supabase"),
    Layer.succeed(LegacyWorkdirFlag, Option.none()),
    Layer.succeed(LegacyOutputFlag, Option.none()),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: [] }),
  );

  const heavyServiceStubs = Layer.mergeAll(
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
    // The runtime layer under test builds the REAL legacyCliConfigLayer, which
    // reads `<homeDir>/.supabase/profile` (resolving SUPABASE_HOME/SUPABASE_PROFILE
    // from ambient env) through the real filesystem at layer construction.
    // Isolate both so stale files or env vars on the host can't leak in.
    mockRuntimeInfo({ homeDir: tempRoot.current }),
    processEnvLayer(),
    mockTty(),
    mockProcessControl().layer,
    analytics.layer,
    mockTelemetryRuntime(),
    out.layer,
    flagLayers,
    mockLegacyCliConfig({ workdir: "/tmp/gen-types-layers-test" }),
    mockLegacyCredentialsLayer,
    mockLegacyLinkedProjectCacheLayer,
    mockLegacyTelemetryStateLayer,
    heavyServiceStubs,
  );
}

describe("legacyGenTypesRuntimeLayer — LegacyIdentityStitch exposure", () => {
  it.live(
    "exposes LegacyIdentityStitch at top level so withLegacyCommandInstrumentation can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(LegacyIdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(legacyGenTypesRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );
});
