import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, Stream } from "effect";
import { StackError } from "../Rpc.ts";
import { postgres } from "../Commands.ts";
import { makeCommandAttachments } from "./CommandAttachments.ts";

it.live("stopAll waits for an admitted tool to register and interrupt its runner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const admissionStarted = yield* Deferred.make<void>();
      const releaseAdmission = yield* Deferred.make<void>();
      const runnerStarted = yield* Deferred.make<void>();
      const runnerFinalized = yield* Deferred.make<void>();
      const attachments = yield* makeCommandAttachments({
        admit: Deferred.succeed(admissionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseAdmission)),
        ),
        run: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(runnerStarted, undefined);
            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(runnerFinalized, undefined))),
        toError: (operation, cause) =>
          new StackError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      const running = yield* Effect.forkChild(
        attachments
          .run({
            attachmentId: "admitted",
            command: {
              type: "postgres",
              command: postgres.psql({ major: 17 }),
              args: [],
              env: {},
              stdin: false,
            },
          })
          .pipe(Stream.runDrain),
      );
      yield* Deferred.await(admissionStarted);
      const stopFinished = yield* Ref.make(false);
      const stopping = yield* Effect.forkChild(
        attachments.stopAll.pipe(Effect.andThen(Ref.set(stopFinished, true))),
      );
      yield* Effect.yieldNow;
      expect(yield* Ref.get(stopFinished)).toBe(false);
      yield* Deferred.succeed(releaseAdmission, undefined);
      yield* Fiber.join(stopping);
      yield* Deferred.await(runnerStarted);
      yield* Deferred.await(runnerFinalized);
      yield* Fiber.interrupt(running);
    }),
  ),
);
