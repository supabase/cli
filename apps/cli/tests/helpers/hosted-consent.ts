import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import type { Command } from "effect/cli";

import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "../../src/command-internal/hosted-consent/hosted-consent.errors.ts";
import { YesFlag } from "../../src/command-internal/global-flags.ts";
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
  Layer.mergeAll(runtime, Layer.succeed(YesFlag, yes), Layer.succeed(TargetPolicy, policy));

/** Everything a leaf's handler can require while `describeHostedConsent` runs it. */
type HostedConsentServices = Layer.Success<ReturnType<typeof consentLayer>>;

interface HostedConsentEnv {
  readonly workdir: string;
  readonly out: ReturnType<typeof mockOutput>;
  readonly api: ReturnType<typeof mockCommandPlatformApi>;
}

interface HostedConsentInvocation {
  readonly run: Effect.Effect<unknown, unknown, HostedConsentServices>;
  /** Persistent writes made so far; defaults to the non-GET requests the mocked platform API recorded. */
  readonly mutations?: () => number;
}

export interface HostedConsentScenario {
  /** Resolve the policy from this command instead of looking `path` up in the CLI tree. */
  readonly command?: Command.Command.Any;
  /** The leaf asks for a typed confirmation instead of a yes/no prompt. */
  readonly typed?: boolean;
  readonly api?: MockCommandPlatformApiOpts;
  readonly setup?: (workdir: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>;
  /** Builds the leaf's handler call; runs once per case, so per-case state can live in its closure. */
  readonly invoke: (env: HostedConsentEnv) => HostedConsentInvocation;
}

interface CaseOptions {
  readonly json: boolean;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly shellYes?: boolean;
  readonly projectEnvYes?: boolean;
  readonly stdinInput?: string;
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

const writeProjectEnv = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
    yield* fs.writeFileString(path.join(workdir, "supabase", ".env"), "SUPABASE_YES=1\n");
  }).pipe(Effect.provide(BunServices.layer));

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
 * Runs the hosted-consent matrix against the leaf at `path`: no consent without `--yes` in
 * JSON or piped text, a TTY decline, `--yes`, shell `SUPABASE_YES`, and a project `.env`
 * that must not count as consent.
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
          stdin: mockStdin(stdinIsTty, options.stdinInput),
          outputFlag: options.json ? Option.some("json") : Option.none(),
          cliArgs: options.yes === true ? ["--yes"] : [],
        });
        const layer = consentLayer(runtime, options.yes ?? false, policy);

        if (scenario.setup !== undefined) {
          yield* scenario.setup(workdir).pipe(Effect.provide(BunServices.layer));
        }
        if (options.projectEnvYes === true) yield* writeProjectEnv(workdir);

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

    it.effect("refuses JSON output without --yes and changes nothing", () =>
      Effect.gen(function* () {
        const { exit, mutations } = yield* runCase({ json: true });
        expect(failureOf(exit)).toBeInstanceOf(HostedMutationConsentRequiredError);
        expect(mutations).toBe(0);
      }),
    );

    it.effect("ignores an answer piped to stdin in text mode and changes nothing", () =>
      Effect.gen(function* () {
        const { exit, out, mutations } = yield* runCase({ json: false, stdinInput: "y\n" });
        expect(failureOf(exit)).toBeInstanceOf(HostedMutationConsentRequiredError);
        expect(out.promptConfirmCalls).toEqual([]);
        expect(mutations).toBe(0);
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

    it.effect("runs under --yes, echoes the confirmation, and shows the target banner", () =>
      Effect.gen(function* () {
        const { exit, out, mutations } = yield* runCase({ json: true, yes: true });
        expectSuccess(exit);
        expect(mutations).toBeGreaterThan(0);
        expect(out.stderrText).toContain("Confirmed by --yes: ");
        expect(out.stderrText).toContain("Target: ");
      }),
    );

    it.effect("runs under a shell SUPABASE_YES", () =>
      Effect.gen(function* () {
        const { exit, mutations } = yield* runCase({ json: true, shellYes: true });
        expectSuccess(exit);
        expect(mutations).toBeGreaterThan(0);
      }),
    );

    it.effect("does not treat SUPABASE_YES in supabase/.env as consent", () =>
      Effect.gen(function* () {
        const { exit, mutations } = yield* runCase({ json: true, projectEnvYes: true });
        expect(failureOf(exit)).toBeInstanceOf(HostedMutationConsentRequiredError);
        expect(mutations).toBe(0);
      }),
    );
  });
}
