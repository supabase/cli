/**
 * Layer-exposure tests for `dbLintRuntimeLayer` and
 * `dbAdvisorsRuntimeLayer`.
 *
 * These tests verify that `IdentityStitch` is exposed at the top level of
 * each runtime layer (i.e., is a member of the layer's provided-services set)
 * so that `withCommandTelemetry` can read `stitchedDistinctId()` via
 * `Effect.serviceOption(IdentityStitch)` and attribute the
 * `cli_command_executed` event to the gotrue id.
 *
 * The bug this guards against: `Layer.provide(A, B)` satisfies A's dep on B but
 * does NOT expose B to sibling layers inside a `Layer.mergeAll`. If
 * `identityStitchLayer` is only provided to child layers (db-config,
 * linked-project-cache, platform-api-factory) and NOT added to the top-level
 * `Layer.mergeAll`, then `serviceOption(IdentityStitch)` returns `None`
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
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { IdentityStitch } from "../../../command-internal/identity-stitch.ts";

import { dbAdvisorsRuntimeLayer } from "../advisors/advisors.layers.ts";
import { dbLintRuntimeLayer } from "./lint.layers.ts";

const tempRoot = useTempWorkdir("supabase-lint-layers-");

/**
 * Builds a stub ambient layer that satisfies every external service required by
 * `dbLintRuntimeLayer` and `dbAdvisorsRuntimeLayer` from the root
 * runtime. Services whose logic is not under test are no-op stubs.
 */
function ambientStubs() {
  const analytics = mockAnalytics();
  const out = mockOutput();

  // Flag services — runtime layers consume these via commandSettingsLayer /
  // debugLoggerLayer / httpClientLayer.
  const flagLayers = Layer.mergeAll(
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ProfileFlag, "supabase"),
    Layer.succeed(WorkdirFlag, Option.none()),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: [] }),
  );

  // Stub out the heavy service layers so layer construction doesn't require a
  // real DB, real API, or real credentials.
  const heavyServiceStubs = Layer.mergeAll(
    Layer.succeed(DbConnection, {
      connect: () => Effect.die("db-connection not needed for layer-exposure test"),
    }),
    Layer.succeed(DbConfigResolver, {
      resolve: () => Effect.die("db-config-resolver not needed for layer-exposure test"),
      resolvePoolerFallback: () =>
        Effect.die("db-config-resolver not needed for layer-exposure test"),
    }),
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
    mockCommandSettings({ workdir: "/tmp/lint-layers-test" }),
    mockCommandCredentialsLayer,
    mockLinkedProjectCacheLayer,
    mockTelemetryStateLayer,
    heavyServiceStubs,
  );
}

describe("dbLintRuntimeLayer — IdentityStitch exposure", () => {
  it.live(
    "exposes IdentityStitch at top level so withCommandTelemetry can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(IdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(dbLintRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );
});

describe("dbAdvisorsRuntimeLayer — IdentityStitch exposure (regression guard)", () => {
  it.live(
    "exposes IdentityStitch at top level so withCommandTelemetry can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(IdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(dbAdvisorsRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );
});
