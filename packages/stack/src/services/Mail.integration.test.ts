import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { engineTarget, testEngine } from "../../tests/engine-target.ts";
import { httpHost } from "../../tests/helpers/endpoint.ts";

const options = (root: string) => ({
  stackId: "catalog-mail",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
});

const dockerOptions = (root: string) => ({
  ...options(root),
  runtime: testEngine,
  engineTarget,
});

interface MailpitMessages {
  readonly total: number;
  readonly messages: ReadonlyArray<{ readonly Subject: string }>;
}

const fetchMessages = (endpoint: { readonly host?: string; readonly port: number }) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const host = endpoint.host ?? "127.0.0.1";
    const response = yield* client.execute(
      HttpClientRequest.get(`http://${host}:${endpoint.port}/api/v1/messages`),
    );
    return (yield* response.json) as unknown as MailpitMessages;
  });

/** Sends a test email through Mailpit's HTTP send API rather than a raw SMTP session. */
const sendTestEmail = (
  endpoint: { readonly host?: string; readonly port: number },
  subject: string,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const host = endpoint.host ?? "127.0.0.1";
    const response = yield* client.execute(
      HttpClientRequest.post(`http://${host}:${endpoint.port}/api/v1/send`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          From: { Email: "sender@example.com" },
          To: [{ Email: "recipient@example.com" }],
          Subject: subject,
          Text: "body",
        }),
      ),
    );
    yield* HttpClientResponse.filterStatusOk(response);
  });

describe("service catalog", () => {
  it.live("launches the real Mailpit recipe and serves its HTTP endpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const client = yield* HttpClient.HttpClient;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-mail-" });
        const recipe = yield* makeServiceRecipe(
          { service: "mail", config: {} },
          dockerOptions(root),
        );
        const instance = yield* makeStandaloneService(recipe.definition, {
          id: "mail",
          config: recipe.creation,
        });
        yield* instance.start;
        yield* instance.ready;
        const endpoint = yield* recipe.endpoint("http");
        const response = yield* client.execute(
          HttpClientRequest.get(`http://${httpHost(endpoint)}:${endpoint.port}/readyz`),
        );
        expect(response.status).toBe(200);
        yield* instance.stop;
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  it.live(
    "keeps two native mail instances on one isolated database each, both becoming ready",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-mail-isolation-" });
          const recipeFor = (instanceId: string) =>
            makeServiceRecipe({ service: "mail", config: {} }, { ...options(root), instanceId });
          const first = yield* recipeFor("mail-a");
          const second = yield* recipeFor("mail-b");
          const firstInstance = yield* makeStandaloneService(first.definition, {
            id: "mail-a",
            config: first.creation,
          });
          const secondInstance = yield* makeStandaloneService(second.definition, {
            id: "mail-b",
            config: second.creation,
          });
          yield* Effect.all([firstInstance.start, secondInstance.start], {
            concurrency: "unbounded",
          });
          yield* Effect.all([firstInstance.ready, secondInstance.ready], {
            concurrency: "unbounded",
          });
          expect(yield* fs.exists(path.join(root, "mail-a", "mailpit.db"))).toBe(true);
          expect(yield* fs.exists(path.join(root, "mail-b", "mailpit.db"))).toBe(true);
          yield* Effect.all([firstInstance.stop, secondInstance.stop], {
            concurrency: "unbounded",
          });
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  it.live("keeps a captured email after a native mail stop and start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-mail-persistence-" });
        const recipe = yield* makeServiceRecipe({ service: "mail", config: {} }, options(root));
        const instance = yield* makeStandaloneService(recipe.definition, {
          id: "mail",
          config: recipe.creation,
        });
        yield* instance.start;
        yield* instance.ready;
        yield* sendTestEmail(yield* recipe.endpoint("http"), "persistence-test");
        const beforeRestart = yield* fetchMessages(yield* recipe.endpoint("http"));
        expect(beforeRestart.messages.map((message) => message.Subject)).toContain(
          "persistence-test",
        );
        yield* instance.stop;
        yield* instance.start;
        yield* instance.ready;
        const afterRestart = yield* fetchMessages(yield* recipe.endpoint("http"));
        expect(afterRestart.messages.map((message) => message.Subject)).toContain(
          "persistence-test",
        );
        yield* instance.stop;
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  it.live("keeps a captured email after a Docker mail stop and start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "catalog-mail-persistence-docker-",
        });
        const recipe = yield* makeServiceRecipe(
          { service: "mail", config: {} },
          dockerOptions(root),
        );
        const instance = yield* makeStandaloneService(recipe.definition, {
          id: "mail",
          config: recipe.creation,
        });
        yield* instance.start;
        yield* instance.ready;
        yield* sendTestEmail(yield* recipe.endpoint("http"), "persistence-test-docker");
        const beforeRestart = yield* fetchMessages(yield* recipe.endpoint("http"));
        expect(beforeRestart.messages.map((message) => message.Subject)).toContain(
          "persistence-test-docker",
        );
        yield* instance.stop;
        yield* instance.start;
        yield* instance.ready;
        const afterRestart = yield* fetchMessages(yield* recipe.endpoint("http"));
        expect(afterRestart.messages.map((message) => message.Subject)).toContain(
          "persistence-test-docker",
        );
        yield* instance.stop;
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  it.live("removes the native mail instance directory when destroyed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-mail-destroy-" });
        const recipe = yield* makeServiceRecipe({ service: "mail", config: {} }, options(root));
        const instance = yield* makeStandaloneService(recipe.definition, {
          id: "mail",
          config: recipe.creation,
        });
        yield* instance.start;
        yield* instance.ready;
        const instanceRoot = path.join(root, "instance");
        expect(yield* fs.exists(instanceRoot)).toBe(true);
        yield* instance.destroy;
        expect(yield* fs.exists(instanceRoot)).toBe(false);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  it.live("rejects a traversal instance id and creates nothing outside the root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-mail-traversal-" });
        const recipe = yield* makeServiceRecipe(
          { service: "mail", config: {} },
          { ...options(root), instanceId: "../escaped" },
        );
        const instance = yield* makeStandaloneService(recipe.definition, {
          id: "mail",
          config: recipe.creation,
        });
        const exit = yield* Effect.exit(instance.start);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* fs.exists(path.join(root, "..", "escaped"))).toBe(false);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );
});
