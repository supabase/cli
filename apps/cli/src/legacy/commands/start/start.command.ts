import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withHidden } from "../../../shared/cli/hidden-flag.ts";
import { legacyStart } from "./start.handler.ts";

const config = {
  exclude: Flag.string("exclude").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Names of containers to not start. [analytics,db,edge-runtime,functions,imgproxy,inbucket,kong,meta,realtime,rest,storage,studio,vector]",
    ),
    Flag.withDefault([] as ReadonlyArray<string>),
    Flag.withAlias("x"),
  ),
  ignoreHealthCheck: Flag.boolean("ignore-health-check").pipe(
    Flag.withDescription("Ignore unhealthy services and exit 0"),
  ),
  preview: withHidden(
    Flag.boolean("preview").pipe(Flag.withDescription("Connect to feature preview branch")),
  ),
} as const;

export type LegacyStartFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyStartCommand = Command.make("start", config).pipe(
  Command.withDescription("Start containers for Supabase local development."),
  Command.withShortDescription("Start local Supabase stack"),
  Command.withHandler((flags) => legacyStart(flags)),
);
