import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import {
  buildTestRuntime,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockContextualAnalytics, mockOutput } from "../../../../tests/helpers/mocks.ts";
import { functionsDeleteHandler } from "./delete.command.ts";
import { functionsDelete } from "./delete.handler.ts";

const tempRoot = useTempWorkdir("supabase-functions-delete-");

// Strips ANSI color codes so assertions are stable regardless of color support.
// eslint-disable-next-line no-control-regex
const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

describe("functions delete", () => {
  it.live("deletes a function natively through the Management API", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
    const linkedProjectCache = mockLinkedProjectCacheTracked();
    const telemetry = mockTelemetryStateTracked();
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      linkedProjectCache: linkedProjectCache.layer,
      telemetry: telemetry.layer,
    });

    return Effect.gen(function* () {
      yield* functionsDelete({
        functionName: "hello-world",
        projectRef: Option.none(),
      });

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("DELETE");
      expect(api.requests[0]?.url).toBe(
        "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/functions/hello-world",
      );
      expect(stripSgr(out.stdoutText)).toBe(
        "Deleted Function hello-world from project abcdefghijklmnopqrst.\n",
      );
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses an explicit project ref", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      }),
    });

    return Effect.gen(function* () {
      yield* functionsDelete({
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
      const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
      const analytics = mockContextualAnalytics();
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        yield* functionsDeleteHandler({
          functionName: "hello-world",
          projectRef: Option.some("abcdefghijklmnopqrst"),
        });

        const event = analytics.captured.find((c) => c.event === "cli_command_executed");
        expect(event?.properties.flags).toEqual({ "project-ref": "abcdefghijklmnopqrst" });
      }).pipe(Effect.provide(layer));
    },
  );
});
