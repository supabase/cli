import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyBucketsFlags } from "./buckets.command.ts";

export const legacyBuckets = Effect.fn("legacy.seed.buckets")(function* (
  _flags: LegacyBucketsFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["seed", "buckets"]);
});
