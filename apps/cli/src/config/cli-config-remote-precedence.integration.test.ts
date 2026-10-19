import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { configValuesLayer } from "../../tests/helpers/config-values-layer.ts";
import { createStackConfigProject } from "../../tests/helpers/stack-config.ts";
import { CLI_CONFIG_FAMILIES } from "./cli-config-key-annotations.ts";
import { cliConfigFamilyKey, cliConfigRegistry, type AnyCliConfigKey } from "./cli-config-keys.ts";
import { CliConfigValues } from "./cli-config-values.service.ts";

const LINKED = "abcdefghijklmnopqrst";

const registered = (path: string) => {
  const key = cliConfigRegistry.keyAt(path);
  if (key === undefined) throw new Error(`${path} is not in the registry`);
  return key;
};

const familyKey = (id: string, name: string, field: string) => {
  const family = CLI_CONFIG_FAMILIES.find((candidate) => candidate.id === id);
  const key = family === undefined ? undefined : cliConfigFamilyKey(family, name, field);
  if (key === undefined) throw new Error(`no ${id} family key for ${field}`);
  return key;
};

interface Scenario {
  readonly name: string;
  readonly key: AnyCliConfigKey;
  readonly optional?: true;
  readonly base: string;
  readonly remote: string;
  readonly remoteValue: unknown;
  readonly envValue: string;
  readonly decodedEnvValue: unknown;
}

const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "a top-level numeric section value",
    key: registered("api.max_rows"),
    base: "[api]\nmax_rows = 10\n",
    remote: "[remotes.staging.api]\nmax_rows = 20\n",
    remoteValue: 20,
    envValue: "30",
    decodedEnvValue: 30,
  },
  {
    name: "a top-level auth value",
    key: registered("auth.site_url"),
    base: '[auth]\nsite_url = "https://base.example"\n',
    remote: '[remotes.staging.auth]\nsite_url = "https://remote.example"\n',
    remoteValue: "https://remote.example",
    envValue: "https://env.example",
    decodedEnvValue: "https://env.example",
  },
  {
    name: "an external provider field",
    key: familyKey("authExternal", "github", "client_id"),
    base: '[auth.external.github]\nenabled = true\nclient_id = "base-id"\nsecret = "env(GITHUB_SECRET)"\n',
    remote:
      '[remotes.staging.auth.external.github]\nenabled = true\nclient_id = "remote-id"\nsecret = "env(GITHUB_SECRET)"\n',
    remoteValue: "remote-id",
    envValue: "env-id",
    decodedEnvValue: "env-id",
  },
  {
    name: "an email template field",
    key: familyKey("authEmailTemplate", "invite", "subject"),
    optional: true,
    base: '[auth.email.template.invite]\nsubject = "Base"\n',
    remote: '[remotes.staging.auth.email.template.invite]\nsubject = "Remote"\n',
    remoteValue: "Remote",
    envValue: "Env",
    decodedEnvValue: "Env",
  },
  {
    name: "an email notification field",
    key: familyKey("authEmailNotification", "password_changed", "subject"),
    optional: true,
    base: '[auth.email.notification.password_changed]\nenabled = true\nsubject = "Base"\n',
    remote:
      '[remotes.staging.auth.email.notification.password_changed]\nenabled = true\nsubject = "Remote"\n',
    remoteValue: "Remote",
    envValue: "Env",
    decodedEnvValue: "Env",
  },
  {
    name: "a hook field",
    key: familyKey("authHook", "send_email", "uri"),
    base: '[auth.hook.send_email]\nenabled = true\nuri = "https://base.example/hook"\n',
    remote:
      '[remotes.staging.auth.hook.send_email]\nenabled = true\nuri = "https://remote.example/hook"\n',
    remoteValue: "https://remote.example/hook",
    envValue: "https://env.example/hook",
    decodedEnvValue: "https://env.example/hook",
  },
];

const expected = (scenario: Scenario, value: unknown) =>
  scenario.optional === true ? Option.some(value) : value;

const readKey = (scenario: Scenario, shell: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const root = yield* createStackConfigProject(
      `project_id = "base"\n${scenario.base}\n[remotes.staging]\nproject_id = "${LINKED}"\n${scenario.remote}`,
      { prefix: "supabase-cli-remote-precedence-", supabaseEnv: "GITHUB_SECRET=g\n" },
    );
    const layer = configValuesLayer({ env: shell });
    const resolvedConfig = yield* CliConfigValues.use((values) =>
      values.load({ workdir: root, projectRef: Option.some(LINKED) }),
    ).pipe(Effect.provide(layer));
    return yield* resolvedConfig.get(scenario.key);
  }).pipe(Effect.provide(BunServices.layer), Effect.scoped);

describe("CliConfigValues env versus a matched remote", () => {
  for (const scenario of scenarios) {
    const envName = scenario.key.env[0];
    if (envName === undefined) throw new Error(`${scenario.name} has no env name`);

    it.live(`takes the matched remote for ${scenario.name} until its env override is set`, () =>
      Effect.gen(function* () {
        const withoutEnv = yield* readKey(scenario, {});
        expect(withoutEnv.value).toEqual(expected(scenario, scenario.remoteValue));
        expect(withoutEnv.origin).toMatchObject({ tier: "config", remote: "staging" });

        const withEnv = yield* readKey(scenario, { [envName]: scenario.envValue });
        expect(withEnv.value).toEqual(expected(scenario, scenario.decodedEnvValue));
        expect(withEnv.origin).toMatchObject({ tier: "shell", envName });
      }),
    );
  }
});
