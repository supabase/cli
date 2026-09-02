import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { CAPABILITY_NAMES, StackIdSchema } from "@supabase/stack/effect";
import { status, type StatusOperations } from "./status.handler.ts";
import { emptyEnv, mockCliProjectHome, mockOutput } from "../../../../tests/helpers/mocks.ts";

describe("status handler", () => {
  it.live("reports an unknown project stack without contacting a daemon", () => {
    const out = mockOutput({ interactive: false, format: "json" });
    return status({ stack: "default" }).pipe(
      Effect.provide(
        Layer.mergeAll(emptyEnv(), out.layer, mockCliProjectHome({ projectRoot: process.cwd() })),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(out.messages.some((message) => message.type === "success")).toBe(true);
        }),
      ),
    );
  });

  it.live("distinguishes an incompatible owner and provides restart guidance", () => {
    const out = mockOutput({ interactive: false, format: "text" });
    const id = StackIdSchema.make(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const descriptor = {
      id,
      projectRoot: process.cwd(),
      name: "default",
      branchContext: "main",
      runtime: { kind: "native" as const },
      desiredLifecycle: "running" as const,
    };
    const operations: StatusOperations = {
      findStack: () => Effect.succeed(Option.some(descriptor)),
      inspectStack: () => Effect.succeed({ descriptor, owner: "incompatible" as const }),
    };
    return status({ stack: "default" }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(out.messages).toContainEqual(
            expect.objectContaining({
              type: "warn",
              message: expect.stringContaining("supabase restart"),
            }),
          );
          expect(out.messages).toContainEqual(
            expect.objectContaining({ message: "Lifecycle: running" }),
          );
        }),
      ),
    );
  });

  it.live("reports a compatible owner that is still starting", () => {
    const out = mockOutput({ interactive: false, format: "json" });
    const id = StackIdSchema.make(
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    const descriptor = {
      id,
      projectRoot: process.cwd(),
      name: "default",
      branchContext: "main",
      runtime: { kind: "native" as const },
      desiredLifecycle: "running" as const,
    };
    const runningStatus = {
      id,
      lifecycle: "starting" as const,
      desiredLifecycle: "running" as const,
      runtime: descriptor.runtime,
      endpoints: {},
      versions: {},
      capabilities: CAPABILITY_NAMES.map((name) => ({
        name,
        activation: "lazy" as const,
        state: "starting" as const,
      })),
    };
    const operations: StatusOperations = {
      findStack: () => Effect.succeed(Option.some(descriptor)),
      inspectStack: () =>
        Effect.succeed({ descriptor, owner: "running" as const, status: runningStatus }),
    };
    return status({ stack: "default" }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(out.messages).toContainEqual(
            expect.objectContaining({
              type: "success",
              message: "Local Supabase stack is starting.",
            }),
          );
        }),
      ),
    );
  });

  it.live("reports running intent without an owner as unavailable", () => {
    const out = mockOutput({ interactive: false, format: "text" });
    const id = StackIdSchema.make(
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    );
    const descriptor = {
      id,
      projectRoot: process.cwd(),
      name: "default",
      branchContext: "main",
      runtime: { kind: "native" as const },
      desiredLifecycle: "running" as const,
    };
    const operations: StatusOperations = {
      findStack: () => Effect.succeed(Option.some(descriptor)),
      inspectStack: () => Effect.succeed({ descriptor, owner: "absent" as const }),
    };
    return status({ stack: "default" }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(out.messages).toContainEqual(
            expect.objectContaining({
              type: "warn",
              message: expect.stringContaining("supabase start"),
            }),
          );
          expect(out.messages).toContainEqual(
            expect.objectContaining({ message: expect.stringContaining("unavailable") }),
          );
        }),
      ),
    );
  });
});
