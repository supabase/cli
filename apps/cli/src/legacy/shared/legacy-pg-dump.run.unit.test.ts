import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";

import { LegacyNetworkIdFlag } from "../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { LegacyDockerRun, type LegacyDockerRunOpts } from "./legacy-docker-run.service.ts";
import { legacyStreamPgDump } from "./legacy-pg-dump.run.ts";

const DOCKER_IO_IMAGE = "supabase/postgres:17.4.1.030";
const SLIM_IMAGE = "ghcr.io/supabase/cli/postgres:17.6.1.165";

afterEach(() => {
  vi.unstubAllEnvs();
});

function mockDockerRun() {
  const calls: LegacyDockerRunOpts[] = [];
  const layer = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.succeed(0),
    runCapture: () => Effect.succeed({ exitCode: 0, stdout: new Uint8Array(0), stderr: "" }),
    runStream: (opts) =>
      Effect.sync(() => {
        calls.push(opts);
        return { exitCode: 0, stderr: "" };
      }),
  });
  return {
    layer,
    get lastOpts() {
      return calls[calls.length - 1];
    },
  };
}

const runtimeInfoLayer = Layer.succeed(RuntimeInfo, {
  cwd: "/work/project",
  platform: "linux",
  arch: "x64",
  homeDir: "/home/user",
  execPath: "/usr/bin/supabase",
  pid: 1234,
});

function runStreamPgDump(image: string): LegacyDockerRunOpts {
  const docker = mockDockerRun();
  const layer = Layer.mergeAll(
    docker.layer,
    runtimeInfoLayer,
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
  );
  Effect.runSync(
    legacyStreamPgDump({
      image,
      script: "pg_dump",
      env: {},
      onStdout: () => Effect.void,
    }).pipe(Effect.provide(layer)),
  );
  const opts = docker.lastOpts;
  if (opts === undefined) throw new Error("docker.runStream was never called");
  return opts;
}

describe("legacyStreamPgDump entrypoint wiring", () => {
  test("docker.io: keeps the image's own entrypoint, running bash under it", () => {
    const opts = runStreamPgDump(DOCKER_IO_IMAGE);
    expect(opts.entrypoint).toBeUndefined();
    expect(opts.cmd).toEqual(["bash", "-c", "pg_dump", "--"]);
  });

  test("SUPABASE_USE_SLIM_IMAGES unset: a ghcr.io-shaped image still keeps the docker.io cmd shape (flag-off byte-identity)", () => {
    const opts = runStreamPgDump(SLIM_IMAGE);
    expect(opts.entrypoint).toBeUndefined();
    expect(opts.cmd).toEqual(["bash", "-c", "pg_dump", "--"]);
  });

  test("slim image + flag on: uses the same bash cmd as docker.io", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const opts = runStreamPgDump(SLIM_IMAGE);
    expect(opts.entrypoint).toBeUndefined();
    expect(opts.cmd).toEqual(["bash", "-c", "pg_dump", "--"]);
  });
});
