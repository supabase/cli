/**
 * Verifies `IdentityStitch` is exposed at the top level of
 * `testDbRuntimeLayer`, not just provided to the child `dbConfig` layer —
 * see `CLAUDE.md`'s "Layer.provide does not share to siblings" invariant.
 * Otherwise `withCommandTelemetry` can't read `stitchedDistinctId()` and
 * `test db --linked`'s `cli_command_executed` is mis-attributed to the
 * device id.
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
} from "../../tests/helpers/mocks.ts";
import {
  isolatedHomeLayer,
  mockCommandSettings,
  mockTelemetryStateLayer,
  useTempWorkdir,
} from "../../tests/helpers/command-mocks.ts";

import { CliArgs } from "../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
} from "./global-flags.ts";

import { DbConfigResolver } from "./db-config.service.ts";
import { DbConnection } from "./db-connection.service.ts";
import { IdentityStitch } from "./identity-stitch.ts";

import { testDbRuntimeLayer } from "./test-db.layers.ts";

const tempRoot = useTempWorkdir("supabase-test-db-layers-");

/**
 * Builds a stub ambient layer that satisfies every external service required by
 * `testDbRuntimeLayer` from the root runtime. Services whose logic is not
 * under test are no-op stubs.
 */
function ambientStubs() {
  const analytics = mockAnalytics();
  const out = mockOutput();

  // Flag services consumed via commandSettingsLayer / debugLoggerLayer.
  const flagLayers = Layer.mergeAll(
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ProfileFlag, "supabase"),
    Layer.succeed(WorkdirFlag, Option.none()),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: [] }),
  );

  // Stub out the heavy service layers so layer construction doesn't require a
  // real DB or real credentials.
  const heavyServiceStubs = Layer.mergeAll(
    Layer.succeed(DbConnection, {
      connect: () => Effect.die("db-connection not needed for layer-exposure test"),
    }),
    Layer.succeed(DbConfigResolver, {
      resolve: () => Effect.die("db-config-resolver not needed for layer-exposure test"),
      resolvePoolerFallback: () =>
        Effect.die("db-config-resolver not needed for layer-exposure test"),
    }),
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
    mockCommandSettings({ workdir: "/tmp/test-db-layers-test" }),
    mockTelemetryStateLayer,
    heavyServiceStubs,
  );
}

describe("testDbRuntimeLayer — IdentityStitch exposure", () => {
  it.live(
    "exposes IdentityStitch at top level so withCommandTelemetry can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(IdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(testDbRuntimeLayer(["test", "db"])), Effect.provide(ambientStubs()));
    },
  );
});
