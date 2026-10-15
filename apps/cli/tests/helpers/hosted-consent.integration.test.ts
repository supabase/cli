import { Effect, Option } from "effect";
import { Command } from "effect/cli";

import { CommandPlatformApi } from "../../src/auth/command-platform-api.service.ts";
import { requireHostedMutationConsent } from "../../src/command-internal/hosted-consent/hosted-consent.ts";
import { withTargetPolicy } from "../../src/command-internal/target/target-policy.ts";
import { ProjectRefResolver } from "../../src/config/project-ref.service.ts";
import { describeHostedConsent } from "./hosted-consent.ts";

const syntheticWrite = (options: { typed?: boolean; onWrite?: () => void } = {}) =>
  Effect.gen(function* () {
    const ref = yield* ProjectRefResolver.use((resolver) => resolver.resolve(Option.none()));
    yield* requireHostedMutationConsent({
      action: `create a secret on ${ref}`,
      ...(options.typed === true ? { confirm: { kind: "typed" as const, expected: ref } } : {}),
    });
    options.onWrite?.();
    const api = yield* CommandPlatformApi;
    yield* api.v1.bulkCreateSecrets({ ref, body: [{ name: "FOO", value: "bar" }] });
  });

const syntheticLeaf = Command.make("synthetic-write").pipe(
  Command.withHandler(() => syntheticWrite()),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);

describeHostedConsent("synthetic-write", {
  command: syntheticLeaf,
  invoke: () => ({ run: syntheticWrite() }),
});

describeHostedConsent("synthetic-write with a typed confirmation", {
  command: syntheticLeaf,
  typed: true,
  invoke: () => ({ run: syntheticWrite({ typed: true }) }),
});

describeHostedConsent("synthetic-write with a custom mutation probe", {
  command: syntheticLeaf,
  invoke: () => {
    let writes = 0;
    return {
      run: syntheticWrite({ onWrite: () => writes++ }),
      mutations: () => writes,
    };
  },
});
