import * as Http from "node:http";
import { Effect } from "effect";
import {
  CONTROL_STATUS_PATH,
  ControlProtocolError,
  ControlTransportError,
  type ControlEndpoint,
  type ControlOwnerReader,
} from "./managed/control.ts";

const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return errorCode(cause.cause);
  return undefined;
};

const readError = (
  endpoint: ControlEndpoint,
  cause: unknown,
): ControlTransportError | ControlProtocolError => {
  const code = errorCode(cause);
  if (
    cause instanceof SyntaxError ||
    code?.startsWith("HPE_") === true ||
    (cause instanceof Error &&
      cause.message === `Control status response exceeded ${MAX_CONTROL_RESPONSE_BYTES} bytes`) ||
    (cause instanceof Error && cause.message.startsWith("Control status request returned"))
  ) {
    return new ControlProtocolError({ endpoint, cause });
  }
  return new ControlTransportError({
    endpoint,
    reason: code === "ECONNREFUSED" ? "unreachable" : "transport",
    cause,
  });
};

/** Protocol-aware owner reader shared by the Node and Bun control transports. */
export const readControlOwner: ControlOwnerReader = (endpoint) =>
  Effect.callback<unknown, unknown>((resume) => {
    let response: Http.IncomingMessage | undefined;
    let onData: ((chunk: string) => void) | undefined;
    let onEnd: (() => void) | undefined;
    let onResponseError: ((cause: Error) => void) | undefined;
    let onResponseAborted: (() => void) | undefined;
    let onResponseClose: (() => void) | undefined;
    let settled = false;
    let cleanup = () => {};
    let dispose = () => {};
    const finish = (effect: Effect.Effect<unknown, unknown>, shouldDispose = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (shouldDispose) dispose();
      resume(effect);
    };
    const onRequestError = (cause: Error) => finish(Effect.fail(cause), true);
    const request = Http.request(
      {
        host: endpoint.hostname,
        port: endpoint.port,
        path: CONTROL_STATUS_PATH,
        method: "GET",
        // One-shot connection: a pooled keep-alive connection would let a
        // closed listener keep answering status probes while the probes
        // themselves keep the connection alive.
        agent: false,
      },
      (incoming) => {
        response = incoming;
        let body = "";
        let bodyBytes = 0;
        let ended = false;
        let responseAborted = false;
        onData = (chunk) => {
          bodyBytes += Buffer.byteLength(chunk, "utf8");
          if (bodyBytes > MAX_CONTROL_RESPONSE_BYTES) {
            finish(
              Effect.fail(
                new Error(`Control status response exceeded ${MAX_CONTROL_RESPONSE_BYTES} bytes`),
              ),
              true,
            );
            return;
          }
          body += chunk;
        };
        onEnd = () => {
          ended = true;
          if ((incoming.statusCode ?? 500) < 200 || (incoming.statusCode ?? 500) >= 300) {
            finish(
              Effect.fail(
                new Error(`Control status request returned ${incoming.statusCode ?? 500}`),
              ),
              true,
            );
            return;
          }
          try {
            finish(Effect.succeed(JSON.parse(body)));
          } catch (cause) {
            finish(Effect.fail(cause), true);
          }
        };
        onResponseError = (cause) => finish(Effect.fail(cause), true);
        onResponseAborted = () => {
          responseAborted = true;
        };
        onResponseClose = () => {
          if (responseAborted || !ended) {
            finish(Effect.fail(new Error("Control status response closed before end")), true);
          }
        };
        incoming.setEncoding("utf8");
        incoming.on("data", onData);
        incoming.once("end", onEnd);
        incoming.once("error", onResponseError);
        incoming.once("aborted", onResponseAborted);
        incoming.once("close", onResponseClose);
      },
    );
    dispose = () => {
      response?.destroy();
      request.destroy();
    };
    cleanup = () => {
      request.removeListener("error", onRequestError);
      if (response !== undefined) {
        if (onData !== undefined) response.removeListener("data", onData);
        if (onEnd !== undefined) response.removeListener("end", onEnd);
        if (onResponseError !== undefined) response.removeListener("error", onResponseError);
        if (onResponseAborted !== undefined) response.removeListener("aborted", onResponseAborted);
        if (onResponseClose !== undefined) response.removeListener("close", onResponseClose);
      }
    };
    request.once("error", onRequestError);
    request.end();
    return Effect.callback<void>((resumeCancellation) => {
      const onClose = () => {
        cleanup();
        resumeCancellation(Effect.void);
      };
      settled = true;
      request.once("close", onClose);
      dispose();
      return Effect.sync(() => {
        request.removeListener("close", onClose);
        cleanup();
      });
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: 500,
      orElse: () => Effect.fail(new Error("Control status request timed out")),
    }),
    Effect.mapError((cause) => readError(endpoint, cause)),
  );
