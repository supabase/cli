import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { StackError } from "@supabase/stack/effect";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { YesFlag } from "../../../../command-internal/global-flags.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { StackApi, stackApiLayer, stackTargetResolverLayer } from "../stack.shared.ts";
import { stackDestroy } from "./destroy.handler.ts";
import { StackCommandDestroyError } from "./destroy.errors.ts";

const live = Layer.provideMerge(stackApiLayer, BunServices.layer);

/**
 * A real registration whose `destroy` fails the way the stack owner reports an unreachable engine:
 * the namespace behaviour behind it (registration and claims untouched) is covered by
 * packages/stack's own suite; this fixture is only the CLI's mapping of that failure.
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
          destroy: Effect.fail(
            new StackError({
              operation: "destroy",
              message: "Docker CLI or daemon isn't reachable",
              reason: "runtime-unavailable",
            }),
          ),
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

for (const format of ["text", "json"] as const)
  it.live(
    `fails with the exact --yes retry command and keeps the stack registered when its engine is unreachable (${format})`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(format);

        const failure = yield* stackDestroy(f.flags).pipe(Effect.provide(f.layer), Effect.flip);

        expect(failure).toBeInstanceOf(StackCommandDestroyError);
        expect(failure.reason).toBe("runtime");
        expect(failure.suggestion).toContain(
          `supabase stack destroy --stack-id ${f.stack.id} --yes`,
        );
        expect(f.output.stdoutText).not.toContain("destroyed");
        expect(f.output.messages.filter(({ type }) => type === "success")).toEqual([]);
        expect(yield* f.api.discover(f.locations)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(live)),
  );
