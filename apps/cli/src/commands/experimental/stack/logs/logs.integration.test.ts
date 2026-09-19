import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Ref, Stream } from "effect";
import type { Stack } from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { StackApi, stackApiLayer, stackTargetResolverLayer } from "../stack.shared.ts";
import { stackLogs } from "./logs.handler.ts";

const live = Layer.provideMerge(stackApiLayer, BunServices.layer);
const fixture = Effect.fn("StackLogsTest.fixture")(function* (
  format: "text" | "stream-json" | "json" = "text",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-logs-" });
  const api = yield* StackApi;
  const locations = { stateRoot: path.join(root, "stacks"), cacheRoot: path.join(root, "cache") };
  const stack = yield* api.create({ ...locations, projectRoot: root, runtime: "native" });
  const output = mockOutput({ format });
  const telemetry = mockTelemetryStateTracked();
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const layer = Layer.mergeAll(
    output.layer,
    telemetry.layer,
    settings,
    stackTargetResolverLayer.pipe(Layer.provide(settings)),
  );
  return {
    api,
    locations,
    stack,
    output,
    telemetry,
    layer,
    flags: {
      stack: Option.none<string>(),
      stackId: Option.some(stack.id),
      service: Option.none<string>(),
    },
  };
});
const loggingApi = (
  api: StackApi["Service"],
  stack: Stack,
  instances: Effect.Success<Stack["services"]["list"]>,
) =>
  Layer.succeed(
    StackApi,
    StackApi.of({
      ...api,
      open: () =>
        Effect.succeed({
          ...stack,
          services: { ...stack.services, list: Effect.succeed([...instances]) },
        }),
    }),
  );

describe("stack logs", () => {
  it.live("rejects finite JSON before starting an owner", () =>
    Effect.gen(function* () {
      const f = yield* fixture("json");
      const error = yield* stackLogs(f.flags).pipe(Effect.provide(f.layer), Effect.flip);
      expect(error.reason).toBe("flags");
      expect(error.suggestion).toBe("Use --output-format stream-json.");
      expect((yield* f.api.discover(f.locations))[0]?.host).toBeUndefined();
    }).pipe(Effect.provide(live)),
  );

  it.live("selects all instances of a kind and sanitizes terminal text", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.acquireUseRelease(
        Effect.succeed(f.stack),
        (stack) =>
          Effect.gen(function* () {
            const first = yield* stack.services.create({
              service: "mail",
              config: {},
              endpoints: {},
            });
            const second = yield* stack.services.create({
              service: "mail",
              config: {},
              endpoints: {},
            });
            const api = loggingApi(
              f.api,
              stack,
              [first, second].map((instance) => ({
                ...instance,
                logs: Stream.make({
                  stream: "stderr" as const,
                  bytes: new TextEncoder().encode("\u001b[31mwarning\u001b[0m\n"),
                }),
              })),
            );
            yield* stackLogs({ ...f.flags, service: Option.some("mail") }).pipe(
              Effect.provide(Layer.provideMerge(f.layer, api)),
            );
            expect(f.output.stdoutText).toContain(`mail/${first.id}/stderr: warning\n`);
            expect(f.output.stdoutText).toContain(`mail/${second.id}/stderr: warning\n`);
            expect(f.output.stdoutText).not.toContain("\u001b");
            const error = yield* stackLogs({ ...f.flags, service: Option.some("missing") }).pipe(
              Effect.provide(f.layer),
              Effect.flip,
            );
            expect(error.message).toBe("No service matches missing.");
          }),
        (stack) => stack.destroy,
      );
    }).pipe(Effect.provide(live)),
  );

  it.live("frames split UTF-8 and stdout/stderr lines with instance identity", () =>
    Effect.gen(function* () {
      const f = yield* fixture("stream-json");
      yield* Effect.acquireUseRelease(
        Effect.succeed(f.stack),
        (stack) =>
          Effect.gen(function* () {
            const member = yield* stack.services.create({
              service: "mail",
              config: {},
              endpoints: {},
            });
            const standalone = yield* stack.services.create({
              service: "mail",
              config: {},
              endpoints: {},
            });
            yield* stack.composition.configure({
              members: [{ id: member.id, activation: "eager" }],
              dependencies: [],
            });
            const utf8 = new TextEncoder().encode("hello 🐘\nlast line");
            const memberLogs = Stream.make(
              { stream: "stdout" as const, bytes: utf8.slice(0, 8) },
              { stream: "stderr" as const, bytes: new TextEncoder().encode("warning\n") },
              { stream: "stdout" as const, bytes: utf8.slice(8) },
            );
            const api = loggingApi(f.api, stack, [
              { ...member, logs: memberLogs },
              { ...standalone, logs: Stream.die("standalone must not be subscribed") },
            ]);
            yield* stackLogs(f.flags).pipe(Effect.provide(Layer.provideMerge(f.layer, api)));
            const entries = f.output.events.filter((entry) => entry.type === "log-entry");
            expect(entries).toHaveLength(3);
            expect(entries.map(({ line }) => line)).toEqual(
              expect.arrayContaining(["hello 🐘", "last line", "warning"]),
            );
            expect(
              entries.every(
                (entry) =>
                  entry.instance_id === member.id &&
                  entry.service === "mail" &&
                  entry.source === "live",
              ),
            ).toBe(true);
            expect(entries.find(({ line }) => line === "warning")?.stream).toBe("stderr");
            expect(f.telemetry.flushed).toBe(true);
          }),
        (stack) => stack.destroy,
      );
    }).pipe(Effect.provide(live)),
  );

  it.live("interrupts a selected log subscription without stopping or destroying its service", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.acquireUseRelease(
        Effect.succeed(f.stack),
        (stack) =>
          Effect.gen(function* () {
            const service = yield* stack.services.create({
              service: "mail",
              config: {},
              endpoints: {},
            });
            const subscribed = yield* Deferred.make<void>();
            const released = yield* Ref.make(false);
            const logs = Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
              Stream.ensuring(Ref.set(released, true)),
            );
            const api = loggingApi(f.api, stack, [{ ...service, logs }]);
            const fiber = yield* stackLogs({ ...f.flags, service: Option.some(service.id) }).pipe(
              Effect.provide(Layer.provideMerge(f.layer, api)),
              Effect.forkChild,
            );
            yield* Deferred.await(subscribed);
            yield* Fiber.interrupt(fiber);
            expect(yield* Ref.get(released)).toBe(true);
            expect((yield* service.status).registered).toBe(true);
            expect((yield* f.api.discover(f.locations))[0]?.host).toBeDefined();
            expect(f.telemetry.flushed).toBe(true);
          }),
        (stack) => stack.destroy,
      );
    }).pipe(Effect.provide(live)),
  );

  it.live("reports unavailable logs without starting an offline owner", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const error = yield* stackLogs(f.flags).pipe(Effect.provide(f.layer), Effect.flip);
      expect(error.reason).toBe("lifecycle");
      expect((yield* f.api.discover(f.locations))[0]?.host).toBeUndefined();
      expect(f.output.stdoutText).toBe("");
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );
});
