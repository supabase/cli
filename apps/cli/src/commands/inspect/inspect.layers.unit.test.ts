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

import { DbConfigResolver } from "../../command-internal/db-config.service.ts";
import { DbConnection } from "../../command-internal/db-connection.service.ts";
import { IdentityStitch } from "../../command-internal/identity-stitch.ts";

import { inspectBaseLayer } from "./inspect.layers.ts";

const tempRoot = useTempWorkdir("supabase-inspect-layers-");

// Services under test are stubbed as `Effect.die` — layer construction must not invoke them.
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
    // Builds the real commandSettingsLayer against the real filesystem; see isolatedHomeLayer's docs.
    isolatedHomeLayer(tempRoot.current),
    mockTty(),
    mockProcessControl().layer,
    analytics.layer,
    mockTelemetryRuntime(),
    out.layer,
    flagLayers,
    mockCommandSettings({ workdir: "/tmp/inspect-layers-test" }),
    mockCommandCredentialsLayer,
    mockLinkedProjectCacheLayer,
    mockTelemetryStateLayer,
    heavyServiceStubs,
  );
}

describe("inspectBaseLayer — IdentityStitch exposure", () => {
  it.live(
    "exposes IdentityStitch at top level so withCommandTelemetry can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(IdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(inspectBaseLayer), Effect.provide(ambientStubs()));
    },
  );
});
