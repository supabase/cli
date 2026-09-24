import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Creation, makeSpec } from "./services/Auth.ts";
import { makeAuthTemplateServer } from "./AuthTemplates.ts";

const request = (port: number, pathname: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`http://127.0.0.1:${port}${pathname}`),
    );
    return { status: response.status, body: yield* response.text };
  });

describe("Auth template server", () => {
  it.live("serves live template changes and refuses routes outside the project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "auth-templates-" });
        const projectRoot = path.join(root, "project");
        const filePath = path.join(projectRoot, "confirm.html");
        const notificationPath = path.join(projectRoot, "email_changed_notification.mjml");
        const replacementPath = path.join(projectRoot, "confirm.html.next");
        const outsidePath = path.join(root, "outside.html");
        const encode = (value: string) => new TextEncoder().encode(value);
        yield* fs.makeDirectory(projectRoot, { recursive: true });
        yield* fs.writeFile(filePath, encode("initial"));
        yield* fs.writeFile(notificationPath, encode("notification"));
        yield* fs.writeFile(outsidePath, encode("outside"));

        const server = yield* makeAuthTemplateServer({
          host: "127.0.0.1",
          port: 0,
          projectRoot,
          templates: [
            { id: "confirm", filePath },
            { id: "email_changed_notification", filePath: notificationPath },
          ],
        });
        const creation = yield* Schema.decodeEffect(Creation)({
          service: "auth",
          config: {
            databaseUrl: "postgresql://localhost/postgres",
            templateBaseUrl: `http://127.0.0.1:${server.port}/`,
            templates: [
              { id: "confirm", filePath },
              { id: "email_changed_notification", filePath: notificationPath },
            ],
          },
        });
        const env = yield* makeSpec().env(creation, new Map(), false);
        expect(env.GOTRUE_MAILER_TEMPLATE_RELOADING_ENABLED).toBe("true");
        expect(
          yield* request(server.port, new URL(env.GOTRUE_MAILER_TEMPLATES_CONFIRM!).pathname),
        ).toEqual({
          status: 200,
          body: "initial",
        });
        expect(
          yield* request(
            server.port,
            new URL(env.GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGED_NOTIFICATION!).pathname,
          ),
        ).toEqual({ status: 200, body: "notification" });

        yield* fs.writeFile(filePath, encode("edited"));
        expect(
          yield* request(server.port, new URL(env.GOTRUE_MAILER_TEMPLATES_CONFIRM!).pathname),
        ).toEqual({
          status: 200,
          body: "edited",
        });

        yield* fs.writeFile(replacementPath, encode("atomically replaced"));
        yield* fs.rename(replacementPath, filePath);
        expect(
          yield* request(server.port, new URL(env.GOTRUE_MAILER_TEMPLATES_CONFIRM!).pathname),
        ).toEqual({
          status: 200,
          body: "atomically replaced",
        });

        expect(
          yield* request(server.port, "/email/unlisted.html").pipe(
            Effect.map(({ status }) => status),
          ),
        ).toBe(404);

        yield* fs.remove(filePath);
        yield* fs.symlink(outsidePath, filePath);
        expect(
          yield* request(server.port, "/email/confirm.html").pipe(
            Effect.map(({ status }) => status),
          ),
        ).toBe(403);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeHttpClient.layerNodeHttp, NodeServices.layer))),
  );
});
