import { Effect, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the fixture reports on the inherited readiness descriptor.
import { closeSync, rmSync, writeSync } from "node:fs";

const [stateRoot, , stackId] = process.argv.slice(2);
if (stateRoot === undefined || stackId === undefined) throw new Error("Fixture arguments missing");

/** Logs a diagnostic, deletes its own log as a failed session start does, then reports failure. */
const program = Effect.gen(function* () {
  process.stderr.write("failing-owner-diagnostic\n");
  rmSync(`${stateRoot}/${stackId}/owner.log`, { force: true });
  const line = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    type: "error",
    message: "owner startup failed",
  });
  try {
    writeSync(3, `${line}\n`);
  } finally {
    closeSync(3);
  }
  process.exitCode = 1;
});

await Effect.runPromise(program);
