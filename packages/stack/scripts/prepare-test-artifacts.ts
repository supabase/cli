import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { artifactServiceKinds, catalogPins, prepareNativeArtifact } from "../src/Artifacts.ts";
import { testArtifactCacheRoot } from "../tests/artifact-cache.ts";

/**
 * Downloads every default native artifact into the shared test cache, as CI fills its disk.
 * With `--images`, prints every catalog container image instead so CI can pull them.
 */
const prepareNative = Effect.forEach(
  [...artifactServiceKinds(), "vector" as const],
  (service) =>
    prepareNativeArtifact({ service }, testArtifactCacheRoot).pipe(
      Effect.tap((artifact) => Console.log(`${service} ${artifact.version}`)),
    ),
  { concurrency: "unbounded", discard: true },
).pipe(Effect.withSpan("Stack.prepareNativeArtifacts"));

const printImages = Effect.forEach(catalogPins(), ({ pin }) => Console.log(pin.image), {
  discard: true,
});

(process.argv.includes("--images") ? printImages : prepareNative).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
  NodeRuntime.runMain,
);
