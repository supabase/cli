import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Deferred, Effect, Layer, Option, Context, Schedule, Result } from "effect";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { StackServiceActivator } from "./ServiceActivation.ts";
import type { ServiceName } from "./ServiceName.ts";

export interface ProxyConfig {
  readonly listenPort: number;
  readonly gotruePort: number;
  readonly postgrestPort: number;
  readonly postgrestAdminPort: number;
  readonly edgeRuntimePort: number;
  readonly realtimePort: number;
  readonly storagePort: number;
  readonly pgmetaPort: number;
  readonly analyticsPort: number;
  readonly poolerPort: number;
  readonly studioPort: number;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
}

function transformAuthorization(
  headers: Headers.Headers,
  config: ProxyConfig,
  useCustomHeader = false,
): Headers.Headers {
  const auth = headers["authorization"];
  const apikey = headers["apikey"];

  const transformHeaderName = useCustomHeader ? "sb-api-key" : "authorization";
  const transformPrefix = useCustomHeader ? "" : "Bearer ";

  if (auth !== undefined && !auth.startsWith("Bearer sb_")) {
    return headers;
  }

  if (apikey === config.publishableKey) {
    return Headers.set(headers, transformHeaderName, transformPrefix + config.anonJwt);
  }
  if (apikey === config.secretKey) {
    return Headers.set(headers, transformHeaderName, transformPrefix + config.serviceRoleJwt);
  }
  if (apikey !== undefined && apikey !== "") {
    return Headers.set(headers, transformHeaderName, apikey);
  }

  return headers;
}

function addProxyHeaders(
  headers: Headers.Headers,
  remoteAddress: string | undefined,
): Headers.Headers {
  const clientIp = remoteAddress ?? "127.0.0.1";
  const prior = headers["x-forwarded-for"];
  const xForwardedFor = prior !== undefined ? `${prior}, ${clientIp}` : clientIp;

  return Headers.set(
    Headers.set(Headers.set(headers, "x-real-ip", clientIp), "x-forwarded-for", xForwardedFor),
    "x-forwarded-proto",
    "http",
  );
}

// The response body is passed through unmodified (including any
// content-encoding compression), so only the framing headers — recomputed by
// the gateway's own server — and the stale upstream date are dropped.
const STRIP_PROXY_RESPONSE_HEADERS = new Set(["content-length", "date", "transfer-encoding"]);

function sanitizeProxyResponseHeaders(headers: Headers.Headers): Headers.Headers {
  return Headers.fromInput(
    Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) => !STRIP_PROXY_RESPONSE_HEADERS.has(name.toLowerCase()),
      ),
    ),
  );
}

// `transfer-encoding` is hop-by-hop: the outgoing transport frames the
// forwarded body itself and re-adds chunked when no length is known.
// `content-length` is deliberately preserved: storage enforces file size
// limits from it, S3 SigV4 clients sign it, and S3 UploadPart rejects
// requests without it — which is also why the proxy transport is node:http
// rather than fetch (fetch cannot send a length-framed stream and silently
// converts uploads to chunked). Exported for unit tests.
export function sanitizeProxyRequestHeaders(headers: Headers.Headers): Headers.Headers {
  return Headers.remove(headers, "transfer-encoding");
}

// The gateway answers preflights itself by echoing
// Access-Control-Request-Headers, matching the hosted api-gateway
// (customer-router options handler) and the legacy Kong gateway, so new
// client headers never need an allowlist update here. The method list and
// max-age mirror the hosted values. Expose-headers is deliberately not set:
// hosted never sets it either — backends own what they expose (PostgREST
// exposes Content-Range, storage exposes etag on S3 UploadPart), and adding
// a permissive value here would make code work locally that fails in
// production.
const corsMiddleware = HttpMiddleware.cors({
  allowedMethods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS", "TRACE", "CONNECT"],
  maxAge: 3600,
});

// HTTP/1.1 requests carry a body only when framed by one of these headers
// (RFC 9112 §6.3, where transfer-encoding takes precedence). Streaming a
// nonexistent body upstream fails with a transport error, so bodyless
// requests must forward HttpBody.empty instead. Exported for unit tests.
export function hasRequestBody(headers: Headers.Headers): boolean {
  if (headers["transfer-encoding"] !== undefined) {
    return true;
  }
  const contentLength = headers["content-length"];
  if (contentLength === undefined) {
    return false;
  }
  // Bodyless only when every (possibly duplicated) content-length value is
  // zero — "0", "00", or a merged duplicate like "0, 0". Anything else,
  // including malformed values, errs toward forwarding a body rather than
  // silently dropping one.
  return !/^0+(\s*,\s*0+)*$/.test(contentLength.trim());
}

// Cold-start retries must replay the request body, so replayable bodies are
// buffered up to this size. Larger and unsized (chunked) bodies stream
// through instead — a partially consumed stream cannot be re-sent — and skip
// the retry.
const COLD_START_REPLAY_MAX_BYTES = 1024 * 1024;

// Exported for unit tests.
export function isReplayableBodySize(headers: Headers.Headers): boolean {
  const contentLength = Number(headers["content-length"]);
  return Number.isFinite(contentLength) && contentLength <= COLD_START_REPLAY_MAX_BYTES;
}

// Edge Functions cold-boot lazily: the first request to a function makes the
// edge-runtime spin up a user worker, and it can drop the connection while it
// does so. Its `/_internal/health` probe answers immediately, so "Healthy"
// status does not mean a function is servable yet. Briefly retry transport
// failures on that route so a user's first call doesn't surface as a 502.
const COLD_START_RETRY_SCHEDULE = Schedule.spaced("250 millis").pipe(Schedule.upTo({ times: 8 }));
interface ProxyHandlerOptions {
  readonly service: ServiceName;
  readonly backendPort: number;
  readonly stripPrefix?: string;
  readonly backendPath?: string;
  readonly transformAuth?: boolean;
  readonly transformAuthCustomHeader?: boolean;
  readonly extraHeaders?: Record<string, string>;
  // Retry transient transport failures, for backends (edge-runtime) that may
  // refuse/reset connections while cold-starting. Buffers the request body so
  // it can be re-sent across attempts.
  readonly retryColdStart?: boolean;
}

function makeProxyHandler(
  client: HttpClient.HttpClient,
  config: ProxyConfig,
  activator: StackServiceActivator["Service"],
  signalTerminalFailure: Effect.Effect<void>,
  opts: ProxyHandlerOptions,
) {
  return (req: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const activation = yield* activator.activate(opts.service).pipe(
        Effect.tapError((error) =>
          error._tag === "StackReadinessError" ? signalTerminalFailure : Effect.void,
        ),
        Effect.result,
      );
      if (Result.isFailure(activation)) {
        return HttpServerResponse.text("Service unavailable", {
          status: 503,
          headers: { "retry-after": "1" },
        });
      }

      let backendPath = opts.backendPath;

      if (backendPath === undefined) {
        backendPath = req.url.startsWith(opts.stripPrefix ?? "")
          ? req.url.slice((opts.stripPrefix ?? "").length)
          : req.url;
        if (backendPath === "") {
          backendPath = "/";
        }
      }

      let outHeaders = req.headers;
      if (opts.transformAuth === true) {
        outHeaders = transformAuthorization(outHeaders, config, opts.transformAuthCustomHeader);
      }
      outHeaders = addProxyHeaders(outHeaders, Option.getOrUndefined(req.remoteAddress));

      for (const [name, value] of Object.entries(opts.extraHeaders ?? {})) {
        outHeaders = Headers.set(outHeaders, name, value);
      }

      outHeaders = sanitizeProxyRequestHeaders(outHeaders);

      const backendUrl = `http://127.0.0.1:${opts.backendPort}${backendPath}`;
      const contentType = req.headers["content-type"];

      let body: HttpBody.HttpBody;
      let replayable = true;
      if (!HttpMethod.hasBody(req.method) || !hasRequestBody(req.headers)) {
        body = HttpBody.empty;
        // Normalize the forwarded framing: the inbound content-length may be
        // absent or non-canonical (a merged duplicate like "0, 0").
        outHeaders = HttpMethod.hasBody(req.method)
          ? Headers.set(outHeaders, "content-length", "0")
          : Headers.remove(outHeaders, "content-length");
      } else if (opts.retryColdStart === true && isReplayableBodySize(req.headers)) {
        // Buffer the body so the request can be safely re-sent if we retry.
        const buffered = yield* Effect.result(req.arrayBuffer);
        if (Result.isFailure(buffered)) {
          return HttpServerResponse.text("Bad gateway: unable to read request body", {
            status: 502,
          });
        }
        const bytes = new Uint8Array(buffered.success);
        body = HttpBody.uint8Array(bytes, contentType);
        outHeaders = Headers.set(outHeaders, "content-length", String(bytes.byteLength));
      } else {
        // Stream the body through with its original content-length framing
        // preserved: storage derives file-size enforcement from it and S3
        // SigV4 clients sign it, so it must reach the backend byte-exact.
        body = HttpBody.stream(req.stream, contentType);
        replayable = false;
      }

      const outReq = HttpClientRequest.make(req.method)(backendUrl, {
        headers: outHeaders,
        body,
      });

      const request = client.execute(outReq);
      const outRes = yield* opts.retryColdStart === true && replayable
        ? Effect.retry(request, {
            while: (error) => error.reason._tag === "TransportError",
            schedule: COLD_START_RETRY_SCHEDULE,
          })
        : request;
      const responseHeaders = sanitizeProxyResponseHeaders(outRes.headers);
      return HttpServerResponse.stream(outRes.stream, {
        status: outRes.status,
        headers: responseHeaders,
      });
    }).pipe(
      Effect.catchTag("HttpClientError", (error) =>
        Effect.succeed(
          // The request body may have been partially consumed when the
          // upstream failed, so the connection cannot be reused for another
          // request — tell the client to close it.
          HttpServerResponse.text(`Bad gateway: ${error.message}`, {
            status: 502,
            headers: { connection: "close" },
          }),
        ),
      ),
    );
}

export class ApiProxy extends Context.Service<
  ApiProxy,
  {
    readonly address: HttpServer.Address;
    /** Completes when terminal lazy-activation failure requires daemon teardown. */
    readonly awaitTerminalFailure: Effect.Effect<void>;
  }
>()("local/ApiProxy") {
  // The proxy owns its outgoing transport: it must forward length-framed
  // streams byte-exact (fetch-based clients strip content-length and convert
  // every streamed body to chunked, which breaks storage size enforcement and
  // S3 signature verification), so it always uses the node:http client — Bun
  // serves it through its node:http compatibility layer.
  static layer = (
    config: ProxyConfig,
  ): Layer.Layer<ApiProxy, never, HttpServer.HttpServer | StackServiceActivator> =>
    Layer.effect(ApiProxy)(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const client = yield* HttpClient.HttpClient;
        const activator = yield* StackServiceActivator;
        const terminalFailure = yield* Deferred.make<void>();
        const signalTerminalFailure = Deferred.succeed(terminalFailure, void 0).pipe(Effect.asVoid);

        const routes = [
          HttpRouter.route("*", "/health", HttpServerResponse.text("OK", { status: 200 })),
          HttpRouter.route(
            "*",
            "/.well-known/oauth-authorization-server",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "auth",
              backendPort: config.gotruePort,
              backendPath: "/.well-known/oauth-authorization-server",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/verify",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/callback",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/authorize",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/rest/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "postgrest",
              backendPort: config.postgrestPort,
              stripPrefix: "/rest/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/rest-admin/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "postgrest",
              backendPort: config.postgrestAdminPort,
              stripPrefix: "/rest-admin/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/graphql/v1",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "postgrest",
              backendPort: config.postgrestPort,
              backendPath: "/rpc/graphql",
              transformAuth: true,
              extraHeaders: { "content-profile": "graphql_public" },
            }),
          ),
          HttpRouter.route(
            "*",
            "/functions/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "edge-runtime",
              backendPort: config.edgeRuntimePort,
              stripPrefix: "/functions/v1",
              transformAuth: true,
              transformAuthCustomHeader: true,
              retryColdStart: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/realtime/v1/api/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "realtime",
              backendPort: config.realtimePort,
              stripPrefix: "/realtime/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/realtime/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "realtime",
              backendPort: config.realtimePort,
              stripPrefix: "/realtime/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/storage/v1/s3/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "storage",
              backendPort: config.storagePort,
              stripPrefix: "/storage/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/storage/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "storage",
              backendPort: config.storagePort,
              stripPrefix: "/storage/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/pg/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "pgmeta",
              backendPort: config.pgmetaPort,
              stripPrefix: "/pg",
            }),
          ),
          HttpRouter.route(
            "*",
            "/analytics/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "analytics",
              backendPort: config.analyticsPort,
              stripPrefix: "/analytics/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/pooler/v2/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "pooler",
              backendPort: config.poolerPort,
              stripPrefix: "/pooler",
            }),
          ),
          HttpRouter.route(
            "*",
            "/mcp",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "studio",
              backendPort: config.studioPort,
              backendPath: "/api/mcp",
            }),
          ),
        ];

        const httpEffect = yield* HttpRouter.toHttpEffect(HttpRouter.addAll(routes));

        // Edge Functions own their CORS, preflights included: the hosted
        // gateway forwards OPTIONS on functions routes to the user's function
        // (function templates answer OPTIONS themselves), so the local
        // gateway must not intercept them.
        const corsApp = corsMiddleware(httpEffect);
        const appEffect = Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;
          const isFunctionsRoute =
            req.url === "/functions/v1" || req.url.startsWith("/functions/v1/");
          return yield* isFunctionsRoute ? httpEffect : corsApp;
        });

        yield* Effect.forkScoped(server.serve(appEffect));

        return {
          address: server.address,
          awaitTerminalFailure: Deferred.await(terminalFailure),
        };
      }),
    ).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));
}
