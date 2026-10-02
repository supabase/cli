import { describe, expect, it } from "vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";

import { DockerRun } from "./docker-run.service.ts";
import { DockerRunError } from "./docker-run.errors.ts";
import { NetworkIdFlag } from "./global-flags.ts";
import { streamPgDump } from "./pg-dump.run.ts";
import { mockRuntimeInfo } from "../../tests/helpers/mocks.ts";

describe("streamPgDump", () => {
  it("maps registry configuration failures to DockerRunError", async () => {
    let runStreamCalls = 0;
    const dockerLayer = Layer.succeed(DockerRun, {
      run: () => Effect.succeed(0),
      runCapture: () => Effect.succeed({ exitCode: 0, stdout: new Uint8Array(), stderr: "" }),
      runStream: () => {
        runStreamCalls += 1;
        return Effect.succeed({ exitCode: 0, stderr: "" });
      },
    });
    const configProvider = ConfigProvider.make(() =>
      Effect.fail(new ConfigProvider.SourceError({ message: "injected registry config failure" })),
    );

    const error = await Effect.runPromise(
      streamPgDump({
        image: "supabase/postgres:17",
        script: "select 1",
        env: {},
        onStdout: () => Effect.void,
      }).pipe(
        Effect.flip,
        Effect.provide(
          Layer.mergeAll(
            dockerLayer,
            mockRuntimeInfo({ platform: "linux" }),
            Layer.succeed(NetworkIdFlag, Option.none()),
            ConfigProvider.layer(configProvider),
          ),
        ),
      ),
    );

    expect(error).toBeInstanceOf(DockerRunError);
    expect(error).toMatchObject({ reason: "config", daemonDown: false });
    expect(runStreamCalls).toBe(0);
  });
});
