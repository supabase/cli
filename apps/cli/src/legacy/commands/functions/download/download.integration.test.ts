import { describe, expect, it } from "@effect/vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

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
import type { LegacyFunctionsDownloadFlags } from "./download.command.ts";
import { legacyFunctionsDownload } from "./download.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-functions-download-legacy-");
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
});
