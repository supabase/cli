import { BunServices } from "@effect/platform-bun";
import { holdLock, isLockBusy } from "@supabase/stack/effect";
import { Effect, FileSystem, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";

/** Probes a start lock on the real clock, so a held lock reads `busy` without waiting on the TestClock. */
export const startLockState = (lockFile: string) =>
  TestClock.withLive(
    holdLock(lockFile, "0 millis", "probe").pipe(
      Effect.scoped,
      Effect.match({
        onSuccess: () => "free" as const,
        onFailure: (error) => (isLockBusy(error) ? ("busy" as const) : ("error" as const)),
      }),
    ),
  );

/** A `FileSystem` that reports each successful `makeDirectory`, the last real I/O before the first lock attempt. */
export const observeMakeDirectory = (onMade: (path: string) => Effect.Effect<void>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) =>
      FileSystem.FileSystem.of({
        ...real,
        makeDirectory: (path, options) =>
          real.makeDirectory(path, options).pipe(Effect.tap(() => onMade(path))),
      }),
    ),
  ).pipe(Layer.provide(BunServices.layer));
