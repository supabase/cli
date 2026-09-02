import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { StackIdSchema, StackNotFoundError } from "@supabase/stack/effect";
import { stop, type StopOperations } from "./stop.handler.ts";
import { emptyEnv, mockCliProjectHome, mockOutput } from "../../../../tests/helpers/mocks.ts";

describe("stop handler", () => {
  it.live("fails clearly when no stack descriptor exists", () => {
    const out = mockOutput({ interactive: false });
    return stop({ stack: "default", noBackup: false }).pipe(
      Effect.provide(
        Layer.mergeAll(emptyEnv(), out.layer, mockCliProjectHome({ projectRoot: process.cwd() })),
      ),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.squash(exit.cause)).toBeInstanceOf(StackNotFoundError);
        }),
      ),
    );
  });

  it.live("stops an ownerless persisted stack through the package handle", () => {
    const out = mockOutput({ interactive: false });
    const descriptor = {
      id: StackIdSchema.make("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
      projectRoot: process.cwd(),
      name: "default",
      branchContext: "main",
      runtime: { kind: "native" as const },
      desiredLifecycle: "stopped" as const,
    };
    let stopped = false;
    const operations: StopOperations = {
      findStack: () => Effect.succeed(Option.some(descriptor)),
      openStack: () =>
        Effect.succeed({
          stop: () => Effect.sync(() => void (stopped = true)),
          destroy: () => Effect.void,
        }),
    };
    return stop({ stack: "default", noBackup: false }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(stopped).toBe(true);
          expect(out.messages).toContainEqual(
            expect.objectContaining({ message: "Local Supabase stopped" }),
          );
        }),
      ),
    );
  });

  it.live("destroys an ownerless stack through the managed package with --no-backup", () => {
    const out = mockOutput({ interactive: false });
    const descriptor = {
      id: StackIdSchema.make("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"),
      projectRoot: process.cwd(),
      name: "default",
      branchContext: "main",
      runtime: { kind: "native" as const },
      desiredLifecycle: "stopped" as const,
    };
    let destroyed = false;
    let stopped = false;
    const operations: StopOperations = {
      findStack: () => Effect.succeed(Option.some(descriptor)),
      openStack: () =>
        Effect.succeed({
          stop: () => Effect.sync(() => void (stopped = true)),
          destroy: () => Effect.sync(() => void (destroyed = true)),
        }),
    };
    return stop({ stack: "default", noBackup: true }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(stopped).toBe(true);
          expect(destroyed).toBe(true);
          expect(out.messages).toContainEqual(
            expect.objectContaining({
              message: "Local Supabase stopped and persisted data deleted",
            }),
          );
        }),
      ),
    );
  });

  it.live("uses stable maintenance stop for an incompatible owner", () => {
    const out = mockOutput({ interactive: false });
    const descriptor = {
      id: StackIdSchema.make("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
      projectRoot: process.cwd(),
      name: "default",
      branchContext: "main",
      runtime: { kind: "native" as const },
      desiredLifecycle: "running" as const,
    };
    let stopped = false;
    const operations: StopOperations = {
      findStack: () => Effect.succeed(Option.some(descriptor)),
      openStack: () =>
        Effect.sync(() => {
          return {
            stop: () => Effect.sync(() => void (stopped = true)),
            destroy: () => Effect.void,
          };
        }),
    };
    return stop({ stack: "default", noBackup: false }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(stopped).toBe(true);
        }),
      ),
    );
  });

  it.live("delegates dead-owner recovery to the package handle", () => {
    const out = mockOutput({ interactive: false });
    const descriptor = {
      id: StackIdSchema.make("fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"),
      projectRoot: process.cwd(),
      name: "default",
      branchContext: "main",
      runtime: { kind: "native" as const },
      desiredLifecycle: "running" as const,
    };
    let stopped = false;
    const operations: StopOperations = {
      findStack: () => Effect.succeed(Option.some(descriptor)),
      openStack: () =>
        Effect.succeed({
          stop: () => Effect.sync(() => void (stopped = true)),
          destroy: () => Effect.void,
        }),
    };
    return stop({ stack: "default", noBackup: false }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(stopped).toBe(true);
          expect(out.messages).toContainEqual(
            expect.objectContaining({ message: "Local Supabase stopped" }),
          );
        }),
      ),
    );
  });

  it.live("stops an incompatible owner before deleting with --no-backup", () => {
    const out = mockOutput({ interactive: false });
    const descriptor = {
      id: StackIdSchema.make("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"),
      projectRoot: process.cwd(),
      name: "default",
      branchContext: "main",
      runtime: { kind: "native" as const },
      desiredLifecycle: "running" as const,
    };
    let destroyed = false;
    let stopped = false;
    const operations: StopOperations = {
      findStack: () => Effect.succeed(Option.some(descriptor)),
      openStack: () =>
        Effect.sync(() => {
          return {
            stop: () => Effect.sync(() => void (stopped = true)),
            destroy: () => Effect.sync(() => void (destroyed = true)),
          };
        }),
    };
    return stop({ stack: "default", noBackup: true }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), out.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(stopped).toBe(true);
          expect(destroyed).toBe(true);
        }),
      ),
    );
  });
});
