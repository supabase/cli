/** See `db/lint/lint.layers.unit.test.ts` for the canonical pattern this test follows. */

import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";

import {
  mockAnalytics,
  mockBrowser,
  mockOutput,
  mockProcessControl,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import {
  VALID_TOKEN,
  isolatedHomeLayer,
  mockCommandSettings,
  mockCommandCredentialsLayer,
  mockLinkedProjectCacheLayer,
  mockLoginApi,
  mockLoginCrypto,
  mockTelemetryStateLayer,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";

import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  NetworkIdFlag,
  OutputFlag,
  WorkdirFlag,
  ProfileFlag,
} from "../../command-internal/global-flags.ts";

import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import { IdentityStitch } from "../../command-internal/identity-stitch.ts";
import { TemplateService } from "./bootstrap.templates.ts";

import { bootstrapRuntimeLayer } from "./bootstrap.layers.ts";

const tempRoot = useTempWorkdir("supabase-bootstrap-layers-");

// Stub layer for every external service `bootstrapRuntimeLayer` needs from the root runtime.
// Services under test are `Effect.die` no-ops — layer construction must not invoke them.
function ambientStubs() {
  const analytics = mockAnalytics();
  const out = mockOutput();

  const flagLayers = Layer.mergeAll(
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ProfileFlag, "supabase"),
    Layer.succeed(WorkdirFlag, Option.none()),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(NetworkIdFlag, Option.none()),
    Layer.succeed(CliArgs, { args: [] }),
  );

  // These stubs exist only so the Effect type system sees CommandPlatformApi,
  // CommandPlatformApiFactory, and ProjectRefResolver as satisfiable in the outer context; the
  // runtime layer's own provisions take precedence at runtime.
  const heavyServiceStubs = Layer.mergeAll(
    Layer.succeed(CommandPlatformApi, {
      v1: new Proxy({}, { get: () => () => Effect.die("not needed for layer-exposure test") }),
      executeRaw: () => Effect.die("not needed for layer-exposure test"),
    } as unknown as import("@supabase/api/effect").ApiClient),
    Layer.succeed(CommandPlatformApiFactory, {
      make: Effect.die("platform-api-factory not needed for layer-exposure test"),
    }),
    Layer.succeed(ProjectRefResolver, {
      resolve: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      resolveForLink: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      resolveOptional: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      loadProjectRef: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
      promptProjectRef: () => Effect.die("project-ref-resolver not needed for layer-exposure test"),
    }),
    Layer.succeed(TemplateService, {
      listSamples: Effect.die("template-service not needed for layer-exposure test"),
      download: () => Effect.die("template-service not needed for layer-exposure test"),
    }),
    mockLoginApi().layer,
    mockLoginCrypto().layer,
  );

  return Layer.mergeAll(
    BunServices.layer,
    // Builds the real `commandSettingsLayer` against the real filesystem (see
    // `isolatedHomeLayer`'s docs). `commandPlatformApiLayer` eagerly validates the access token at
    // construction time, so inject a valid one via the isolated env (`SUPABASE_ACCESS_TOKEN`).
    isolatedHomeLayer(tempRoot.current, { SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    mockTty(),
    mockProcessControl().layer,
    mockBrowser(),
    mockStdin(false),
    analytics.layer,
    mockTelemetryRuntime(),
    out.layer,
    flagLayers,
    mockCommandSettings({ workdir: "/tmp/bootstrap-layers-test" }),
    mockCommandCredentialsLayer,
    mockLinkedProjectCacheLayer,
    mockTelemetryStateLayer,
    heavyServiceStubs,
  );
}

describe("bootstrapRuntimeLayer — IdentityStitch exposure", () => {
  it.live(
    "exposes IdentityStitch at top level so withCommandTelemetry can read stitchedDistinctId()",
    () => {
      return Effect.gen(function* () {
        const stitch = yield* Effect.serviceOption(IdentityStitch);
        expect(Option.isSome(stitch)).toBe(true);
      }).pipe(Effect.provide(bootstrapRuntimeLayer), Effect.provide(ambientStubs()));
    },
  );
});
