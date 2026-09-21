import {
  HOST_PROCESS_DISPATCH_SENTINEL,
  NATIVE_PROCESS_DISPATCH_SENTINEL,
} from "./dispatch-markers.ts";

/** Runs the embedded owner when a compiled CLI receives its private dispatch marker. */
export const runHostProcessIfDispatched = (argv: ReadonlyArray<string>): Promise<boolean> => {
  if (argv[0] !== HOST_PROCESS_DISPATCH_SENTINEL) return Promise.resolve(false);
  return import("./host-process.ts")
    .then(({ runHostProcess }) => runHostProcess(argv.slice(1)))
    .then(
      () => true,
      () => {
        process.exitCode = 1;
        return true;
      },
    );
};

/** Runs the embedded native launcher when a compiled CLI receives its private dispatch marker. */
export const runNativeProcessIfDispatched = (argv: ReadonlyArray<string>): Promise<boolean> => {
  if (argv[0] !== NATIVE_PROCESS_DISPATCH_SENTINEL) return Promise.resolve(false);
  return import("../runtime/native-launcher.ts").then(({ runNativeLauncher }) => {
    runNativeLauncher();
    return true;
  });
};
