import { Duration, Effect, Option, Schedule, Stream } from "effect";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { HttpClient } from "effect/unstable/http";
import { Socket } from "node:net";
import { RuntimeDriverError } from "./RuntimeDriver.ts";
import { StackPreparationError } from "../public/Errors.ts";

export interface ReadinessTarget {
  readonly mode: "http" | "tcp";
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ReadinessProbeOptions {
  /** Optional maximum number of retries after the initial attempt. */
  readonly retries?: number;
  /** Delay between attempts; defaults to a short spaced schedule. */
  readonly retryDelay?: Duration.Input;
  /** Total time allowed for the initial attempt and all retries; zero ignores retries. */
  readonly deadline?: Duration.Input;
}

/** Default total readiness budget for non-database workloads. */
export const DEFAULT_READINESS_DEADLINE = Duration.seconds(30);

const preparationError = (message: string): StackPreparationError =>
  new StackPreparationError({ message });

const runtimeError = (
  target: ReadinessTarget,
  message: string,
  cause?: unknown,
): RuntimeDriverError =>
  new RuntimeDriverError({
    message,
    target,
    cause,
  });

const containsControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

const validHeaderName = (value: string): boolean =>
  value.length > 0 && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value);

const validateTarget = (target: ReadinessTarget): Effect.Effect<void, StackPreparationError> => {
  if (target.host.length === 0 || containsControl(target.host))
    return Effect.fail(preparationError("Readiness host is invalid"));
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535)
    return Effect.fail(preparationError("Readiness port is invalid"));
  if (target.mode === "http" && target.path !== undefined) {
    if (!target.path.startsWith("/"))
      return Effect.fail(preparationError("Readiness HTTP path must begin with '/'"));
    if (containsControl(target.path))
      return Effect.fail(preparationError("Readiness HTTP path contains control characters"));
  }
  if (target.headers !== undefined) {
    for (const [name, value] of Object.entries(target.headers)) {
      if (!validHeaderName(name))
        return Effect.fail(preparationError("Readiness HTTP header name is invalid"));
      if (containsControl(value))
        return Effect.fail(preparationError("Readiness HTTP header value is invalid"));
    }
  }
  return Effect.void;
};

const decodeDuration = (
  value: Duration.Input,
  name: string,
): Effect.Effect<Duration.Duration, StackPreparationError> => {
  const decoded = Duration.fromInput(value);
  if (Option.isNone(decoded)) return Effect.fail(preparationError(`${name} is invalid`));
  if (!Duration.isFinite(decoded.value) || Duration.isNegative(decoded.value))
    return Effect.fail(preparationError(`${name} must be finite and non-negative`));
  return Effect.succeed(decoded.value);
};

const httpAttempt = (target: ReadinessTarget) => {
  const host =
    target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
  const url = `http://${host}:${target.port}${target.path ?? "/"}`;
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url, { headers: target.headers });
    yield* response.stream.pipe(Stream.runDrain);
    if (response.status < 200 || response.status >= 300)
      return yield* runtimeError(target, "Readiness HTTP status was not successful");
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof RuntimeDriverError
        ? cause
        : runtimeError(target, "Readiness HTTP request failed", cause),
    ),
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );
};

const tcpAttempt = (target: ReadinessTarget): Effect.Effect<void, RuntimeDriverError> =>
  Effect.callback<void, RuntimeDriverError>((resume) => {
    let settled = false;
    let socket: Socket | undefined;
    const cleanup = () => {
      socket?.off("connect", onConnect);
      socket?.off("error", onError);
      socket?.off("close", onClose);
    };
    const finish = (effect: Effect.Effect<void, RuntimeDriverError>) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket?.destroy();
      resume(effect);
    };
    const onConnect = () => finish(Effect.void);
    const onError = (cause: Error) =>
      finish(Effect.fail(runtimeError(target, "Readiness TCP connection failed", cause)));
    const onClose = () => {
      finish(Effect.fail(runtimeError(target, "Readiness TCP connection closed")));
    };
    socket = new Socket();
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.connect({ host: target.host, port: target.port });
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      cleanup();
      socket?.destroy();
    });
  });

/**
 * Probes one exact private endpoint. Retry is expressed through Effect's
 * Schedule so cancellation interrupts the owned request/socket immediately.
 */
export const probeReadiness = (
  target: ReadinessTarget,
  options: ReadinessProbeOptions = {},
): Effect.Effect<void, RuntimeDriverError | StackPreparationError> =>
  Effect.gen(function* () {
    yield* validateTarget(target);
    const retries = options.retries;
    if (retries !== undefined && (!Number.isSafeInteger(retries) || retries < 0))
      return yield* preparationError("Readiness retry count is invalid");
    const retryDelay = yield* decodeDuration(
      options.retryDelay ?? Duration.millis(100),
      "Readiness retry delay",
    );
    const deadline = yield* decodeDuration(
      options.deadline ?? DEFAULT_READINESS_DEADLINE,
      "Readiness deadline",
    );
    const attempt = target.mode === "http" ? httpAttempt(target) : tcpAttempt(target);
    // A zero deadline runs one immediate probe with no retry delay; a positive deadline can
    // interrupt whichever owned request/socket is still active.
    if (Duration.isZero(deadline)) return yield* attempt;
    const schedule =
      retries === undefined
        ? Schedule.spaced(retryDelay)
        : Schedule.spaced(retryDelay).pipe(Schedule.upTo({ times: retries }));
    yield* Effect.timeoutOrElse(Effect.retry(attempt, schedule), {
      duration: deadline,
      orElse: () => Effect.fail(runtimeError(target, "Readiness deadline exceeded")),
    });
  });
