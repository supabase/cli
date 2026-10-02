import { createServer } from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- real socket fixture.
import { Effect, Queue, Schema, Scope } from "effect";
import type { StoredEvents } from "../src/host/LogForwarder.ts";

const Body = Schema.Struct({
  batch: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      event_message: Schema.String,
      appname: Schema.String,
      timestamp: Schema.String,
      metadata: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});
export type FakeEvent = Schema.Schema.Type<typeof Body>["batch"][number];

const decodeBody = Schema.decodeUnknownSync(Body);

/** One ingest request as the fake received it. */
export interface Received {
  readonly port: number;
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly events: ReadonlyArray<FakeEvent>;
}

export interface FakeLogflareOptions {
  /** Events per stored batch; Logflare's Postgres pipeline uses 350. */
  readonly batchEvents?: number;
  /** Stores queued events this long after they arrive; without it only `apply` stores them. */
  readonly flushMillis?: number;
}

/**
 * A Logflare stand-in with its asynchronous Postgres pipeline: an accepted post only queues its
 * events, and each per-source batch is stored atomically, or dropped whole when one of its ids is
 * already stored. Listeners share the storage, like an Analytics restarted on a new port.
 */
export const makeFakeLogflare = (options: FakeLogflareOptions = {}) =>
  Effect.gen(function* () {
    const batchEvents = options.batchEvents ?? 350;
    const received = yield* Queue.unbounded<Received>();
    const stored = new Map<string, Map<string, FakeEvent>>();
    const queued = new Map<string, Array<FakeEvent>>();
    const statuses: Array<number> = [];
    const holds: Array<{ readonly released: Promise<void>; readonly closed: () => void }> = [];
    const counts = { dropped: 0, aborted: 0 };
    const flushes = yield* Queue.unbounded<void>();

    const applyBatches = (limit = Number.POSITIVE_INFINITY) => {
      let applied = 0;
      for (const [source, events] of queued) {
        const table = stored.get(source) ?? new Map<string, FakeEvent>();
        stored.set(source, table);
        while (events.length > 0 && applied < limit) {
          const batch = events.splice(0, batchEvents);
          applied++;
          const ids = new Set(batch.map(({ id }) => id));
          if (ids.size < batch.length || batch.some(({ id }) => table.has(id)))
            counts.dropped += batch.length;
          else for (const event of batch) table.set(event.id, event);
        }
      }
    };
    const { flushMillis } = options;
    if (flushMillis !== undefined)
      yield* Queue.take(flushes).pipe(
        Effect.andThen(Effect.sleep(flushMillis)),
        Effect.andThen(Queue.clear(flushes)),
        Effect.andThen(Effect.sync(() => applyBatches())),
        Effect.forever,
        Effect.forkScoped,
      );

    const listen = Effect.acquireRelease(
      Effect.callback<{ readonly port: number; readonly server: ReturnType<typeof createServer> }>(
        (resume) => {
          const server = createServer((request, response) => {
            const chunks: Array<Uint8Array> = [];
            request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
            request.on("end", () => {
              const url = new URL(request.url ?? "", "http://fake");
              const apiKey = request.headers["x-api-key"];
              const { batch } = decodeBody(
                JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))),
              );
              const status = statuses.shift() ?? 200;
              if (status >= 200 && status < 300) {
                const source = url.searchParams.get("source_name") ?? "";
                queued.set(source, [...(queued.get(source) ?? []), ...batch]);
                Queue.offerUnsafe(flushes, undefined);
              }
              const hold = holds.shift();
              response.on("finish", () => hold?.closed());
              response.on("close", () => {
                if (!response.writableFinished) counts.aborted++;
                hold?.closed();
              });
              Queue.offerUnsafe(received, {
                port: Number(request.socket.localPort),
                url: request.url ?? "",
                apiKey: typeof apiKey === "string" ? apiKey : undefined,
                events: batch,
              });
              void (hold?.released ?? Promise.resolve()).then(() => {
                response.statusCode = status;
                response.end();
              });
            });
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string")
              return resume(Effect.die("fake Logflare has no address"));
            resume(Effect.succeed({ port: address.port, server }));
          });
        },
      ),
      ({ server }) =>
        Effect.callback<void>((resume) => {
          server.closeAllConnections();
          server.close(() => resume(Effect.void));
        }),
    ).pipe(Effect.map(({ port }) => port));

    const port = yield* listen;
    const storedIds: StoredEvents["storedIds"] = (source, ids) =>
      Effect.sync(() => new Set(ids.filter((id) => stored.get(source)?.has(id) === true)));

    return {
      port,
      /** Opens another ingest port sharing this fake's storage. */
      listen: (scope: Scope.Scope) => listen.pipe(Scope.provide(scope)),
      next: Queue.take(received),
      /** The next posts answer with these statuses; only a 2xx queues its events. */
      respond: (...next: ReadonlyArray<number>) => Effect.sync(() => statuses.push(...next)),
      /** Holds the next post's response until the returned effect runs; it ends once the response does. */
      hold: Effect.sync(() => {
        const released = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        holds.push({ released: released.promise, closed: closed.resolve });
        return Effect.sync(released.resolve).pipe(
          Effect.andThen(Effect.promise(() => closed.promise)),
        );
      }),
      /** Stores queued batches now, at most `limit` of them. */
      apply: (limit?: number) => Effect.sync(() => applyBatches(limit)),
      /** Loses every queued event, like Analytics stopping before its pipeline flushed. */
      discard: Effect.sync(() => queued.clear()),
      storedIds,
      storedEvents: Effect.succeed({ storedIds } satisfies StoredEvents),
      stored: Effect.sync(() => [...stored.values()].flatMap((table) => [...table.values()])),
      dropped: Effect.sync(() => counts.dropped),
      aborted: Effect.sync(() => counts.aborted),
    };
  });

export type FakeLogflare = Effect.Success<ReturnType<typeof makeFakeLogflare>>;
