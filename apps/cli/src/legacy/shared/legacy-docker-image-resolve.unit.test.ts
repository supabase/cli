import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, PlatformError, Sink, Stream } from "effect";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as TestClock from "effect/testing/TestClock";

import { imageDigest } from "../../shared/services/image-digests.ts";
import { legacyMakeDockerImageResolver } from "./legacy-docker-image-resolve.ts";
import { legacyContainerRuntimeNotFoundMessage } from "./legacy-container-cli.ts";
import { LEGACY_SUGGEST_DOCKER_INSTALL } from "./legacy-docker-suggest.ts";
import { LegacyDockerRunError } from "./legacy-docker-run.errors.ts";

const REGISTRY_ENV = "SUPABASE_INTERNAL_IMAGE_REGISTRY";

function mockSpawner(
  pullResults: ReadonlyArray<{ readonly exitCode: number; readonly stderr?: string }>,
  // Defaults to a confirmed "not found" inspect response, which forces every
  // candidate through the pull path instead of the already-cached shortcut —
  // the behavior both existing pull-retry tests below rely on. A test
  // covering `hasLocalImage`'s own fail-fast behavior overrides this to
  // simulate a daemon-down (or other non-not-found) `image inspect` response
  // instead.
  imageInspectResult: { readonly exitCode: number; readonly stderr?: string } = {
    exitCode: 1,
    stderr: "Error response from daemon: No such image: placeholder",
  },
  tagResult: { readonly exitCode: number; readonly stderr?: string } = { exitCode: 0 },
) {
  const pulls: Array<string> = [];
  const tags: Array<[string, string]> = [];
  const imageInspectOptions: Array<ChildProcess.CommandOptions> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];

      if (args[0] === "image" && args[1] === "inspect") {
        if (command._tag === "StandardCommand") imageInspectOptions.push(command.options);
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        yield* Deferred.succeed(
          exitDeferred,
          ChildProcessSpawner.ExitCode(imageInspectResult.exitCode),
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          stdout: Stream.empty,
          stderr:
            imageInspectResult.stderr !== undefined
              ? Stream.fromIterable([new TextEncoder().encode(imageInspectResult.stderr)])
              : Stream.empty,
          all: Stream.empty,
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }

      const isTag = args[0] === "tag";
      if (isTag) tags.push([args[1] ?? "", args[2] ?? ""]);
      const result = isTag
        ? tagResult
        : pulls.length < pullResults.length
          ? pullResults[pulls.length]
          : undefined;
      if (!isTag) pulls.push(args[1] ?? "");
      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result?.exitCode ?? 1));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.empty,
        stderr:
          result?.stderr !== undefined
            ? Stream.fromIterable([new TextEncoder().encode(result.stderr)])
            : Stream.empty,
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
    spawner,
    get pulls() {
      return pulls;
    },
    get tags() {
      return tags;
    },
    get imageInspectOptions() {
      return imageInspectOptions;
    },
  };
}

/**
 * Joins everything written to stderr — the tee's `Uint8Array` chunks and the
 * resolver's own `string` writes — into one transcript, so tests can assert
 * on the byte sequence a terminal would actually display (e.g. that a retry
 * banner starts on a fresh line after an unterminated child error).
 */
function stderrTranscript(chunks: ReadonlyArray<unknown>): string {
  const decoder = new TextDecoder();
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk instanceof Uint8Array) return decoder.decode(chunk);
      return "";
    })
    .join("");
}

describe("legacyMakeDockerImageResolver", () => {
  it.effect(
    "retries a pull failure unconditionally through messages that wouldn't have matched the old retryable-pattern allowlist, giving up after 3 total attempts",
    () =>
      Effect.gen(function* () {
        // Pins the resolver to a single registry candidate (the image
        // unchanged) so the assertions below cover exactly one candidate's
        // attempt count, rather than the full ECR/GHCR/Docker Hub fallback
        // list built by `legacyGetRegistryImageUrlCandidates`.
        const previousRegistry = process.env[REGISTRY_ENV];
        process.env[REGISTRY_ENV] = "docker.io";
        // Records every chunk written to stderr, including the `docker pull` child's own
        // stdout/stderr, which `pullImage` tees live to the parent's stderr as `Uint8Array`
        // chunks — only the `Retrying after …` banner (and its fresh-line `"\n"` separator)
        // is ever written as a plain `string`, so filtering by `startsWith("Retrying after")`
        // isolates the banner from the tee below.
        const stderrChunks: Array<unknown> = [];
        const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
        globalThis.process.stderr.write = ((chunk: unknown) => {
          stderrChunks.push(chunk);
          return true;
        }) as typeof globalThis.process.stderr.write;

        try {
          // Mirrors Go's own `docker_test.go` "throws error on failure to pull
          // image" case: a bare, non-pattern-matching message (no
          // "toomanyrequests"/"rate exceeded"/etc.) still exhausts every
          // retry, because `DockerImagePullWithRetry` retries on any
          // non-nil error, with no message classification at all.
          const mock = mockSpawner([
            { exitCode: 1, stderr: "no space left on device" },
            { exitCode: 1, stderr: "no space left on device" },
            { exitCode: 1, stderr: "no space left on device" },
          ]);
          const resolve = legacyMakeDockerImageResolver(mock.spawner);
          const fiber = yield* resolve("supabase/postgres:17.6.1.138").pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          // 2 retries after the initial attempt, with Go's escalating 4s/8s
          // backoff (`2<<(i+1)` seconds for i=0,1) between them.
          yield* TestClock.adjust("4 seconds");
          yield* TestClock.adjust("8 seconds");
          const error = yield* Fiber.join(fiber).pipe(Effect.flip);

          expect(mock.pulls).toHaveLength(3);
          expect(error.message).toContain("no space left on device");
          expect(error.message).toContain("attempt 3");
          // `image inspect`'s stdout must be fully ignored — the default
          // `"pipe"` stdio risks a write-buffer deadlock on a cache hit (see
          // the doc comment in `legacy-docker-image-resolve.ts`) — but
          // stderr IS piped so a daemon-unreachable response can be told
          // apart from a genuine cache miss.
          expect(mock.imageInspectOptions.length).toBeGreaterThan(0);
          for (const options of mock.imageInspectOptions) {
            expect(options).toMatchObject({ stdin: "ignore", stdout: "ignore", stderr: "pipe" });
          }
          // Go's per-retry banner: `Fprintf(os.Stderr, "Retrying after %v: %s\n", …)` —
          // one banner before each of the 2 retries, escalating 4s then 8s, naming the exact
          // candidate this resolver pinned to (see the comment above on `REGISTRY_ENV`).
          const retryBanners = stderrChunks.filter(
            (chunk): chunk is string =>
              typeof chunk === "string" && chunk.startsWith("Retrying after"),
          );
          expect(retryBanners).toEqual([
            "Retrying after 4s: supabase/postgres:17.6.1.138\n",
            "Retrying after 8s: supabase/postgres:17.6.1.138\n",
          ]);
          // Go `Fprintln`s the failed error before the banner,
          // so the banner always starts on a fresh line. The child's error here
          // has no trailing newline, so the resolver must add one — never the
          // glued `…deviceRetrying after …`.
          const transcript = stderrTranscript(stderrChunks);
          expect(transcript).toContain(
            "no space left on device\nRetrying after 4s: supabase/postgres:17.6.1.138\n",
          );
          expect(transcript).not.toContain("deviceRetrying");
        } finally {
          globalThis.process.stderr.write = originalWrite;
          if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
          else process.env[REGISTRY_ENV] = previousRegistry;
        }
      }),
  );

  it.effect(
    "resolves successfully once a retried pull succeeds, without waiting for the second backoff",
    () =>
      Effect.gen(function* () {
        const previousRegistry = process.env[REGISTRY_ENV];
        process.env[REGISTRY_ENV] = "docker.io";
        const stderrChunks: Array<unknown> = [];
        const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
        globalThis.process.stderr.write = ((chunk: unknown) => {
          stderrChunks.push(chunk);
          return true;
        }) as typeof globalThis.process.stderr.write;

        try {
          const mock = mockSpawner([
            { exitCode: 1, stderr: "no space left on device" },
            { exitCode: 0 },
          ]);
          const resolve = legacyMakeDockerImageResolver(mock.spawner);
          const fiber = yield* resolve("supabase/postgres:17.6.1.138").pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          yield* TestClock.adjust("4 seconds");
          const image = yield* Fiber.join(fiber);

          expect(mock.pulls).toHaveLength(2);
          expect(image).toBe("supabase/postgres:17.6.1.138");
          // Only the first candidate's failed attempt sleeps through a retry banner — the
          // second attempt succeeds immediately, so the 8s banner (and a third pull) must
          // never happen.
          const retryBanners = stderrChunks.filter(
            (chunk): chunk is string =>
              typeof chunk === "string" && chunk.startsWith("Retrying after"),
          );
          expect(retryBanners).toEqual(["Retrying after 4s: supabase/postgres:17.6.1.138\n"]);
        } finally {
          globalThis.process.stderr.write = originalWrite;
          if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
          else process.env[REGISTRY_ENV] = previousRegistry;
        }
      }),
  );

  it.effect(
    "does not inject a blank line before the banner when the child error is newline-terminated",
    () =>
      Effect.gen(function* () {
        const previousRegistry = process.env[REGISTRY_ENV];
        process.env[REGISTRY_ENV] = "docker.io";
        const stderrChunks: Array<unknown> = [];
        const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
        globalThis.process.stderr.write = ((chunk: unknown) => {
          stderrChunks.push(chunk);
          return true;
        }) as typeof globalThis.process.stderr.write;

        try {
          const mock = mockSpawner([
            { exitCode: 1, stderr: "no space left on device\n" },
            { exitCode: 0 },
          ]);
          const resolve = legacyMakeDockerImageResolver(mock.spawner);
          const fiber = yield* resolve("supabase/postgres:17.6.1.138").pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          yield* TestClock.adjust("4 seconds");
          const image = yield* Fiber.join(fiber);

          expect(image).toBe("supabase/postgres:17.6.1.138");
          // The child already terminated its own line — `Fprintln`
          // output shape is exactly one newline between error and banner, so
          // the resolver must not add a second one.
          const transcript = stderrTranscript(stderrChunks);
          expect(transcript).toContain(
            "no space left on device\nRetrying after 4s: supabase/postgres:17.6.1.138\n",
          );
          expect(transcript).not.toContain("\n\nRetrying");
        } finally {
          globalThis.process.stderr.write = originalWrite;
          if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
          else process.env[REGISTRY_ENV] = previousRegistry;
        }
      }),
  );

  it.live("gives every registry candidate its share when a deadline is passed", () => {
    // Fail-fast pulls with a small budget: each candidate still gets a turn
    // (unused share carries forward), and the guarded backoff never sleeps a
    // 4s retry into the next candidate's time — the test finishing in
    // milliseconds rather than seconds is itself the assertion.
    const mock = mockSpawner([
      { exitCode: 1, stderr: "denied" },
      { exitCode: 1, stderr: "denied" },
      { exitCode: 1, stderr: "denied" },
    ]);
    const resolve = legacyMakeDockerImageResolver(mock.spawner);
    return resolve("supabase/postgres:15", Date.now() + 500).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyDockerRunError);
        expect(mock.pulls.length).toBe(3);
        expect(new Set(mock.pulls).size).toBe(3);
      }),
    );
  });

  it.live("reports exhausted candidate budgets instead of pulling past a spent deadline", () => {
    const mock = mockSpawner([]);
    const resolve = legacyMakeDockerImageResolver(mock.spawner);
    return resolve("supabase/postgres:15", Date.now() - 1_000).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.message).toContain("candidate budget exhausted");
        expect(mock.pulls.length).toBe(0);
      }),
    );
  });

  it.effect("prints no Retrying banner when the first pull attempt succeeds", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      process.env[REGISTRY_ENV] = "docker.io";
      const stderrChunks: Array<unknown> = [];
      const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
      globalThis.process.stderr.write = ((chunk: unknown) => {
        stderrChunks.push(chunk);
        return true;
      }) as typeof globalThis.process.stderr.write;

      try {
        const mock = mockSpawner([{ exitCode: 0 }]);
        const resolve = legacyMakeDockerImageResolver(mock.spawner);

        const image = yield* resolve("supabase/postgres:17.6.1.138");

        expect(mock.pulls).toHaveLength(1);
        expect(image).toBe("supabase/postgres:17.6.1.138");
        const retryBanners = stderrChunks.filter(
          (chunk): chunk is string =>
            typeof chunk === "string" && chunk.startsWith("Retrying after"),
        );
        expect(retryBanners).toEqual([]);
      } finally {
        globalThis.process.stderr.write = originalWrite;
        if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
        else process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );

  it.effect("fails fast on a daemon-unreachable image inspect without ever attempting a pull", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      process.env[REGISTRY_ENV] = "docker.io";

      try {
        const daemonUnreachableStderr =
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
        const mock = mockSpawner([], { exitCode: 1, stderr: daemonUnreachableStderr });
        const resolve = legacyMakeDockerImageResolver(mock.spawner);

        const error = yield* resolve("supabase/postgres:17.6.1.138").pipe(Effect.flip);

        expect(error).toBeInstanceOf(LegacyDockerRunError);
        expect(error.message).toContain(daemonUnreachableStderr);
        expect(error.message).toContain(LEGACY_SUGGEST_DOCKER_INSTALL);
        expect(mock.pulls).toHaveLength(0);
      } finally {
        if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
        else process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );

  it.effect(
    "fails fast on a non-not-found image inspect error (e.g. an auth-plugin denial) without ever attempting a pull",
    () =>
      Effect.gen(function* () {
        const previousRegistry = process.env[REGISTRY_ENV];
        process.env[REGISTRY_ENV] = "docker.io";

        try {
          // `DockerResolveImageIfNotCached` treats ONLY a confirmed `errdefs.IsNotFound`
          // as a cache miss; every other inspect error — this is neither a "no such image" nor
          // a daemon-unreachable message — returns immediately instead of falling through to
          // the pull loop.
          const authPluginDenialStderr =
            "Error response from daemon: authorization denied by plugin AuthZPlugin: no policy matched";
          const mock = mockSpawner([], { exitCode: 1, stderr: authPluginDenialStderr });
          const resolve = legacyMakeDockerImageResolver(mock.spawner);

          const error = yield* resolve("supabase/postgres:17.6.1.138").pipe(Effect.flip);

          expect(error).toBeInstanceOf(LegacyDockerRunError);
          expect(error.message).toContain(authPluginDenialStderr);
          expect(error.message).not.toContain(LEGACY_SUGGEST_DOCKER_INSTALL);
          expect(mock.pulls).toHaveLength(0);
        } finally {
          if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
          else process.env[REGISTRY_ENV] = previousRegistry;
        }
      }),
  );

  it.effect(
    "treats Podman's differently worded image-inspect miss as a cache miss and proceeds to pull",
    () =>
      Effect.gen(function* () {
        const previousRegistry = process.env[REGISTRY_ENV];
        process.env[REGISTRY_ENV] = "docker.io";

        try {
          // An uncached `podman image inspect <missing>` exits non-zero with `image not
          // known` rather than Docker's `No such image` — see `isImageNotFoundMessage`'s
          // doc comment. Both wordings must reach the pull loop identically.
          const mock = mockSpawner([{ exitCode: 0 }], {
            exitCode: 1,
            stderr: "supabase/postgres:17.6.1.138: image not known",
          });
          const resolve = legacyMakeDockerImageResolver(mock.spawner);

          const image = yield* resolve("supabase/postgres:17.6.1.138");

          expect(image).toBe("supabase/postgres:17.6.1.138");
          expect(mock.pulls).toHaveLength(1);
        } finally {
          if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
          else process.env[REGISTRY_ENV] = previousRegistry;
        }
      }),
  );

  it.effect("surfaces the no-container-runtime message when neither docker nor podman spawns", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "not found",
          }),
        ),
      );
      const resolve = legacyMakeDockerImageResolver(spawner);

      const error = yield* Effect.flip(resolve("supabase/postgres:17.6.1.138"));

      expect(error).toBeInstanceOf(LegacyDockerRunError);
      expect(error.message).toContain(legacyContainerRuntimeNotFoundMessage);
    }),
  );

  it.effect("pulls a pinned image by digest and tags it under the candidate reference", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      delete process.env[REGISTRY_ENV];
      try {
        const mock = mockSpawner([{ exitCode: 0 }]);
        const resolve = legacyMakeDockerImageResolver(mock.spawner);
        const candidate = "public.ecr.aws/supabase/postgres-meta:v0.99.0";
        const pinned = `${candidate}@${imageDigest(candidate) ?? ""}`;

        const image = yield* resolve("supabase/postgres-meta:v0.99.0");

        expect(image).toBe(candidate);
        expect(mock.pulls).toEqual([pinned]);
        expect(mock.tags).toEqual([[pinned, candidate]]);
      } finally {
        if (previousRegistry !== undefined) process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );

  it.effect("moves to the next registry without retrying when one rejects the pinned digest", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      delete process.env[REGISTRY_ENV];
      try {
        const digest = imageDigest("supabase/postgres-meta:v0.99.0") ?? "";
        const mock = mockSpawner([
          {
            exitCode: 1,
            stderr: `Error response from daemon: unknown: failed to resolve reference "public.ecr.aws/supabase/postgres-meta@${digest}": unexpected status from HEAD request to https://public.ecr.aws/v2/supabase/postgres-meta/blobs/${digest}: 401 Unauthorized`,
          },
          {
            exitCode: 1,
            stderr: `Error response from daemon: failed to resolve reference "ghcr.io/supabase/postgres-meta@${digest}": ghcr.io/supabase/postgres-meta@${digest}: not found`,
          },
          { exitCode: 0 },
        ]);
        const resolve = legacyMakeDockerImageResolver(mock.spawner);

        const image = yield* resolve("supabase/postgres-meta:v0.99.0");

        expect(image).toBe("supabase/postgres-meta:v0.99.0");
        expect(mock.pulls).toEqual([
          `public.ecr.aws/supabase/postgres-meta:v0.99.0@${digest}`,
          `ghcr.io/supabase/postgres-meta:v0.99.0@${digest}`,
          `supabase/postgres-meta:v0.99.0@${digest}`,
        ]);
        expect(mock.tags).toEqual([
          [`supabase/postgres-meta:v0.99.0@${digest}`, "supabase/postgres-meta:v0.99.0"],
        ]);
      } finally {
        if (previousRegistry !== undefined) process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );

  it.effect("reports a docker tag that fails after a pinned pull", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      delete process.env[REGISTRY_ENV];
      try {
        const mock = mockSpawner([{ exitCode: 0 }], undefined, {
          exitCode: 1,
          stderr: "Error response from daemon: No such image: placeholder",
        });
        const resolve = legacyMakeDockerImageResolver(mock.spawner);

        const error = yield* resolve("supabase/postgres-meta:v0.99.0").pipe(Effect.flip);

        expect(error.reason).toBe("pull");
        expect(error.daemonDown).toBe(false);
        expect(error.message).toBe(
          "failed to tag docker image: Error response from daemon: No such image: placeholder",
        );
      } finally {
        if (previousRegistry !== undefined) process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );

  it.effect("names the pin and a way out when every registry rejects it", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      delete process.env[REGISTRY_ENV];
      try {
        const digest = imageDigest("supabase/postgres-meta:v0.99.0") ?? "";
        const mock = mockSpawner([
          { exitCode: 1, stderr: `${digest}: not found` },
          { exitCode: 1, stderr: `${digest}: not found` },
          { exitCode: 1, stderr: `${digest}: not found` },
        ]);
        const resolve = legacyMakeDockerImageResolver(mock.spawner);

        const error = yield* resolve("supabase/postgres-meta:v0.99.0").pipe(Effect.flip);

        expect(mock.pulls).toHaveLength(3);
        expect(error.message).toContain(
          `failed to pull docker image from all registries (3 of 3 registries rejected ${digest}, the digest this CLI pins for supabase/postgres-meta:v0.99.0; update the CLI, or set SUPABASE_INTERNAL_IMAGE_REGISTRY, for example to docker.io, to pull the tag unpinned): `,
        );
      } finally {
        if (previousRegistry !== undefined) process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );

  it.effect("keeps retrying a failure that does not name the pinned digest", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      delete process.env[REGISTRY_ENV];
      try {
        const digest = imageDigest("supabase/postgres-meta:v0.99.0") ?? "";
        const credentialHelperMissing =
          'error getting credentials - err: exec: "docker-credential-desktop": executable file not found in $PATH';
        const mock = mockSpawner([
          { exitCode: 1, stderr: `${digest}: not found` },
          { exitCode: 1, stderr: credentialHelperMissing },
          { exitCode: 1, stderr: credentialHelperMissing },
          { exitCode: 1, stderr: credentialHelperMissing },
          { exitCode: 1, stderr: `${digest}: not found` },
        ]);
        const resolve = legacyMakeDockerImageResolver(mock.spawner);
        const fiber = yield* resolve("supabase/postgres-meta:v0.99.0").pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("4 seconds");
        yield* TestClock.adjust("8 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(mock.pulls).toHaveLength(5);
        expect(error.message).toContain(
          `(2 of 3 registries rejected ${digest}, the digest this CLI pins for supabase/postgres-meta:v0.99.0; set SUPABASE_INTERNAL_IMAGE_REGISTRY, for example to docker.io, to pull the tag unpinned): `,
        );
        expect(error.message).not.toContain("update the CLI");
      } finally {
        if (previousRegistry !== undefined) process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );

  it.effect("never pins a docker.io override", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      process.env[REGISTRY_ENV] = "docker.io";
      try {
        const mock = mockSpawner([{ exitCode: 0 }]);
        const resolve = legacyMakeDockerImageResolver(mock.spawner);

        const image = yield* resolve("supabase/postgres-meta:v0.99.0");

        expect(image).toBe("supabase/postgres-meta:v0.99.0");
        expect(mock.pulls).toEqual(["supabase/postgres-meta:v0.99.0"]);
        expect(mock.tags).toEqual([]);
      } finally {
        if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
        else process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );

  it.effect("never pins a registry override that only the project dotenv sets", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      delete process.env[REGISTRY_ENV];
      try {
        const mock = mockSpawner([{ exitCode: 0 }]);
        const resolve = legacyMakeDockerImageResolver(mock.spawner, {
          [REGISTRY_ENV]: "docker.io",
        });

        const image = yield* resolve("supabase/postgres-meta:v0.99.0");

        expect(image).toBe("supabase/postgres-meta:v0.99.0");
        expect(mock.pulls).toEqual(["supabase/postgres-meta:v0.99.0"]);
        expect(mock.tags).toEqual([]);
      } finally {
        if (previousRegistry !== undefined) process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );

  it.effect("never pins a user-configured registry", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      process.env[REGISTRY_ENV] = "registry.example.com";
      try {
        const mock = mockSpawner([{ exitCode: 0 }]);
        const resolve = legacyMakeDockerImageResolver(mock.spawner);

        const image = yield* resolve("supabase/postgres-meta:v0.99.0");

        expect(image).toBe("registry.example.com/supabase/postgres-meta:v0.99.0");
        expect(mock.pulls).toEqual([image]);
        expect(mock.tags).toEqual([]);
      } finally {
        if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
        else process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );
});
