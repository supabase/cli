import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { Data, Effect, Layer, Predicate } from "effect";
import * as Stack from "../src/index.ts";

class FixtureError extends Data.TaggedError("OwnerExitFixtureError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const promise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new FixtureError({ message: String(cause), cause }),
  });

const assertExited = Effect.fn("Fixture.assertExited")(function* (pid: number) {
  const alive = yield* Effect.try({
    try: () => process.kill(pid, 0),
    catch: (cause) => new FixtureError({ message: String(cause), cause }),
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      ({ cause }) => Predicate.hasProperty(cause, "code") && cause.code === "ESRCH",
      () => Effect.succeed(false),
    ),
  );
  if (alive) return yield* new FixtureError({ message: `Owner ${pid} survived teardown` });
});

const program = Effect.gen(function* () {
  const [root, cacheRoot] = process.argv.slice(2);
  if (root === undefined || cacheRoot === undefined)
    return yield* new FixtureError({ message: "Missing fixture roots" });
  const locations = { stateRoot: `${root}/state`, cacheRoot };
  const ownerPid = (id: string) =>
    promise(() => Stack.discover(locations)).pipe(
      Effect.flatMap((entries) => {
        const owner = entries.find((entry) => entry.definition.id === id)?.host;
        return owner === undefined
          ? Effect.fail(new FixtureError({ message: `No owner for ${id}` }))
          : Effect.succeed(owner.pid);
      }),
    );
  yield* Effect.acquireUseRelease(
    promise(() => Stack.create({ ...locations, projectRoot: root, runtime: "native" })),
    (stack) =>
      Effect.acquireUseRelease(
        Effect.succeed(stack),
        (client) =>
          Effect.gen(function* () {
            const mail = yield* promise(() =>
              client.services.create({
                service: "mail",
                config: {},
                endpoints: { http: { port: "auto" } },
              }),
            );
            yield* promise(() => mail.start());
            yield* promise(() => mail.ready());
            const firstPid = yield* ownerPid(client.id);
            yield* promise(() => client.stop());
            yield* assertExited(firstPid);
            yield* promise(() => mail.start());
            yield* promise(() => mail.ready());
          }),
        (client) =>
          Effect.gen(function* () {
            const pid = yield* ownerPid(client.id);
            yield* promise(() => client.destroy());
            yield* assertExited(pid);
          }),
      ),
    (client) => promise(() => client.close()),
  );
  process.stdout.write("owner-exit-confirmed\n");
});

await Effect.runPromise(
  program.pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
