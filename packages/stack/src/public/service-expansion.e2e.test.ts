import { NodeServices } from "@effect/platform-node";
import {
  Config,
  Data,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Queue,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { afterAll, expect, test } from "vitest";
import { isolatedInstanceApi } from "../../tests/helpers/instance-api.ts";

const host = ManagedRuntime.make(Layer.merge(NodeServices.layer, FetchHttpClient.layer));
afterAll(() => host.dispose());
const selectedRuntime = Option.getOrUndefined(
  Effect.runSync(Config.option(Config.string("SUPABASE_STACK_E2E_RUNTIME"))),
);
const runtimes = [{ kind: "native" }, { kind: "container", engine: "docker" }] as const;

class ExpansionTestError extends Data.TaggedError("ExpansionTestError")<{
  readonly message: string;
}> {}

for (const runtime of runtimes) {
  test.skipIf(selectedRuntime !== undefined && selectedRuntime !== runtime.kind)(
    `preserves a Functions WebSocket while whole start expands the stack in ${runtime.kind}`,
    { timeout: 10 * 60_000 },
    // oxlint-disable-next-line effecttsgo/async-function -- Exercises the public Promise API across real supervisor processes.
    async () => {
      const root = await host.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectory({ prefix: "supabase-instance-expansion-" });
          const directory = path.join(root, "supabase", "functions", "echo");
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFileString(
            path.join(directory, "index.ts"),
            `Deno.serve(async (request) => {
  const query = new URL(request.url).searchParams;
  if (query.has("sql")) {
    const value = Deno.env.get("SUPABASE_DB_URL");
    if (!value) return new Response("missing-sql-hint", { status: 500 });
    const endpoint = new URL(value);
    if (query.get("sql") === "connect") {
      const connection = await Deno.connect({ hostname: endpoint.hostname, port: Number(endpoint.port) });
      try {
        await connection.write(new Uint8Array([0, 0, 0, 8, 4, 210, 22, 47]));
        const reply = new Uint8Array(1);
        const count = await connection.read(reply);
        return new Response(count === 1 ? String.fromCharCode(reply[0]) : "no-postgres-reply");
      } finally { connection.close(); }
    }
    return new Response(endpoint.port);
  }
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.onmessage = (event) => socket.send(event.data);
    return response;
  }
  return new Response("functions-ready");
});
`,
          );
          return root;
        }),
      );
      const { createStack } = await host.runPromise(isolatedInstanceApi(root));
      const stack = await createStack({
        projectRoot: root,
        runtime,
        initialConfig: {
          capabilities: {
            database: { enabled: true },
            functions: {
              enabled: true,
              activation: "lazy",
              settings: {
                functions_root: "supabase/functions",
                functions: { echo: { enabled: true, verify_jwt: false } },
              },
            },
            auth: { enabled: false },
            rest: { enabled: false },
            realtime: { enabled: false },
            storage: { enabled: false },
            studio: { enabled: false },
            mail: { enabled: false },
            analytics: { enabled: false },
            pooler: { enabled: false },
          },
        },
      });
      const failures: unknown[] = [];
      try {
        const database = await stack.services.get({ name: "database" });
        const functions = await stack.services.get({ name: "functions" });
        if (database.service !== "database" || functions.service !== "functions")
          throw new Error("Default service kinds do not match their registrations");
        const plannedSql = await database.credentials();
        if (plannedSql === undefined) throw new Error("Planned SQL credentials missing");
        await functions.start();
        expect((await database.status()).phase).toBe("stopped");
        const api = (await stack.status()).endpoints.api;
        if (api === undefined) throw new Error("Functions managed API missing");
        const hintPort = await host.runPromise(
          HttpClient.get(new URL("/functions/v1/echo?sql=hint", api.url)).pipe(
            Effect.flatMap((response) => response.text),
          ),
        );
        expect(hintPort).toBe(new URL(plannedSql.url).port);
        expect((await database.status()).phase).toBe("stopped");
        const socketUrl = new URL("/functions/v1/echo", api.url);
        socketUrl.protocol = "ws:";
        await host.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const socket = yield* Socket.makeWebSocket(socketUrl.toString());
              const write = yield* socket.writer;
              const opened = yield* Deferred.make<void>();
              const messages = yield* Queue.unbounded<string>();
              const reader = yield* socket
                .runString((message) => Queue.offer(messages, message), {
                  onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
                })
                .pipe(Effect.forkChild);
              const disconnected = Fiber.join(reader).pipe(
                Effect.andThen(
                  Effect.fail(new ExpansionTestError({ message: "Functions socket closed" })),
                ),
              );
              yield* Effect.raceFirst(Deferred.await(opened), disconnected);
              const echo = (message: string) =>
                write(message).pipe(
                  Effect.andThen(Effect.raceFirst(Queue.take(messages), disconnected)),
                  Effect.tap((received) => Effect.sync(() => expect(received).toBe(message))),
                );
              yield* echo("before-expansion");
              yield* Effect.tryPromise(() =>
                expect(functions.sleep()).rejects.toMatchObject({
                  _tag: "StackLifecycleConflictError",
                  instanceId: functions.id,
                }),
              );
              const expanded = yield* Effect.tryPromise(() => stack.start());
              expect(expanded.instances.find(({ id }) => id === database.id)?.phase).toBe("ready");
              expect(expanded.endpoints.api?.url).toBe(api.url);
              yield* echo("after-expansion");
              const postgresReply = yield* HttpClient.get(
                new URL("/functions/v1/echo?sql=connect", api.url),
              ).pipe(
                Effect.flatMap((response) => response.text),
                Effect.timeout("15 seconds"),
              );
              expect(["S", "N"]).toContain(postgresReply);
              const sql = yield* Effect.tryPromise(() => database.credentials());
              expect(sql?.url).toBe(plannedSql.url);
              yield* Effect.tryPromise(() => database.stop());
              yield* echo("while-database-stopped");
              yield* Effect.tryPromise(() => database.start());
              yield* echo("after-database-restart");
            }),
          ).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        await stack.destroy();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0)
        throw new AggregateError(failures, `Expansion failed; project retained at ${root}`);
      await host.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(root, { recursive: true })),
      );
    },
  );
}
