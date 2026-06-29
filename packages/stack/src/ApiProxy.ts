import { Effect, Layer, Option, Context, Schedule, Result } from "effect";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

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

const STRIP_PROXY_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "date",
  "transfer-encoding",
]);

function sanitizeProxyResponseHeaders(headers: Headers.Headers): Headers.Headers {
  return Headers.fromInput(
    Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) => !STRIP_PROXY_RESPONSE_HEADERS.has(name.toLowerCase()),
      ),
    ),
  );
}

const CORS_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["access-control-allow-origin", "*"],
  ["access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS"],
  ["access-control-allow-headers", "Authorization, Content-Type, apikey, X-Client-Info"],
  ["access-control-expose-headers", "Content-Range, Range"],
  ["access-control-max-age", "86400"],
];

function addCorsHeaders(
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse {
  return CORS_HEADERS.reduce(
    (res, [name, value]) => HttpServerResponse.setHeader(res, name, value),
    response,
  );
}

// Edge Functions cold-boot lazily: the first request to a function makes the
// edge-runtime spin up a user worker, and it can drop the connection while it
// does so. Its `/_internal/health` probe answers immediately, so "Healthy"
// status does not mean a function is servable yet. Briefly retry transport
// failures on that route so a user's first call doesn't surface as a 502.
const COLD_START_RETRY_SCHEDULE = Schedule.spaced("250 millis").pipe(Schedule.take(8));

interface ProxyHandlerOptions {
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
  opts: ProxyHandlerOptions,
) {
  return (req: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
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

      const backendUrl = `http://127.0.0.1:${opts.backendPort}${backendPath}`;
      const noBodyMethods = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
      const contentType = Option.getOrUndefined(Headers.get(req.headers, "content-type"));

      let body: HttpBody.HttpBody;
      if (noBodyMethods.has(req.method)) {
        body = HttpBody.empty;
      } else if (opts.retryColdStart === true) {
        // Buffer the body so the request can be safely re-sent if we retry.
        const buffered = yield* Effect.result(req.arrayBuffer);
        if (Result.isFailure(buffered)) {
          return HttpServerResponse.text("Bad gateway: unable to read request body", {
            status: 502,
          });
        }
        body = HttpBody.uint8Array(new Uint8Array(buffered.success), contentType);
      } else {
        body = HttpBody.stream(req.stream, contentType);
      }

      const outReq = HttpClientRequest.make(req.method)(backendUrl, {
        headers: outHeaders,
        body,
      });

      const request = client.execute(outReq);
      const outRes = yield* opts.retryColdStart === true
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
          HttpServerResponse.text(`Bad gateway: ${error.message}`, {
            status: 502,
          }),
        ),
      ),
    );
}

export class ApiProxy extends Context.Service<
  ApiProxy,
  {
    readonly address: HttpServer.Address;
  }
>()("local/ApiProxy") {
  static layer = (
    config: ProxyConfig,
  ): Layer.Layer<ApiProxy, never, HttpServer.HttpServer | HttpClient.HttpClient> =>
    Layer.effect(ApiProxy)(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const client = yield* HttpClient.HttpClient;

        const routes = [
          HttpRouter.route("*", "/health", HttpServerResponse.text("OK", { status: 200 })),
          HttpRouter.route(
            "*",
            "/.well-known/oauth-authorization-server",
            makeProxyHandler(client, config, {
              backendPort: config.gotruePort,
              backendPath: "/.well-known/oauth-authorization-server",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/verify",
            makeProxyHandler(client, config, {
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/callback",
            makeProxyHandler(client, config, {
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/authorize",
            makeProxyHandler(client, config, {
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/*",
            makeProxyHandler(client, config, {
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/rest/v1/*",
            makeProxyHandler(client, config, {
              backendPort: config.postgrestPort,
              stripPrefix: "/rest/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/rest-admin/v1/*",
            makeProxyHandler(client, config, {
              backendPort: config.postgrestAdminPort,
              stripPrefix: "/rest-admin/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/graphql/v1",
            makeProxyHandler(client, config, {
              backendPort: config.postgrestPort,
              backendPath: "/rpc/graphql",
              transformAuth: true,
              extraHeaders: { "content-profile": "graphql_public" },
            }),
          ),
          HttpRouter.route(
            "*",
            "/functions/v1/*",
            makeProxyHandler(client, config, {
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
            makeProxyHandler(client, config, {
              backendPort: config.realtimePort,
              stripPrefix: "/realtime/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/realtime/v1/*",
            makeProxyHandler(client, config, {
              backendPort: config.realtimePort,
              stripPrefix: "/realtime/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/storage/v1/s3/*",
            makeProxyHandler(client, config, {
              backendPort: config.storagePort,
              stripPrefix: "/storage/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/storage/v1/*",
            makeProxyHandler(client, config, {
              backendPort: config.storagePort,
              stripPrefix: "/storage/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/pg/*",
            makeProxyHandler(client, config, {
              backendPort: config.pgmetaPort,
              stripPrefix: "/pg",
            }),
          ),
          HttpRouter.route(
            "*",
            "/analytics/v1/*",
            makeProxyHandler(client, config, {
              backendPort: config.analyticsPort,
              stripPrefix: "/analytics/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/pooler/v2/*",
            makeProxyHandler(client, config, {
              backendPort: config.poolerPort,
              stripPrefix: "/pooler",
            }),
          ),
          HttpRouter.route(
            "*",
            "/mcp",
            makeProxyHandler(client, config, {
              backendPort: config.studioPort,
              backendPath: "/api/mcp",
            }),
          ),
        ];

        const httpEffect = yield* HttpRouter.toHttpEffect(HttpRouter.addAll(routes));

        const appEffect = Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;

          if (req.method === "OPTIONS") {
            return addCorsHeaders(HttpServerResponse.empty({ status: 204 }));
          }

          const response = yield* httpEffect;
          return addCorsHeaders(response);
        });

        yield* Effect.forkScoped(server.serve(appEffect));

        return {
          address: server.address,
        };
      }),
    );
}
