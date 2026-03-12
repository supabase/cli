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

interface ProxyHandlerOptions {
  readonly backendPort: number;
  readonly stripPrefix?: string;
  readonly backendPath?: string;
  readonly transformAuth?: boolean;
  readonly extraHeaders?: Record<string, string>;
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
        outHeaders = transformAuthorization(outHeaders, config);
      }
      outHeaders = addProxyHeaders(outHeaders, req.remoteAddress);

      for (const [name, value] of Object.entries(opts.extraHeaders ?? {})) {
        outHeaders = Headers.set(outHeaders, name, value);
      }

      const backendUrl = `http://127.0.0.1:${opts.backendPort}${backendPath}`;
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
      Effect.catchTag("HttpClientError", (error) =>
        Effect.succeed(
          HttpServerResponse.text(`Bad gateway: ${error.message}`, {
            status: 502,
          }),
        ),
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
