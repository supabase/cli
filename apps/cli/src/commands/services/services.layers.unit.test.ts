/**
 * Verifies `IdentityStitch` is exposed at the top level of
 * `servicesRuntimeLayer` so `withCommandTelemetry` can attribute
 * `cli_command_executed` to the gotrue id. See lint.layers.unit.test.ts.
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
} from "../../../tests/helpers/mocks.ts";
import {
  isolatedHomeLayer,
  mockCommandSettings,
  mockCommandCredentialsLayer,
  mockLinkedProjectCacheLayer,
  mockTelemetryStateLayer,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";

import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  OutputFlag,
  WorkdirFlag,
  ProfileFlag,
} from "../../command-internal/global-flags.ts";

import { IdentityStitch } from "../../command-internal/identity-stitch.ts";

import { servicesRuntimeLayer } from "./services.layers.ts";

const tempRoot = useTempWorkdir("supabase-services-layers-");

/**
 * Stub layer satisfying every external service required by
 * `servicesRuntimeLayer` from the root runtime. Services under test are
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

  return Layer.mergeAll(
    BunServices.layer,
    // The runtime layer under test builds the real commandSettingsLayer against
    // the real filesystem — see isolatedHomeLayer's docs.
    isolatedHomeLayer(tempRoot.current),
    mockTty(),
    mockProcessControl().layer,
    analytics.layer,
    mockTelemetryRuntime(),
    out.layer,
    flagLayers,
    mockCommandSettings({ workdir: "/tmp/services-layers-test" }),
    mockCommandCredentialsLayer,
    mockLinkedProjectCacheLayer,
    mockTelemetryStateLayer,
  );
}

describe("servicesRuntimeLayer — IdentityStitch exposure", () => {
  it.live(
    "exposes IdentityStitch at top level so withCommandTelemetry can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(IdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(servicesRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );
});
