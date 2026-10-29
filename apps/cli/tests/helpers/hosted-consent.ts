import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option } from "effect";
import type { Command } from "effect/cli";

import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "../../src/command-internal/hosted-consent/hosted-consent.errors.ts";
import { AgentFlag, YesFlag } from "../../src/command-internal/global-flags.ts";
import { TargetPolicy, readTargetPolicy } from "../../src/command-internal/target/target-policy.ts";
import type { TargetPolicyShape } from "../../src/command-internal/target/target-policy.ts";
import { commandTreeFor } from "./command-flags.ts";
import {
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
  withConfigEnv,
  withEmptyConfigEnv,
} from "./command-mocks.ts";
import type { MockCommandPlatformApiOpts } from "./command-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "./mocks.ts";

type RuntimeLayer = ReturnType<typeof buildTestRuntime>;

const consentLayer = (runtime: RuntimeLayer, yes: boolean, policy: TargetPolicyShape) =>
  Layer.mergeAll(
    runtime,
    Layer.succeed(YesFlag, yes),
    Layer.succeed(AgentFlag, "auto"),
    Layer.succeed(TargetPolicy, policy),
  );

/** Everything a leaf's handler can require while `describeHostedConsent` runs it. */
type HostedConsentServices = Layer.Success<ReturnType<typeof consentLayer>>;

interface HostedConsentEnv {
  readonly workdir: string;
  readonly out: ReturnType<typeof mockOutput>;
  readonly api: ReturnType<typeof mockCommandPlatformApi>;
}

interface HostedConsentInvocation {
  readonly run: Effect.Effect<unknown, unknown, HostedConsentServices>;
  /** Persistent writes so far; defaults to the non-GET requests the mocked API recorded. */
  readonly mutations?: () => number;
}

export interface HostedConsentScenario {
  /** Resolve the policy from this command instead of looking `path` up in the CLI tree. */
  readonly command?: Command.Command.Any;
  /** The leaf asks for a typed confirmation instead of a yes/no prompt. */
  readonly typed?: boolean;
  readonly api?: MockCommandPlatformApiOpts;
  readonly setup?: (workdir: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>;
  /** Builds the handler call; runs once per case, so per-case state can live in its closure. */
  readonly invoke: (env: HostedConsentEnv) => HostedConsentInvocation;
}

interface CaseOptions {
  readonly json: boolean;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly shellYes?: boolean;
  readonly confirmResponses?: ReadonlyArray<boolean>;
  readonly textResponses?: ReadonlyArray<string>;
}

const policyFor = (path: string, scenario: HostedConsentScenario): TargetPolicyShape => {
  const command = scenario.command ?? commandTreeFor(undefined).get(path)?.command;
  if (command === undefined) {
    throw new Error(`describeHostedConsent("${path}"): no such command in the CLI tree`);
  }
  const policy = readTargetPolicy(command);
  if (Option.isNone(policy)) {
    throw new Error(`describeHostedConsent("${path}"): the leaf declares no withTargetPolicy`);
  }
  if (policy.value.consent === "none") {
    throw new Error(
      `describeHostedConsent("${path}"): the leaf declares consent "none", so it has no consent to test`,
    );
  }
  return policy.value;
};

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Exit.findErrorOption(exit);
  return Option.isSome(failure) ? failure.value : Cause.pretty(exit.cause);
};

const expectSuccess = (exit: Exit.Exit<unknown, unknown>) => {
  expect(failureOf(exit), "the leaf should have run to completion").toBeUndefined();
};

const nonGetRequests = (api: HostedConsentEnv["api"]): number =>
  api.requests.filter((request) => request.method !== "GET").length;

/**
 * Runs the hosted-consent matrix against the leaf at `path`: JSON output without `--yes` is
 * refused, a TTY decline stops it, and `--yes` or a shell `SUPABASE_YES` lets it run.
 */
export function describeHostedConsent(path: string, scenario: HostedConsentScenario): void {
  const policy = policyFor(path, scenario);

  describe(`hosted consent: ${path}`, () => {
    const tempRoot = useTempWorkdir("supabase-hosted-consent-");

    const runCase = (options: CaseOptions) =>
      Effect.gen(function* () {
        const workdir = tempRoot.current;
        const out = mockOutput({
          format: options.json ? "json" : "text",
          interactive: options.interactive ?? false,
          promptConfirmResponses: options.confirmResponses,
          promptTextResponses: options.textResponses,
        });
        const api = mockCommandPlatformApi(scenario.api);
        const interactive = options.interactive ?? false;
        const stdinIsTty = interactive || options.json;
        const runtime = buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir }),
          tty: mockTty({ stdinIsTty, stdoutIsTty: interactive }),
          stdin: mockStdin(stdinIsTty),
          outputFlag: options.json ? Option.some("json") : Option.none(),
          cliArgs: options.yes === true ? ["--yes"] : [],
        });
        const layer = consentLayer(runtime, options.yes ?? false, policy);

        if (scenario.setup !== undefined) {
          yield* scenario.setup(workdir).pipe(Effect.provide(BunServices.layer));
        }

        const invocation = scenario.invoke({ workdir, out, api });
        const shellEnv = <A, E, R>(body: Effect.Effect<A, E, R>) =>
          options.shellYes === true
            ? withConfigEnv({ SUPABASE_YES: "1" }, body)
            : withEmptyConfigEnv(body);
        const exit = yield* shellEnv(invocation.run.pipe(Effect.provide(layer))).pipe(Effect.exit);
        return {
          exit,
          out,
          mutations: (invocation.mutations ?? (() => nonGetRequests(api)))(),
        };
      });

    it.effect("refuses JSON output without --yes, changes nothing and prints no payload", () =>
      Effect.gen(function* () {
        const { exit, out, mutations } = yield* runCase({ json: true });
        expect(failureOf(exit)).toBeInstanceOf(HostedMutationConsentRequiredError);
        expect(mutations).toBe(0);
        // Only Output.success reaches stdout and records a data key; task.succeed goes to stderr.
        expect(
          out.messages.filter((message) => message.type === "success" && "data" in message),
        ).toEqual([]);
        expect(out.stdoutText).toBe("");
      }),
    );

    it.effect("stops when the user declines at the prompt and changes nothing", () =>
      Effect.gen(function* () {
        const { exit, out, mutations } = yield* runCase({
          json: false,
          interactive: true,
          confirmResponses: [false],
          textResponses: ["no"],
        });
        expect(failureOf(exit)).toBeInstanceOf(HostedMutationDeclinedError);
        if (scenario.typed !== true) {
          expect(out.promptConfirmCalls[0]?.opts?.defaultValue).toBe(policy.consent === "yes");
        }
        expect(mutations).toBe(0);
      }),
    );

    it.effect(
      policy.group === "account"
        ? "runs under --yes and echoes the confirmation"
        : "runs under --yes, echoes the confirmation, and shows the target banner",
      () =>
        Effect.gen(function* () {
          const { exit, out, mutations } = yield* runCase({ json: true, yes: true });
          expectSuccess(exit);
          expect(mutations).toBeGreaterThan(0);
          expect(out.stderrText).toContain("Confirmed by --yes: ");
          if (policy.group === "account") {
            expect(out.stderrText).not.toContain("Target: ");
          } else {
            expect(out.stderrText).toContain("Target: ");
          }
        }),
    );

    it.effect("runs under a shell SUPABASE_YES and echoes it as the source", () =>
      Effect.gen(function* () {
        const { exit, out, mutations } = yield* runCase({ json: true, shellYes: true });
        expectSuccess(exit);
        expect(mutations).toBeGreaterThan(0);
        expect(out.stderrText).toContain("Confirmed by SUPABASE_YES: ");
      }),
    );
  });
}
