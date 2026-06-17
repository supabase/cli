/**
 * Layer-exposure test for `legacyBootstrapRuntimeLayer`.
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
  mockBrowser,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
  processEnvLayer,
} from "../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_TOKEN,
  mockLegacyCliConfig,
  mockLegacyCredentialsLayer,
  mockLegacyLinkedProjectCacheLayer,
  mockLegacyLoginApi,
  mockLegacyLoginCrypto,
  mockLegacyTelemetryStateLayer,
} from "../../../../tests/helpers/legacy-mocks.ts";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyOutputFlag,
  LegacyWorkdirFlag,
  LegacyProfileFlag,
} from "../../../shared/legacy/global-flags.ts";

import { LegacyPlatformApiFactory } from "../../auth/legacy-platform-api-factory.service.ts";
import { LegacyPlatformApi } from "../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../config/legacy-project-ref.service.ts";
import { LegacyIdentityStitch } from "../../shared/legacy-identity-stitch.ts";
import { LegacyTemplateService } from "./bootstrap.templates.ts";

import { legacyBootstrapRuntimeLayer } from "./bootstrap.layers.ts";

/**
 * Stub layer satisfying every external service required by
 * `legacyBootstrapRuntimeLayer` from the root runtime. Services under test are
 * left as `Effect.die` no-ops — layer construction must not invoke them.
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
    Layer.succeed(CliArgs, { args: [] }),
  );

  // Bootstrap's runtime layer provides LegacyPlatformApi, LegacyPlatformApiFactory,
  // and LegacyProjectRefResolver by building them from real sub-layers. These
  // stubs are present so that the Effect type system sees those services as
  // satisfiable in the outer ambient context; the runtime layer's own provisions
  // take precedence at runtime.
  const heavyServiceStubs = Layer.mergeAll(
    Layer.succeed(LegacyPlatformApi, {
      v1: new Proxy({}, { get: () => () => Effect.die("not needed for layer-exposure test") }),
      executeRaw: () => Effect.die("not needed for layer-exposure test"),
    } as unknown as import("@supabase/api/effect").ApiClient),
    Layer.succeed(LegacyPlatformApiFactory, {
      make: Effect.die("platform-api-factory not needed for layer-exposure test"),
    }),
    Layer.succeed(LegacyProjectRefResolver, {
      resolve: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      resolveForLink: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      resolveOptional: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      loadProjectRef: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      promptProjectRef: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
    }),
    Layer.succeed(LegacyTemplateService, {
      listSamples: Effect.die("template-service not needed for layer-exposure test"),
      download: () => Effect.die("template-service not needed for layer-exposure test"),
    }),
    mockLegacyLoginApi().layer,
    mockLegacyLoginCrypto().layer,
  );

  return Layer.mergeAll(
    BunServices.layer,
    mockRuntimeInfo(),
    mockTty(),
    mockProcessControl().layer,
    mockBrowser(),
    mockStdin(false),
    analytics.layer,
    mockTelemetryRuntime(),
    out.layer,
    flagLayers,
    // Bootstrap's legacyPlatformApiLayer eagerly validates the access token at
    // layer-construction time. Inject a valid token via the environment so the
    // real legacyCliConfigLayer (built inside the bootstrap runtime) finds it —
    // matching the same mechanism the cli-e2e harness uses (SUPABASE_ACCESS_TOKEN
    // env var, legacy CLAUDE.md item 4 dual-mode profile). The processEnvLayer
    // isolates the env mutation to this test's scope.
    processEnvLayer({ SUPABASE_ACCESS_TOKEN: LEGACY_VALID_TOKEN }),
    mockLegacyCliConfig({ workdir: "/tmp/bootstrap-layers-test" }),
    mockLegacyCredentialsLayer,
    mockLegacyLinkedProjectCacheLayer,
    mockLegacyTelemetryStateLayer,
    heavyServiceStubs,
  );
}

describe("legacyBootstrapRuntimeLayer — LegacyIdentityStitch exposure", () => {
  it.live(
    "exposes LegacyIdentityStitch at top level so withLegacyCommandInstrumentation can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(LegacyIdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(legacyBootstrapRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );
});
