import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_VERSIONS } from "@supabase/stack/effect";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Deferred, Effect, Exit, Layer, Option, PlatformError, Sink, Stdio, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
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
import { mockChildProcessSpawner } from "../../../../../../../packages/process-compose/tests/helpers/mocks.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyContainerRuntimeNotFoundMessage } from "../../../shared/legacy-container-cli.ts";
import { ConflictingFunctionDownloadFlagsError } from "../../../../shared/functions/download.errors.ts";
import { legacyFunctionsDownloadHandler } from "./download.command.ts";
import type { LegacyFunctionsDownloadFlags } from "./download.command.ts";
import { legacyFunctionsDownload } from "./download.handler.ts";

const PROJECT_ID = "abcdefghijklmnopqrst";

/**
 * Mutates the shared spawner options object from inside `onSpawn`, scoped to
 * the `docker run ... unbundle` invocation specifically — every earlier
 * Docker call (`info`, `network inspect`, `volume create`) in the same test
 * already resolved by the time this fires, since `download.ts` awaits each
 * child process sequentially, so this only ever affects the unbundle step's
 * own exit code/stdio.
 */
function mockDockerUnbundle(
  opts: {
    readonly runExitCode?: number;
    readonly runStdout?: ReadonlyArray<string>;
    readonly runStderr?: ReadonlyArray<string>;
  } = {},
) {
  const spawnerOpts: {
    exitCode?: number;
    stdout?: string[];
    stderr?: string[];
    onSpawn?: (record: { command: string; args: ReadonlyArray<string> }) => void;
  } = { exitCode: 0 };
  spawnerOpts.onSpawn = (record) => {
    if (record.command === "docker" && record.args[0] === "run") {
      spawnerOpts.exitCode = opts.runExitCode ?? 0;
      spawnerOpts.stdout = opts.runStdout === undefined ? [] : [...opts.runStdout];
      spawnerOpts.stderr = opts.runStderr === undefined ? [] : [...opts.runStderr];
    }
  };
  return mockChildProcessSpawner(spawnerOpts);
}

/**
 * A real ENOENT-style spawn failure for the `docker run ... unbundle` step
 * specifically — distinct from `mockDockerUnbundle`'s non-zero exit code,
 * which models the container starting but the `unbundle` binary itself
 * failing. This models `child_process.spawn` (or the container runtime
 * binary) never starting at all, which `runChildProcess` surfaces as an
 * `unknown` cause rather than an `{ exitCode, stdout, stderr }` result.
 * Mirrors `legacy-container-cli.unit.test.ts`'s `mockSpawner({ bothMissing:
 * true })`: failing both the `docker` and `podman` fallback attempts for the
 * `run` step is what makes `spawnContainerCli` surface
 * `legacyContainerRuntimeNotFoundMessage` instead of retrying indefinitely.
 * Every other Docker call (`info`, `network inspect`, `volume create`)
 * succeeds with exit code 0, so only the unbundle step itself fails.
 */
function mockDockerRunSpawnFailure() {
  const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const cmd = command._tag === "StandardCommand" ? command.command : "";
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push({ command: cmd, args });

      if (args[0] === "run") {
        return yield* Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: `${cmd} not found`,
          }),
        );
      }

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(0));

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1000 + spawned.length),
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  return {
    get spawned() {
      return spawned;
    },
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  };
}

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

  it.live(
    "runs the native Docker unbundle path by default (Go parity), with no flags passed",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi();
      const proxy = mockProxy();
      // Non-empty stdout/stderr on the `docker run` step exercises both the
      // text-mode stdout routing branch and the always-to-stderr container
      // stderr branch in `downloadWithDockerUnbundle`.
      const child = mockDockerUnbundle({
        runStdout: ["unbundle: wrote index.ts"],
        runStderr: ["unbundle: warning about deno.json"],
      });
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "hello-world",
            "--project-ref",
            PROJECT_ID,
          ]),
        }),
      );

      return Effect.gen(function* () {
        // `useDocker: true` mirrors what the CLI parser now resolves to by
        // default (CLI-1862) — no `--use-docker` flag appears in argv above.
        // CLI-1963: this now runs the native Docker-unbundle path instead of
        // delegating to the Go proxy.
        yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

        expect(proxy.calls).toEqual([]);
        expect(proxy.captureCalls).toEqual([]);
        expect(api.requests.some((request) => request.url.endsWith("/hello-world/body"))).toBe(
          true,
        );
        expect(
          child.spawned.some(
            (spawned) => spawned.command === "docker" && spawned.args[0] === "run",
          ),
        ).toBe(true);
        expect(out.stderrText).toContain("Downloading function: hello-world\n");
        expect(out.stdoutText).toContain("unbundle: wrote index.ts\n");
        expect(out.stderrText).toContain("unbundle: warning about deno.json\n");
        // Go parity finding (CLI-1963 audit): unlike the server-side and
        // `--legacy-bundle` paths, `downloadWithDockerUnbundle` never prints
        // a "Downloaded Function ... from project ..." success line —
        // guarded here against a future accidental regression.
        expect(out.stderrText).not.toContain("Downloaded Function");
        // No `--debug` — the temp eszip file is removed after the run.
        expect(
          existsSync(join(tempRoot.current, "supabase", ".temp", "output_hello-world.eszip")),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

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

  it.live(
    "still runs the native Docker unbundle path when --use-api=false is passed explicitly",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi();
      const proxy = mockProxy();
      const child = mockChildProcessSpawner({ exitCode: 0 });
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "hello-world",
            "--use-api=false",
            "--project-ref",
            PROJECT_ID,
          ]),
        }),
      );

      return Effect.gen(function* () {
        // Go's override is value-based (`if useApi { useDocker = false }`,
        // apps/cli-go/cmd/functions.go:51-53), not presence-based. An
        // explicit `--use-api=false` must not be treated like `--use-api` —
        // it should leave the `--use-docker` default (true) in effect and
        // still run the native Docker path (CLI-1963).
        yield* legacyFunctionsDownload({ ...baseFlags, useApi: false, useDocker: true });

        expect(proxy.calls).toEqual([]);
        expect(proxy.captureCalls).toEqual([]);
        expect(
          child.spawned.some(
            (spawned) => spawned.command === "docker" && spawned.args[0] === "run",
          ),
        ).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "emits a JSON success envelope when running the native Docker path in machine-output mode",
    () => {
      const out = mockOutput({ format: "json" });
      const api = mockLegacyPlatformApi();
      const proxy = mockProxy();
      // Non-empty container stdout exercises the machine-mode branch that
      // routes it to stderr instead of stdout (CLI-1546: stdout stays
      // payload-only in json/stream-json modes).
      const child = mockDockerUnbundle({ runStdout: ["unbundle: wrote index.ts"] });
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "hello-world",
            "--project-ref",
            PROJECT_ID,
            "--output-format",
            "json",
          ]),
        }),
      );

      return Effect.gen(function* () {
        // CLI-1963: `--use-docker` now runs the native Docker-unbundle path;
        // this asserts the JSON envelope this command emits itself still
        // shows up correctly, with no delegated Go child's stdout to worry
        // about capturing.
        yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

        expect(proxy.calls).toEqual([]);
        expect(proxy.captureCalls).toEqual([]);
        expect(
          child.spawned.some(
            (spawned) => spawned.command === "docker" && spawned.args[0] === "run",
          ),
        ).toBe(true);
        expect(out.stdoutText).toBe("");
        expect(out.stderrText).toContain("unbundle: wrote index.ts\n");
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            data: { function_slugs: ["hello-world"], project_ref: PROJECT_ID },
          }),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("lists remote functions and downloads each natively via Docker in machine mode", () => {
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
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      child.layer,
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "download",
          "--project-ref",
          PROJECT_ID,
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
      expect(proxy.captureCalls).toEqual([]);
      expect(
        child.spawned.filter(
          (spawned) => spawned.command === "docker" && spawned.args[0] === "run",
        ),
      ).toHaveLength(2);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: {
            function_slugs: ["hello-world", "goodbye-world"],
            project_ref: PROJECT_ID,
          },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("runs docker with the expected binds, network, and unbundle command", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      child.layer,
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "download",
          "hello-world",
          "--use-docker",
          "--project-ref",
          PROJECT_ID,
        ]),
      }),
    );

    return Effect.gen(function* () {
      yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

      // Go: `extractOne` (`download.go:260-266`) — bind order and network
      // reuse the same primitives `deploy.ts`'s own Docker-bundling path
      // already uses.
      expect(child.spawned.find((spawned) => spawned.args[0] === "network")).toEqual({
        command: "docker",
        args: ["network", "inspect", `supabase_network_${PROJECT_ID}`],
      });
      expect(child.spawned.find((spawned) => spawned.args[0] === "volume")).toEqual({
        command: "docker",
        args: [
          "volume",
          "create",
          "--label",
          `com.supabase.cli.project=${PROJECT_ID}`,
          "--label",
          `com.docker.compose.project=${PROJECT_ID}`,
          `supabase_edge_runtime_${PROJECT_ID}`,
        ],
      });

      const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
      const hostEszipPath = resolve(
        tempRoot.current,
        "supabase",
        ".temp",
        "output_hello-world.eszip",
      );
      const functionsDir = resolve(tempRoot.current, "supabase", "functions");
      expect(runCommand?.args).toContain(
        `supabase_edge_runtime_${PROJECT_ID}:/root/.cache/deno:rw`,
      );
      expect(runCommand?.args).toContain(
        `${hostEszipPath}:/root/eszips/output_hello-world.eszip:ro`,
      );
      expect(runCommand?.args).toContain(`${functionsDir}:/home/deno:rw`);
      expect(runCommand?.args).toContain("--network");
      expect(runCommand?.args).toContain(`supabase_network_${PROJECT_ID}`);
      // The unbundle tail is always the LAST 6 args regardless of whether
      // `--add-host` (Linux-only) was inserted before it.
      expect(runCommand?.args.slice(-6)).toEqual([
        `public.ecr.aws/supabase/edge-runtime:v${DEFAULT_VERSIONS["edge-runtime"]}`,
        "unbundle",
        "--eszip",
        "/root/eszips/output_hello-world.eszip",
        "--output",
        "/home/deno/hello-world",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("omits the named Deno cache volume bind on Bitbucket", () => {
    // Go's `DockerStart` drops the named-volume bind entirely on Bitbucket
    // (`internal/utils/docker.go:400-405`) rather than just skipping its
    // explicit creation — `docker run -v <name>:...` would otherwise still
    // implicitly create the named volume, which Bitbucket's restricted Docker
    // environment doesn't allow (review round on CLI-1963's `functions
    // download` port; `deploy.ts`'s `buildDockerBinds` already applies this
    // same carve-out).
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      child.layer,
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "download",
          "hello-world",
          "--use-docker",
          "--project-ref",
          PROJECT_ID,
        ]),
      }),
    );

    const previousBitbucketCloneDir = process.env["BITBUCKET_CLONE_DIR"];
    process.env["BITBUCKET_CLONE_DIR"] = "/opt/atlassian/pipelines/agent/build";

    return Effect.gen(function* () {
      yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

      const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
      expect(runCommand?.args).not.toContain(
        `supabase_edge_runtime_${PROJECT_ID}:/root/.cache/deno:rw`,
      );
      const hostEszipPath = resolve(
        tempRoot.current,
        "supabase",
        ".temp",
        "output_hello-world.eszip",
      );
      expect(runCommand?.args).toContain(
        `${hostEszipPath}:/root/eszips/output_hello-world.eszip:ro`,
      );
    })
      .pipe(Effect.provide(layer))
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousBitbucketCloneDir === undefined) {
              delete process.env["BITBUCKET_CLONE_DIR"];
            } else {
              process.env["BITBUCKET_CLONE_DIR"] = previousBitbucketCloneDir;
            }
          }),
        ),
      );
  });

  it.live("requests the raw eszip body instead of a negotiated JSON response", () => {
    // `v1GetAFunctionBody`'s generated contract marks its response
    // `kind: "json"`, so `executeRaw` would otherwise default to
    // `Accept: application/json` (`buildRequest`'s unconditional `acceptJson`
    // for json-kind operations) and risk a negotiated JSON response instead
    // of the raw eszip body Go's un-overridden request receives (review round
    // on CLI-1963's `functions download` port).
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      child.layer,
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "download",
          "hello-world",
          "--use-docker",
          "--project-ref",
          PROJECT_ID,
        ]),
      }),
    );

    return Effect.gen(function* () {
      yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

      const bodyRequest = api.requests.find((request) => request.url.endsWith("/hello-world/body"));
      expect(bodyRequest?.headers["accept"]).toBe("*/*");
    }).pipe(Effect.provide(layer));
  });

  it.live("uses an explicit --network-id override instead of the derived network name", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      child.layer,
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "download",
          "hello-world",
          "--use-docker",
          "--project-ref",
          PROJECT_ID,
          "--network-id",
          "custom-network",
        ]),
      }),
    );

    return Effect.gen(function* () {
      // `--network-id` is a persistent root flag (`cmd/root.go:328`), not
      // registered on `functions download` itself —
      // `explicitNonEmptyStringFlag` scans the whole argv unscoped.
      yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

      expect(child.spawned.find((spawned) => spawned.args[0] === "network")).toEqual({
        command: "docker",
        args: ["network", "inspect", "custom-network"],
      });
      const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
      expect(runCommand?.args).toContain("custom-network");
      expect(runCommand?.args).not.toContain(`supabase_network_${PROJECT_ID}`);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "falls back to the generated network name when --network-id is passed with an empty value",
    () => {
      // Go only overrides the network when `len(viper.GetString("network-id")) > 0`
      // (`internal/utils/docker.go:379-382`) — an explicit-but-empty
      // `--network-id=` must fall through to the generated network name just
      // like an omitted flag (review round on CLI-1963's `functions download`
      // port).
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi();
      const proxy = mockProxy();
      const child = mockChildProcessSpawner({ exitCode: 0 });
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "hello-world",
            "--use-docker",
            "--project-ref",
            PROJECT_ID,
            "--network-id=",
          ]),
        }),
      );

      return Effect.gen(function* () {
        yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

        expect(child.spawned.find((spawned) => spawned.args[0] === "network")).toEqual({
          command: "docker",
          args: ["network", "inspect", `supabase_network_${PROJECT_ID}`],
        });
        const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
        expect(runCommand?.args).toContain(`supabase_network_${PROJECT_ID}`);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("does not double-prefix an already v-prefixed edge-runtime-version pin", () => {
    // Go's `replaceImageTag` (`pkg/config/utils.go:81-84`) appends the pin
    // file's raw content verbatim after the image's `:`, so a pin already
    // carrying its own `v` prefix (a legitimate form — see
    // `legacy-edge-runtime-image.unit.test.ts`'s own `"v9.9.9"` fixture) must
    // not be prepended with a second `v` (review round on CLI-1963's
    // `functions download` port).
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      child.layer,
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "download",
          "hello-world",
          "--use-docker",
          "--project-ref",
          PROJECT_ID,
        ]),
      }),
    );

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        mkdir(join(tempRoot.current, "supabase", ".temp"), { recursive: true }),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", ".temp", "edge-runtime-version"), "v9.9.9\n"),
      );

      yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

      const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
      expect(runCommand?.args.slice(-6)[0]).toBe("public.ecr.aws/supabase/edge-runtime:v9.9.9");
    }).pipe(Effect.provide(layer));
  });

  it.live("keeps the temporary eszip file when --debug is passed", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      child.layer,
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "download",
          "hello-world",
          "--use-docker",
          "--project-ref",
          PROJECT_ID,
          "--debug",
        ]),
      }),
    );

    return Effect.gen(function* () {
      yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true });

      expect(
        existsSync(join(tempRoot.current, "supabase", ".temp", "output_hello-world.eszip")),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "fails on an invalid project config before falling back when Docker is not running",
    () => {
      // Go's `Run` calls `flags.LoadConfig(fsys)` unconditionally at the very
      // top, before checking whether Docker is running (`download.go:135-138`)
      // — an invalid `supabase/config.toml` must fail up front instead of
      // silently falling through to the server-side path's API/filesystem
      // side effects (review round on CLI-1963's `functions download` port).
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi();
      const proxy = mockProxy();
      // Every docker command (including the `docker info` probe) fails,
      // modeling Docker not running.
      const child = mockChildProcessSpawner({ exitCode: 1 });
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "hello-world",
            "--project-ref",
            PROJECT_ID,
          ]),
        }),
      );

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          mkdir(join(tempRoot.current, "supabase"), { recursive: true }),
        );
        yield* Effect.tryPromise(() =>
          writeFile(
            join(tempRoot.current, "supabase", "config.toml"),
            ["[edge_runtime]", "deno_version = 3", ""].join("\n"),
          ),
        );

        const error = yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true }).pipe(
          Effect.flip,
        );

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "Failed reading config: Invalid edge_runtime.deno_version: 3.",
        );
        expect(api.requests).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  describe("docker unbundle container failures", () => {
    it.live("fails with the legacy-bundle suggestion when the container exits non-zero", () => {
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi();
      const proxy = mockProxy();
      const child = mockDockerUnbundle({ runExitCode: 1, runStderr: ["boom"] });
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "hello-world",
            "--use-docker",
            "--project-ref",
            PROJECT_ID,
          ]),
        }),
      );

      return Effect.gen(function* () {
        const error = yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true }).pipe(
          Effect.flip,
        );

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("error running container: exit 1");
        expect((error as Error & { suggestion?: string }).suggestion).toBe(
          "\nIf your function is deployed using CLI < 1.120.0, trying running supabase functions download --legacy-bundle hello-world instead.",
        );
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "prepends the deno v2 suggestion when deno_version is 1 and the container reports an invalid eszip",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockLegacyPlatformApi();
        const proxy = mockProxy();
        const child = mockDockerUnbundle({
          runExitCode: 1,
          // Go's scanner requires a full-line, case-insensitive match
          // (`strings.EqualFold(line, "invalid eszip v2")`, `download.go:295`)
          // — a line merely containing the phrase as a substring (e.g.
          // "error: invalid eszip v2 header") does not fire the suggestion.
          runStderr: ["invalid eszip v2"],
        });
        const layer = Layer.mergeAll(
          buildLegacyTestRuntime({
            out,
            api,
            cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          }),
          proxy.layer,
          child.layer,
          Stdio.layerTest({
            args: Effect.succeed([
              "functions",
              "download",
              "hello-world",
              "--use-docker",
              "--project-ref",
              PROJECT_ID,
            ]),
          }),
        );

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            mkdir(join(tempRoot.current, "supabase"), { recursive: true }),
          );
          yield* Effect.tryPromise(() =>
            writeFile(
              join(tempRoot.current, "supabase", "config.toml"),
              ["[edge_runtime]", "deno_version = 1", ""].join("\n"),
            ),
          );

          const error = yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true }).pipe(
            Effect.flip,
          );

          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe("error running container: exit 1");
          expect((error as Error & { suggestion?: string }).suggestion).toBe(
            "Please use deno v2 in supabase/config.toml to download this Function:\n\n[edge_runtime]\ndeno_version = 2\n" +
              "\nIf your function is deployed using CLI < 1.120.0, trying running supabase functions download --legacy-bundle hello-world instead.",
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "does not prepend the deno v2 suggestion when deno_version is 1 but the container's error is unrelated",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockLegacyPlatformApi();
        const proxy = mockProxy();
        const child = mockDockerUnbundle({ runExitCode: 1, runStderr: ["permission denied"] });
        const layer = Layer.mergeAll(
          buildLegacyTestRuntime({
            out,
            api,
            cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          }),
          proxy.layer,
          child.layer,
          Stdio.layerTest({
            args: Effect.succeed([
              "functions",
              "download",
              "hello-world",
              "--use-docker",
              "--project-ref",
              PROJECT_ID,
            ]),
          }),
        );

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            mkdir(join(tempRoot.current, "supabase"), { recursive: true }),
          );
          yield* Effect.tryPromise(() =>
            writeFile(
              join(tempRoot.current, "supabase", "config.toml"),
              ["[edge_runtime]", "deno_version = 1", ""].join("\n"),
            ),
          );

          const error = yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true }).pipe(
            Effect.flip,
          );

          expect((error as Error & { suggestion?: string }).suggestion).toBe(
            "\nIf your function is deployed using CLI < 1.120.0, trying running supabase functions download --legacy-bundle hello-world instead.",
          );
        }).pipe(Effect.provide(layer));
      },
    );
  });

  it.live("fails when ensureDockerNetwork can't create a missing network", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const proxy = mockProxy();
    const spawnerOpts: {
      exitCode?: number;
      stderr?: string[];
      onSpawn?: (record: { command: string; args: ReadonlyArray<string> }) => void;
    } = { exitCode: 0 };
    spawnerOpts.onSpawn = (record) => {
      spawnerOpts.exitCode = record.command === "docker" && record.args[0] === "network" ? 1 : 0;
      spawnerOpts.stderr = ["permission denied"];
    };
    const child = mockChildProcessSpawner(spawnerOpts);
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      child.layer,
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "download",
          "hello-world",
          "--use-docker",
          "--project-ref",
          PROJECT_ID,
        ]),
      }),
    );

    return Effect.gen(function* () {
      const error = yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true }).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `failed to create docker network: supabase_network_${PROJECT_ID}`,
      );
      expect(child.spawned.some((spawned) => spawned.args[0] === "volume")).toBe(false);
      expect(child.spawned.some((spawned) => spawned.args[0] === "run")).toBe(false);
      // Go parity fix (CLI-1963 review): `Effect.ensuring` wraps the whole
      // Docker-extraction sequence, so the temp eszip written just before it
      // is still cleaned up even though the failure happened before Docker
      // ever ran — not only after a successful `runChildProcess` call.
      expect(
        existsSync(join(tempRoot.current, "supabase", ".temp", "output_hello-world.eszip")),
      ).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "fails with the docker-step prefix when the unbundle container itself cannot be spawned",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi();
      const proxy = mockProxy();
      const child = mockDockerRunSpawnFailure();
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "download",
            "hello-world",
            "--use-docker",
            "--project-ref",
            PROJECT_ID,
          ]),
        }),
      );

      return Effect.gen(function* () {
        const error = yield* legacyFunctionsDownload({ ...baseFlags, useDocker: true }).pipe(
          Effect.flip,
        );

        // Distinct from `ensureDockerNetwork`/`ensureDockerNamedVolume`
        // failures (asserted above), which already self-describe and must
        // NOT gain this prefix — a bare spawn/runtime-not-found failure from
        // `runChildProcess` itself carries no context of its own about which
        // command was running, so `withDockerStepFailure` adds one.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          `failed to run the edge-runtime unbundle container: ${legacyContainerRuntimeNotFoundMessage}`,
        );
        expect((error as Error & { suggestion?: string }).suggestion).toBe(
          "\nIf your function is deployed using CLI < 1.120.0, trying running supabase functions download --legacy-bundle hello-world instead.",
        );
        expect(child.spawned.some((spawned) => spawned.args[0] === "run")).toBe(true);
        expect(
          existsSync(join(tempRoot.current, "supabase", ".temp", "output_hello-world.eszip")),
        ).toBe(false);
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
      // Deterministic stand-in for `emptyEnv()`'s real `ChildProcessSpawner`
      // (via `BunServices`, pulled in by `buildLegacyTestRuntime`) — `useDocker:
      // true` still probes `docker info` even though this project has no
      // functions to download, so this must not spawn a real `docker` process.
      const child = mockChildProcessSpawner({ exitCode: 0 });
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        child.layer,
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
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      child.layer,
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
