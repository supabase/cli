import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Stream } from "effect";
import { StackIdSchema, type EffectStack } from "@supabase/stack/effect";
import { logs, type LogsOperations } from "./logs.handler.ts";
import { emptyEnv, mockOutput, mockProcessControl } from "../../../../tests/helpers/mocks.ts";

describe("logs handler", () => {
  it.live("fails clearly when no managed stack exists", () => {
    const out = mockOutput({ interactive: false });
    const operations: LogsOperations = {
      findStack: () => Effect.succeed(Option.none()),
      openStack: () => Effect.die("openStack should not be called"),
    };
    return logs({ stack: "default", service: [], tail: 10, noFollow: true }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer, mockProcessControl().layer)),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isSuccess(exit)).toBe(true);
          expect(out.messages).toContainEqual(
            expect.objectContaining({ message: "No local Supabase stack was found." }),
          );
        }),
      ),
    );
  });

  it.live("filters services, emits the newest tail, then follows from the retained cursor", () => {
    const out = mockOutput({ format: "stream-json", interactive: false });
    const id = StackIdSchema.make(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const entries = [
      {
        cursor: { opaque: "1" },
        timestamp: "1",
        source: "auth" as const,
        stream: "stdout" as const,
        message: "old",
      },
      {
        cursor: { opaque: "2" },
        timestamp: "2",
        source: "auth" as const,
        stream: "stdout" as const,
        message: "new",
      },
      {
        cursor: { opaque: "3" },
        timestamp: "3",
        source: "storage" as const,
        stream: "stdout" as const,
        message: "other",
      },
    ];
    const live = {
      cursor: { opaque: "4" },
      timestamp: "4",
      source: "auth" as const,
      stream: "stderr" as const,
      message: "live",
    };
    const seen: Array<unknown> = [];
    const operations: LogsOperations = {
      findStack: () =>
        Effect.succeed(
          Option.some({
            id,
            projectRoot: "/tmp/project",
            name: "default",
            branchContext: "main",
            runtime: { kind: "native" as const },
            desiredLifecycle: "running" as const,
          }),
        ),
      openStack: () =>
        Effect.succeed({
          logs: (options: Parameters<EffectStack["logs"]>[0]) => {
            seen.push(options);
            return Effect.succeed({
              entries: entries.filter(
                (entry) => options?.capabilities?.includes(entry.source) ?? true,
              ),
              cursor: { opaque: "v1_3" },
              running: true,
            });
          },
          followLogs: (options: Parameters<EffectStack["followLogs"]>[0]) => {
            seen.push(options);
            return Stream.succeed(live);
          },
        }),
    };
    return logs({ stack: "default", service: ["auth"], tail: 1, noFollow: false }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer, mockProcessControl().layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(seen[0]).toMatchObject({ capabilities: ["auth"], tail: 1 });
          expect(seen[1]).toMatchObject({
            capabilities: ["auth"],
            cursor: { opaque: "v1_3" },
          });
          expect(out.events).toContainEqual(
            expect.objectContaining({ type: "log-entry", source: "history", line: "new" }),
          );
          expect(out.events).toContainEqual(
            expect.objectContaining({ type: "log-entry", source: "live", line: "live" }),
          );
        }),
      ),
    );
  });
});
