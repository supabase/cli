import { Effect } from "effect";
import type { Command } from "effect/cli";
import { Argument, Command as CommandApi, Flag } from "effect/cli";
import { projectTargetFlags, targetFlags } from "../../src/command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../src/command-internal/target/target-policy.ts";
import type { TargetPolicyDeclaration } from "../../src/command-internal/target/target-policy.ts";

export const remoteFlag = targetFlags({ subject: "database", dbUrl: true }).remote.pipe(
  Flag.withDescription("Target a remote project."),
);

export const hostedRemoteFlag = projectTargetFlags().remote.pipe(
  Flag.withDescription("Target a remote project."),
);

const positional = (kind: "required" | "optional" | "variadic", index: number) => {
  const argument = Argument.String(`arg${index}`);
  if (kind === "optional") return argument.pipe(Argument.optional);
  return kind === "variadic" ? argument.pipe(Argument.variadic()) : argument;
};

const exempt = "fixture";

const POLICIES = {
  selectable: { group: "selectable", consent: "none", consentExemptReason: exempt },
  hosted: { group: "hosted", consent: "none" },
  "local-only": { group: "local-only", consent: "none" },
  account: { group: "account", consent: "none" },
  removed: { group: "removed", consent: "none" },
} as const satisfies Record<string, TargetPolicyDeclaration>;

export type FixtureGroup = keyof typeof POLICIES;

export interface FixtureLeafOptions {
  readonly withRemote?: boolean;
  readonly positionals?: ReadonlyArray<"required" | "optional" | "variadic">;
  readonly description?: string;
}

/** A leaf with `group`'s target policy and its `--remote` flag, unless `withRemote` is false. */
export const fixtureLeaf = (
  name: string,
  group: FixtureGroup,
  options: FixtureLeafOptions = {},
) => {
  const config = {
    other: Flag.Boolean("other").pipe(Flag.withDescription("Another flag.")),
    ...(options.withRemote === false
      ? {}
      : { remote: group === "hosted" ? hostedRemoteFlag : remoteFlag }),
    ...Object.fromEntries(
      (options.positionals ?? []).map((kind, index) => [`arg${index}`, positional(kind, index)]),
    ),
  };
  return CommandApi.make(name, config, () => Effect.void).pipe(
    CommandApi.withDescription(options.description ?? `The ${name} command.`),
    withTargetPolicy(POLICIES[group]),
  );
};

export const fixtureRoot = (...children: ReadonlyArray<Command.Command.Any>): Command.Command.Any =>
  CommandApi.make("supabase").pipe(CommandApi.withSubcommands([...children]));

export const fixtureGroup = (name: string, ...children: ReadonlyArray<Command.Command.Any>) =>
  CommandApi.make(name).pipe(
    CommandApi.withDescription(`The ${name} group.`),
    CommandApi.withSubcommands([...children]),
  );
