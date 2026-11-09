import { Clock, Data, Deferred, Effect, Fiber, FiberSet, Ref, Scope } from "effect";
import { redactCredentials } from "./internal/redact-credentials.ts";
import { PortError } from "./Ports.ts";
import type { BackendAddress, ProxyError } from "./Proxy.ts";
import {
  Agent,
  createServer,
  request as upstreamRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- raw HTTP upgrade sockets preserve handshake bytes.
import { createServer as createNetServer, Socket } from "node:net";
import { createSecureContext, type SecureContext, TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";

class HttpProxyError extends Data.TaggedError("HttpProxyError")<{
  readonly message: string;
  readonly cause?: unknown;
  /** Whether upstream response headers had arrived when a proxied request failed. */
  readonly responded?: boolean;
}> {}

/** Distinguishes a client that went away first from a genuine proxy failure. */
class HttpProxyDisconnected extends Data.TaggedError("HttpProxyDisconnected") {}

export interface HttpRoute {
  readonly id: string;
  readonly prefix: string;
  readonly target: Effect.Effect<BackendAddress, ProxyError, Scope.Scope>;
  readonly upstreamPrefix?: string;
  readonly upstreamHost?: string;
  /** Headers sent only when the client sent none, like Kong's request-transformer `add`. */
  readonly addHeaders?: Readonly<Record<string, string>>;
  /** X-Forwarded-Prefix of a stripped route; defaults to `prefix/`, legacy Kong's path form. */
  readonly forwardedPrefix?: string;
  /** A shared API listener route, which sends legacy Kong's X-Forwarded-Proto/Host/Port/Path/Prefix. */
  readonly gateway?: boolean;
  readonly keyRewrite?: HttpRouteKeyRewrite;
  /** Sends each write over a fresh upstream connection; reads still share the pool and its retry. */
  readonly freshWrites?: boolean;
  /** Leaves CORS, preflights included, to the upstream, like Edge Functions on the platform. */
  readonly upstreamCors?: boolean;
}

/** Answers plain GET from this process, with no CORS headers or backend; `undefined` is a 404. */
export interface HttpFileRoute {
  readonly id: string;
  readonly prefix: string;
  readonly file: (url: string) => Effect.Effect<Uint8Array | undefined>;
}

/** Configures Supabase API-key rewriting for one HTTP route. */
interface HttpRouteKeyRewrite {
  readonly policy: "bearer" | "query" | "sb-api-key";
  readonly keys: {
    readonly publishableKey: string;
    readonly secretKey: string;
    readonly anonKey: string;
    readonly serviceRoleKey: string;
  };
}

/** One request or WebSocket upgrade the proxy completed. */
export interface HttpAccess {
  /** Epoch milliseconds when the request arrived. */
  readonly time: number;
  readonly client: string;
  readonly method: string;
  /** The request path and query, with credential query and fragment values redacted. */
  readonly target: string;
  readonly protocol: string;
  /**
   * The recorded outcome: the status sent, or 499 when the client left before a response. An
   * upgrade records the upstream handshake status; without one, 404 for no route and 502 for a
   * failure, while the client sees its socket reset.
   */
  readonly status: number;
  /** Body bytes of a response that finished; absent when it was cut short, and for upgrades. */
  readonly bytes?: number;
  /** The Referer header, with credential query and fragment values redacted. */
  readonly referer?: string;
  readonly userAgent?: string;
  /** Until the response finished; for an upgrade, until the upstream handshake answered. */
  readonly durationMillis: number;
}

/** Receives each completed request after its response; it must not block. */
export type HttpAccessSink = (access: HttpAccess) => Effect.Effect<void>;

export interface HttpProxy {
  readonly host: string;
  readonly port: number;
  readonly setRoutes: (routes: ReadonlyArray<HttpRoute | HttpFileRoute>) => Effect.Effect<void>;
}

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const errorFor = (cause: unknown, responded?: boolean) =>
  new HttpProxyError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
    ...(responded === undefined ? {} : { responded }),
  });

// RFC 9110 section 9.2.1 safe methods only: user functions behind the proxy need not honor
// PUT or DELETE idempotency.
const safeMethods = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

// RFC 9112 section 6: a request carries a body only when Content-Length or
// Transfer-Encoding is present, regardless of method.
const hasBody = (request: IncomingMessage) =>
  request.headers["transfer-encoding"] !== undefined ||
  Number(request.headers["content-length"] ?? 0) > 0;

// A write can commit before its connection resets, so only safe, bodyless requests are resent.
const isReplayable = (request: IncomingMessage) =>
  safeMethods.has(request.method ?? "GET") && !hasBody(request);

const headersFor = (headers: IncomingMessage["headers"]) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => value !== undefined && !hopByHop.has(name.toLowerCase()),
    ),
  );

const headerValue = (value: string | ReadonlyArray<string> | undefined) =>
  value === undefined ? undefined : typeof value === "string" ? value : value.join(", ");

const bearerValueFor = (headers: IncomingMessage["headers"], keys: HttpRouteKeyRewrite["keys"]) => {
  const authorization = headerValue(headers.authorization);
  if (authorization !== undefined && !authorization.startsWith("Bearer sb_")) return authorization;
  const apiKey = headerValue(headers.apikey);
  if (apiKey === undefined) return undefined;
  if (apiKey === keys.secretKey) return `Bearer ${keys.serviceRoleKey}`;
  if (apiKey === keys.publishableKey) return `Bearer ${keys.anonKey}`;
  return apiKey;
};

/* Like Kong: append the client to any incoming X-Forwarded-For chain; X-Real-IP is the client. */
const upstreamHeadersFor = (request: IncomingMessage, route: HttpRoute) => {
  const headers = request.headers;
  const client = request.socket.remoteAddress;
  const forwardedFor = headerValue(headers["x-forwarded-for"]);
  const result: Record<string, string | string[]> = {
    ...headersFor(headers),
    ...(route.upstreamHost === undefined ? {} : { host: route.upstreamHost }),
  };
  /* Without a peer address, a client-sent X-Real-IP is still dropped rather than passed through. */
  if (client === undefined) delete result["x-real-ip"];
  else {
    result["x-forwarded-for"] = forwardedFor === undefined ? client : `${forwardedFor}, ${client}`;
    result["x-real-ip"] = client;
  }
  /* Like Kong without trusted IPs: client-sent X-Forwarded-* values are replaced, the host is
     nginx's `$host` (lowercase, no port or trailing dot: ngx_http_validate_host, release-1.19.10
     src/http/ngx_http_request.c#L2026-L2028), and only a stripped route sends its prefix. */
  if (route.gateway === true) {
    const host = headerValue(headers.host)
      ?.toLowerCase()
      .replace(/\.?(?::\d*)?$/u, "");
    const port = request.socket.localPort;
    const prefix =
      route.upstreamPrefix === undefined || route.prefix === "/"
        ? undefined
        : (route.forwardedPrefix ?? `${route.prefix}/`);
    result["x-forwarded-proto"] = encrypted(request) ? "https" : "http";
    if (host === undefined) delete result["x-forwarded-host"];
    else result["x-forwarded-host"] = host;
    if (port === undefined) delete result["x-forwarded-port"];
    else result["x-forwarded-port"] = String(port);
    result["x-forwarded-path"] = pathnameFor(request.url ?? "/");
    if (prefix === undefined) delete result["x-forwarded-prefix"];
    else result["x-forwarded-prefix"] = prefix;
  }
  for (const [name, value] of Object.entries(route.addHeaders ?? {}))
    result[name.toLowerCase()] ??= value;
  const keyRewrite = route.keyRewrite;
  if (keyRewrite?.policy === "bearer") {
    const value = bearerValueFor(headers, keyRewrite.keys);
    if (value === undefined) delete result.authorization;
    else result.authorization = value;
  } else if (keyRewrite?.policy === "sb-api-key") {
    const value = bearerValueFor(headers, keyRewrite.keys);
    if (value === undefined) delete result["sb-api-key"];
    else result["sb-api-key"] = value;
  }
  return result;
};

/** Captures a request's access fields while its socket is open; completes them once it settles. */
const accessFor = (request: IncomingMessage, time: number) => {
  const referer = headerValue(request.headers.referer);
  const userAgent = headerValue(request.headers["user-agent"]);
  const fields = {
    time,
    client: request.socket.remoteAddress ?? "-",
    method: request.method ?? "GET",
    target: redactCredentials(request.url ?? "/"),
    protocol: `HTTP/${request.httpVersion}`,
    ...(referer === undefined ? {} : { referer: redactCredentials(referer) }),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
  return (ended: number, status: number, bytes?: number): HttpAccess => ({
    ...fields,
    status,
    ...(bytes === undefined ? {} : { bytes }),
    durationMillis: Math.max(0, ended - time),
  });
};

/** What one request's client was sent. */
interface Sent {
  /** Body bytes handed to the response. */
  bytes: number;
  /** The client went away before the response completed. */
  clientLeft: boolean;
}

const respond = (
  response: ServerResponse,
  sent: Sent,
  status: number,
  body?: string | Uint8Array,
) => {
  response.statusCode = status;
  // Node sends no body for a HEAD request.
  sent.bytes = body === undefined || response.req.method === "HEAD" ? 0 : Buffer.byteLength(body);
  response.end(body);
};

const serveFile = Effect.fnUntraced(function* (
  request: IncomingMessage,
  response: ServerResponse,
  sent: Sent,
  route: HttpFileRoute,
) {
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    return respond(response, sent, 405, "Method Not Allowed");
  }
  const body = yield* route.file(request.url ?? "/");
  if (body === undefined) return respond(response, sent, 404, "Not Found");
  respond(response, sent, 200, body);
});

const responseSettled = (response: ServerResponse) =>
  Effect.callback<void>((resume) => {
    const onDone = () => resume(Effect.void);
    response.once("finish", onDone);
    response.once("close", onDone);
    if (response.writableFinished || response.destroyed) onDone();
    return Effect.sync(() => {
      response.off("finish", onDone);
      response.off("close", onDone);
    });
  });

const decodeQuery = (value: string) => {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    return value;
  }
};

const queryValueFor = (value: string, keys: HttpRouteKeyRewrite["keys"]) =>
  value === keys.secretKey
    ? keys.serviceRoleKey
    : value === keys.publishableKey
      ? keys.anonKey
      : value;

const pathFor = (request: IncomingMessage, route: HttpRoute) => {
  const input = request.url ?? "/";
  const queryAt = input.indexOf("?");
  const pathname = queryAt < 0 ? input : input.slice(0, queryAt);
  const query = queryAt < 0 ? "" : input.slice(queryAt);
  const suffix = route.prefix === "/" ? pathname : pathname.slice(route.prefix.length);
  const path =
    route.upstreamPrefix === undefined
      ? pathname
      : // Exact-path upstreams such as Studio's `/api/mcp` redirect a trailing slash.
        suffix === ""
        ? route.upstreamPrefix
        : `${route.upstreamPrefix.replace(/\/$/u, "")}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  return `${path}${rewriteQuery(query, route)}`;
};

const rewriteQuery = (query: string, route: HttpRoute) => {
  if (route.keyRewrite?.policy !== "query" || query.length === 0) return query;
  const { keys } = route.keyRewrite;
  return query
    .slice(1)
    .split("&")
    .map((parameter) => {
      const separator = parameter.indexOf("=");
      const name = separator < 0 ? parameter : parameter.slice(0, separator);
      if (decodeQuery(name) !== "apikey") return parameter;
      const rawValue = separator < 0 ? "" : parameter.slice(separator + 1);
      const replacement = queryValueFor(decodeQuery(rawValue), keys);
      return replacement === decodeQuery(rawValue)
        ? parameter
        : `${name}=${encodeURIComponent(replacement)}`;
    })
    .join("&")
    .replace(/^/u, "?");
};

const pathnameFor = (url: string) => url.split("?", 1)[0] || "/";

const routeFor = (url: string, routes: ReadonlyArray<HttpRoute | HttpFileRoute>) => {
  const pathname = pathnameFor(url);
  return routes.find(
    (route) =>
      pathname === route.prefix || route.prefix === "/" || pathname.startsWith(`${route.prefix}/`),
  );
};

const corsMethods = "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT";

/** Headers the platform gateway puts on responses it answers itself. */
const setCors = (response: ServerResponse) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", corsMethods);
};

const varyOnOrigin = (response: ServerResponse) => {
  const vary = response.getHeader("vary");
  const values = (Array.isArray(vary) ? vary.join(",") : String(vary ?? ""))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (values.some((value) => value === "*" || value.toLowerCase() === "origin")) return;
  response.setHeader("vary", [...values, "Origin"].join(", "));
};

const setPreflightCors = (response: ServerResponse, request: IncomingMessage) => {
  setCors(response);
  response.setHeader(
    "access-control-allow-headers",
    request.headers["access-control-request-headers"] ??
      "accept-profile,apikey,authorization,x-client-info",
  );
};

const disconnected = (request: IncomingMessage, response: ServerResponse) =>
  Effect.callback<never, HttpProxyDisconnected>((resume) => {
    const onAbort = () => resume(Effect.fail(new HttpProxyDisconnected()));
    const onRequestClose = () => {
      if (!request.complete) onAbort();
    };
    const onSocketClose = () => {
      if (!response.writableEnded) onAbort();
    };
    request.once("aborted", onAbort);
    request.once("close", onRequestClose);
    request.socket.once("close", onSocketClose);
    response.once("close", onAbort);
    if (request.aborted || request.socket.destroyed || response.destroyed) onAbort();
    return Effect.sync(() => {
      request.off("aborted", onAbort);
      request.off("close", onRequestClose);
      request.socket.off("close", onSocketClose);
      response.off("close", onAbort);
    });
  });

const connectInterruptibly = Effect.fn("HttpProxy.connect")((address: BackendAddress) =>
  Effect.gen(function* () {
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => new Socket({ allowHalfOpen: true })),
      (value) => Effect.sync(() => value.destroy()),
    );
    yield* Effect.callback<void, HttpProxyError>((resume) => {
      const onConnect = () => resume(Effect.void);
      const onError = (cause: Error) => resume(Effect.fail(errorFor(cause)));
      socket.once("connect", onConnect);
      socket.on("error", onError);
      if ("path" in address) socket.connect(address.path);
      else socket.connect(address.port, address.host);
      return Effect.sync(() => {
        socket.off("connect", onConnect);
      });
    }).pipe(Effect.timeout("10 seconds"));
    return socket;
  }),
);

const earlyResponseDrain = "2 seconds";

// Mirrors nginx `proxy_next_upstream error`: a backend that drops a connection before answering
// gets one more attempt, but only when nothing sent to the client or upstream would need replaying.
const isRetryable =
  (request: IncomingMessage, response: ServerResponse) =>
  (error: HttpProxyError | HttpProxyDisconnected) =>
    error._tag === "HttpProxyError" &&
    error.responded === false &&
    !response.destroyed &&
    isReplayable(request);

const forward = Effect.fn("HttpProxy.forward")(function* (
  request: IncomingMessage,
  response: ServerResponse,
  route: HttpRoute,
  backend: BackendAddress,
  agent: Agent | false,
  sent: Sent,
) {
  const draining = yield* Deferred.make<void>();
  yield* Deferred.await(draining).pipe(
    Effect.andThen(Effect.sleep(earlyResponseDrain)),
    Effect.andThen(Effect.sync(() => response.end())),
    Effect.forkChild,
  );
  return yield* Effect.callback<void, HttpProxyError | HttpProxyDisconnected>((resume) => {
    let outgoing: ReturnType<typeof upstreamRequest> | undefined;
    let incoming: IncomingMessage | undefined;
    let settled = false;
    // Error listeners remain until collection because destroy may emit errors asynchronously.
    const cleanup = () => {
      request.off("aborted", onClientGone);
      request.off("end", endResponse);
      response.off("close", onResponseClose);
      response.off("finish", onFinish);

      incoming?.off("aborted", onError);
    };
    const finish = (result: Effect.Effect<void, HttpProxyError | HttpProxyDisconnected>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(result);
    };
    // Settling first keeps the outcome: destroying a partial upstream response emits
    // `aborted` synchronously, which would otherwise resettle as a proxy failure.
    const abandon = (result: Effect.Effect<void, HttpProxyError | HttpProxyDisconnected>) => {
      if (settled) return;
      finish(result);
      outgoing?.destroy();
      incoming?.destroy();
    };
    const onError = (cause: Error) => abandon(Effect.fail(errorFor(cause, incoming !== undefined)));
    const onClientGone = () => abandon(Effect.fail(new HttpProxyDisconnected()));
    const onFinish = () => finish(Effect.void);
    const endResponse = () => {
      if (!settled) response.end();
    };
    // Bun resets a `Connection: close` client when the response completes before its request body
    // is fully read, so the response waits, like nginx's lingering close, for a bounded drain.
    const onUpstreamEnd = () => {
      if (outgoing !== undefined) request.unpipe(outgoing);
      if (request.readableEnded) endResponse();
      else {
        request.once("end", endResponse);
        Deferred.doneUnsafe(draining, Effect.void);
        request.resume();
      }
    };
    // A close after `end()` but before `finish` means the client reset with writes still queued.
    const onResponseClose = () => {
      if (!response.writableFinished) onClientGone();
    };
    outgoing = upstreamRequest(
      {
        host: "path" in backend ? undefined : backend.host,
        port: "path" in backend ? undefined : backend.port,
        socketPath: "path" in backend ? backend.path : undefined,
        agent,
        method: request.method,
        path: pathFor(request, route),
        // Bun ends a streamed upstream response early when the request says Connection: close,
        // and sends a GET or DELETE body unframed unless the request says it is chunked.
        headers: {
          ...upstreamHeadersFor(request, route),
          ...(request.headers["transfer-encoding"] === undefined
            ? {}
            : { "transfer-encoding": "chunked" }),
          connection: "keep-alive",
        },
      },
      (value) => {
        incoming = value;
        value.once("aborted", onError);
        value.on("error", onError);
        value.on("data", (chunk: Buffer) => {
          sent.bytes += chunk.length;
        });
        response.once("finish", onFinish);
        response.statusCode = value.statusCode ?? 502;
        for (const [name, header] of Object.entries(value.headers)) {
          if (header !== undefined && !hopByHop.has(name.toLowerCase()))
            response.setHeader(name, header);
        }
        if (route.upstreamCors !== true) {
          const origin = request.headers.origin;
          response.setHeader("access-control-allow-origin", origin ?? "*");
          varyOnOrigin(response);
        }
        response.flushHeaders();
        value.pipe(response, { end: false });
        value.once("end", onUpstreamEnd);
      },
    );
    outgoing.on("error", onError);
    request.once("aborted", onClientGone);
    response.once("close", onResponseClose);
    // A retried bodyless request was already drained by the first attempt and emits no
    // further `end`, so pipe would never finish the upstream request.
    if (request.readableEnded) outgoing.end();
    else request.pipe(outgoing);
    return Effect.sync(() => {
      settled = true;
      cleanup();
      outgoing?.destroy();
      incoming?.destroy();
    });
  });
});

const proxyRequest = Effect.fn("HttpProxy.proxyRequest")(
  (
    request: IncomingMessage,
    response: ServerResponse,
    route: HttpRoute,
    agent: Agent,
    sent: Sent,
  ) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ route_id: route.id });
      // Re-resolved on retry: a backend invalidated between attempts may have its address reused.
      const resolveBackend = () => Effect.raceFirst(route.target, disconnected(request, response));
      const backend = yield* resolveBackend();
      yield* forward(
        request,
        response,
        route,
        backend,
        route.freshWrites === true && !isReplayable(request) ? false : agent,
        sent,
      ).pipe(
        Effect.catchIf(isRetryable(request, response), (error) =>
          Effect.logWarning(
            `Route ${route.id} ${request.method ?? "GET"} upstream failed before responding, retrying`,
            error,
          ).pipe(
            Effect.andThen(resolveBackend()),
            Effect.andThen((retryBackend) =>
              forward(request, response, route, retryBackend, false, sent),
            ),
          ),
        ),
      );
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          response.headersSent
            ? Effect.annotateCurrentSpan({ "http.response.status_code": response.statusCode })
            : Effect.void,
        ),
      ),
    ),
);

const statusLine = /^HTTP\/\d(?:\.\d)? (\d{3})\b/u;
/** Upstream bytes read for the handshake status before giving up on finding one. */
const answerLimit = 8 * 1024;

const upgrade = Effect.fn("HttpProxy.upgrade")(
  (
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
    route: HttpRoute,
    handshake: Deferred.Deferred<number>,
  ) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ route_id: route.id });
      const backend = yield* Effect.raceFirst(
        route.target,
        Effect.callback<never, HttpProxyDisconnected>((resume) => {
          const onClose = () => resume(Effect.fail(new HttpProxyDisconnected()));
          client.once("close", onClose);
          if (client.destroyed) onClose();
          return Effect.sync(() => client.off("close", onClose));
        }),
      );
      const upstream = yield* connectInterruptibly(backend);
      yield* Effect.callback<void, HttpProxyError | HttpProxyDisconnected>((resume) => {
        let settled = false;
        let answer = "";
        const cleanup = () => {
          client.off("close", onClientClose);

          upstream.off("close", onClose);
          client.off("end", onClientEnd);
          upstream.off("end", onUpstreamEnd);
          upstream.off("data", onAnswer);
        };
        const finish = (result: Effect.Effect<void, HttpProxyError | HttpProxyDisconnected>) => {
          if (settled) return;
          settled = true;
          cleanup();
          resume(result);
        };
        const abandon = (result: Effect.Effect<void, HttpProxyError | HttpProxyDisconnected>) => {
          finish(result);
          client.destroy();
          upstream.destroy();
        };
        const onError = (cause: Error) => abandon(Effect.fail(errorFor(cause)));
        const onClientGone = () => abandon(Effect.fail(new HttpProxyDisconnected()));
        const onClose = () => abandon(Effect.void);
        // A client leaving before the upstream answered never received a response.
        const onClientClose = () => (Deferred.isDoneUnsafe(handshake) ? onClose() : onClientGone());
        const onClientEnd = () => upstream.end();
        const onUpstreamEnd = () => client.end();
        // Reads the final handshake status off the bytes relayed to the client once its status
        // line is complete, skipping interim 1xx responses such as 100 Continue (RFC 9110
        // section 15.2).
        const onAnswer = (chunk: Buffer) => {
          answer += chunk.toString("latin1");
          let status: number | undefined;
          while (status === undefined && answer.includes("\r\n")) {
            const parsed = Number(statusLine.exec(answer)?.[1] ?? Number.NaN);
            if (parsed >= 100 && parsed < 200 && parsed !== 101) {
              const interimEnd = answer.indexOf("\r\n\r\n");
              if (interimEnd < 0) break;
              answer = answer.slice(interimEnd + 4);
              continue;
            }
            status = parsed;
          }
          if (status === undefined && answer.length < answerLimit) return;
          upstream.off("data", onAnswer);
          // An answer without an HTTP status line is logged as 502, like an invalid upstream
          // header in nginx, instead of waiting for the connection to close.
          Deferred.doneUnsafe(
            handshake,
            Effect.succeed(status === undefined || Number.isNaN(status) ? 502 : status),
          );
        };
        upstream.on("data", onAnswer);
        client.on("error", onClientGone);
        client.once("close", onClientClose);
        upstream.on("error", onError);
        upstream.once("close", onClose);
        client.once("end", onClientEnd);
        upstream.once("end", onUpstreamEnd);
        const lines = [`${request.method ?? "GET"} ${pathFor(request, route)} HTTP/1.1`];
        for (const [name, value] of Object.entries(upstreamHeadersFor(request, route))) {
          if (value !== undefined)
            lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
        }
        lines.push("Connection: Upgrade", "Upgrade: websocket", "", "");
        upstream.write(lines.join("\r\n"));
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream, { end: false });
        upstream.pipe(client, { end: false });
        return Effect.sync(() => {
          settled = true;
          cleanup();
          client.destroy();
          upstream.destroy();
        });
      });
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          Deferred.isDoneUnsafe(handshake)
            ? Deferred.await(handshake).pipe(
                Effect.flatMap((status) =>
                  Effect.annotateCurrentSpan({ "http.response.status_code": status }),
                ),
              )
            : Effect.void,
        ),
      ),
    ),
);

/* The connection's own proto, so a TLS port also forwards http for its plain peers. */
const encrypted = (request: IncomingMessage) => request.socket instanceof TLSSocket;

/** Container-facing names plain requests on a TLS port may carry, each with the API port. */
const RUNTIME_HOSTS = [
  "host.supabase.internal",
  "host.docker.internal",
  "host.containers.internal",
  "localhost",
];

/* An IP literal needs no DNS, so it can't be rebound; `pg_net` may call the bridge gateway. */
const IP_LITERAL = /^(?:(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:.]+\])$/u;

/**
 * Whether a plain request's `Host` names a stack host alias, `localhost` or an IP literal with the
 * API port, so a rebound DNS name never reaches the API in plain; on port 80 the port may be left out.
 */
export const plainHostAllowed = (host: string | undefined, port: number): boolean => {
  const value = host?.toLowerCase() ?? "";
  const suffix = `:${port}`;
  const name = value.endsWith(suffix) ? value.slice(0, -suffix.length) : port === 80 ? value : "";
  return RUNTIME_HOSTS.includes(name) || IP_LITERAL.test(name);
};

/**
 * Serves a TLS ClientHello with this PEM pair on the API port; any other first byte is plain HTTP
 * for the peers `plainPeer` admits by their address and the local address they connected to, and
 * every other connection closes before any HTTP byte.
 */
export interface HttpProxyTls {
  readonly cert: string;
  readonly key: string;
  readonly plainPeer: (peer: string, local: string) => boolean;
  /** A rejected peer whose first bytes are `GET <path> ` is learned, so `plainPeer` admits it. */
  readonly learn?: { readonly path: string; readonly add: (address: string) => void };
  /** The plain listener's clocks unless a test shortens them. */
  readonly deadlines?: HttpDeadlines;
}

interface HttpDeadlines {
  /** From accept until a request's headers, a TLS handshake included. */
  readonly headers: number;
  /** From a response until the connection's next request. */
  readonly idle: number;
}

/* Advertising 5 s lets clients close idle sockets first; holding them 75 s, like Kong, keeps a
   client that stalls past its own timer from reusing a closed one. */
const KEEP_ALIVE_TIMEOUT_BUFFER = 70_000;

/** What Bun 1.4.4's HTTP server gives a plain connection: 12 s for headers, then 75 s idle. */
const PLAIN_LISTENER_DEADLINES: HttpDeadlines = {
  headers: 12_000,
  idle: 5_000 + KEEP_ALIVE_TIMEOUT_BUFFER,
};

const unmapped = (address: string | undefined) =>
  address?.startsWith("::ffff:") === true ? address.slice(7) : (address ?? "");

/* Hands each connection to `server` by its first byte, as `HttpProxyTls` describes; a rejected
   peer is destroyed before `server` sees any of its bytes. */
const sniffing = (
  tls: HttpProxyTls,
  secureContext: SecureContext,
  server: ReturnType<typeof createServer>,
  sockets: Set<Socket>,
  runDeadline: (deadline: Effect.Effect<void>) => Fiber.Fiber<void>,
) => {
  const deadlines = tls.deadlines ?? PLAIN_LISTENER_DEADLINES;
  /* Handed-off sockets lose the HTTP server's own clocks, so each accepted one carries a timer
     that waits for its next request and destroys the connection when it runs out. */
  interface Deadline {
    readonly socket: Socket;
    timer: Fiber.Fiber<void> | undefined;
    inFlight: number;
  }
  const pending = new WeakMap<object, Deadline>();
  const disarm = (deadline: Deadline) => {
    deadline.timer?.interruptUnsafe();
    deadline.timer = undefined;
  };
  const arm = (deadline: Deadline, ms: number) => {
    disarm(deadline);
    deadline.timer = runDeadline(
      Effect.sleep(ms).pipe(Effect.andThen(Effect.sync(() => deadline.socket.destroy()))),
    );
  };
  const handOff = (deadline: Deadline, socket: Socket) => {
    pending.set(socket, deadline);
    server.emit("connection", socket);
  };
  server.on("request", (request, response) => {
    const deadline = pending.get(request.socket);
    if (deadline === undefined) return;
    deadline.inFlight += 1;
    disarm(deadline);
    response.once("close", () => {
      deadline.inFlight -= 1;
      if (deadline.inFlight === 0 && !deadline.socket.destroyed) arm(deadline, deadlines.idle);
    });
  });
  server.on("upgrade", (request) => {
    const deadline = pending.get(request.socket);
    if (deadline !== undefined) disarm(deadline);
    pending.delete(request.socket);
  });
  const learn = tls.learn;
  const learning = learn === undefined ? undefined : Buffer.from(`GET ${learn.path} `);
  /* Reads `size` bytes without consuming them, or `undefined` when the peer ends first. */
  const peek = (socket: Socket, size: number, next: (bytes: Buffer | undefined) => void) => {
    const bytes: Buffer | null = socket.read(size);
    if (bytes !== null) {
      socket.unshift(bytes);
      next(bytes);
    } else if (socket.readableEnded || socket.destroyed) next(undefined);
    else socket.once("readable", () => peek(socket, size, next));
  };
  return createNetServer({ pauseOnConnect: true }, (socket) => {
    const deadline: Deadline = { socket, timer: undefined, inFlight: 0 };
    arm(deadline, deadlines.headers);
    sockets.add(socket);
    socket.once("close", () => {
      disarm(deadline);
      sockets.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    const peer = unmapped(socket.remoteAddress);
    peek(socket, 1, (first) => {
      if (first === undefined) return socket.destroy();
      if (first[0] === 0x16) {
        const secure = new TLSSocket(socket, { isServer: true, secureContext });
        secure.on("error", () => secure.destroy());
        return handOff(deadline, secure);
      }
      if (tls.plainPeer(peer, unmapped(socket.localAddress))) return handOff(deadline, socket);
      if (learn === undefined || learning === undefined) return socket.destroy();
      peek(socket, learning.length, (head) => {
        if (head === undefined || !head.equals(learning)) return socket.destroy();
        learn.add(peer);
        handOff(deadline, socket);
      });
    });
  });
};

export const makeHttpProxy = (options: {
  readonly host: string;
  readonly port: number;
  readonly onAccess?: HttpAccessSink | undefined;
  readonly tls?: HttpProxyTls | undefined;
}): Effect.Effect<HttpProxy, PortError, Scope.Scope> =>
  Effect.gen(function* () {
    const routes = yield* Ref.make<ReadonlyArray<HttpRoute | HttpFileRoute>>([]);
    // Sockets per upstream stay unbounded so long-lived streamed responses never queue requests.
    // Idle sockets close before an upstream's 5 s keep-alive timeout, the shortest in the stack,
    // can race a reuse.
    const agent = yield* Effect.acquireRelease(
      Effect.sync(() => new Agent({ keepAlive: true, timeout: 4_000 })),
      (value) => Effect.sync(() => value.destroy()),
    );
    const runRequest = yield* FiberSet.makeRuntime();
    const sockets = new Set<Socket>();
    const onAccess = options.onAccess;
    const tls = options.tls;
    /* A plain request on the TLS port whose `Host` is no stack alias or loopback is 421. */
    const misdirected = (request: IncomingMessage) =>
      tls !== undefined &&
      !encrypted(request) &&
      !plainHostAllowed(headerValue(request.headers.host), request.socket.localPort ?? 0);
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      runRequest(
        Effect.gen(function* () {
          const sent: Sent = { bytes: 0, clientLeft: false };
          const access =
            onAccess === undefined
              ? undefined
              : {
                  complete: accessFor(request, yield* Clock.currentTimeMillis),
                  // Timed when the response settles, before the target's release runs.
                  settled: yield* responseSettled(response).pipe(
                    Effect.andThen(Clock.currentTimeMillis),
                    Effect.forkChild({ startImmediately: true }),
                  ),
                  record: onAccess,
                };
          // The access record waits outside this scope, so it never holds the target's activity.
          yield* Effect.scoped(
            Effect.gen(function* () {
              if (misdirected(request)) {
                response.setHeader("content-type", "text/plain; charset=utf-8");
                respond(response, sent, 421, "Misdirected Request");
                return;
              }
              const route = yield* Ref.get(routes).pipe(
                Effect.map((current) => routeFor(request.url ?? "/", current)),
              );
              /* Under TLS, Auth templates stay off the encrypted path, which the LAN reaches. */
              if (route !== undefined && "file" in route) {
                if (encrypted(request)) respond(response, sent, 404, "Not Found");
                else yield* serveFile(request, response, sent, route);
                return;
              }
              if (request.method === "OPTIONS" && route?.upstreamCors !== true) {
                setPreflightCors(response, request);
                respond(response, sent, 200);
              } else if (route === undefined) {
                setCors(response);
                respond(response, sent, 404, "Not Found");
              } else {
                yield* proxyRequest(request, response, route, agent, sent).pipe(
                  Effect.tapError((cause) =>
                    cause._tag === "HttpProxyDisconnected"
                      ? Effect.void
                      : Effect.logError(`Route ${route.id} request failed`, cause),
                  ),
                  Effect.catch((cause) =>
                    Effect.sync(() => {
                      if (cause._tag === "HttpProxyDisconnected") sent.clientLeft = true;
                      if (response.destroyed) return;
                      if (response.headersSent || sent.clientLeft) response.destroy();
                      else {
                        setCors(response);
                        respond(response, sent, 502, "Bad Gateway");
                      }
                    }),
                  ),
                );
              }
            }),
          );
          if (access === undefined) return;
          const ended = yield* Fiber.join(access.settled);
          const delivered = response.writableFinished && !sent.clientLeft;
          yield* access.record(
            access.complete(
              ended,
              response.headersSent ? response.statusCode : 499,
              delivered ? sent.bytes : undefined,
            ),
          );
        }),
      );
    };
    const server = createServer({ keepAliveTimeoutBuffer: KEEP_ALIVE_TIMEOUT_BUFFER }, handler);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
      });
    });
    server.on("upgrade", (request, socket, head) => {
      socket.on("error", () => socket.destroy());
      runRequest(
        Effect.gen(function* () {
          // Completed by the upstream's handshake status, otherwise by the upgrade's outcome.
          const handshake = yield* Deferred.make<number>();
          const recorded =
            onAccess === undefined
              ? undefined
              : yield* Effect.gen(function* () {
                  const complete = accessFor(request, yield* Clock.currentTimeMillis);
                  return yield* Deferred.await(handshake).pipe(
                    Effect.flatMap((status) =>
                      Clock.currentTimeMillis.pipe(
                        Effect.flatMap((ended) => onAccess(complete(ended, status))),
                      ),
                    ),
                    Effect.forkChild({ startImmediately: true }),
                  );
                });
          const route = yield* Ref.get(routes).pipe(
            Effect.map((current) => routeFor(request.url ?? "/", current)),
          );
          const outcome = misdirected(request)
            ? yield* Effect.sync(() => {
                socket.end(
                  "HTTP/1.1 421 Misdirected Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
                );
                return 421;
              })
            : route === undefined || "file" in route
              ? yield* Effect.sync(() => {
                  socket.destroy();
                  return 404;
                })
              : yield* Effect.scoped(upgrade(request, socket, head, route, handshake)).pipe(
                  Effect.as(502),
                  Effect.tapError((cause) =>
                    cause._tag === "HttpProxyDisconnected"
                      ? Effect.void
                      : Effect.logError(`Route ${route.id} upgrade failed`, cause),
                  ),
                  Effect.catch((cause) =>
                    Effect.sync(() => {
                      socket.destroy();
                      return cause._tag === "HttpProxyDisconnected" ? 499 : 502;
                    }),
                  ),
                );
          yield* Deferred.succeed(handshake, outcome);
          if (recorded !== undefined) yield* Fiber.join(recorded);
        }),
      );
    });
    const listener =
      tls === undefined
        ? server
        : sniffing(
            tls,
            yield* Effect.try({
              try: () => createSecureContext({ cert: tls.cert, key: tls.key }),
              catch: (cause) =>
                new PortError({
                  key: "http",
                  message: `api.tls: invalid certificate or key: ${cause instanceof Error ? cause.message : String(cause)}`,
                  cause,
                }),
            }),
            server,
            sockets,
            yield* FiberSet.makeRuntime<never, void, never>(),
          );
    yield* Effect.acquireRelease(
      Effect.callback<void, PortError>((resume) => {
        const onError = (cause: Error) =>
          resume(Effect.fail(new PortError({ key: "http", message: cause.message, cause })));
        listener.once("error", onError);
        listener.listen(options.port, options.host, () => resume(Effect.void));
        return Effect.sync(() => listener.off("error", onError));
      }),
      () =>
        Effect.callback<void, never>((resume) => {
          listener.close(() => resume(Effect.void));
          for (const socket of sockets) socket.destroy();
          return Effect.sync(() => server.closeAllConnections?.());
        }),
    );
    const address = listener.address();
    if (address === null || typeof address === "string")
      return yield* new PortError({ key: "http", message: "HTTP listener has no address" });
    return {
      host: address.address,
      port: address.port,
      setRoutes: (next: ReadonlyArray<HttpRoute | HttpFileRoute>) =>
        Ref.set(
          routes,
          [...next].sort((a, b) => b.prefix.length - a.prefix.length),
        ),
    };
  });
