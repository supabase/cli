import { Effect, Layer, ServiceMap } from "effect";
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
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
}

/**
 * Transform the Authorization header by mapping opaque API keys to JWTs.
 *
 * Logic (ported from Go proxy.go transformAuthorization):
 * 1. If `Authorization` exists and is NOT `Bearer sb_*`, keep it (user has a real JWT).
 * 2. If `apikey` matches publishableKey → set `Authorization: Bearer <anonJwt>`.
 * 3. If `apikey` matches secretKey → set `Authorization: Bearer <serviceRoleJwt>`.
 * 4. If `apikey` is present but unrecognized → pass it through as Authorization.
 */
function transformAuthorization(headers: Headers.Headers, config: ProxyConfig): Headers.Headers {
  const auth = headers["authorization"];
  const apikey = headers["apikey"];

  if (auth !== undefined && !auth.startsWith("Bearer sb_")) {
    return headers;
  }

  if (apikey === config.publishableKey) {
    return Headers.set(headers, "authorization", `Bearer ${config.anonJwt}`);
  }
  if (apikey === config.secretKey) {
    return Headers.set(headers, "authorization", `Bearer ${config.serviceRoleJwt}`);
  }
  if (apikey !== undefined && apikey !== "") {
    return Headers.set(headers, "authorization", apikey);
  }

  return headers;
}

/**
 * Add standard proxy forwarding headers (X-Real-IP, X-Forwarded-For,
 * X-Forwarded-Proto) to an outgoing request's headers.
 */
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

/**
 * Build a proxy handler that forwards requests to a backend service.
 * Returns 502 Bad Gateway if the backend is unreachable.
 */
function makeProxyHandler(
  client: HttpClient.HttpClient,
  backendPort: number,
  stripPrefix: string,
  transformAuth: boolean,
  config: ProxyConfig,
) {
  return (req: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      let backendPath = req.url.startsWith(stripPrefix)
        ? req.url.slice(stripPrefix.length)
        : req.url;
      if (backendPath === "") {
        backendPath = "/";
      }

      let outHeaders = req.headers;
      if (transformAuth) {
        outHeaders = transformAuthorization(outHeaders, config);
      }
      outHeaders = addProxyHeaders(outHeaders, req.remoteAddress);

      const backendUrl = `http://127.0.0.1:${backendPort}${backendPath}`;

      // Methods that must not carry a request body per the HTTP spec.
      const noBodyMethods = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
      const contentType = req.headers["content-type"];
      const body = noBodyMethods.has(req.method)
        ? HttpBody.empty
        : HttpBody.stream(req.stream, contentType);

      const outReq = HttpClientRequest.make(req.method)(backendUrl, {
        headers: outHeaders,
        body,
      });

      const outRes = yield* client.execute(outReq);

      return HttpServerResponse.stream(outRes.stream, {
        status: outRes.status,
        headers: outRes.headers,
      });
    }).pipe(
      Effect.catchTag("HttpClientError", (e) =>
        Effect.succeed(HttpServerResponse.text(`Bad gateway: ${e.message}`, { status: 502 })),
      ),
    );
}

export class ApiProxy extends ServiceMap.Service<
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
          // Health check — handled locally.
          HttpRouter.route("*", "/health", HttpServerResponse.text("OK", { status: 200 })),

          // Auth open endpoints (no auth transformation).
          // Must be registered BEFORE the general /auth/v1/* catch-all.
          HttpRouter.route(
            "*",
            "/auth/v1/verify",
            makeProxyHandler(client, config.gotruePort, "/auth/v1", false, config),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/callback",
            makeProxyHandler(client, config.gotruePort, "/auth/v1", false, config),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/authorize",
            makeProxyHandler(client, config.gotruePort, "/auth/v1", false, config),
          ),

          // Auth protected endpoints (with auth transformation).
          HttpRouter.route(
            "*",
            "/auth/v1/*",
            makeProxyHandler(client, config.gotruePort, "/auth/v1", true, config),
          ),

          // REST API (with auth transformation).
          HttpRouter.route(
            "*",
            "/rest/v1/*",
            makeProxyHandler(client, config.postgrestPort, "/rest/v1", true, config),
          ),

          // REST Admin API (no auth transformation).
          HttpRouter.route(
            "*",
            "/rest-admin/v1/*",
            makeProxyHandler(client, config.postgrestAdminPort, "/rest-admin/v1", false, config),
          ),
        ];

        const httpEffect = yield* HttpRouter.toHttpEffect(HttpRouter.addAll(routes));

        // CORS middleware wraps all responses. OPTIONS preflight is handled here
        // before reaching the router — this matches the Go proxy behavior where
        // corsMiddleware intercepts all OPTIONS requests globally.
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
