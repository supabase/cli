import { Cause, Effect, Fiber, Queue, Ref, Schema, Semaphore, Stream } from "effect";
import { StackError, CommandEvent as CommandEventSchema } from "../Rpc.ts";
import type { CommandInvocation } from "../Commands.ts";
import type * as CommandRunner from "./CommandRunner.ts";

type CommandEvent = Schema.Schema.Type<typeof CommandEventSchema>;

export interface CommandAttachmentPayload {
  readonly attachmentId: string;
  readonly command: CommandInvocation;
}

interface AttachedCommandOutput {
  readonly stdout: (bytes: Uint8Array) => Effect.Effect<void>;
  readonly stderr: (bytes: Uint8Array) => Effect.Effect<void>;
}
type AttachedCommandInput =
  | (AttachedCommandOutput & {
      readonly command: Extract<CommandInvocation, { type: "postgres" }>;
      readonly stdin: Stream.Stream<Uint8Array> | undefined;
    })
  | (AttachedCommandOutput & {
      readonly command: Exclude<CommandInvocation, { type: "postgres" }>;
    });

interface Attachment {
  readonly attachmentId: string;
  readonly stdin: boolean;
  readonly input: Queue.Queue<Uint8Array | null>;
  readonly output: Queue.Queue<CommandEvent, Cause.Done | StackError>;
  readonly fiber: Ref.Ref<Fiber.Fiber<void, unknown> | undefined>;
}

interface CommandAttachmentOperations {
  readonly run: (input: CommandAttachmentPayload) => Stream.Stream<CommandEvent, StackError>;
  readonly input: (
    attachmentId: string,
    bytes: Uint8Array | null,
  ) => Effect.Effect<void, StackError>;
  readonly stopAll: Effect.Effect<void>;
}

export interface CommandAttachmentOptions {
  readonly admit: Effect.Effect<void, StackError>;
  readonly run: (
    input: AttachedCommandInput,
  ) => Effect.Effect<
    { readonly jobId: string; readonly exitCode: number },
    CommandRunner.CommandError
  >;
  readonly toError: (operation: string, cause: unknown) => StackError;
}

export const makeCommandAttachments = (options: CommandAttachmentOptions) =>
  Effect.gen(function* () {
    const entries = yield* Ref.make(new Map<string, Attachment>());
    const admission = yield* Semaphore.make(1);
    const stopAll = Effect.gen(function* () {
      const snapshot = yield* admission.withPermits(1)(Ref.get(entries));
      yield* Effect.forEach(
        [...snapshot.values()],
        (entry) =>
          Effect.gen(function* () {
            yield* Queue.shutdown(entry.input);
            yield* Queue.fail(entry.output, options.toError("command", "Stack host is draining"));
            const runner = yield* Ref.get(entry.fiber);
            if (runner !== undefined) yield* Fiber.interrupt(runner);
          }),
        { discard: true },
      );
    }).pipe(Effect.withSpan("CommandAttachments.stopAll"));

    const run = (input: CommandAttachmentPayload): Stream.Stream<CommandEvent, StackError> =>
      Stream.unwrap(
        admission.withPermits(1)(
          Effect.gen(function* () {
            yield* options.admit;
            const existing = yield* Ref.get(entries).pipe(
              Effect.map((values) => values.get(input.attachmentId)),
            );
            if (existing !== undefined)
              return yield* options.toError("command", "Attachment is already in use");
            const attachment: Attachment = {
              attachmentId: input.attachmentId,
              stdin: input.command.type === "postgres" && input.command.stdin,
              input: yield* Queue.bounded<Uint8Array | null>(1),
              output: yield* Queue.make<CommandEvent, Cause.Done | StackError>({ capacity: 16 }),
              fiber: yield* Ref.make<Fiber.Fiber<void, unknown> | undefined>(undefined),
            };
            yield* Ref.update(entries, (values) =>
              new Map(values).set(input.attachmentId, attachment),
            );
            const stdin = attachment.stdin
              ? Stream.fromQueue(attachment.input).pipe(
                  Stream.takeWhile((chunk): chunk is Uint8Array => chunk !== null),
                )
              : Stream.empty;
            const write = (event: CommandEvent) =>
              Queue.offer(attachment.output, event).pipe(Effect.asVoid);
            const outputs = {
              stdout: (bytes: Uint8Array) => write({ _tag: "Stdout", bytes }),
              stderr: (bytes: Uint8Array) => write({ _tag: "Stderr", bytes }),
            };
            const runner = options
              .run(
                input.command.type === "postgres"
                  ? { command: input.command, stdin, ...outputs }
                  : { command: input.command, ...outputs },
              )
              .pipe(
                Effect.flatMap((result) =>
                  write({ _tag: "Completed", jobId: result.jobId, exitCode: result.exitCode }),
                ),
                Effect.mapError((cause) => options.toError("command", cause)),
                Effect.tapError((cause) => Queue.fail(attachment.output, cause)),
                Effect.ensuring(
                  Effect.gen(function* () {
                    yield* Queue.shutdown(attachment.input);
                    yield* Queue.end(attachment.output);
                    yield* Ref.update(entries, (values) => {
                      const next = new Map(values);
                      next.delete(input.attachmentId);
                      return next;
                    });
                  }),
                ),
              );
            const fiber = yield* Effect.forkScoped(runner);
            yield* Ref.set(attachment.fiber, fiber);
            const stream = Stream.concat(
              Stream.succeed({
                _tag: "Attached",
                attachmentId: input.attachmentId,
              } satisfies CommandEvent),
              Stream.fromQueue(attachment.output),
            );
            return stream.pipe(
              Stream.ensuring(
                Effect.gen(function* () {
                  yield* Queue.shutdown(attachment.input);
                  yield* Queue.shutdown(attachment.output);
                  yield* Fiber.interrupt(fiber);
                }),
              ),
            );
          }).pipe(Effect.withSpan("CommandAttachments.run")),
        ),
      );

    const input = Effect.fn("CommandAttachments.input")(
      (attachmentId: string, bytes: Uint8Array | null) =>
        Ref.get(entries).pipe(
          Effect.flatMap((values) => {
            const attachment = values.get(attachmentId);
            if (attachment === undefined)
              return Effect.fail(options.toError("command-input-closed", "Attachment is closed"));
            if (!attachment.stdin)
              return Effect.fail(options.toError("command-input", "Command did not request stdin"));
            return Queue.offer(attachment.input, bytes).pipe(
              Effect.flatMap((accepted) =>
                accepted
                  ? Effect.void
                  : Effect.fail(options.toError("command-input-closed", "Attachment is closed")),
              ),
            );
          }),
        ),
    );
    return { run, input, stopAll } satisfies CommandAttachmentOperations;
  });
