#!/usr/bin/env bun
import { runSupervisorProcess } from "../../../../packages/stack/src/entrypoints/supervisor-node.ts";
import { SUPERVISOR_DISPATCH_SENTINEL } from "../../../../packages/stack/src/supervisor/Launcher.ts";

const args = process.argv.slice(2);
if (args[0] === SUPERVISOR_DISPATCH_SENTINEL) {
  await runSupervisorProcess(args.slice(1));
} else {
  await import("./cli/main.ts");
}
