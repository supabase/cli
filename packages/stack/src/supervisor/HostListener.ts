import { Effect, Scope } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { PortUnavailableError } from "../public/Errors.ts";
import { type HostListener } from "../state/PortCoordinator.ts";
import type { PortField } from "../public/Status.ts";

const HTTP_FIELDS: ReadonlySet<PortField> = new Set([
  "api",
  "studio",
  "mailUi",
  "functionsInspector",
]);

export interface HostListenerBindOptions {
  readonly createHttpServer?: () => HttpServer;
  readonly createTcpServer?: () => NetServer;
  /** Test/embedding seam for a foreign listener API; production uses Server.listen directly. */
  readonly listen?: (
    server: HttpServer | NetServer,
    address: string,
    port: number,
    onListening: () => void,
  ) => void;
}

const closeServer = (server: HttpServer | NetServer): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close(() => resume(Effect.void));
    return Effect.sync(() => {
      if (server.listening) server.close(() => undefined);
    });
  });

const bind = <T extends HttpServer | NetServer>(
  server: T,
  address: string,
  port: number,
  field: PortField,
  listen: HostListenerBindOptions["listen"] = (value, host, number, onListening) =>
    value.listen({ host, port: number }, onListening),
): Effect.Effect<T, PortUnavailableError, Scope.Scope> =>
  Effect.callback<T, PortUnavailableError>((resume) => {
    let settled = false;
    const cleanup = () => {
      server.off("error", onError);
    };
    const onError = (cause: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const swallow = () => undefined;
      server.once("error", swallow);
      try {
        server.close(() => server.off("error", swallow));
      } catch {
        server.off("error", swallow);
      }
      resume(
        Effect.fail(
          new PortUnavailableError({
            field,
            port,
            message: "Host listener is unavailable",
            cause,
          }),
        ),
      );
    };
    server.once("error", onError);
    try {
      listen(server, address, port, () => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(Effect.succeed(server));
      });
    } catch (cause) {
      onError(cause instanceof Error ? cause : new Error(String(cause)));
    }
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      cleanup();
      // `listen` may still be completing when the waiting fiber is interrupted. Keep a temporary
      // error sink while asking Node to close the exact server so a late bind failure cannot become
      // an uncaught process error. `close` throws synchronously when no handle exists; in that case
      // the server has no owned resources left to release.
      const swallow = () => undefined;
      server.once("error", swallow);
      try {
        server.close(() => server.off("error", swallow));
      } catch {
        server.off("error", swallow);
      }
    });
  });

/** Bind and retain one public host listener for direct adoption by a gateway. */
export const bindHostListener = (
  address: string,
  port: number,
  field: PortField,
): Effect.Effect<HostListener, PortUnavailableError, Scope.Scope> =>
  bindHostListenerWithOptions(address, port, field);

export const bindHostListenerWithOptions = (
  address: string,
  port: number,
  field: PortField,
  options: HostListenerBindOptions = {},
): Effect.Effect<HostListener, PortUnavailableError, Scope.Scope> => {
  if (HTTP_FIELDS.has(field))
    return bind(
      options.createHttpServer?.() ?? createHttpServer(),
      address,
      port,
      field,
      options.listen,
    ).pipe(
      Effect.flatMap((server) =>
        Effect.gen(function* () {
          const close = yield* Effect.cached(closeServer(server));
          yield* Effect.addFinalizer(() => close);
          return {
            field,
            address,
            port,
            close,
            binding: { kind: "http", server },
          } satisfies HostListener;
        }),
      ),
    );
  return bind(
    options.createTcpServer?.() ?? createNetServer({ allowHalfOpen: true }),
    address,
    port,
    field,
    options.listen,
  ).pipe(
    Effect.flatMap((server) =>
      Effect.gen(function* () {
        const close = yield* Effect.cached(closeServer(server));
        yield* Effect.addFinalizer(() => close);
        return {
          field,
          address,
          port,
          close,
          binding: { kind: "tcp", server, allowHalfOpen: true },
        } satisfies HostListener;
      }),
    ),
  );
};

export const isHttpPortField = (field: PortField): boolean => HTTP_FIELDS.has(field);
