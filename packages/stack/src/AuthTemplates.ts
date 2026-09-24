import { NodeHttpServer } from "@effect/platform-node";
import { Effect, FileSystem, Path, Predicate, Schema } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- NodeHttpServer.make requires a native server factory.
import * as Http from "node:http";

class AuthTemplateServerError extends Schema.TaggedError<AuthTemplateServerError>()(
  "AuthTemplateServerError",
  { message: Schema.String },
) {}

interface AuthTemplateFile {
  readonly id: string;
  readonly filePath: string;
}

export interface AuthTemplateServerOptions {
  readonly host: string;
  readonly port: number;
  readonly projectRoot: string;
  readonly templates: ReadonlyArray<AuthTemplateFile>;
}

const safeId = /^[A-Za-z0-9_-]+$/u;

const isContained = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative.length === 0 ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

/** Starts a scoped HTTP server for the configured Auth email templates. */
export const makeAuthTemplateServer = Effect.fn("AuthTemplates.makeServer")(function* (
  options: AuthTemplateServerOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectRoot = yield* fs.realPath(options.projectRoot).pipe(
    Effect.mapError(
      (cause) =>
        new AuthTemplateServerError({
          message: `Unable to resolve the project directory: ${cause.message}`,
        }),
    ),
  );
  const routes = new Map<string, string>();

  for (const template of options.templates) {
    if (!safeId.test(template.id))
      return yield* new AuthTemplateServerError({ message: "Invalid Auth email template ID" });
    const filePath = path.isAbsolute(template.filePath)
      ? template.filePath
      : path.resolve(projectRoot, template.filePath);
    const route = `/email/${template.id}${path.extname(filePath)}`;
    if (routes.has(route))
      return yield* new AuthTemplateServerError({ message: "Duplicate Auth email template route" });
    routes.set(route, filePath);
  }

  const server = yield* NodeHttpServer.make(() => Http.createServer(), {
    host: options.host,
    port: options.port,
  });
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = request.url.split("?", 1)[0] ?? "/";
      const filePath = routes.get(pathname);
      if (request.method !== "GET")
        return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } });
      if (filePath === undefined) return HttpServerResponse.empty({ status: 404 });

      return yield* fs.realPath(filePath).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          onSuccess: (realFilePath) => {
            if (!isContained(path, projectRoot, realFilePath))
              return Effect.succeed(HttpServerResponse.empty({ status: 403 }));
            return fs.readFile(realFilePath).pipe(
              Effect.map((body) =>
                HttpServerResponse.uint8Array(body, { contentType: "text/html; charset=utf-8" }),
              ),
              Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })),
            );
          },
        }),
      );
    }),
  );

  if (!Predicate.isTagged(server.address, "TcpAddress"))
    return yield* Effect.die("Auth email template server requires a TCP listener");
  return { port: server.address.port };
});
