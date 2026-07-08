import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { CurrentAnalyticsContext } from "../../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../../shared/telemetry/analytics.service.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyFunctionsDeleteHandler } from "./delete.command.ts";
import { legacyFunctionsDelete } from "./delete.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-functions-delete-legacy-");

// `withLegacyCommandInstrumentation` threads `flags`/`command`/etc. through
// `CurrentAnalyticsContext`, not the direct `capture()` call args — mirrors
// the identical local helper in `legacy-command-instrumentation.unit.test.ts`.
// The shared `mockAnalytics()` in tests/helpers/mocks.ts deliberately doesn't
// merge this context (most callers don't need it).
function mockContextualAnalytics() {
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const layer = Layer.succeed(
    Analytics,
    Analytics.of({
      capture: (event: string, properties: Record<string, unknown> = {}) =>
        Effect.gen(function* () {
          const context = yield* CurrentAnalyticsContext;
          captured.push({ event, properties: { ...context, ...properties } });
        }),
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );
  return { layer, captured };
}

describe("legacy functions delete", () => {
  it.live("deletes a function natively through the Management API", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: null } });
    const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
    const telemetry = mockLegacyTelemetryStateTracked();
    const layer = buildLegacyTestRuntime({
      out,
      api,
      cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      linkedProjectCache: linkedProjectCache.layer,
      telemetry: telemetry.layer,
    });

    return Effect.gen(function* () {
      yield* legacyFunctionsDelete({
        functionName: "hello-world",
        projectRef: Option.none(),
      });

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("DELETE");
      expect(api.requests[0]?.url).toBe(
        "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/functions/hello-world",
      );
      expect(out.stdoutText).toBe(
        "Deleted Function hello-world from project abcdefghijklmnopqrst.\n",
      );
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses an explicit project ref", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: null } });
    const layer = buildLegacyTestRuntime({
      out,
      api,
      cliConfig: mockLegacyCliConfig({
        workdir: tempRoot.current,
        projectId: Option.none(),
      }),
    });

    return Effect.gen(function* () {
      yield* legacyFunctionsDelete({
        functionName: "hello-world",
        projectRef: Option.some("qrstuvwxyzabcdefghij"),
      });

      expect(api.requests[0]?.url).toContain("/projects/qrstuvwxyzabcdefghij/functions/");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "does not redact --project-ref in cli_command_executed (Go parity: cmd/functions.go:153)",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi({ response: { status: 200, body: null } });
      const analytics = mockContextualAnalytics();
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          analytics,
        }),
        commandRuntimeLayer(["functions", "delete"]),
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "delete",
            "hello-world",
            "--project-ref",
            "abcdefghijklmnopqrst",
          ]),
        }),
      );

      return Effect.gen(function* () {
        yield* legacyFunctionsDeleteHandler({
          functionName: "hello-world",
          projectRef: Option.some("abcdefghijklmnopqrst"),
        });

        const event = analytics.captured.find((c) => c.event === "cli_command_executed");
        expect(event?.properties.flags).toEqual({ "project-ref": "abcdefghijklmnopqrst" });
      }).pipe(Effect.provide(layer));
    },
  );
});
