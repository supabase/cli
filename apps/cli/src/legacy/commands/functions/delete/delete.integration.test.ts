import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyFunctionsDelete } from "./delete.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-functions-delete-legacy-");

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
});
