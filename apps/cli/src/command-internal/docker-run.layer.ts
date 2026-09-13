import { Effect, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ProcessControl } from "../shared/runtime/process-control.service.ts";
import { isBitbucketPipeline } from "./bitbucket-pipeline.ts";
import { containerCliExitCode, spawnContainerCli } from "./container-cli.ts";
import { makeDockerImageResolver } from "./docker-image-resolve.ts";
import { buildDockerArgs, applyBitbucketDockerFilter } from "./docker-run.args.ts";
import { DockerRunError } from "./docker-run.errors.ts";
import { SUGGEST_DOCKER_INSTALL } from "./docker-suggest.ts";
import { DockerRun, type DockerRunOpts } from "./docker-run.service.ts";

export const dockerRunLayer: Layer.Layer<DockerRun, never, ProcessControl | ChildProcessSpawner> =
  Layer.effect(
    DockerRun,
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const spawner = yield* ChildProcessSpawner;

      const spawnError = () =>
        // The raw spawn error can leak the failed exec's full argv and environment, so emit a
        // fixed, credential-free message instead.
        new DockerRunError({
          message: `failed to run docker. ${SUGGEST_DOCKER_INSTALL}`,
          reason: "spawn",
          daemonDown: false,
        });

      const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
        const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return bytes;
      };

      const resolveImage = makeDockerImageResolver(spawner);

      const withResolvedImage = (
        opts: DockerRunOpts,
      ): Effect.Effect<DockerRunOpts, DockerRunError> =>
        opts.skipImageResolve === true
          ? Effect.succeed(opts)
          : resolveImage(opts.image).pipe(Effect.map((image) => ({ ...opts, image })));

      return DockerRun.of({
        runCapture: (opts, captureOpts) =>
          Effect.scoped(
            Effect.gen(function* () {
              const teeStderr = captureOpts?.teeStderr ?? false;
              yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
              const resolvedOpts = yield* withResolvedImage(opts);
              const args = buildDockerArgs(
                applyBitbucketDockerFilter(resolvedOpts, isBitbucketPipeline()),
              );
              // Pipe stdout/stderr (rather than inherit) so the output can be captured and
              // redirected to `--file`/post-processing.
              const handle = yield* spawnContainerCli(spawner, args, {
                stdin: "inherit",
                stdout: "pipe",
                stderr: "pipe",
                detached: false,
                env: opts.env,
                extendEnv: true,
              }).pipe(Effect.mapError(spawnError));

              const stdoutChunks: Array<Uint8Array> = [];
              const stderrChunks: Array<Uint8Array> = [];
              // Drain both pipes concurrently — reading stdout to completion before
              // stderr would deadlock once the unread stderr pipe buffer fills.
              yield* Effect.all(
                [
                  Stream.runForEach(handle.stdout, (chunk) =>
                    Effect.sync(() => {
                      stdoutChunks.push(chunk);
                    }),
                  ),
                  Stream.runForEach(handle.stderr, (chunk) =>
                    Effect.sync(() => {
                      stderrChunks.push(chunk);
                      // Tee container stderr to the parent terminal in real time only when the
                      // caller opts in; otherwise it's buffered and surfaced only on failure.
                      if (teeStderr) globalThis.process.stderr.write(chunk);
                    }),
                  ),
                ],
                { concurrency: "unbounded" },
              ).pipe(Effect.mapError(spawnError));

              const exitCode = yield* handle.exitCode.pipe(Effect.mapError(spawnError));
              return {
                exitCode,
                stdout: concat(stdoutChunks),
                stderr: new TextDecoder().decode(concat(stderrChunks)),
              };
            }),
          ),
        runStream: (opts, streamOpts) =>
          Effect.scoped(
            Effect.gen(function* () {
              const teeStderr = streamOpts.teeStderr ?? false;
              const captureStderr = streamOpts.captureStderr ?? true;
              yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
              const resolvedOpts = yield* withResolvedImage(opts);
              const args = buildDockerArgs(
                applyBitbucketDockerFilter(resolvedOpts, isBitbucketPipeline()),
              );
              const handle = yield* spawnContainerCli(spawner, args, {
                stdin: "inherit",
                stdout: "pipe",
                stderr: "pipe",
                detached: false,
                env: opts.env,
                extendEnv: true,
              }).pipe(Effect.mapError(spawnError));

              const stderrChunks: Array<Uint8Array> = [];
              // Stream stdout to the caller's sink in arrival order while draining stderr
              // concurrently — reading one pipe to completion before the other would deadlock
              // once the unread pipe's OS buffer fills.
              yield* Effect.all(
                [
                  // Map the stdout pipe's own read errors to a docker error while letting
                  // the caller's `onStdout` failure (`E`) propagate unchanged.
                  Stream.runForEach(
                    handle.stdout.pipe(Stream.mapError(spawnError)),
                    streamOpts.onStdout,
                  ),
                  Stream.runForEach(handle.stderr, (chunk) =>
                    Effect.sync(() => {
                      // Retained only for the returned string — skipped when the caller
                      // opts out, so a tee-only consumer stays at constant memory.
                      if (captureStderr) stderrChunks.push(chunk);
                      if (teeStderr) globalThis.process.stderr.write(chunk);
                    }),
                  ).pipe(Effect.mapError(spawnError)),
                ],
                { concurrency: "unbounded" },
              );

              const exitCode = yield* handle.exitCode.pipe(Effect.mapError(spawnError));
              return { exitCode, stderr: new TextDecoder().decode(concat(stderrChunks)) };
            }),
          ),
        run: (opts) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
              const resolvedOpts = yield* withResolvedImage(opts);
              const args = buildDockerArgs(
                applyBitbucketDockerFilter(resolvedOpts, isBitbucketPipeline()),
              );
              // Pass run env (incl. PGPASSWORD) through the docker child's own environment, not
              // the argv — `buildDockerArgs` emits the key-only `-e KEY` form, so docker inherits
              // each value from here. `extendEnv: true` keeps the rest of process.env (PATH,
              // DOCKER_HOST, …) so the invocation behaves like the parent shell's. The spawn error
              // below omits the raw argv/environment for the same reason as `spawnError` above.
              const exitCode = yield* containerCliExitCode(spawner, args, {
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
                detached: false,
                env: opts.env,
                extendEnv: true,
              }).pipe(
                Effect.mapError(
                  () =>
                    new DockerRunError({
                      message: `failed to run docker. ${SUGGEST_DOCKER_INSTALL}`,
                      reason: "spawn",
                      daemonDown: false,
                    }),
                ),
              );
              return exitCode;
            }),
          ),
      });
    }),
  );
