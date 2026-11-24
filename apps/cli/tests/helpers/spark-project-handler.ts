import { Effect } from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import type { ApiHandler } from "./command-mocks.ts";

const PROJECT_PATH = /^\/v1\/projects\/[^/]+$/u;

/** Answers `GET /v1/projects/{ref}` as a Spark project and leaves every other request to `inner`. */
export const withSparkProjectRead =
  (inner: ApiHandler): ApiHandler =>
  (request, recorded) =>
    request.method === "GET" && PROJECT_PATH.test(new URL(request.url, "http://localhost").pathname)
      ? Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ status: "ACTIVE_HEALTHY", database: { postgres_engine: "spark" } }),
          ),
        )
      : inner(request, recorded);
