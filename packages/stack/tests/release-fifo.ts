import { Effect } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the FIFO write end must stay open read-write so releasing never blocks.
import { closeSync, constants, openSync, writeSync } from "node:fs";

/**
 * Holds an existing FIFO open read-write for the scope, so a release never blocks on a missing
 * reader and one written before a reader opens is buffered. `release` is idempotent.
 */
export const holdReleaseFifo = (path: string) =>
  Effect.gen(function* () {
    const holder = openSync(path, constants.O_RDWR);
    let released = false;
    yield* Effect.addFinalizer(() => Effect.sync(() => closeSync(holder)));
    return {
      release: Effect.sync(() => {
        if (released) return;
        released = true;
        writeSync(holder, "\n");
      }),
    };
  });
