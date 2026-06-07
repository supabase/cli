import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyBucketsFlags } from "./buckets.command.ts";

export const legacyBuckets = Effect.fn("legacy.seed.buckets")(function* (
  flags: LegacyBucketsFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["seed", "buckets"];
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
