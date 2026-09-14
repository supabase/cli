import {
  NATIVE_PROCESS_DISPATCH_SENTINEL,
  SUPERVISOR_DISPATCH_SENTINEL,
} from "./dispatch-markers.ts";

export {
  NATIVE_PROCESS_DISPATCH_SENTINEL,
  SUPERVISOR_DISPATCH_SENTINEL,
} from "./dispatch-markers.ts";

/**
 * Supported process-entrypoint seam for embedders such as the CLI binary.
 * Returns true when the argv is the supervisor child dispatch, otherwise the
 * caller should continue with its normal command entrypoint.
 */
export const runSupervisorProcessIfDispatched = (argv: ReadonlyArray<string>): Promise<boolean> => {
  if (argv[0] !== SUPERVISOR_DISPATCH_SENTINEL) return Promise.resolve(false);
  return import("../entrypoints/supervisor-node.ts")
    .then(({ runSupervisorProcess }) => runSupervisorProcess(argv.slice(1)))
    .then(() => true);
};

/**
 * Runs the embedded native launcher when a compiled CLI receives its private
 * dispatch marker. Returns false for ordinary CLI argv so callers can continue
 * with their normal command entrypoint.
 */
export const runNativeProcessIfDispatched = (argv: ReadonlyArray<string>): Promise<boolean> => {
  if (argv[0] !== NATIVE_PROCESS_DISPATCH_SENTINEL) return Promise.resolve(false);
  return import("../runtime/native-launcher.ts")
    .then(({ runNativeLauncher }) => runNativeLauncher())
    .then(() => true);
};
