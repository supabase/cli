/**
 * Layer-exposure test for `genTypesRuntimeLayer`.
 *
 * Verifies that `IdentityStitch` is exposed at the top level of the
 * runtime layer so that `withCommandTelemetry` can read
 * `stitchedDistinctId()` via `Effect.serviceOption(IdentityStitch)` and
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
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { IdentityStitch } from "../../../command-internal/identity-stitch.ts";

import { genTypesRuntimeLayer } from "./types.layers.ts";

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
    Layer.succeed(ProjectRefResolver, {
      resolve: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      resolveForLink: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      resolveOptional: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      loadProjectRef: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      promptProjectRef: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
    }),
    Layer.succeed(CommandPlatformApiFactory, {
      make: Effect.die("platform-api-factory not needed for layer-exposure test"),
    }),
  );

  return Layer.mergeAll(
    BunServices.layer,
    // The runtime layer under test builds the REAL commandSettingsLayer against
    // the real filesystem — see isolatedHomeLayer's docs.
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
  it.live(
    "exposes IdentityStitch at top level so withCommandTelemetry can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(IdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(genTypesRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );
});
