import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliSettings,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockContextualAnalytics, mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyFunctionsDeleteHandler } from "./delete.command.ts";
import { legacyFunctionsDelete } from "./delete.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-functions-delete-legacy-");

// Strip ANSI SGR (aqua slug/ref via `legacyAqua`) so byte-assertions are
// stable whether or not the test stdout supports color.
// eslint-disable-next-line no-control-regex
const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

describe("legacy functions delete", () => {
  it.live("deletes a function natively through the Management API", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: null } });
    const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
    const telemetry = mockLegacyTelemetryStateTracked();
    const layer = buildLegacyTestRuntime({
      out,
      api,
      cliSettings: mockLegacyCliSettings({ workdir: tempRoot.current }),
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
      // The slug and ref are wrapped in ANSI (legacyAqua) in colour-capable
      // environments — strip SGR so the byte assertion stays stable.
      expect(stripSgr(out.stdoutText)).toBe(
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
      cliSettings: mockLegacyCliSettings({
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
          cliSettings: mockLegacyCliSettings({ workdir: tempRoot.current }),
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
