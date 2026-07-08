import { describe, expect, it } from "@effect/vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Exit, Layer, Option, Stdio } from "effect";
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
  const envs: Array<Record<string, string> | undefined> = [];
  const captureCalls: Array<ReadonlyArray<string>> = [];
  const captureEnvs: Array<Record<string, string> | undefined> = [];
  return {
    calls,
    envs,
    captureCalls,
    captureEnvs,
    layer: Layer.succeed(LegacyGoProxy, {
      exec: (args, opts) =>
        Effect.sync(() => {
          calls.push([...args]);
          envs.push(opts?.env);
        }),
      execCapture: (args, opts) =>
        Effect.sync(() => {
          captureCalls.push([...args]);
          captureEnvs.push(opts?.env);
          return "";
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

  it.live("proxies to Docker by default (Go parity), with no flags passed", () => {
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
      // `useDocker: true` mirrors what the CLI parser now resolves to by
      // default (CLI-1862) — no `--use-docker` flag appears in argv above.
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
      // The delegated Go binary must not also fire its own
      // `cli_command_executed` on top of this command's own instrumentation.
      expect(proxy.envs).toEqual([{ SUPABASE_TELEMETRY_DISABLED: "1" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "does not treat the --use-docker default as conflicting with an explicit --use-api",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi({
        handler: (request) =>
          request.url.endsWith("/body")
            ? Effect.succeed(multipartResponse(request))
            : Effect.succeed(legacyJsonResponse(request, 200, {})),
      });
      const proxy = mockProxy();
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "hello-world",
            "--use-api",
            "--project-ref",
            "abcdefghijklmnopqrst",
          ]),
        }),
      );

      return Effect.gen(function* () {
        // The CLI parser resolves `useDocker: true` here too (its default),
        // even though only `--use-api` was passed explicitly. Neither the
        // mutex check nor the routing decision should treat that default as
        // if the user had asked for Docker.
        yield* legacyFunctionsDownload({ ...baseFlags, useApi: true, useDocker: true });

        expect(proxy.calls).toEqual([]);
        expect(
          yield* Effect.tryPromise(() =>
            readFile(
              join(tempRoot.current, "supabase", "functions", "hello-world", "index.ts"),
              "utf8",
            ),
          ),
        ).toBe("console.log('legacy native')");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("still proxies to Docker when --use-api=false is passed explicitly", () => {
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
        args: Effect.succeed([
          "functions",
          "download",
          "hello-world",
          "--use-api=false",
          "--project-ref",
          "abcdefghijklmnopqrst",
        ]),
      }),
    );

    return Effect.gen(function* () {
      // Go's override is value-based (`if useApi { useDocker = false }`,
      // apps/cli-go/cmd/functions.go:51-53), not presence-based. An explicit
      // `--use-api=false` must not be treated like `--use-api` — it should
      // leave the `--use-docker` default (true) in effect and still proxy.
      yield* legacyFunctionsDownload({ ...baseFlags, useApi: false, useDocker: true });

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
      expect(proxy.envs).toEqual([{ SUPABASE_TELEMETRY_DISABLED: "1" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success envelope when proxying to Docker in machine-output mode", () => {
    const out = mockOutput({ format: "json" });
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
        args: Effect.succeed([
          "functions",
          "download",
          "hello-world",
          "--project-ref",
          "abcdefghijklmnopqrst",
          "--output-format",
          "json",
        ]),
      }),
    );

    return Effect.gen(function* () {
      // CLI-1546: stdout is payload-only in machine mode, so the Go child's
      // raw output must be captured/discarded (not inherited) and this
      // command must emit the `Output` envelope itself, matching the native
      // path's shape.
      yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

      expect(proxy.calls).toEqual([]);
      expect(proxy.captureCalls).toEqual([
        [
          "functions",
          "download",
          "hello-world",
          "--project-ref",
          "abcdefghijklmnopqrst",
          "--use-docker",
        ],
      ]);
      expect(proxy.captureEnvs).toEqual([{ SUPABASE_TELEMETRY_DISABLED: "1" }]);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: { function_slugs: ["hello-world"], project_ref: "abcdefghijklmnopqrst" },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "lists remote functions before delegating when no function name is given in machine mode",
    () => {
      const out = mockOutput({ format: "json" });
      const api = mockLegacyPlatformApi({
        handler: (request) =>
          request.url.endsWith("/functions")
            ? Effect.succeed(
                legacyJsonResponse(request, 200, [
                  { slug: "hello-world" },
                  { slug: "goodbye-world" },
                ]),
              )
            : Effect.succeed(legacyJsonResponse(request, 200, {})),
      });
      const proxy = mockProxy();
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "--project-ref",
            "abcdefghijklmnopqrst",
            "--output-format",
            "json",
          ]),
        }),
      );

      return Effect.gen(function* () {
        yield* legacyFunctionsDownload({
          ...baseFlags,
          functionName: Option.none(),
          useDocker: true,
        });

        expect(proxy.calls).toEqual([]);
        expect(proxy.captureCalls).toEqual([
          ["functions", "download", "--project-ref", "abcdefghijklmnopqrst", "--use-docker"],
        ]);
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            data: {
              function_slugs: ["hello-world", "goodbye-world"],
              project_ref: "abcdefghijklmnopqrst",
            },
          }),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "reports no functions found without delegating when the project is empty in machine mode",
    () => {
      const out = mockOutput({ format: "json" });
      const api = mockLegacyPlatformApi({
        handler: (request) =>
          request.url.endsWith("/functions")
            ? Effect.succeed(legacyJsonResponse(request, 200, []))
            : Effect.succeed(legacyJsonResponse(request, 200, {})),
      });
      const proxy = mockProxy();
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "--project-ref",
            "abcdefghijklmnopqrst",
            "--output-format",
            "json",
          ]),
        }),
      );

      return Effect.gen(function* () {
        // An empty project has nothing to delegate — this must match the
        // native path's "No functions found." short-circuit instead of
        // still invoking the Go/Docker child and reporting a misleading
        // "Downloaded Edge Function source." success with an empty list.
        yield* legacyFunctionsDownload({
          ...baseFlags,
          functionName: Option.none(),
          useDocker: true,
        });

        expect(proxy.calls).toEqual([]);
        expect(proxy.captureCalls).toEqual([]);
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            message: "No functions found.",
            data: { function_slugs: [], project_ref: "abcdefghijklmnopqrst" },
          }),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails before delegating when the pre-flight function list fails in machine mode", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      handler: (request) =>
        request.url.endsWith("/functions")
          ? Effect.succeed(legacyJsonResponse(request, 500, { message: "unavailable" }))
          : Effect.succeed(legacyJsonResponse(request, 200, {})),
    });
    const proxy = mockProxy();
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "download",
          "--project-ref",
          "abcdefghijklmnopqrst",
          "--output-format",
          "json",
        ]),
      }),
    );

    return Effect.gen(function* () {
      // The pre-flight list failure must be reported before any download
      // side effect — the delegated proxy must never be invoked (CLI-1862
      // review: a listing failure after a successful delegated download
      // must not mask that success).
      const exit = yield* legacyFunctionsDownload({
        ...baseFlags,
        functionName: Option.none(),
        useDocker: true,
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(proxy.calls).toEqual([]);
      expect(proxy.captureCalls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards only --legacy-bundle to the Go proxy, not the --use-docker default too", () => {
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
        args: Effect.succeed([
          "functions",
          "download",
          "hello-world",
          "--legacy-bundle",
          "--project-ref",
          "abcdefghijklmnopqrst",
        ]),
      }),
    );

    return Effect.gen(function* () {
      // `useDocker: true` mirrors the CLI parser's default (CLI-1862) even
      // though only `--legacy-bundle` was passed explicitly. The Go proxy
      // call must not forward both, or the Go binary's own
      // MarkFlagsMutuallyExclusive rejects the combination.
      yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true, legacyBundle: true });

      expect(proxy.calls).toEqual([
        [
          "functions",
          "download",
          "hello-world",
          "--project-ref",
          "abcdefghijklmnopqrst",
          "--legacy-bundle",
        ],
      ]);
      expect(proxy.envs).toEqual([{ SUPABASE_TELEMETRY_DISABLED: "1" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects an invalid slug before ever reaching the Go proxy", () => {
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
        args: Effect.succeed([
          "functions",
          "download",
          "../../etc",
          "--project-ref",
          "abcdefghijklmnopqrst",
        ]),
      }),
    );

    return Effect.gen(function* () {
      // `useDocker: true` is the real default (CLI-1862). Before this fix,
      // slug validation only ran on the native path, so a malformed slug
      // would sail past it and straight into the Go proxy argv.
      const exit = yield* legacyFunctionsDownload({
        ...baseFlags,
        functionName: Option.some("../../etc"),
        useDocker: true,
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(proxy.calls).toEqual([]);
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
