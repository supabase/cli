import { Data, Effect, Predicate } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the waiter reports on stdout synchronously before it blocks on the lock.
import { writeSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the waiter takes the same SQLite lock as the lease.
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

class LeaseWaitError extends Data.TaggedError("LeaseWaitError")<{ readonly message: string }> {}

const [file] = process.argv.slice(2);
if (file === undefined) throw new Error("Lease file missing");

/** Opens an existing lease file, reports `waiting`, then blocks until its holder releases it. */
const program = Effect.try({
  try: () => {
    const connection = new DatabaseSync(new URL(`${pathToFileURL(file).href}?mode=rw`));
    writeSync(1, "waiting\n");
    connection.exec("PRAGMA busy_timeout = 120000");
    try {
      connection.exec("BEGIN IMMEDIATE");
    } catch (cause) {
      // macOS SQLite reports a lock file that its releasing holder unlinked.
      if (!(Predicate.hasProperty(cause, "errcode") && cause.errcode === 6922)) throw cause;
    }
    connection.close();
    writeSync(1, "free\n");
  },
  catch: (cause) => new LeaseWaitError({ message: String(cause) }),
});

await Effect.runPromise(program);
