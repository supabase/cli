import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Layer, Path } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- sends a raw SMTP payload for the persistence test.
import * as Net from "node:net";
import { makeService } from "../Service.ts";
import { makeServiceRecipe } from "./Catalog.ts";

const options = (root: string) => ({
  stackId: "catalog-mail",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
});

const dockerOptions = (root: string) => ({
  ...options(root),
  runtime: "docker" as const,
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

interface SmtpStep {
  readonly command: string;
  readonly expectedCode: number;
}

const smtpGreetingCode = 220;

class SmtpScriptError extends Data.TaggedError("SmtpScriptError")<{ readonly message: string }> {}

/** Scripts one SMTP round trip, sending each command only after its expected reply code. */
const sendTestEmail = (
  endpoint: { readonly host?: string; readonly port: number },
  subject: string,
) =>
  Effect.callback<void, SmtpScriptError>((resume) => {
    const socket = Net.createConnection({
      host: endpoint.host ?? "127.0.0.1",
      port: endpoint.port,
    });
    const steps: ReadonlyArray<SmtpStep> = [
      { command: "EHLO localhost\r\n", expectedCode: 250 },
      { command: "MAIL FROM:<sender@example.com>\r\n", expectedCode: 250 },
      { command: "RCPT TO:<recipient@example.com>\r\n", expectedCode: 250 },
      { command: "DATA\r\n", expectedCode: 354 },
      {
        command: `Subject: ${subject}\r\nFrom: sender@example.com\r\nTo: recipient@example.com\r\n\r\nbody\r\n.\r\n`,
        expectedCode: 250,
      },
      { command: "QUIT\r\n", expectedCode: 221 },
    ];
    let step = -1;
    let quitAcknowledged = false;
    let buffer = "";
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.fail(new SmtpScriptError({ message })));
    };

    // A completed reply (its final line matches `^\d{3} `) advances the script; anything else fails.
    const handleReply = (code: number) => {
      const expected = step < 0 ? smtpGreetingCode : steps[step]?.expectedCode;
      if (expected === undefined || code !== expected) {
        fail(`Unexpected SMTP reply ${code} at step ${step}`);
        return;
      }
      step += 1;
      const next = steps[step];
      if (next === undefined) {
        quitAcknowledged = true;
        socket.end();
        return;
      }
      socket.write(next.command);
    };

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const match = /^(\d{3})([ -])/.exec(line);
        if (match === null) {
          fail(`Unparseable SMTP line: ${line}`);
          return;
        }
        if (match[2] === "-") continue;
        handleReply(Number(match[1]));
        if (settled) return;
      }
    });
    socket.on("error", (error) => fail(error.message));
    socket.on("close", () => {
      if (settled) return;
      settled = true;
      if (quitAcknowledged) resume(Effect.void);
      else
        resume(
          Effect.fail(
            new SmtpScriptError({
              message: "SMTP connection closed before QUIT was acknowledged",
            }),
          ),
        );
    });
    return Effect.sync(() => socket.destroy());
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
        const instance = yield* makeService(recipe.definition, {
          id: "mail",
          config: recipe.creation,
        });
        yield* instance.start;
        yield* instance.ready;
        const endpoint = yield* recipe.endpoint("http");
        const response = yield* client.execute(
          HttpClientRequest.get(`http://${endpoint.host}:${endpoint.port}/readyz`),
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
          const firstInstance = yield* makeService(first.definition, {
            id: "mail-a",
            config: first.creation,
          });
          const secondInstance = yield* makeService(second.definition, {
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
        const instance = yield* makeService(recipe.definition, {
          id: "mail",
          config: recipe.creation,
        });
        yield* instance.start;
        yield* instance.ready;
        yield* sendTestEmail(yield* recipe.endpoint("smtp"), "persistence-test");
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

  it.live("removes the native mail instance directory when destroyed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-mail-destroy-" });
        const recipe = yield* makeServiceRecipe({ service: "mail", config: {} }, options(root));
        const instance = yield* makeService(recipe.definition, {
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
        const instance = yield* makeService(recipe.definition, {
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
