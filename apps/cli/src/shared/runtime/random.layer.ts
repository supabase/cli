import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { Random } from "./random.service.ts";

/** Default `Random`, backed by `node:crypto.randomBytes`. */
export const randomLayer = Layer.succeed(Random, {
  randomHex: (bytes: number) => Effect.sync(() => randomBytes(bytes).toString("hex")),
});
