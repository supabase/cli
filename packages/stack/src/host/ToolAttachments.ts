import { Cause, Effect, Fiber, Queue, Ref, Schema, Stream } from "effect";
import { StackError, ToolEvent as ToolEventSchema } from "../Rpc.ts";
import type { PostgresTool } from "../Tools.ts";
import type * as ToolRunner from "./ToolRunner.ts";
import type { ToolInput } from "./ToolRunner.ts";

type ToolEvent = Schema.Schema.Type<typeof ToolEventSchema>;

export interface ToolAttachmentPayload {
  readonly attachmentId: string;
  readonly tool: PostgresTool;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: boolean;
}

interface Attachment {
  readonly attachmentId: string;
  readonly stdin: boolean;
  readonly input: Queue.Queue<Uint8Array | null>;
  readonly output: Queue.Queue<ToolEvent, Cause.Done | StackError>;
  readonly fiber: Ref.Ref<Fiber.Fiber<void, unknown> | undefined>;
}

interface ToolAttachmentOperations {
  readonly run: (input: ToolAttachmentPayload) => Stream.Stream<ToolEvent, StackError>;
  readonly input: (
    attachmentId: string,
    stdin: boolean,
    bytes: Uint8Array | null,
  ) => Effect.Effect<void, StackError>;
  readonly stopAll: Effect.Effect<void>;
}

export interface ToolAttachmentOptions {
  readonly admit: Effect.Effect<void, StackError>;
  readonly run: ToolRunner.Interface["run"];
  readonly toError: (operation: string, cause: unknown) => StackError;
}

export const makeToolAttachments = (options: ToolAttachmentOptions) =>
  Effect.gen(function* () {
    const entries = yield* Ref.make(new Map<string, Attachment>());
    const stopAll = Effect.gen(function* () {
      yield* Ref.get(entries).pipe(
        Effect.flatMap((values) =>
          Effect.forEach(
            [...values.values()],
            (entry) =>
              Effect.gen(function* () {
                yield* Queue.shutdown(entry.input);
                yield* Queue.fail(entry.output, options.toError("tool", "Stack host is draining"));
                const runner = yield* Ref.get(entry.fiber);
                if (runner !== undefined) yield* Fiber.interrupt(runner);
              }),
            { discard: true },
          ),
        ),
      );
      yield* Ref.set(entries, new Map());
    }).pipe(Effect.withSpan("ToolAttachments.stopAll"));

    const run = (input: ToolAttachmentPayload): Stream.Stream<ToolEvent, StackError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* options.admit;
          const existing = yield* Ref.get(entries).pipe(
            Effect.map((values) => values.get(input.attachmentId)),
          );
          if (existing !== undefined)
            return yield* options.toError("tool", "Attachment is already in use");
          const attachment: Attachment = {
            attachmentId: input.attachmentId,
            stdin: input.stdin,
            input: yield* Queue.bounded<Uint8Array | null>(1),
            output: yield* Queue.make<ToolEvent, Cause.Done | StackError>({ capacity: 16 }),
            fiber: yield* Ref.make<Fiber.Fiber<void, unknown> | undefined>(undefined),
          };
          yield* Ref.update(entries, (values) =>
            new Map(values).set(input.attachmentId, attachment),
          );
          const stdin = input.stdin
            ? Stream.fromQueue(attachment.input).pipe(
                Stream.takeWhile((chunk): chunk is Uint8Array => chunk !== null),
              )
            : Stream.empty;
          const write = (event: ToolEvent) =>
            Queue.offer(attachment.output, event).pipe(Effect.asVoid);
          const runner = options
            .run({
              tool: input.tool,
              args: input.args,
              env: input.env,
              stdin,
              stdout: (bytes) => write({ _tag: "Stdout", bytes }),
              stderr: (bytes) => write({ _tag: "Stderr", bytes }),
            } satisfies ToolInput<never, never>)
            .pipe(
              Effect.flatMap((result) =>
                write({ _tag: "Completed", jobId: result.jobId, exitCode: result.exitCode }),
              ),
              Effect.mapError((cause) => options.toError("tool", cause)),
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
            } satisfies ToolEvent),
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
        }).pipe(Effect.withSpan("ToolAttachments.run")),
      );

    const input = Effect.fn("ToolAttachments.input")(
      (attachmentId: string, stdin: boolean, bytes: Uint8Array | null) =>
        Ref.get(entries).pipe(
          Effect.flatMap((values) => {
            const attachment = values.get(attachmentId);
            if (attachment === undefined)
              return Effect.fail(options.toError("tool-input-closed", "Attachment is closed"));
            if (!stdin || !attachment.stdin)
              return Effect.fail(options.toError("toolInput", "Tool did not request stdin"));
            return Queue.offer(attachment.input, bytes).pipe(
              Effect.flatMap((accepted) =>
                accepted
                  ? Effect.void
                  : Effect.fail(options.toError("tool-input-closed", "Attachment is closed")),
              ),
            );
          }),
        ),
    );
    return { run, input, stopAll } satisfies ToolAttachmentOperations;
  });
