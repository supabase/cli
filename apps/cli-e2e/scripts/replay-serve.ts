import { Config, Console, Data, Effect, Fiber, Schema } from "effect";
import { startReplayServer } from "../src/server/replay-server.ts";

const FIXTURES_DIR = new URL("../fixtures", import.meta.url).pathname;

class ReplayServeError extends Data.TaggedError("ReplayServeError")<{ readonly message: string }> {}

const parsePort = (argv: readonly string[]) => {
  const index = argv.indexOf("--port");
  if (index === -1) return Effect.succeed(0);
  const port = Number(argv[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Effect.fail(
      new ReplayServeError({
        message: `--port expects an integer between 0 and 65535, got "${argv[index + 1]}"`,
      }),
    );
  }
  return Effect.succeed(port);
};

const stopSignal = Effect.callback<void>((resume) => {
  const stop = () => resume(Effect.void);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return Effect.sync(() => {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  });
});

const main = Effect.gen(function* () {
  // Recording mode wipes the committed fixtures, so a standalone server never runs in it.
  if ((yield* Config.String("RECORD").pipe(Config.withDefault(""))) === "true") {
    return yield* new ReplayServeError({
      message: "replay-serve does not support RECORD; unset it to serve the fixtures",
    });
  }

  const server = yield* startReplayServer({
    fixturesDir: FIXTURES_DIR,
    hostname: "127.0.0.1",
    port: yield* parsePort(process.argv.slice(2)),
    record: false,
    stagingUrl: undefined,
  });

  const stopped = yield* stopSignal.pipe(Effect.forkChild({ startImmediately: true }));
  yield* Console.log(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ url: server.url }),
  );
  yield* Fiber.join(stopped);
});

await Effect.runPromise(Effect.scoped(main));
