import { SUPERVISOR_DISPATCH_SENTINEL } from "../supervisor/Launcher.ts";
import { runSupervisorProcess } from "../entrypoints/supervisor-node.ts";

/**
 * Supported process-entrypoint seam for embedders such as the CLI binary.
 * Returns true when the argv is the supervisor child dispatch, otherwise the
 * caller should continue with its normal command entrypoint.
 */
export const runSupervisorProcessIfDispatched = (argv: ReadonlyArray<string>): Promise<boolean> => {
  if (argv[0] !== SUPERVISOR_DISPATCH_SENTINEL) return Promise.resolve(false);
  return runSupervisorProcess(argv.slice(1)).then(() => true);
};
