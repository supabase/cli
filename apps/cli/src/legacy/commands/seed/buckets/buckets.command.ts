import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyBuckets } from "./buckets.handler.ts";

const config = {
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Seeds the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Seeds the local database.")),
} as const;

export type LegacyBucketsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyBucketsCommand = Command.make("buckets", config).pipe(
  Command.withDescription("Seed buckets declared in [storage.buckets]."),
  Command.withShortDescription("Seed buckets declared in [storage.buckets]"),
  Command.withHandler((flags) => legacyBuckets(flags)),
);
