import { Effect, Layer, Option } from "effect";
import { describe, expect, test } from "vitest";

import { LegacyNetworkIdFlag } from "../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { LegacyDockerRun, type LegacyDockerRunOpts } from "./legacy-docker-run.service.ts";
import { legacyStreamPgDump } from "./legacy-pg-dump.run.ts";

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

describe("legacyStreamPgDump entrypoint wiring", () => {
  test("keeps the image entrypoint and runs bash -c, not dump-bash", () => {
    const docker = mockDockerRun();
    const layer = Layer.mergeAll(
      docker.layer,
      runtimeInfoLayer,
      Layer.succeed(LegacyNetworkIdFlag, Option.none()),
    );
    Effect.runSync(
      legacyStreamPgDump({
        image: "supabase/postgres:17.4.1.030",
        script: "pg_dump",
        env: {},
        onStdout: () => Effect.void,
      }).pipe(Effect.provide(layer)),
    );
    const opts = docker.lastOpts;
    if (opts === undefined) throw new Error("docker.runStream was never called");
    expect(opts.entrypoint).toBeUndefined();
    expect(opts.cmd).toEqual(["bash", "-c", "pg_dump", "--"]);
  });
});
