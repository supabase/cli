import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { unixHttpClientLayer } from "@supabase/stack";
import { Effect, Exit, Fiber, Layer } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logs } from "./logs.handler.ts";
import { mockOutput, mockProcessControl, withEnv } from "../../../../tests/helpers/mocks.ts";
import { makeRunningStackFixture } from "../../../../tests/helpers/running-stack.ts";

type LogsHistoryCompletion =
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "fiber"; readonly exit: Exit.Exit<unknown, unknown> };

describe("logs handler", () => {
  it.live("shows a friendly failure when no local stack is running", () => {
    const out = mockOutput();
    const home = mkdtempSync(join(tmpdir(), "supabase-logs-test-"));
    const layer = Layer.mergeAll(out.layer, BunServices.layer, unixHttpClientLayer);

    return Effect.gen(function* () {
      const exit = yield* logs({
        stack: "default",
        tail: 100,
        service: [],
        noFollow: false,
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "intro", message: "Show local Supabase logs" }),
      );
    }).pipe(Effect.provide(layer), Effect.provide(withEnv({ SUPABASE_HOME: home })));
  });

  it.live("shows a bounded history snapshot for the current local stack", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() =>
          makeRunningStackFixture({
            history: [
              {
                timestamp: 1_000,
                service: "auth",
                stream: "stdout",
                line: '{"path":"/signup"}',
              },
              {
                timestamp: 1_001,
                service: "postgres",
                stream: "stdout",
                line: "database system is ready to accept connections",
              },
            ],
          }),
        ),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const out = mockOutput({ format: "text", interactive: false });
      const processControl = mockProcessControl();
      const layer = Layer.mergeAll(fixture.baseLayer, out.layer, processControl.layer);

      const fiber = yield* logs({
        stack: fixture.stackName,
        tail: 10,
        service: [],
        noFollow: true,
      }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));

      const completion: LogsHistoryCompletion = yield* Effect.race(
        Effect.map(
          processControl.awaitExit,
          (code): LogsHistoryCompletion => ({ type: "exit", code }),
        ),
        Effect.map(Fiber.await(fiber), (exit): LogsHistoryCompletion => ({ type: "fiber", exit })),
      );
      if (completion.type === "fiber") {
        throw new Error(
          Exit.isFailure(completion.exit)
            ? "logs command failed before finishing its history snapshot"
            : "logs command completed before reporting process exit",
        );
      }
      expect(completion.code).toBe(0);
      yield* Fiber.interrupt(fiber);

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: '[auth] {"path":"/signup"}' }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "[postgres] database system is ready to accept connections",
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: "Finished showing local Supabase logs.",
        }),
      );
    }),
  );

  it.live("streams machine-readable log events for a running local stack", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() =>
          makeRunningStackFixture({
            history: [],
            live: [
              {
                timestamp: Date.UTC(2026, 2, 25, 10, 30, 0),
                service: "auth",
                stream: "stdout",
                line: '{"msg":"signed in"}',
              },
            ],
          }),
        ),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const out = mockOutput({ format: "stream-json", interactive: false });
      const processControl = mockProcessControl();
      const layer = Layer.mergeAll(fixture.baseLayer, out.layer, processControl.layer);

      yield* logs({
        stack: fixture.stackName,
        tail: 0,
        service: [],
        noFollow: false,
      }).pipe(Effect.provide(layer));

      expect(out.events).toEqual([
        {
          type: "log-entry",
          timestamp: "2026-03-25T10:30:00.000Z",
          service: "auth",
          stream: "stdout",
          line: '{"msg":"signed in"}',
          source: "live",
        },
      ]);
    }),
  );

  it.live("rejects json output mode and points to stream-json instead", () => {
    const out = mockOutput({ format: "json", interactive: false });
    const home = mkdtempSync(join(tmpdir(), "supabase-logs-json-test-"));
    const layer = Layer.mergeAll(out.layer, BunServices.layer, unixHttpClientLayer);

    return Effect.gen(function* () {
      const exit = yield* logs({
        stack: "default",
        tail: 100,
        service: [],
        noFollow: false,
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "intro", message: "Show local Supabase logs" }),
      );
    }).pipe(Effect.provide(layer), Effect.provide(withEnv({ SUPABASE_HOME: home })));
  });
});
