import { Effect, Exit, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { containerCliExitCode, spawnContainerCli } from "./legacy-container-cli.ts";
import {
  buildLegacyDockerArgs,
  legacyApplyBitbucketDockerFilter,
} from "./legacy-docker-run.args.ts";
import { LegacyDockerRunError } from "./legacy-docker-run.errors.ts";
import { legacyGetRegistryImageUrlCandidates } from "./legacy-docker-registry.ts";
import { LegacyDockerRun, type LegacyDockerRunOpts } from "./legacy-docker-run.service.ts";

// Go's prerequisite hint (`apps/cli-go/internal/utils/docker.go:248`).
const SUGGEST_DOCKER_INSTALL =
  "Docker Desktop is a prerequisite for local development. Follow the official docs to install: https://docs.docker.com/desktop";

// Go's `DockerStart` checks `os.Getenv("BITBUCKET_CLONE_DIR") != ""`
// (`apps/cli-go/internal/utils/docker.go:289`) to drop named volumes / security-opts.
const legacyIsBitbucketPipeline = (): boolean => {
  const value = globalThis.process.env["BITBUCKET_CLONE_DIR"];
  return value !== undefined && value.length > 0;
};

const DOCKER_PULL_RETRY_DELAYS_MS = [500] as const;

const RETRYABLE_PULL_PATTERNS = [
  /toomanyrequests/i,
  /rate exceeded/i,
  /429\b/i,
  /timeout/i,
  /temporarily unavailable/i,
  /temporary failure/i,
  /connection reset/i,
  /tls handshake timeout/i,
  /i\/o timeout/i,
] as const;

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
      new LegacyDockerRunError({ message: `failed to run docker. ${SUGGEST_DOCKER_INSTALL}` });

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

    const hasLocalImage = (image: string): Effect.Effect<boolean> =>
      containerCliExitCode(spawner, ["image", "inspect", image]).pipe(
        Effect.map((exitCode) => exitCode === 0),
        Effect.catch(() => Effect.succeed(false)),
      );

    const pullImage = (
      image: string,
    ): Effect.Effect<{ readonly exitCode: number; readonly stderr: string }, Error> =>
      Effect.gen(function* () {
        const handle = yield* spawnContainerCli(spawner, ["pull", image], {
          stdin: "inherit",
          stdout: "pipe",
          stderr: "pipe",
          detached: false,
          extendEnv: true,
        }).pipe(Effect.mapError(() => new Error("spawn")));
        // Tee pull progress to the parent terminal in real time so a large,
        // uncached pull does not look frozen — Go streams the same progress via
        // `jsonmessage.DisplayJSONMessagesToStream`. Progress goes to stderr so
        // it never corrupts the captured stdout of the `db dump` run path. The
        // buffered copies are kept only to classify retryable failures and to
        // report the error on a non-zero exit. Decode each stream separately so
        // a multi-byte UTF-8 sequence is never split across interleaved chunks.
        const stdoutChunks: Array<Uint8Array> = [];
        const stderrChunks: Array<Uint8Array> = [];
        yield* Effect.all(
          [
            Stream.runForEach(handle.stdout, (chunk) =>
              Effect.sync(() => {
                stdoutChunks.push(chunk);
                globalThis.process.stderr.write(chunk);
              }),
            ),
            Stream.runForEach(handle.stderr, (chunk) =>
              Effect.sync(() => {
                stderrChunks.push(chunk);
                globalThis.process.stderr.write(chunk);
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const exitCode = yield* handle.exitCode.pipe(Effect.map(Number));
        const stdout = new TextDecoder().decode(concat(stdoutChunks));
        const stderr = new TextDecoder().decode(concat(stderrChunks));
        return {
          exitCode,
          stderr: `${stdout}${stderr}`.trim(),
        };
      }).pipe(Effect.scoped);

    const shouldRetryPull = (message: string): boolean =>
      RETRYABLE_PULL_PATTERNS.some((pattern) => pattern.test(message));

    const resolveImage = (image: string): Effect.Effect<string, LegacyDockerRunError> =>
      Effect.gen(function* () {
        const candidates = legacyGetRegistryImageUrlCandidates(image);
        for (const candidate of candidates) {
          if (yield* hasLocalImage(candidate)) {
            return candidate;
          }
        }

        const failures: Array<string> = [];
        for (const candidate of candidates) {
          for (
            let attemptIndex = 0;
            attemptIndex <= DOCKER_PULL_RETRY_DELAYS_MS.length;
            attemptIndex += 1
          ) {
            const attempt = attemptIndex + 1;
            const result = yield* Effect.exit(pullImage(candidate));
            if (Exit.isSuccess(result)) {
              if (result.value.exitCode === 0) {
                return candidate;
              }
              const message =
                result.value.stderr.length > 0
                  ? result.value.stderr
                  : `docker pull exited with code ${result.value.exitCode}`;
              failures.push(`${candidate} attempt ${attempt}: ${message}`);
              if (
                !shouldRetryPull(message) ||
                attemptIndex === DOCKER_PULL_RETRY_DELAYS_MS.length
              ) {
                break;
              }
            } else {
              // A failed effect (rather than a non-zero exit, which returns a
              // value) means the container runtime could not be spawned at all.
              // No registry candidate can fix a missing Docker/Podman binary or
              // a down daemon, so stop here and surface the install hint instead
              // of an opaque, repeated spawn error across every candidate.
              return yield* Effect.fail(spawnError());
            }

            const delay = DOCKER_PULL_RETRY_DELAYS_MS[attemptIndex];
            if (delay === undefined) {
              break;
            }
            yield* Effect.sleep(`${delay} millis`);
          }
        }

        return yield* Effect.fail(
          new LegacyDockerRunError({
            message: `failed to pull docker image from all registries: ${failures.join("; ")}`,
          }),
        );
      });

    const withResolvedImage = (
      opts: LegacyDockerRunOpts,
    ): Effect.Effect<LegacyDockerRunOpts, LegacyDockerRunError> =>
      resolveImage(opts.image).pipe(Effect.map((image) => ({ ...opts, image })));

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
            // captured and redirected to `--file`/post-processing. Go's `dockerExec`
            // does the same: stdout → caller's writer, stderr → `MultiWriter(os.Stderr,
            // errBuf)` (`apps/cli-go/internal/db/dump/dump.go:50-90`).
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
            // via `stdcopy.StdCopy(stdout, stderr, logs)` (`docker.go:394`).
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
                    message: `failed to run docker. ${SUGGEST_DOCKER_INSTALL}`,
                  }),
              ),
            );
            return exitCode;
          }),
        ),
    });
  }),
);
