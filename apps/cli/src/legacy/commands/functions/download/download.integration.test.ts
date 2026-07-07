import { describe, expect, it } from "@effect/vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Option, Stdio } from "effect";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { CurrentAnalyticsContext } from "../../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../../shared/telemetry/analytics.service.ts";
import {
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { ConflictingFunctionDownloadFlagsError } from "../../../../shared/functions/download.errors.ts";
import { legacyFunctionsDownloadHandler } from "./download.command.ts";
import type { LegacyFunctionsDownloadFlags } from "./download.command.ts";
import { legacyFunctionsDownload } from "./download.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-functions-download-legacy-");

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
const baseFlags: LegacyFunctionsDownloadFlags = {
  functionName: Option.some("hello-world"),
  projectRef: Option.none(),
  useApi: false,
  useDocker: false,
  legacyBundle: false,
};

function multipartResponse(request: Parameters<typeof HttpClientResponse.fromWeb>[0]) {
  const boundary = "legacy-download-test";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="metadata"',
    "Content-Type: application/json",
    "",
    JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="source/index.ts"',
    "",
    "console.log('legacy native')",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status: 200,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    }),
  );
}

function mockProxy() {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    calls,
    layer: Layer.succeed(LegacyGoProxy, {
      exec: (args) =>
        Effect.sync(() => {
          calls.push([...args]);
        }),
      execCapture: () => Effect.succeed(""),
    }),
  };
}

describe("legacy functions download", () => {
  it.live("downloads a function natively into the legacy workdir", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) =>
        request.url.endsWith("/body")
          ? Effect.succeed(multipartResponse(request))
          : Effect.succeed(legacyJsonResponse(request, 200, {})),
    });
    const proxy = mockProxy();
    const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
    const telemetry = mockLegacyTelemetryStateTracked();
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        linkedProjectCache: linkedProjectCache.layer,
        telemetry: telemetry.layer,
      }),
      proxy.layer,
    );

    return Effect.gen(function* () {
      yield* legacyFunctionsDownload(baseFlags);

      expect(proxy.calls).toEqual([]);
      expect(
        yield* Effect.tryPromise(() =>
          readFile(
            join(tempRoot.current, "supabase", "functions", "hello-world", "index.ts"),
            "utf8",
          ),
        ),
      ).toBe("console.log('legacy native')");
      expect(out.stderrText).toContain(
        "Downloaded Function hello-world from project abcdefghijklmnopqrst.",
      );
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("keeps hidden Docker compatibility mode behind the Go proxy", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const proxy = mockProxy();
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
    );

    return Effect.gen(function* () {
      yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

      expect(api.requests).toEqual([]);
      expect(proxy.calls).toEqual([
        [
          "functions",
          "download",
          "hello-world",
          "--project-ref",
          "abcdefghijklmnopqrst",
          "--use-docker",
        ],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "does not redact --project-ref in cli_command_executed (Go parity: cmd/functions.go:178)",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi({
        handler: (request) =>
          request.url.endsWith("/body")
            ? Effect.succeed(multipartResponse(request))
            : Effect.succeed(legacyJsonResponse(request, 200, {})),
      });
      const proxy = mockProxy();
      const analytics = mockContextualAnalytics();
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          analytics,
        }),
        proxy.layer,
        commandRuntimeLayer(["functions", "download"]),
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "hello-world",
            "--project-ref",
            "abcdefghijklmnopqrst",
          ]),
        }),
      );

      return Effect.gen(function* () {
        yield* legacyFunctionsDownloadHandler({
          ...baseFlags,
          projectRef: Option.some("abcdefghijklmnopqrst"),
        });

        const event = analytics.captured.find((c) => c.event === "cli_command_executed");
        expect(event?.properties.flags).toEqual({ "project-ref": "abcdefghijklmnopqrst" });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("rejects the bundler mutex with cobra's exact error text", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const proxy = mockProxy();
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "download", "--use-api", "--use-docker"]),
      }),
    );

    return Effect.gen(function* () {
      const error = yield* legacyFunctionsDownload({
        ...baseFlags,
        useApi: true,
        useDocker: true,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConflictingFunctionDownloadFlagsError);
      if (!(error instanceof ConflictingFunctionDownloadFlagsError)) {
        throw new Error(`unexpected error: ${String(error)}`);
      }
      expect(error.message).toBe(
        "if any flags in the group [use-api use-docker legacy-bundle] are set none of the others can be; [use-api use-docker] were all set",
      );
      expect(proxy.calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
