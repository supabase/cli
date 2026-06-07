import { Effect, Layer, PubSub, Ref, Context, Stream } from "effect";

export interface LogEntry {
  readonly timestamp: number;
  readonly service: string;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
}

const MAX_BUFFER_SIZE = 10_000;

export class LogBuffer extends Context.Service<
  LogBuffer,
  {
    readonly append: (
      service: string,
      stream: "stdout" | "stderr",
      line: string,
    ) => Effect.Effect<void>;
    readonly subscribe: (service: string) => Stream.Stream<LogEntry>;
    readonly subscribeAll: () => Stream.Stream<LogEntry>;
    readonly history: (service: string, limit?: number) => Effect.Effect<ReadonlyArray<LogEntry>>;
    readonly historyAll: (
      limit?: number,
      services?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LogEntry>>;
    readonly truncate: (service: string) => Effect.Effect<void>;
  }
>()("process-compose/LogBuffer") {
  static layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const servicePubSubs = new Map<string, PubSub.PubSub<LogEntry>>();
      const serviceBuffers = new Map<string, Ref.Ref<Array<LogEntry>>>();
      const globalPubSub = yield* PubSub.bounded<LogEntry>(4096);
      const globalBuffer = yield* Ref.make<Array<LogEntry>>([]);

      const getOrCreate = (service: string) =>
        Effect.gen(function* () {
          if (!servicePubSubs.has(service)) {
            const ps = yield* PubSub.bounded<LogEntry>(1024);
            servicePubSubs.set(service, ps);
            serviceBuffers.set(service, Ref.makeUnsafe<Array<LogEntry>>([]));
          }
          return {
            pubsub: servicePubSubs.get(service)!,
            buffer: serviceBuffers.get(service)!,
          };
        });

      return {
        append: (service, stream, line) =>
          Effect.gen(function* () {
            const entry: LogEntry = {
              timestamp: Date.now(),
              service,
              stream,
              line,
            };
            const { pubsub, buffer } = yield* getOrCreate(service);
            yield* PubSub.publish(pubsub, entry);
            yield* PubSub.publish(globalPubSub, entry);
            yield* Ref.update(globalBuffer, (buf) => {
              const next = buf.concat(entry);
              return next.length > MAX_BUFFER_SIZE ? next.slice(-MAX_BUFFER_SIZE) : next;
            });
            yield* Ref.update(buffer, (buf) => {
              const next = buf.concat(entry);
              return next.length > MAX_BUFFER_SIZE ? next.slice(-MAX_BUFFER_SIZE) : next;
            });
          }),

        subscribe: (service) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const { pubsub } = yield* getOrCreate(service);
              return Stream.fromPubSub(pubsub);
            }),
          ),

        subscribeAll: () => Stream.fromPubSub(globalPubSub),

        history: (service, limit = 100) =>
          Effect.gen(function* () {
            const { buffer } = yield* getOrCreate(service);
            const all = Ref.getUnsafe(buffer);
            return all.slice(-limit);
          }),

        historyAll: (limit = 100, services) =>
          Effect.sync(() => {
            const all = Ref.getUnsafe(globalBuffer);
            const filtered =
              services === undefined || services.length === 0
                ? all
                : all.filter((entry) => services.includes(entry.service));

            return filtered.slice(-limit);
          }),

        truncate: (service) =>
          Effect.gen(function* () {
            const { buffer } = yield* getOrCreate(service);
            yield* Ref.set(buffer, []);
            yield* Ref.update(globalBuffer, (entries) =>
              entries.filter((entry) => entry.service !== service),
            );
          }),
      };
    }),
  );
}
