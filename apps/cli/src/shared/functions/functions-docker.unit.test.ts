import process from "node:process";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildFunctionsDockerRunArgs,
  containerArchiveBytes,
  localDockerId,
  resolveDockerNetworkMode,
  runChildProcess,
  toDockerPath,
} from "./functions-docker.ts";

/**
 * A `ChildProcessSpawner` layer whose handle emits exactly the given raw
 * `Uint8Array` chunks on stdout/stderr — unlike the shared
 * `mockChildProcessSpawner` (`packages/process-compose/tests/helpers/mocks.ts`),
 * which encodes one full line per chunk, this lets a test place an arbitrary
 * byte boundary mid-codepoint to exercise `collectByteStream`'s per-stream
 * `TextDecoder` buffering.
 */
function mockStreamingChildProcessLayer(
  opts: {
    readonly stdout?: ReadonlyArray<Uint8Array>;
    readonly stderr?: ReadonlyArray<Uint8Array>;
  } = {},
) {
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(0));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable(opts.stdout ?? []),
        stderr: Stream.fromIterable(opts.stderr ?? []),
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
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
}

describe("toDockerPath", () => {
  it("keeps a posix absolute path unchanged", () => {
    expect(toDockerPath("/home/u/p/supabase/functions")).toBe("/home/u/p/supabase/functions");
  });

  it.runIf(process.platform === "win32")(
    "strips the drive letter and flips separators for a Windows path",
    () => {
      // The container path is constructed here and never re-parsed, so this is
      // the single guard for supabase/cli#6035's Windows `--workdir` behavior:
      // a drive-letter colon surviving into the container path would corrupt
      // every `host:container:mode` bind built from it. `resolve()` only
      // treats a drive-letter path as absolute on Windows, so the guard is
      // exercisable only there.
      const containerPath = toDockerPath("C:\\Users\\u\\p\\supabase\\functions");
      expect(containerPath).toBe("/Users/u/p/supabase/functions");
      expect(containerPath).not.toContain(":");
    },
  );

  it("never leaves a separator-breaking colon in a locally resolvable path", () => {
    const containerPath = toDockerPath("/home/u/repo:with:colons/supabase/functions");
    expect(containerPath).toBe("/home/u/repo:with:colons/supabase/functions");
  });
});

describe("buildFunctionsDockerRunArgs", () => {
  it("assembles run/--rm, binds, network, env, labels, image, and container args in order", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "supabase/edge-runtime:v1.2.3",
      projectId: "my-project",
      networkMode: "supabase_network_my-project",
      binds: ["/host/a:/container/a", "/host/b:/container/b"],
      env: ["FOO=bar", "BAZ=qux"],
      containerArgs: ["bundle", "--entrypoint", "index.ts"],
      platform: "darwin",
    });

    expect(args).toEqual([
      "run",
      "--rm",
      "-v",
      "/host/a:/container/a",
      "-v",
      "/host/b:/container/b",
      "--network",
      "supabase_network_my-project",
      "-e",
      "FOO=bar",
      "-e",
      "BAZ=qux",
      "--label",
      "com.supabase.cli.project=my-project",
      "--label",
      "com.docker.compose.project=my-project",
      "supabase/edge-runtime:v1.2.3",
      "bundle",
      "--entrypoint",
      "index.ts",
    ]);
  });

  it("omits --add-host on a non-linux platform", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "p",
      networkMode: "bridge",
      binds: [],
      containerArgs: [],
      platform: "darwin",
    });

    expect(args).not.toContain("--add-host");
  });

  it("inserts --add-host host.docker.internal:host-gateway between --network and the -e entries on linux", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "p",
      networkMode: "bridge",
      binds: [],
      env: ["FOO=bar"],
      containerArgs: [],
      platform: "linux",
    });

    const networkIndex = args.indexOf("--network");
    expect(args.slice(networkIndex, networkIndex + 6)).toEqual([
      "--network",
      "bridge",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      "FOO=bar",
    ]);
  });

  it("produces no -v flags for an empty binds array", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "p",
      networkMode: "bridge",
      binds: [],
      containerArgs: [],
      platform: "darwin",
    });

    expect(args).not.toContain("-v");
  });

  it("produces no -e flags when env is omitted", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "p",
      networkMode: "bridge",
      binds: [],
      containerArgs: [],
      platform: "darwin",
    });

    expect(args).not.toContain("-e");
  });

  it("preserves the input order of multiple binds and env entries", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "p",
      networkMode: "bridge",
      binds: ["/c:/c", "/a:/a", "/b:/b"],
      env: ["C=3", "A=1", "B=2"],
      containerArgs: [],
      platform: "darwin",
    });

    expect(args.slice(2, 8)).toEqual(["-v", "/c:/c", "-v", "/a:/a", "-v", "/b:/b"]);
    const networkIndex = args.indexOf("--network");
    expect(args.slice(networkIndex + 2, networkIndex + 8)).toEqual([
      "-e",
      "C=3",
      "-e",
      "A=1",
      "-e",
      "B=2",
    ]);
  });

  it("uses the exact projectId value in both labels, unsanitized", () => {
    const args = buildFunctionsDockerRunArgs({
      image: "img",
      projectId: "My Weird/Project!!",
      networkMode: "bridge",
      binds: [],
      containerArgs: [],
      platform: "darwin",
    });

    expect(args).toContain("--label");
    expect(args).toContain("com.supabase.cli.project=My Weird/Project!!");
    expect(args).toContain("com.docker.compose.project=My Weird/Project!!");
  });
});

describe("containerArchiveBytes", () => {
  // Regular-file tar entries parsed straight from the ustar headers.
  function tarRegularFileEntries(archive: Uint8Array): ReadonlyArray<[string, number]> {
    const decoder = new TextDecoder();
    const parseOctal = (field: Uint8Array) =>
      Number.parseInt(decoder.decode(field).replaceAll("\0", "").trim() || "0", 8);
    const entries: Array<[string, number]> = [];
    let offset = 0;

    while (offset + 512 <= archive.byteLength) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;

      const type = header[156];
      if (type === 0 || type === 0x30) {
        const name = decoder.decode(header.subarray(0, 100)).replaceAll("\0", "");
        entries.push([name, parseOctal(header.subarray(100, 108))]);
      }

      const size = parseOctal(header.subarray(124, 136));
      offset += 512 + Math.ceil(size / 512) * 512;
    }

    return entries;
  }

  it("strips leading slashes into root-relative tar entries with the contractual 0644 mode", async () => {
    const archive = await containerArchiveBytes({ "/root/index.ts": "export const x = 1;\n" });
    // The 0644 mode is contractual — a Bun default change must fail here, not as a
    // runtime permission error inside the container.
    expect(tarRegularFileEntries(archive)).toEqual([["root/index.ts", 0o644]]);
    const files = await new Bun.Archive(archive).files();
    expect(await files.get("root/index.ts")?.text()).toBe("export const x = 1;\n");
  });
});

describe("resolveDockerNetworkMode", () => {
  it("prefers the explicit flag over the env override when both are set", () => {
    expect(
      resolveDockerNetworkMode({
        explicit: "explicit-network",
        envOverride: "env-network",
        projectId: "my-project",
      }),
    ).toBe("explicit-network");
  });

  it("falls back to the env override when explicit is undefined", () => {
    expect(
      resolveDockerNetworkMode({
        explicit: undefined,
        envOverride: "env-network",
        projectId: "my-project",
      }),
    ).toBe("env-network");
  });

  it("treats an explicit empty flag (--network-id=) as skipping straight to the generated default, not the env override", () => {
    // Go parity: viper's Changed pflag wins over AutomaticEnv outright — an
    // explicit `--network-id=` never falls back to SUPABASE_NETWORK_ID, only
    // an OMITTED flag does.
    expect(
      resolveDockerNetworkMode({
        explicit: "",
        envOverride: "env-network",
        projectId: "my-project",
      }),
    ).toBe(localDockerId("network", "my-project"));
  });

  it("treats an empty env override as unset and falls through to the generated default", () => {
    expect(
      resolveDockerNetworkMode({
        explicit: undefined,
        envOverride: "",
        projectId: "my-project",
      }),
    ).toBe(localDockerId("network", "my-project"));
  });

  it("generates supabase_network_<sanitized-project-id> when both are unset", () => {
    const result = resolveDockerNetworkMode({
      explicit: undefined,
      envOverride: undefined,
      projectId: "my-project",
    });

    expect(result).toBe(localDockerId("network", "my-project"));
    expect(result).toBe("supabase_network_my-project");
  });
});

describe("runChildProcess", () => {
  it.effect(
    "tees a multi-byte UTF-8 character split across a chunk boundary, decoding it correctly in both the live tee and the accumulated stdout, and never tees an empty string",
    () =>
      Effect.gen(function* () {
        // "café"'s bytes are [c, a, f, 0xC3, 0xA9] — "é" is the 2-byte sequence
        // 0xC3 0xA9. Chunk 1 ends right after the leading byte (incomplete on
        // its own); chunk 2 is a genuinely empty chunk (decodes to "", must
        // never be teed); chunk 3 carries only the trailing byte, completing
        // "é" once joined with the decoder's buffered leading byte.
        const full = new TextEncoder().encode("café");
        const chunk1 = full.slice(0, 4);
        const chunk2 = new Uint8Array(0);
        const chunk3 = full.slice(4);

        const stdoutTee: Array<string> = [];
        const result = yield* runChildProcess("docker", ["logs"], {
          onStdout: (chunk) => Effect.sync(() => stdoutTee.push(chunk)),
        }).pipe(
          Effect.provide(mockStreamingChildProcessLayer({ stdout: [chunk1, chunk2, chunk3] })),
        );

        expect(result.stdout).toBe("café");
        // The teed chunks, concatenated, must equal the returned stdout exactly.
        expect(stdoutTee.join("")).toBe(result.stdout);
        expect(stdoutTee).not.toContain("");
        expect(stdoutTee.every((chunk) => chunk.length > 0)).toBe(true);
      }),
  );

  it.effect("tees stderr independently of stdout, both live and in the returned strings", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      const stdoutChunks = [encoder.encode("stdout-"), encoder.encode("chunk")];
      const stderrChunks = [encoder.encode("stderr-"), encoder.encode("chunk")];

      const stdoutTee: Array<string> = [];
      const stderrTee: Array<string> = [];
      const result = yield* runChildProcess("docker", ["logs"], {
        onStdout: (chunk) => Effect.sync(() => stdoutTee.push(chunk)),
        onStderr: (chunk) => Effect.sync(() => stderrTee.push(chunk)),
      }).pipe(
        Effect.provide(
          mockStreamingChildProcessLayer({ stdout: stdoutChunks, stderr: stderrChunks }),
        ),
      );

      expect(result.stdout).toBe("stdout-chunk");
      expect(result.stderr).toBe("stderr-chunk");
      expect(stdoutTee.join("")).toBe(result.stdout);
      expect(stderrTee.join("")).toBe(result.stderr);
      // Neither stream's tee ever observes so much as a fragment of the other.
      expect(stdoutTee.some((chunk) => chunk.includes("stderr"))).toBe(false);
      expect(stderrTee.some((chunk) => chunk.includes("stdout"))).toBe(false);
    }),
  );
});
