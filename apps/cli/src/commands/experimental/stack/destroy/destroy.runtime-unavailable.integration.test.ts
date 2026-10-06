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

/**
 * A registration real enough for target resolution, whose `destroy` reports the skipped-engine
 * outcome directly: the namespace reconcile this models (claim stays, a later acquisition
 * finishes it) is covered by packages/stack's own suite; this fixture is only the CLI's
 * formatting of that result.
 */
const fixture = Effect.fn("StackDestroyRuntimeUnavailableTest.fixture")(function* (
  format: "text" | "json",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-runtime-" });
  const realApi = yield* StackApi;
  const locations = { stateRoot: path.join(root, "stacks"), cacheRoot: path.join(root, "cache") };
  const stack = yield* realApi.create({ ...locations, projectRoot: root, runtime: "docker" });
  const api = StackApi.of({
    ...realApi,
    open: (options) =>
      realApi.open(options).pipe(
        Effect.map((opened) => ({
          ...opened,
          destroy: Effect.succeed({ runtimeCleanup: "skipped", engine: "docker" } as const),
        })),
      ),
  });
  const output = mockOutput({ interactive: false, format });
  const telemetry = mockTelemetryStateTracked();
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const layer = Layer.mergeAll(
    Layer.succeed(StackApi, api),
    output.layer,
    telemetry.layer,
    settings,
    stackTargetResolverLayer.pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(StackApi, api), settings)),
    ),
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

it.live(
  "keeps a stack registered and reports pending engine cleanup when its engine is unreachable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("text");
      yield* stackDestroy(f.flags).pipe(Effect.provide(f.layer));
      expect(f.output.stdoutText).toBe(
        `Stack ${f.stack.id} could not be fully destroyed because Docker is unreachable; restore it and run "supabase stack destroy --stack-id ${f.stack.id}" again.\n`,
      );
      expect(f.output.messages).toContainEqual({
        type: "warn",
        message: `Docker was unavailable, so Docker resources for stack ${f.stack.id} were not removed. Restore Docker and run "supabase stack destroy --stack-id ${f.stack.id}" again to finish removing it.`,
      });
      expect(yield* f.api.discover(f.locations)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(live)),
);

it.live("reports skipped engine cleanup in the JSON result", () =>
  Effect.gen(function* () {
    const f = yield* fixture("json");
    yield* stackDestroy(f.flags).pipe(Effect.provide(f.layer));
    expect(f.output.messages).toContainEqual(
      expect.objectContaining({
        data: {
          destroyed: false,
          id: f.stack.id,
          runtimeCleanup: "skipped",
          engine: "docker",
        },
      }),
    );
    expect(yield* f.api.discover(f.locations)).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(live)),
);
