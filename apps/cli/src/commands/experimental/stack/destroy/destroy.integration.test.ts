import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
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
const fixture = Effect.fn("StackDestroyTest.fixture")(function* (yes: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-" });
  const api = yield* StackApi;
  const locations = { stateRoot: path.join(root, "stacks"), cacheRoot: path.join(root, "cache") };
  const stack = yield* api.create({ ...locations, projectRoot: root, runtime: "native" });
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
    Layer.succeed(YesFlag, yes),
    Layer.succeed(CliArgs, { args: yes ? ["--yes"] : ["--yes=false"] }),
  );
  return {
    root,
    fs,
    path,
    api,
    locations,
    stack,
    output,
    telemetry,
    layer,
    flags: { stack: Option.none<string>(), stackId: Option.some(stack.id) },
  };
});

describe("stack destroy", () => {
  it.live("requires confirmation before starting an owner or changing saved state", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      const error = yield* stackDestroy(f.flags).pipe(Effect.provide(f.layer), Effect.flip);
      expect(error.reason).toBe("confirmation");
      const saved = yield* f.api.discover(f.locations);
      expect(saved.map(({ definition }) => definition.id)).toEqual([f.stack.id]);
      expect(saved[0]?.host).toBeUndefined();
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live("destroys an offline namespace without affecting a different stack", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const other = yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "other",
        runtime: "native",
      });
      yield* Effect.acquireUseRelease(
        Effect.succeed(f.stack),
        () => stackDestroy(f.flags).pipe(Effect.provide(f.layer)),
        () =>
          f.api
            .discover(f.locations)
            .pipe(
              Effect.flatMap((entries) =>
                entries.some(
                  ({ definition, host }) => definition.id === f.stack.id && host !== undefined,
                )
                  ? f.stack.stop
                  : Effect.void,
              ),
            ),
      );
      expect((yield* f.api.discover(f.locations)).map(({ definition }) => definition.id)).toEqual([
        other.id,
      ]);
      expect(f.output.stdoutText).toContain(`Stack ${f.stack.id} destroyed.`);
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live(
    "destroys a live namespace and standalone services while preserving caller-owned uploads",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        const uploads = f.path.join(f.root, "uploads");
        yield* f.fs.makeDirectory(uploads);
        yield* f.fs.writeFileString(f.path.join(uploads, "object.txt"), "keep this upload");
        yield* Effect.acquireUseRelease(
          f.stack.services.create({
            service: "storage",
            config: {
              databaseUrl: "postgresql://unused",
              jwtSecret: "test-secret",
              filePath: uploads,
            },
            endpoints: {},
          }),
          () =>
            Effect.gen(function* () {
              yield* f.stack.services.create({ service: "mail", config: {}, endpoints: {} });
              yield* stackDestroy(f.flags).pipe(Effect.provide(f.layer));
              expect(yield* f.api.discover(f.locations)).toEqual([]);
              expect(yield* f.fs.readFileString(f.path.join(uploads, "object.txt"))).toBe(
                "keep this upload",
              );
            }),
          () =>
            f.api
              .discover(f.locations)
              .pipe(
                Effect.flatMap((entries) =>
                  entries.some(({ host }) => host !== undefined) ? f.stack.stop : Effect.void,
                ),
              ),
        );
      }).pipe(Effect.provide(live)),
  );
});
