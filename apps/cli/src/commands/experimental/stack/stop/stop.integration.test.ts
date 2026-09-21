import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Ref } from "effect";
import { StackError } from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { StackApi, stackApiLayer, stackTargetResolverLayer } from "../stack.shared.ts";
import { stackStop } from "./stop.handler.ts";

const flags = (id?: string) => ({
  all: Option.none<boolean>(),
  stack: Option.none<string>(),
  stackId: Option.fromUndefinedOr(id),
});
const live = Layer.provideMerge(stackApiLayer, BunServices.layer);
const fixture = Effect.fn("StackStopTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-stop-" });
  const api = yield* StackApi;
  const locations = { stateRoot: path.join(root, "stacks"), cacheRoot: path.join(root, "cache") };
  const stack = yield* api.create({ ...locations, projectRoot: root, runtime: "native" });
  const output = mockOutput();
  const telemetry = mockTelemetryStateTracked();
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const layer = Layer.mergeAll(
    output.layer,
    telemetry.layer,
    settings,
    stackTargetResolverLayer.pipe(Layer.provide(settings)),
  );
  return { root, api, locations, stack, output, telemetry, layer };
});

describe("stack stop", () => {
  it.live("stops an owner while preserving standalone definitions", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const stopped = yield* Ref.make(false);
      yield* Effect.acquireUseRelease(
        f.stack.services.create({ service: "mail", config: {}, endpoints: {} }),
        (mail) =>
          Effect.gen(function* () {
            expect((yield* f.api.discover(f.locations))[0]?.host).toBeDefined();
            yield* stackStop(flags(f.stack.id)).pipe(Effect.provide(f.layer));
            yield* Ref.set(stopped, true);
            expect((yield* f.stack.services.list).map(({ id }) => id)).toEqual([mail.id]);
            expect(f.output.stdoutText).toContain(`Stack ${f.stack.id} stopped.`);
            expect(f.telemetry.flushed).toBe(true);
          }),
        () => Ref.get(stopped).pipe(Effect.flatMap((done) => (done ? Effect.void : f.stack.stop))),
      );
    }).pipe(Effect.provide(live)),
  );

  it.live("stop all preserves an offline registry without claiming stopped workloads", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "second",
        runtime: "native",
      });
      yield* stackStop({ ...flags(), all: Option.some(true) }).pipe(Effect.provide(f.layer));
      yield* stackStop({ ...flags(), all: Option.some(true) }).pipe(Effect.provide(f.layer));
      expect(f.output.stdoutText.match(/workload state is unavailable/g)).toHaveLength(4);
      expect(f.output.stdoutText).not.toContain("stopped.");
      expect((yield* f.api.discover(f.locations)).every(({ host }) => host === undefined)).toBe(
        true,
      );
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live("surfaces a shutdown failure after a successful owner preflight", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const saved = (yield* f.api.discover(f.locations))[0];
      if (saved === undefined) return yield* Effect.die("created stack missing");
      const failedApi = Layer.succeed(
        StackApi,
        StackApi.of({
          ...f.api,
          discover: () =>
            Effect.succeed([
              {
                ...saved,
                host: { stackId: f.stack.id, identity: saved.definition.identity, pid: 1, port: 1 },
              },
            ]),
          open: () =>
            Effect.succeed({
              ...f.stack,
              stop: Effect.fail(
                new StackError({ operation: "shutdown", message: "owner disconnected" }),
              ),
            }),
        }),
      );
      const error = yield* stackStop(flags(f.stack.id)).pipe(
        Effect.provide(Layer.provideMerge(f.layer, failedApi)),
        Effect.flip,
      );
      expect(error.reason).toBe("unknown");
      expect(error.detail).toContain(`${f.stack.id}: owner disconnected`);
      expect(f.output.stdoutText).toBe("");
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );
});
