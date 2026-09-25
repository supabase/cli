import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { YesFlag } from "../../../../command-internal/global-flags.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { StackApi, stackApiLayer, stackTargetResolverLayer } from "../stack.shared.ts";
import { stackDestroy } from "./destroy.handler.ts";

const live = Layer.provideMerge(stackApiLayer, BunServices.layer);

const fixture = Effect.fn("StackDestroyRuntimeUnavailableTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-runtime-" });
  const binDir = path.join(root, "bin");
  yield* fs.makeDirectory(binDir, { recursive: true });
  const dockerShim = path.join(binDir, "docker");
  yield* fs.writeFileString(
    dockerShim,
    "#!/bin/sh\necho 'Cannot connect to the Docker daemon at tcp://127.0.0.1:1. Is the docker daemon running?' >&2\nexit 1\n",
  );
  yield* fs.chmod(dockerShim, 0o755);
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the detached host subprocess inherits PATH; this is not application config.
  const originalPath = process.env.PATH;
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above.
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- restores the mutation made above.
      process.env.PATH = originalPath;
    }),
  );

  const api = yield* StackApi;
  const locations = { stateRoot: path.join(root, "stacks"), cacheRoot: path.join(root, "cache") };
  const stack = yield* api.create({ ...locations, projectRoot: root, runtime: "docker" });
  const output = mockOutput({ interactive: false });
  const telemetry = mockTelemetryStateTracked();
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const layer = Layer.mergeAll(
    output.layer,
    telemetry.layer,
    settings,
    stackTargetResolverLayer.pipe(Layer.provide(settings)),
    mockTty({ stdinIsTty: false }),
    mockStdin(false),
    Layer.succeed(YesFlag, true),
    Layer.succeed(CliArgs, { args: ["--yes"] }),
  );
  return {
    api,
    locations,
    stack,
    output,
    layer,
    flags: { stack: Option.none<string>(), stackId: Option.some(stack.id) },
  };
});

it.live("destroys a stack and warns instead of failing when its engine is unreachable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* stackDestroy(f.flags).pipe(Effect.provide(f.layer));
    expect(f.output.stdoutText).toContain(`Stack ${f.stack.id} destroyed.`);
    expect(f.output.messages).toContainEqual({
      type: "warn",
      message: expect.stringContaining(
        `docker rm --force $(docker ps --all --quiet --filter label=com.supabase.stack=${f.stack.id})`,
      ),
    });
    expect(yield* f.api.discover(f.locations)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(live)),
);
