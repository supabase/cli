import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Ref } from "effect";
import { FetchHttpClient } from "effect/http";
import { startReplayServer } from "../../cli-e2e/src/server/replay-server.ts";
import {
  LAUNCH_TIMEOUT_EXIT_CODE,
  runLaunch,
  runWorkloadBench,
  type BenchOptions,
} from "./bench-cli.ts";

const fixturesDir = new URL("../../cli-e2e/fixtures", import.meta.url).pathname;

// Stands in for a CLI build: every launch makes one request to the profile's API and, when asked
// to trace, records it as an HTTP client span.
const FAKE_CLI = `#!/bin/sh
URL=$(sed -n 's/^api_url: "\\(.*\\)"$/\\1/p' "$SUPABASE_PROFILE")
curl -s -o /dev/null "$URL/v1/projects"
if [ -n "$SUPABASE_TRACE_FILE" ]; then
  PORT=\${URL##*:}
  printf '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"t","spanId":"s","name":"GET","startTimeUnixNano":"0","endTimeUnixNano":"1000000","status":{"code":1},"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"url.path","value":{"stringValue":"/v1/projects"}},{"key":"server.address","value":{"stringValue":"127.0.0.1"}},{"key":"server.port","value":{"intValue":%s}},{"key":"http.response.status_code","value":{"intValue":200}}]}]}]}]}\\n' "$PORT" >> "$SUPABASE_TRACE_FILE"
fi
`;

describe("runWorkloadBench", () => {
  it.effect("counts only the measured launch's API calls, not setup or earlier launches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const server = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startReplayServer({ fixturesDir, record: false, stagingUrl: undefined }),
          ),
          (handle) => Effect.promise(() => handle.stop()),
        );
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bench-fake-cli-" });
        const binary = `${dir}/supabase`;
        yield* fs.writeFileString(binary, FAKE_CLI);
        yield* fs.chmod(binary, 0o755);
        const options: BenchOptions = {
          base: binary,
          branch: binary,
          runs: 2,
          warmup: 1,
          commands: [],
          workloadsFile: undefined,
          cwdSetupInit: false,
          apiUrl: server.url,
          trace: true,
          json: false,
          out: undefined,
          cpuProf: false,
          updateCheck: false,
        };

        const { report } = yield* runWorkloadBench(
          options,
          {
            id: "w",
            args: ["projects", "list"],
            cwdSetup: "init",
            scenario: "projects-list-renders-project-list",
          },
          yield* Ref.make(false),
        );

        const samples = [...report.base, ...report.branch];
        expect(samples).toHaveLength(4);
        for (const sample of samples) {
          expect(sample.exitCode).toBe(0);
          expect(sample.trace?.api?.apiCalls).toBe(1);
          expect(sample.trace?.api?.requestLogCount).toBe(1);
          expect(sample.trace?.api?.externalCalls).toBe(0);
        }
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  );
});

describe("runLaunch", () => {
  it.live("kills a launch that outlives the timeout and records a failing exit code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bench-hung-cli-" });
        const pidFile = `${dir}/pid`;
        const binary = `${dir}/supabase`;
        yield* fs.writeFileString(
          binary,
          `#!/bin/sh\necho $$ > "${pidFile}"\nexec /bin/sleep 60\n`,
        );
        yield* fs.chmod(binary, 0o755);

        const result = yield* runLaunch({
          binary,
          args: [],
          cwd: dir,
          env: {},
          timeout: Duration.millis(500),
        });

        expect(result.exitCode).toBe(LAUNCH_TIMEOUT_EXIT_CODE);
        expect(result.wallMs).toBeLessThan(30_000);
        const pid = Number((yield* fs.readFileString(pidFile)).trim());
        expect(Number.isInteger(pid)).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );
});
