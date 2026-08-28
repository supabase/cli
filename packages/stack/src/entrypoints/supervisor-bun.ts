import { Effect, Schema } from "effect";
// Bun's standalone entrypoint writes the launcher readiness descriptor
// directly; no Effect FileSystem service owns this inherited fd3 channel.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import * as NodeFs from "node:fs";
import { parseSupervisorArgs, ReadySchema, runSupervisor } from "./supervisor-node.ts";
import { StackOwnershipConflictError } from "../public/Errors.ts";

export { parseSupervisorArgs, runSupervisor, SupervisorArgsSchema } from "./supervisor-node.ts";

if (import.meta.main) {
  Effect.runPromise(
    parseSupervisorArgs(Bun.argv.slice(2)).pipe(Effect.flatMap(runSupervisor)),
  ).catch((error: unknown) => {
    try {
      const conflict = error instanceof StackOwnershipConflictError;
      NodeFs.writeSync(
        3,
        `${Schema.encodeSync(Schema.fromJsonString(ReadySchema))({ ok: false, code: conflict ? "ownership-conflict" : "failed", message: error instanceof Error ? error.message : "Supervisor failed" })}\n`,
      );
      NodeFs.closeSync(3);
    } catch {
      // The parent may have already closed the readiness descriptor.
    }
    process.exitCode = 1;
  });
}
