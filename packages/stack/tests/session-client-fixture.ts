import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { create } from "../src/effect.ts";

const [root, cacheRoot] = process.argv.slice(2);
if (root === undefined || cacheRoot === undefined) throw new Error("Session fixture roots missing");

/** Creates a session stack with a running native service, reports it, and waits to be killed. */
const program = Effect.scoped(
  Effect.gen(function* () {
    const stack = yield* create({
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot,
      runtime: "native",
      lifetime: "session",
    });
    const mail = yield* stack.services.create({
      service: "mail",
      config: {},
      endpoints: { http: { port: "auto" } },
    });
    yield* mail.start;
    yield* mail.ready;
    const ready = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Struct({ stackId: Schema.String })),
    )({ stackId: stack.id });
    process.stdout.write(`${ready}\n`);
    return yield* Effect.never;
  }),
);

await Effect.runPromise(
  program.pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
