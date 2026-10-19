import { Effect } from "effect";
import type { Command } from "effect/cli";
import { Argument, Command as CommandApi, Flag, Param, Primitive } from "effect/cli";
import { withTargetPolicy } from "../../src/command-internal/target/target-policy.ts";
import type { TargetPolicyDeclaration } from "../../src/command-internal/target/target-policy.ts";

/** A bare-capable, string-valued flag shaped like `--remote`: the Boolean tag keeps the parser from taking the next token as its value. */
export const remoteFlag = Param.makeSingle({
  kind: Param.flagKind,
  name: "remote",
  primitiveType: Object.assign(Object.create(Primitive.Boolean), {
    parse: (value: string) => Effect.succeed(value),
  }),
}).pipe(Flag.withDescription("Target a remote project."), Flag.optional);

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
  readonly positional?: boolean;
  readonly description?: string;
}

/** A leaf declaring `group`'s target policy, with a `--remote` flag unless `withRemote` is false. */
export const fixtureLeaf = (
  name: string,
  group: FixtureGroup,
  options: FixtureLeafOptions = {},
) => {
  const config = {
    other: Flag.Boolean("other").pipe(Flag.withDescription("Another flag.")),
    ...(options.withRemote === false ? {} : { remote: remoteFlag }),
    ...(options.positional === true
      ? { target: Argument.String("target").pipe(Argument.optional) }
      : {}),
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
