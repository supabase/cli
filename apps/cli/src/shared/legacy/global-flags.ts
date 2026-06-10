import { Flag, GlobalFlag } from "effect/unstable/cli";

export const LegacyOutputFlag = GlobalFlag.setting("output")({
  flag: Flag.choice("output", ["env", "pretty", "json", "toml", "yaml"] as const).pipe(
    Flag.withAlias("o"),
    Flag.withDescription("Output format of status variables."),
    Flag.optional,
  ),
});

export const LegacyProfileFlag = GlobalFlag.setting("profile")({
  flag: Flag.string("profile").pipe(
    Flag.withDescription("Use a specific profile for connecting to Supabase API."),
    Flag.withDefault("supabase"),
  ),
});

export const LegacyDebugFlag = GlobalFlag.setting("debug")({
  flag: Flag.boolean("debug").pipe(Flag.withDescription("Output debug logs to stderr.")),
});

export const LegacyWorkdirFlag = GlobalFlag.setting("workdir")({
  flag: Flag.string("workdir").pipe(
    Flag.withDescription("Path to a Supabase project directory."),
    Flag.optional,
  ),
});

export const LegacyExperimentalFlag = GlobalFlag.setting("experimental")({
  flag: Flag.boolean("experimental").pipe(Flag.withDescription("Enable experimental features.")),
});

export const LegacyNetworkIdFlag = GlobalFlag.setting("network-id")({
  flag: Flag.string("network-id").pipe(
    Flag.withDescription("Use the specified Docker network instead of a generated one."),
    Flag.optional,
  ),
});

export const LegacyYesFlag = GlobalFlag.setting("yes")({
  flag: Flag.boolean("yes").pipe(Flag.withDescription("Answer yes to all prompts.")),
});

export const LegacyDnsResolverFlag = GlobalFlag.setting("dns-resolver")({
  flag: Flag.choice("dns-resolver", ["native", "https"] as const).pipe(
    Flag.withDescription("Look up domain names using the specified resolver."),
    Flag.withDefault("native" as const),
  ),
});

export const LegacyCreateTicketFlag = GlobalFlag.setting("create-ticket")({
  flag: Flag.boolean("create-ticket").pipe(
    Flag.withDescription("Create a support ticket for any CLI error."),
  ),
});

export const LegacyAgentFlag = GlobalFlag.setting("agent")({
  flag: Flag.choice("agent", ["auto", "yes", "no"] as const).pipe(
    Flag.withDescription("Override agent detection: yes, no, or auto (default auto)."),
    Flag.withDefault("auto" as const),
  ),
});

export const LEGACY_GLOBAL_FLAGS = [
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyDebugFlag,
  LegacyWorkdirFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
  LegacyDnsResolverFlag,
  LegacyCreateTicketFlag,
  LegacyAgentFlag,
] as const;
