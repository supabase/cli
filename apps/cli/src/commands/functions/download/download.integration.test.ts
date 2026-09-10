import { describe, expect, it } from "@effect/vitest";
import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Deferred, Effect, Exit, Layer, Option, PlatformError, Sink, Stdio, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { CurrentAnalyticsContext } from "../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import {
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { mockChildProcessSpawner } from "../../../../tests/helpers/child-process-spawner.ts";
import { GoProxy } from "../../../command-internal/go-proxy.service.ts";
import { containerRuntimeNotFoundMessage } from "../../../command-internal/container-cli.ts";
import { downloadFunctions } from "../../../shared/functions/download.ts";
import { functionsGoConfigCompat } from "../../../command-internal/functions-go-config.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ConflictingFunctionDownloadFlagsError } from "../../../shared/functions/download.errors.ts";
import { FunctionsApiStatusError } from "../../../shared/functions/functions-api.errors.ts";
import { functionsDownloadHandler } from "./download.command.ts";
import type { FunctionsDownloadFlags } from "./download.command.ts";
import { functionsDownload } from "./download.handler.ts";

const PROJECT_ID = "abcdefghijklmnopqrst";

/**
 * Sets the spawner's exit code/stdio only for the `docker run ... unbundle`
 * step; earlier Docker calls in the same test already resolved by the time
 * this fires, since `download.ts` awaits each child process sequentially.
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
 * Models `docker run ... unbundle` never starting at all (ENOENT), distinct
 * from `mockDockerUnbundle`'s non-zero exit code, which models the container
 * starting but the `unbundle` binary failing. `runChildProcess` surfaces this
 * as an `unknown` cause rather than `{ exitCode, stdout, stderr }`. Every
 * other Docker call succeeds so only the unbundle step fails.
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

const tempRoot = useTempWorkdir("supabase-functions-download-legacy-");

// `withCommandTelemetry` threads `flags`/`command` through
// `CurrentAnalyticsContext`, not `capture()`'s own args, so this merges it manually.
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
const baseFlags: FunctionsDownloadFlags = {
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
    layer: Layer.succeed(GoProxy, {
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

describe("functions download", () => {
  it.live("downloads a function natively into the legacy workdir", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        request.url.endsWith("/body")
          ? Effect.succeed(multipartResponse(request))
          : Effect.succeed(jsonResponse(request, 200, {})),
    });
    const proxy = mockProxy();
    const linkedProjectCache = mockLinkedProjectCacheTracked();
    const telemetry = mockTelemetryStateTracked();
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      yield* functionsDownload(baseFlags);

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
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      // Non-empty stdout/stderr exercises both the text-mode stdout routing
      // and always-to-stderr branches in `downloadWithDockerUnbundle`.
      const child = mockDockerUnbundle({
        runStdout: ["unbundle: wrote index.ts"],
        runStderr: ["unbundle: warning about deno.json"],
      });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        yield* functionsDownload({ ...baseFlags, useDocker: true });

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
        // Unlike the server-side and --legacy-bundle paths, the native Docker
        // path never prints a "Downloaded Function ..." success line.
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
      const api = mockCommandPlatformApi({
        handler: (request) =>
          request.url.endsWith("/body")
            ? Effect.succeed(multipartResponse(request))
            : Effect.succeed(jsonResponse(request, 200, {})),
      });
      const proxy = mockProxy();
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        // `useDocker: true` reflects the flag's own default, unaffected by
        // the explicit `--use-api`.
        yield* functionsDownload({ ...baseFlags, useApi: true, useDocker: true });

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
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      const child = mockChildProcessSpawner({ exitCode: 0 });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        // The override is value-based, not presence-based: an explicit
        // `--use-api=false` leaves `--use-docker`'s own default (true) in effect.
        yield* functionsDownload({ ...baseFlags, useApi: false, useDocker: true });

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
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      // Non-empty container stdout exercises the machine-mode branch that
      // routes it to stderr, keeping stdout payload-only.
      const child = mockDockerUnbundle({ runStdout: ["unbundle: wrote index.ts"] });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        yield* functionsDownload({ ...baseFlags, useDocker: true });

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
    const api = mockCommandPlatformApi({
      handler: (request) =>
        request.url.endsWith("/functions")
          ? Effect.succeed(
              jsonResponse(request, 200, [{ slug: "hello-world" }, { slug: "goodbye-world" }]),
            )
          : Effect.succeed(jsonResponse(request, 200, {})),
    });
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      yield* functionsDownload({
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
      // The edge-runtime image is resolved/pulled once per invocation, not
      // once per function; see `PulledEdgeRuntimeImage` in `download.ts`.
      expect(
        child.spawned.filter(
          (spawned) =>
            spawned.command === "docker" &&
            spawned.args[0] === "image" &&
            spawned.args[1] === "inspect",
        ),
      ).toHaveLength(1);
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
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      yield* functionsDownload({ ...baseFlags, useDocker: true });

      // Bind order and network reuse the same primitives as `deploy.ts`'s
      // own Docker-bundling path.
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
      // The unbundle tail is always the last 6 args regardless of whether
      // `--add-host` (Linux-only) was inserted before it.
      expect(runCommand?.args.slice(-6)).toEqual([
        `public.ecr.aws/${dockerfileServiceImage("edgeruntime")}`,
        "unbundle",
        "--eszip",
        "/root/eszips/output_hello-world.eszip",
        "--output",
        "/home/deno/hello-world",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("omits the named Deno cache volume bind on Bitbucket", () => {
    // The bind is dropped entirely, not just its explicit creation step:
    // `docker run -v <name>:...` would otherwise still implicitly create the
    // volume, which Bitbucket's restricted Docker environment disallows.
    // `deploy.ts`'s `buildDockerBinds` applies the same carve-out.
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      yield* functionsDownload({ ...baseFlags, useDocker: true });

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
    // The generated contract marks this response `kind: "json"`, so
    // `executeRaw` would otherwise default to `Accept: application/json` and
    // risk a negotiated response instead of the raw eszip body.
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      yield* functionsDownload({ ...baseFlags, useDocker: true });

      const bodyRequest = api.requests.find((request) => request.url.endsWith("/hello-world/body"));
      expect(bodyRequest?.headers["accept"]).toBe("*/*");
    }).pipe(Effect.provide(layer));
  });

  it.live("uses an explicit --network-id override instead of the derived network name", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      // `--network-id` is a persistent root flag, not registered on
      // `functions download` itself, so `lastExplicitLongFlagValue` scans the
      // whole argv unscoped.
      yield* functionsDownload({ ...baseFlags, useDocker: true });

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
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      const child = mockChildProcessSpawner({ exitCode: 0 });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        yield* functionsDownload({ ...baseFlags, useDocker: true });

        expect(child.spawned.find((spawned) => spawned.args[0] === "network")).toEqual({
          command: "docker",
          args: ["network", "inspect", `supabase_network_${PROJECT_ID}`],
        });
        const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
        expect(runCommand?.args).toContain(`supabase_network_${PROJECT_ID}`);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("honors the final occurrence of a repeated --network-id flag", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
          "old-network",
          "--network-id",
          "custom-network",
        ]),
      }),
    );

    return Effect.gen(function* () {
      yield* functionsDownload({ ...baseFlags, useDocker: true });

      const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
      expect(runCommand?.args).toContain("custom-network");
      expect(runCommand?.args).not.toContain("old-network");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "falls back to the generated network name when the final --network-id occurrence is empty",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      const child = mockChildProcessSpawner({ exitCode: 0 });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
            "--network-id=",
          ]),
        }),
      );

      return Effect.gen(function* () {
        yield* functionsDownload({ ...baseFlags, useDocker: true });

        const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
        expect(runCommand?.args).toContain(`supabase_network_${PROJECT_ID}`);
        expect(runCommand?.args).not.toContain("custom-network");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "does not climb to an ancestor project's config.toml for the Docker download path",
    () => {
      // No ancestor climb: `resolveEdgeRuntimeImage` uses `search: false`, so
      // a nested workdir without its own config.toml falls back to
      // `--project-ref` rather than an ancestor's `project_id`.
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      const child = mockChildProcessSpawner({ exitCode: 0 });
      const nestedWorkdir = join(tempRoot.current, "nested");
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: nestedWorkdir }),
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
        yield* Effect.tryPromise(() => mkdir(nestedWorkdir, { recursive: true }));
        yield* Effect.tryPromise(() =>
          mkdir(join(tempRoot.current, "supabase"), { recursive: true }),
        );
        yield* Effect.tryPromise(() =>
          writeFile(
            join(tempRoot.current, "supabase", "config.toml"),
            ['project_id = "ancestor-project"', ""].join("\n"),
          ),
        );

        yield* functionsDownload({ ...baseFlags, useDocker: true });

        expect(child.spawned.find((spawned) => spawned.args[0] === "network")).toEqual({
          command: "docker",
          args: ["network", "inspect", `supabase_network_${PROJECT_ID}`],
        });
        const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
        expect(runCommand?.args).toContain(`supabase_network_${PROJECT_ID}`);
        expect(runCommand?.args).not.toContain("supabase_network_ancestor-project");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("prefers config.toml over a stray config.json for the Docker download path", () => {
    // Uses `resolveEdgeRuntimeImage`'s `tomlOnly: true`, so a workdir with
    // both files resolves `project_id` from config.toml, not config.json.
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
          ['project_id = "toml-project"', ""].join("\n"),
        ),
      );
      yield* Effect.tryPromise(() =>
        writeFile(
          join(tempRoot.current, "supabase", "config.json"),
          JSON.stringify({ project_id: "json-project" }),
        ),
      );

      yield* functionsDownload({ ...baseFlags, useDocker: true });

      const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
      expect(runCommand?.args).toContain("supabase_network_toml-project");
      expect(runCommand?.args).not.toContain("supabase_network_json-project");
    }).pipe(Effect.provide(layer));
  });

  it.live("skips network creation for a container: network mode", () => {
    // `--network-id container:redis` attaches to another container's network
    // stack, so no network is inspected or created for it; the mode is
    // passed straight through to `docker run --network`.
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
          "container:redis",
        ]),
      }),
    );

    return Effect.gen(function* () {
      yield* functionsDownload({ ...baseFlags, useDocker: true });

      expect(child.spawned.find((spawned) => spawned.args[0] === "network")).toBeUndefined();
      const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
      expect(runCommand?.args).toContain("container:redis");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not double-prefix an already v-prefixed edge-runtime-version pin", () => {
    // The pin file's raw content is appended verbatim after the image's `:`,
    // so an already-`v`-prefixed pin (see edge-runtime-image.unit.test.ts)
    // must not get a second `v`.
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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

      yield* functionsDownload({ ...baseFlags, useDocker: true });

      const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
      expect(runCommand?.args.slice(-6)[0]).toBe("public.ecr.aws/supabase/edge-runtime:v9.9.9");
    }).pipe(Effect.provide(layer));
  });

  it.live("keeps the temporary eszip file when --debug is passed", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      yield* functionsDownload({ ...baseFlags, useDocker: true });

      expect(
        existsSync(join(tempRoot.current, "supabase", ".temp", "output_hello-world.eszip")),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "removes the temporary eszip file when --debug=false overrides the flag's own presence",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      const child = mockChildProcessSpawner({ exitCode: 0 });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
            "--debug=false",
          ]),
        }),
      );

      return Effect.gen(function* () {
        yield* functionsDownload({ ...baseFlags, useDocker: true });

        expect(
          existsSync(join(tempRoot.current, "supabase", ".temp", "output_hello-world.eszip")),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "fails on an invalid project config before falling back when Docker is not running",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      // Every docker command (including the `docker info` probe) fails,
      // modeling Docker not running.
      const child = mockChildProcessSpawner({ exitCode: 1 });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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

        const error = yield* functionsDownload({ ...baseFlags, useDocker: true }).pipe(Effect.flip);

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
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      const child = mockDockerUnbundle({ runExitCode: 1, runStderr: ["boom"] });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        const error = yield* functionsDownload({ ...baseFlags, useDocker: true }).pipe(Effect.flip);

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
        const api = mockCommandPlatformApi();
        const proxy = mockProxy();
        const child = mockDockerUnbundle({
          runExitCode: 1,
          // Full-line, case-insensitive match required; a substring like
          // "error: invalid eszip v2 header" would not fire the suggestion.
          runStderr: ["invalid eszip v2"],
        });
        const layer = Layer.mergeAll(
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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

          const error = yield* functionsDownload({ ...baseFlags, useDocker: true }).pipe(
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
        const api = mockCommandPlatformApi();
        const proxy = mockProxy();
        const child = mockDockerUnbundle({ runExitCode: 1, runStderr: ["permission denied"] });
        const layer = Layer.mergeAll(
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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

          const error = yield* functionsDownload({ ...baseFlags, useDocker: true }).pipe(
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
    const api = mockCommandPlatformApi();
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
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      const error = yield* functionsDownload({ ...baseFlags, useDocker: true }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `failed to create docker network: supabase_network_${PROJECT_ID}`,
      );
      expect(child.spawned.some((spawned) => spawned.args[0] === "volume")).toBe(false);
      expect(child.spawned.some((spawned) => spawned.args[0] === "run")).toBe(false);
      // `Effect.ensuring` wraps the whole Docker-extraction sequence, so the
      // temp eszip is cleaned up even though the failure happened before
      // Docker ever ran.
      expect(
        existsSync(join(tempRoot.current, "supabase", ".temp", "output_hello-world.eszip")),
      ).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "fails with the docker-step prefix when the unbundle container itself cannot be spawned",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      const child = mockDockerRunSpawnFailure();
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        const error = yield* functionsDownload({ ...baseFlags, useDocker: true }).pipe(Effect.flip);

        // Distinct from the self-describing `ensureDockerNetwork`/
        // `ensureDockerNamedVolume` failures above: a bare spawn/runtime-not-found
        // failure carries no context of its own, so `withDockerStepFailure` adds one.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          `failed to run the edge-runtime unbundle container: ${containerRuntimeNotFoundMessage}`,
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
      const api = mockCommandPlatformApi({
        handler: (request) =>
          request.url.endsWith("/functions")
            ? Effect.succeed(jsonResponse(request, 200, []))
            : Effect.succeed(jsonResponse(request, 200, {})),
      });
      const proxy = mockProxy();
      // Stand-in for the real `ChildProcessSpawner`: `useDocker: true` still
      // probes `docker info` even with no functions to download, so this must
      // not spawn a real `docker` process.
      const child = mockChildProcessSpawner({ exitCode: 0 });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        yield* functionsDownload({
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
    const api = mockCommandPlatformApi({
      handler: (request) =>
        request.url.endsWith("/functions")
          ? Effect.succeed(jsonResponse(request, 500, { message: "unavailable" }))
          : Effect.succeed(jsonResponse(request, 200, {})),
    });
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      const exit = yield* functionsDownload({
        ...baseFlags,
        functionName: Option.none(),
        useDocker: true,
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(proxy.calls).toEqual([]);
      expect(proxy.captureCalls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails loudly instead of silently dropping a malformed function-list entry", () => {
    // A missing "slug" key decodes to the empty string, then fails
    // `ValidateFunctionSlug` in `downloadAll` rather than being silently
    // dropped from the list.
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        request.url.endsWith("/functions")
          ? Effect.succeed(jsonResponse(request, 200, [{}]))
          : Effect.succeed(jsonResponse(request, 200, {})),
    });
    const proxy = mockProxy();
    const child = mockChildProcessSpawner({ exitCode: 0 });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      const exit = yield* functionsDownload({
        ...baseFlags,
        functionName: Option.none(),
        useDocker: true,
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(proxy.calls).toEqual([]);
      expect(out.messages).not.toContainEqual(
        expect.objectContaining({ type: "success", message: "No functions found." }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "attaches the first function's on-disk directory to the failure when a later function's download fails",
    () => {
      // The failure must carry the first function's already-written directory
      // via `writtenSoFar`, since `pull.aggregate.ts`'s `hasWrittenSoFar`
      // needs it to avoid claiming `written: []` on a partial success.
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) =>
          request.url.endsWith("/functions")
            ? Effect.succeed(
                jsonResponse(request, 200, [{ slug: "hello-world" }, { slug: "goodbye-world" }]),
              )
            : request.url.endsWith("/hello-world/body")
              ? Effect.succeed(multipartResponse(request))
              : request.url.endsWith("/goodbye-world/body")
                ? Effect.succeed(jsonResponse(request, 500, { message: "unavailable" }))
                : Effect.succeed(jsonResponse(request, 200, {})),
      });
      const proxy = mockProxy();
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        }),
        proxy.layer,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "download", "--project-ref", PROJECT_ID]),
        }),
      );

      return Effect.gen(function* () {
        // `useDocker: false` forces the native server-side path, not the
        // Docker-unbundle one.
        const error = yield* functionsDownload({
          ...baseFlags,
          functionName: Option.none(),
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(FunctionsApiStatusError);
        expect((error as FunctionsApiStatusError).status).toBe(500);
        expect((error as unknown as { writtenSoFar?: ReadonlyArray<string> }).writtenSoFar).toEqual(
          [resolve(tempRoot.current, "supabase", "functions", "hello-world")],
        );
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

  it.live("forwards only --legacy-bundle to the Go proxy, not the --use-docker default too", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      // `useDocker: true` mirrors the flag's own default even though only
      // `--legacy-bundle` was passed; forwarding both would make the Go
      // binary's own MarkFlagsMutuallyExclusive reject the combination.
      yield* functionsDownload({ ...baseFlags, useDocker: true, legacyBundle: true });

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
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
      // `useDocker: true` reflects the flag's own default; slug validation
      // must run before the Go proxy sees this argv.
      const exit = yield* functionsDownload({
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
      const api = mockCommandPlatformApi({
        handler: (request) =>
          request.url.endsWith("/body")
            ? Effect.succeed(multipartResponse(request))
            : Effect.succeed(jsonResponse(request, 200, {})),
      });
      const proxy = mockProxy();
      const analytics = mockContextualAnalytics();
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        yield* functionsDownloadHandler({
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
    const api = mockCommandPlatformApi();
    const proxy = mockProxy();
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      }),
      proxy.layer,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "download", "--use-api", "--use-docker"]),
      }),
    );

    return Effect.gen(function* () {
      const error = yield* functionsDownload({
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

  describe("Config.Validate / dotenv / env-override parity (CLI-1963)", () => {
    it.live(
      "fails before any Docker/API work when config.toml has an explicit empty project_id",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi();
        const proxy = mockProxy();
        const child = mockChildProcessSpawner({ exitCode: 0 });
        const layer = Layer.mergeAll(
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
            writeFile(join(tempRoot.current, "supabase", "config.toml"), 'project_id = ""\n'),
          );

          const error = yield* functionsDownload({ ...baseFlags, useDocker: true }).pipe(
            Effect.flip,
          );

          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe("Missing required field in config: project_id");
          expect(api.requests).toEqual([]);
          expect(child.spawned).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails before any Docker/API work on an unrelated Config.Validate branch (unsupported Postgres major version)",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi();
        const proxy = mockProxy();
        const child = mockChildProcessSpawner({ exitCode: 0 });
        const layer = Layer.mergeAll(
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
              ['project_id = "test-project"', "", "[db]", "major_version = 12", ""].join("\n"),
            ),
          );

          const error = yield* functionsDownload({ ...baseFlags, useDocker: true }).pipe(
            Effect.flip,
          );

          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(
            "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.",
          );
          expect(api.requests).toEqual([]);
          expect(child.spawned).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "resolves the deno v1 edge-runtime image tag when SUPABASE_EDGE_RUNTIME_DENO_VERSION=1 overrides an unset config value",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi();
        const proxy = mockProxy();
        const child = mockChildProcessSpawner({ exitCode: 0 });
        const layer = Layer.mergeAll(
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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

        const previous = process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
        process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "1";

        return Effect.gen(function* () {
          yield* functionsDownload({ ...baseFlags, useDocker: true });

          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args.slice(-6)[0]).toBe(
            "public.ecr.aws/supabase/edge-runtime:v1.68.4",
          );
        })
          .pipe(Effect.provide(layer))
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previous === undefined) {
                  delete process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
                } else {
                  process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = previous;
                }
              }),
            ),
          );
      },
    );

    it.live(
      "uses SUPABASE_NETWORK_ID as the docker network when no --network-id flag is passed",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi();
        const proxy = mockProxy();
        const child = mockChildProcessSpawner({ exitCode: 0 });
        const layer = Layer.mergeAll(
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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

        const previous = process.env["SUPABASE_NETWORK_ID"];
        process.env["SUPABASE_NETWORK_ID"] = "env-network";

        return Effect.gen(function* () {
          yield* functionsDownload({ ...baseFlags, useDocker: true });

          expect(child.spawned.find((spawned) => spawned.args[0] === "network")).toEqual({
            command: "docker",
            args: ["network", "inspect", "env-network"],
          });
          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args).toContain("env-network");
        })
          .pipe(Effect.provide(layer))
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previous === undefined) {
                  delete process.env["SUPABASE_NETWORK_ID"];
                } else {
                  process.env["SUPABASE_NETWORK_ID"] = previous;
                }
              }),
            ),
          );
      },
    );

    it.live("prefers an explicit --network-id flag over SUPABASE_NETWORK_ID", () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      const child = mockChildProcessSpawner({ exitCode: 0 });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
            "flag-network",
          ]),
        }),
      );

      const previous = process.env["SUPABASE_NETWORK_ID"];
      process.env["SUPABASE_NETWORK_ID"] = "env-network";

      return Effect.gen(function* () {
        yield* functionsDownload({ ...baseFlags, useDocker: true });

        expect(child.spawned.find((spawned) => spawned.args[0] === "network")).toEqual({
          command: "docker",
          args: ["network", "inspect", "flag-network"],
        });
        const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
        expect(runCommand?.args).toContain("flag-network");
        expect(runCommand?.args).not.toContain("env-network");
      })
        .pipe(Effect.provide(layer))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env["SUPABASE_NETWORK_ID"];
              } else {
                process.env["SUPABASE_NETWORK_ID"] = previous;
              }
            }),
          ),
        );
    });

    it.live(
      "resolves a registry override configured only via project dotenv, not the ambient shell",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi();
        const proxy = mockProxy();
        const child = mockChildProcessSpawner({ exitCode: 0 });
        const layer = Layer.mergeAll(
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
              join(tempRoot.current, "supabase", ".env"),
              "SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io\n",
            ),
          );

          yield* functionsDownload({ ...baseFlags, useDocker: true });

          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args.slice(-6)[0]).toBe(
            `ghcr.io/${dockerfileServiceImage("edgeruntime")}`,
          );
          expect(
            child.spawned.filter(
              (spawned) => spawned.args[0] === "image" && spawned.args[1] === "inspect",
            ),
          ).toHaveLength(1);
          expect(process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"]).toBeUndefined();
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("falls back to the GHCR candidate when the ECR image cannot be inspected", () => {
      // Simulates a clean cache miss (non-zero exit, "not found" stderr) so
      // `hasLocalImage` moves to the next candidate without entering the
      // sleeping pull-retry loop.
      const spawnerOpts: {
        exitCode?: number;
        stderr?: string[];
        onSpawn?: (record: { command: string; args: ReadonlyArray<string> }) => void;
      } = { exitCode: 0 };
      spawnerOpts.onSpawn = (record) => {
        if (
          record.command === "docker" &&
          record.args[0] === "image" &&
          record.args[1] === "inspect"
        ) {
          const image = record.args[2] ?? "";
          const isEcrCandidate = image.startsWith("public.ecr.aws/");
          spawnerOpts.exitCode = isEcrCandidate ? 1 : 0;
          spawnerOpts.stderr = isEcrCandidate ? [`Error: No such image: ${image}`] : [];
          return;
        }
        spawnerOpts.exitCode = 0;
        spawnerOpts.stderr = [];
      };
      const child = mockChildProcessSpawner(spawnerOpts);

      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi();
      const proxy = mockProxy();
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
        yield* functionsDownload({ ...baseFlags, useDocker: true });

        expect(
          child.spawned.filter(
            (spawned) => spawned.args[0] === "image" && spawned.args[1] === "inspect",
          ),
        ).toHaveLength(2);
        const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
        expect(runCommand?.args.slice(-6)[0]).toBe(
          `ghcr.io/${dockerfileServiceImage("edgeruntime")}`,
        );
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "labels the unbundle container with the resolved project id (Go parity: docker.go:349-386)",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi();
        const proxy = mockProxy();
        const child = mockChildProcessSpawner({ exitCode: 0 });
        const layer = Layer.mergeAll(
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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
          yield* functionsDownload({ ...baseFlags, useDocker: true });

          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args).toEqual(
            expect.arrayContaining([
              "--label",
              `com.supabase.cli.project=${PROJECT_ID}`,
              "--label",
              `com.docker.compose.project=${PROJECT_ID}`,
            ]),
          );
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("docker-not-running warning styling (Go parity: download.go:146; only WARNING: is styled)", () => {
    it.live("wraps only the WARNING token, not the rest of the fallback line", () => {
      // Uses a marker `styleWarning` instead of `functionsDownload`'s real
      // `yellow` hook, which is TTY-gated and inert under vitest.
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) =>
          request.url.endsWith("/body")
            ? Effect.succeed(multipartResponse(request))
            : Effect.succeed(jsonResponse(request, 200, {})),
      });
      const child = mockChildProcessSpawner({ exitCode: 1 });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        }),
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
        const platformApi = yield* CommandPlatformApi;

        yield* downloadFunctions(
          { ...baseFlags, useDocker: true },
          {
            api: platformApi,
            projectRoot: tempRoot.current,
            rawArgs: ["functions", "download", "hello-world", "--project-ref", PROJECT_ID],
            goConfigCompat: functionsGoConfigCompat,
            edgeRuntimeVersion: "1.69.12",
            resolveProjectRef: () => Effect.succeed(PROJECT_ID),
            proxyDownload: () => Effect.die("unexpected proxy invocation"),
            styleWarning: (text) => `<warn>${text}</warn>`,
          },
        );

        expect(out.stderrText).toContain("<warn>WARNING:</warn> Docker is not running\n");
      }).pipe(Effect.provide(layer));
    });
  });
});
