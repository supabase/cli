import { Effect, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { legacyIsBitbucketPipeline } from "./legacy-bitbucket-pipeline.ts";
import { containerCliExitCode, spawnContainerCli } from "./legacy-container-cli.ts";
import { legacyMakeDockerImageResolver } from "./legacy-docker-image-resolve.ts";
import {
  buildLegacyDockerArgs,
  legacyApplyBitbucketDockerFilter,
} from "./legacy-docker-run.args.ts";
import { LegacyDockerRunError } from "./legacy-docker-run.errors.ts";
import { LEGACY_SUGGEST_DOCKER_INSTALL } from "./legacy-docker-suggest.ts";
import { LegacyDockerRun, type LegacyDockerRunOpts } from "./legacy-docker-run.service.ts";

export const legacyDockerRunLayer: Layer.Layer<
  LegacyDockerRun,
  never,
  ProcessControl | ChildProcessSpawner
> = Layer.effect(
  LegacyDockerRun,
  Effect.gen(function* () {
    const processControl = yield* ProcessControl;
    const spawner = yield* ChildProcessSpawner;

    const spawnError = () =>
      // Never embed the spawn error verbatim: it can leak the full argv and
      // environment of the failed exec (CWE-214/209). Emit a fixed,
      // credential-free message that still points at the likely cause.
      new LegacyDockerRunError({
        message: `failed to run docker. ${LEGACY_SUGGEST_DOCKER_INSTALL}`,
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

    const resolveImage = legacyMakeDockerImageResolver(spawner);

    const withResolvedImage = (
      opts: LegacyDockerRunOpts,
    ): Effect.Effect<LegacyDockerRunOpts, LegacyDockerRunError> =>
      opts.skipImageResolve === true
        ? Effect.succeed(opts)
        : resolveImage(opts.image).pipe(Effect.map((image) => ({ ...opts, image })));

    return LegacyDockerRun.of({
      runCapture: (opts, captureOpts) =>
        Effect.scoped(
          Effect.gen(function* () {
            const teeStderr = captureOpts?.teeStderr ?? false;
            yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
            const resolvedOpts = yield* withResolvedImage(opts);
            const args = buildLegacyDockerArgs(
              legacyApplyBitbucketDockerFilter(resolvedOpts, legacyIsBitbucketPipeline()),
            );
            // Pipe stdout/stderr (rather than inherit) so the SQL dump can be
            // captured and redirected to `--file`/post-processing. `dockerExec`
            // does the same: stdout → caller's writer, stderr → `MultiWriter(os.Stderr,
            // errBuf)`.
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
                    // Tee container stderr to the parent terminal in real time only
                    // when the caller opts in — `db dump` mirrors Go's
                    // `io.MultiWriter(os.Stderr, errBuf)`, while the edge-runtime /
                    // pg-delta path keeps stderr buffered (Go passes a bare
                    // `bytes.Buffer`) and surfaces it only on failure.
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
            yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
            const resolvedOpts = yield* withResolvedImage(opts);
            const args = buildLegacyDockerArgs(
              legacyApplyBitbucketDockerFilter(resolvedOpts, legacyIsBitbucketPipeline()),
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
            // Stream stdout to the caller's sink in arrival order while draining
            // stderr concurrently — reading one pipe to completion before the other
            // would deadlock once the unread pipe's OS buffer fills. Go does the same
            // via `stdcopy.StdCopy(stdout, stderr, logs)`.
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
                    stderrChunks.push(chunk);
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
            const args = buildLegacyDockerArgs(
              legacyApplyBitbucketDockerFilter(resolvedOpts, legacyIsBitbucketPipeline()),
            );
            // Pass run env (incl. PGPASSWORD) through the docker child's own
            // environment, not the argv. `buildLegacyDockerArgs` emits the
            // key-only `-e KEY` form, so docker inherits each value from here
            // and the secret never lands in `ps`/`/proc/<pid>/cmdline`.
            // `extendEnv: true` keeps the rest of process.env (PATH, DOCKER_HOST,
            // …) so the docker invocation behaves like the parent shell's.
            // Never embed the spawn error verbatim: it can leak the full argv and
            // environment of the failed exec (CWE-214/209). Emit a fixed,
            // credential-free message that still points at the likely cause.
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
                  new LegacyDockerRunError({
                    message: `failed to run docker. ${LEGACY_SUGGEST_DOCKER_INSTALL}`,
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
