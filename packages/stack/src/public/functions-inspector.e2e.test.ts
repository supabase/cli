import { NodeServices } from "@effect/platform-node";
import {
  Config,
  Data,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { afterAll, describe, expect, test } from "vitest";
import { isolatedInstanceApi } from "../../tests/helpers/instance-api.ts";
import type { ServiceInstance } from "./Service.ts";
import type { ServiceStatus } from "./Status.ts";

const host = ManagedRuntime.make(Layer.merge(NodeServices.layer, FetchHttpClient.layer));
afterAll(() => host.dispose());
const selectedRuntime = Option.getOrUndefined(
  Effect.runSync(Config.option(Config.string("SUPABASE_STACK_E2E_RUNTIME"))),
);
const runtimes = [{ kind: "native" }, { kind: "container", engine: "docker" }] as const;
const inspectorTargets = Schema.Array(
  Schema.Struct({
    webSocketDebuggerUrl: Schema.String,
    type: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
  }),
);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const inspectorDataText = (data: unknown): string => {
  const decoder = new TextDecoder();
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return decoder.decode(data);
  if (Buffer.isBuffer(data)) return decoder.decode(data);
  return "";
};

class InspectorTestError extends Data.TaggedError("InspectorTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// oxlint-disable-next-line effecttsgo/async-function -- Observes the public Promise API subscription across the supervisor boundary.
const waitForInspector = async (updates: AsyncIterator<ServiceStatus>) => {
  for (;;) {
    const update = await updates.next();
    if (update.done) throw new Error("Status observation ended before inspector publication");
    if (update.value.phase === "failed" || update.value.phase === "recovery")
      throw new Error(JSON.stringify(update.value));
    const endpoint = update.value.endpoints.find(
      (entry) => entry.binding === "inspector" && entry.availability === "listening",
    );
    if (endpoint !== undefined) {
      expect(update.value.phase).toBe("starting");
      return endpoint.url;
    }
  }
};

const releaseDebugger = (endpoint: string, mode: "wait" | "brk") => {
  let targetUrl = "unresolved";
  return Effect.gen(function* () {
    const response = yield* HttpClient.get(new URL("/json/list", endpoint));
    expect(response.status).toBe(200);
    const targets = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(inspectorTargets)),
    );
    expect(targets.length).toBeGreaterThan(0);
    const target = targets[0];
    if (target === undefined)
      return yield* new InspectorTestError({ message: "Inspector target missing" });
    const url = new URL(target.webSocketDebuggerUrl);
    url.host = new URL(endpoint).host;
    targetUrl = url.toString();
    yield* Effect.callback<void, InspectorTestError>((resume) => {
      const socket = new globalThis.WebSocket(url.toString());
      let settled = false;
      let paused = false;
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      const finish = (result: Effect.Effect<void, InspectorTestError>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(result);
      };
      const fail = (message: string, cause?: unknown) =>
        finish(
          Effect.fail(
            new InspectorTestError({ message, ...(cause === undefined ? {} : { cause }) }),
          ),
        );
      const send = (id: number, method: string) => {
        try {
          const command = JSON.stringify({ id, method });
          socket.send(command);
        } catch (cause) {
          fail("Inspector command failed to send", cause);
        }
      };
      const onOpen = () => {
        send(1, mode === "wait" ? "Runtime.runIfWaitingForDebugger" : "Debugger.enable");
      };
      const onMessage = (event: MessageEvent) => {
        const raw = inspectorDataText(event.data);
        // Debugger.enable emits a large scriptParsed stream; only protocol acknowledgements and
        // an actual paused event can settle this release operation.
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (cause) {
          fail("Inspector message was invalid", cause);
          return;
        }
        if (!isRecord(parsed)) {
          fail("Inspector message was invalid");
          return;
        }
        if (parsed.method === "Debugger.paused" && mode === "brk") {
          paused = true;
          send(3, "Debugger.resume");
          return;
        }
        if (parsed.error !== undefined) {
          fail("Inspector command failed", parsed.error);
          return;
        }
        if (parsed.id === 1 && mode === "wait") finish(Effect.void);
        if (parsed.id === 1 && mode === "brk") send(2, "Runtime.runIfWaitingForDebugger");
        if (parsed.id === 2 && (mode === "wait" || !paused)) finish(Effect.void);
        if (parsed.id === 3 && mode === "brk") finish(Effect.void);
      };
      const onError = (cause: Event) => {
        fail("Inspector socket failed", cause);
      };
      const onClose = () => {
        if (!settled) fail("Inspector closed before resume");
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      return Effect.sync(() => {
        cleanup();
        if (
          socket.readyState === globalThis.WebSocket.CONNECTING ||
          socket.readyState === globalThis.WebSocket.OPEN
        )
          socket.close();
      });
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new InspectorTestError({
            message: `Main debugger did not resume at ${endpoint} (${targetUrl})`,
          }),
        ),
    }),
  );
};

describe("functions startup through the managed inspector", () => {
  for (const runtime of runtimes) {
    for (const mode of ["wait", "brk"] as const) {
      test.skipIf(selectedRuntime !== undefined && selectedRuntime !== runtime.kind)(
        `releases inspect-main ${mode} before application health in ${runtime.kind}`,
        { timeout: 5 * 60_000 },
        // oxlint-disable-next-line effecttsgo/async-function -- Exercises the public Promise API and real debugger across supervisor processes.
        async () => {
          const root = await host.runPromise(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const root = yield* fs.makeTempDirectory({ prefix: "supabase-inspector-" });
              const functionsRoot = path.join(root, "supabase", "functions", "hello");
              yield* fs.makeDirectory(functionsRoot, { recursive: true });
              yield* fs.writeFileString(
                path.join(functionsRoot, "index.ts"),
                'Deno.serve(() => new Response("debugger-resumed"));\n',
              );
              return root;
            }),
          );
          const { createStack } = await host.runPromise(isolatedInstanceApi(root));
          const stack = await createStack({
            projectRoot: root,
            name: "inspector",
            runtime,
            initialConfig: {
              capabilities: {
                database: { enabled: false },
                auth: { enabled: false },
                rest: { enabled: false },
                realtime: { enabled: false },
                storage: { enabled: false },
                functions: { enabled: false },
                studio: { enabled: false },
                mail: { enabled: false },
                analytics: { enabled: false },
                pooler: { enabled: false },
              },
            },
          });
          const failures: unknown[] = [];
          let instance: ServiceInstance<"functions"> | undefined;
          try {
            const service = await stack.services.create({
              service: "functions",
              name: "debug-functions",
              config: {
                endpoints: { inspector: { port: "auto" } },
                settings: {
                  functions_root: "supabase/functions",
                  inspector: { mode, main: true },
                  functions: { hello: { enabled: true, verify_jwt: false } },
                },
              },
            });
            instance = service;
            const updates = service.followStatus()[Symbol.asyncIterator]();
            try {
              expect((await updates.next()).value?.phase).toBe("stopped");
              const inspector = waitForInspector(updates).then((endpoint) =>
                host.runPromise(releaseDebugger(endpoint, mode)),
              );
              let startupPhase: string | undefined;
              let healthBeforeInspector: number | undefined;
              let startedStatus: ServiceStatus | undefined;
              const start = host.runPromise(
                Effect.tryPromise({
                  try: () => service.start(),
                  catch: (cause) =>
                    new InspectorTestError({ message: "Functions startup failed", cause }),
                }).pipe(
                  Effect.tap((status) =>
                    Effect.sync(() => {
                      startupPhase = status.phase;
                      startedStatus = status;
                    }),
                  ),
                  Effect.flatMap((status) =>
                    status.phase === "ready"
                      ? Effect.succeed(status)
                      : Effect.fail(
                          new InspectorTestError({
                            message: `Functions startup phase was ${status.phase}`,
                          }),
                        ),
                  ),
                  Effect.flatMap(() =>
                    Effect.tryPromise({
                      try: () => stack.status(),
                      catch: (cause) =>
                        new InspectorTestError({ message: "Managed stack status failed", cause }),
                    }),
                  ),
                  Effect.flatMap((stackStatus) => {
                    const api = stackStatus.endpoints.api;
                    if (api === undefined)
                      return Effect.fail(
                        new InspectorTestError({ message: "Managed API endpoint missing" }),
                      );
                    return HttpClient.get(new URL("/functions/v1/_internal/health", api.url)).pipe(
                      Effect.timeout("15 seconds"),
                      Effect.tap((response) =>
                        Effect.sync(() => {
                          healthBeforeInspector = response.status;
                        }),
                      ),
                      Effect.flatMap((response) =>
                        response.status === 200
                          ? Effect.succeed(response)
                          : Effect.fail(
                              new InspectorTestError({
                                message: `Functions health returned ${response.status}`,
                              }),
                            ),
                      ),
                      Effect.asVoid,
                    );
                  }),
                ),
              );
              const [startResult, inspectorResult] = await Promise.allSettled([start, inspector]);
              if (startResult.status === "rejected") {
                if (inspectorResult.status === "rejected")
                  throw new AggregateError(
                    [startResult.reason, inspectorResult.reason],
                    "Inspector startup failed",
                  );
                throw startResult.reason;
              }
              if (inspectorResult.status === "rejected") {
                const details = [
                  startupPhase === undefined
                    ? "start phase unresolved"
                    : `start phase=${startupPhase}`,
                  healthBeforeInspector === undefined
                    ? "health unresolved"
                    : `health status=${healthBeforeInspector}`,
                ].join("; ");
                throw new Error(`Inspector startup failed; ${details}`, {
                  cause: inspectorResult.reason,
                });
              }
              if (startedStatus === undefined)
                throw new Error("Functions startup completed without a status");
              const started = startedStatus;
              expect(started.phase).toBe("ready");
              const status = await stack.status();
              const api = status.endpoints.api;
              if (api === undefined) throw new Error("Managed API endpoint missing");
              const response = await host.runPromise(
                HttpClient.get(new URL("/functions/v1/_internal/health", api.url)).pipe(
                  Effect.timeout("15 seconds"),
                ),
              );
              expect(response.status).toBe(200);
              expect(await host.runPromise(response.json)).toEqual({ message: "ok" });
              const credentials = await service.credentials();
              if (credentials === undefined || !("publishableKey" in credentials))
                throw new Error("Functions API credentials missing without a database");
              expect(credentials.publishableKey.length).toBeGreaterThan(0);
              const stackCredentials = await stack.credentials();
              expect(stackCredentials.database).toBeUndefined();
              expect(stackCredentials.api?.publishableKey).toBe(credentials.publishableKey);
            } finally {
              await updates.return?.();
            }
          } catch (error) {
            if (instance === undefined) {
              failures.push(error);
            } else {
              try {
                const logs = await instance.logs({ tail: 100 });
                const output = logs.entries
                  .filter((entry) => entry.stream === "stdout" || entry.stream === "stderr")
                  .map((entry) => `${entry.source}/${entry.stream}: ${entry.message}`)
                  .join("\n");
                failures.push(
                  new Error(
                    output.length === 0
                      ? "Inspector startup failed; instance logs contained no stdout/stderr"
                      : `Inspector startup failed; instance logs:\n${output}`,
                    { cause: error },
                  ),
                );
              } catch (logsError) {
                failures.push(
                  new AggregateError(
                    [error, logsError],
                    "Inspector startup failed and instance logs were unavailable",
                  ),
                );
              }
            }
          }
          try {
            await stack.destroy();
          } catch (error) {
            throw new AggregateError(
              [...failures, error],
              `Inspector smoke cleanup failed; retained project at ${root}`,
            );
          }
          await host.runPromise(
            Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(root, { recursive: true })),
          );
          if (failures.length > 0) throw failures[0];
        },
      );
    }
  }
});
