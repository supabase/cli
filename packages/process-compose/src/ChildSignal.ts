import { Cause, Option } from "effect";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const signalFrom = (value: unknown): ChildProcess.Signal | undefined => {
  switch (value) {
    case "SIGABRT":
    case "SIGALRM":
    case "SIGBUS":
    case "SIGCHLD":
    case "SIGCONT":
    case "SIGFPE":
    case "SIGHUP":
    case "SIGILL":
    case "SIGINT":
    case "SIGIO":
    case "SIGIOT":
    case "SIGKILL":
    case "SIGPIPE":
    case "SIGPOLL":
    case "SIGPROF":
    case "SIGPWR":
    case "SIGQUIT":
    case "SIGSEGV":
    case "SIGSTKFLT":
    case "SIGSTOP":
    case "SIGSYS":
    case "SIGTERM":
    case "SIGTRAP":
    case "SIGTSTP":
    case "SIGTTIN":
    case "SIGTTOU":
    case "SIGUNUSED":
    case "SIGURG":
    case "SIGUSR1":
    case "SIGUSR2":
    case "SIGVTALRM":
    case "SIGWINCH":
    case "SIGXCPU":
    case "SIGXFSZ":
    case "SIGBREAK":
    case "SIGLOST":
    case "SIGINFO":
      return value;
    default:
      return undefined;
  }
};

/** Extracts the signal reported by Effect's child-process exit failure. */
export const childSignalFromCause = (
  cause: Cause.Cause<PlatformError.PlatformError>,
): Option.Option<ChildProcess.Signal> =>
  Option.flatMap(Cause.findErrorOption(cause), (error) => {
    if (
      !(error instanceof PlatformError.PlatformError) ||
      !(error.reason instanceof PlatformError.SystemError) ||
      error.reason.method !== "exitCode" ||
      !(error.reason.cause instanceof Error)
    ) {
      return Option.none();
    }

    const match = /^Process interrupted due to receipt of signal: '([^']+)'$/.exec(
      error.reason.cause.message,
    );
    const signal = signalFrom(match?.[1]);
    return signal === undefined ? Option.none() : Option.some(signal);
  });
