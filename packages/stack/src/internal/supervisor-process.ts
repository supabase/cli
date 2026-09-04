import { SUPERVISOR_DISPATCH_SENTINEL } from "../supervisor/Launcher.ts";
import { runSupervisorProcess } from "../entrypoints/supervisor-node.ts";
import { NATIVE_PROCESS_DISPATCH_SENTINEL } from "../runtime/NativeProcess.ts";
import { runNativeLauncher } from "../runtime/native-launcher.ts";

export { NATIVE_PROCESS_DISPATCH_SENTINEL } from "../runtime/NativeProcess.ts";

/**
 * Supported process-entrypoint seam for embedders such as the CLI binary.
 * Returns true when the argv is the supervisor child dispatch, otherwise the
 * caller should continue with its normal command entrypoint.
 */
export const runSupervisorProcessIfDispatched = (argv: ReadonlyArray<string>): Promise<boolean> => {
  if (argv[0] !== SUPERVISOR_DISPATCH_SENTINEL) return Promise.resolve(false);
  return runSupervisorProcess(argv.slice(1)).then(() => true);
};

/**
 * Runs the embedded native launcher when a compiled CLI receives its private
 * dispatch marker. Returns false for ordinary CLI argv so callers can continue
 * with their normal command entrypoint.
 */
export const runNativeProcessIfDispatched = (argv: ReadonlyArray<string>): Promise<boolean> => {
  if (argv[0] !== NATIVE_PROCESS_DISPATCH_SENTINEL) return Promise.resolve(false);
  runNativeLauncher();
  return Promise.resolve(true);
};
