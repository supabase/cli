import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Ref } from "effect";

import {
  bundledPostgresClientLayer,
  BundledPostgresClient,
  resolveBundledPostgresRuntime,
} from "./bundled-postgres-client.ts";
import { dockerRunLayer } from "./docker-run.layer.ts";
import { ProcessControl } from "../shared/runtime/process-control.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { mockCommandSettings } from "../../tests/helpers/command-mocks.ts";

const processControl = Layer.succeed(ProcessControl, {
  awaitSignal: () => Effect.never,
  awaitShutdown: Effect.never,
  holdSignals: () => Effect.void,
  exit: () => Effect.die("unused"),
  setExitCode: () => Effect.void,
  getExitCode: Effect.succeed(undefined),
});

const base = Layer.mergeAll(BunServices.layer, processControl);
const docker = dockerRunLayer.pipe(Layer.provide(base));
const client = bundledPostgresClientLayer.pipe(
  Layer.provide(Layer.mergeAll(base, docker, mockOutput().layer)),
);

describe("BundledPostgresClient", { timeout: 180_000 }, () => {
  it.live("runs the selected runtime with an isolated artifact cache", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "bundled-client-" });
        const runtimeInfo = {
          cwd: "/tmp",
          platform: process.platform,
          arch: process.arch,
          homeDir: `${homeDir}/runtime-home`,
          execPath: process.execPath,
          pid: process.pid,
        };
        const runtime = yield* resolveBundledPostgresRuntime(
          undefined,
          process.platform,
          process.arch,
        );
        const chunks = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);
        const providedClient = client.pipe(
          Layer.provide(Layer.succeed(RuntimeInfo, runtimeInfo)),
          Layer.provide(mockCommandSettings({ workdir: "/tmp", supabaseHome: homeDir })),
        );
        const result = yield* Effect.gen(function* () {
          const client = yield* BundledPostgresClient;
          return yield* client.run({
            version: "17",
            runtime,
            argv:
              runtime.kind === "native"
                ? ["bash", "-c", "pg_dump --version", "--"]
                : ["pg_dump", "--version"],
            env: {},
            onStdout: (chunk) => Ref.update(chunks, (current) => [...current, chunk]),
          });
        }).pipe(Effect.provide(providedClient));
        expect(result.exitCode).toBe(0);
        const output = Uint8Array.from((yield* Ref.get(chunks)).flatMap((chunk) => [...chunk]));
        expect(new TextDecoder().decode(output)).toContain("pg_dump");
        if (runtime.kind === "native") {
          expect(yield* fs.exists(`${homeDir}/cache/stack`)).toBe(true);
          expect(yield* fs.exists(`${homeDir}/runtime-home/cache/stack`)).toBe(false);
        }
      }),
    ).pipe(Effect.provide(base)),
  );

  it.live("runs the Docker runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const chunks = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);
        const client = yield* BundledPostgresClient;
        const result = yield* client.run({
          version: "17",
          runtime: { kind: "container", engine: "docker" },
          argv: ["pg_dump", "--version"],
          env: {},
          onStdout: (chunk) => Ref.update(chunks, (current) => [...current, chunk]),
        });
        expect(result.exitCode).toBe(0);
        const output = Uint8Array.from((yield* Ref.get(chunks)).flatMap((chunk) => [...chunk]));
        expect(new TextDecoder().decode(output)).toContain("pg_dump");
      }),
    ).pipe(
      Effect.provide(
        client.pipe(
          Layer.provide(
            Layer.succeed(RuntimeInfo, {
              cwd: "/tmp",
              platform: process.platform,
              arch: process.arch,
              homeDir: "/tmp",
              execPath: process.execPath,
              pid: process.pid,
            }),
          ),
          Layer.provide(
            mockCommandSettings({ workdir: "/tmp", supabaseHome: "/tmp/bundled-client-docker" }),
          ),
        ),
      ),
    ),
  );
});
