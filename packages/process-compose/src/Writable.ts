import { Effect } from "effect";
import * as PlatformError from "effect/PlatformError";

const writableFailure = (description: string, cause?: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "node:stream",
    method: "write",
    description,
    cause,
  });

/**
 * Writes one chunk to a Node writable, completing only after backpressure is
 * released. The callback owns every listener it registers for the write.
 */
export const writeChunk = (
  writable: NodeJS.WritableStream,
  chunk: Uint8Array,
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.callback<void, PlatformError.PlatformError>((resume, signal) => {
    let settled = false;

    const onDrain = () => finish(Effect.void);
    const onError = (cause: unknown) =>
      finish(Effect.fail(writableFailure("Writable stream emitted an error", cause)));
    const onClose = () =>
      finish(Effect.fail(writableFailure("Writable stream closed before the write completed")));
    const onAbort = () => cleanup();

    const cleanup = () => {
      writable.removeListener("drain", onDrain);
      writable.removeListener("error", onError);
      writable.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };

    const finish = (effect: Effect.Effect<void, PlatformError.PlatformError>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect);
    };

    writable.once("drain", onDrain);
    writable.once("error", onError);
    writable.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (writable.write(chunk)) finish(Effect.void);
    } catch (cause) {
      onError(cause);
    }

    return Effect.sync(cleanup);
  });
