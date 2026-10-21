import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Redacted } from "effect";

import {
  mockCommandSettings,
  withConfigEnv,
  withEmptyConfigEnv,
} from "../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockRuntimeInfo, mockTty } from "../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { commandTargetLayer } from "../../shared/output/command-target.layer.ts";
import {
  announceTarget,
  type CommandTargetJson,
} from "../../shared/output/command-target.service.ts";
import type { OutputFormat } from "../../shared/output/types.ts";
import { AiTool } from "../../shared/telemetry/ai-tool.service.ts";
import { classifyCliErrorActionability } from "../../shared/telemetry/error-actionability.ts";
import type { ResolvedDbConfig } from "../db-config.types.ts";
import { AgentFlag, OutputFlag, YesFlag } from "../global-flags.ts";
import type { ResolvedTarget } from "../target/resolve-target.ts";
import { TargetPolicy } from "../target/target-policy.ts";
import type { TargetPolicyShape } from "../target/target-policy.ts";
import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "./hosted-consent.errors.ts";
import {
  hostedMutationPreapproval,
  requireHostedMutationConsent,
  requireTargetMutationConsent,
} from "./hosted-consent.ts";
import type { HostedMutationRequest } from "./hosted-consent.ts";

type OutputFlagValue = "pretty" | "json" | "yaml" | "toml" | "env" | "table" | "csv";

interface Scenario {
  readonly policy?: TargetPolicyShape;
  readonly format?: OutputFormat;
  readonly interactive?: boolean;
  readonly stdinIsTty?: boolean;
  readonly yes?: boolean;
  readonly args?: ReadonlyArray<string>;
  readonly outputFlag?: OutputFlagValue;
  readonly confirmResponses?: ReadonlyArray<boolean>;
  readonly textResponses?: ReadonlyArray<string>;
  readonly promptFails?: boolean;
  readonly shellYes?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly announced?: string;
  readonly agent?: "auto" | "yes" | "no";
  readonly aiTool?: string;
  readonly cwd?: string;
  readonly workdir?: string;
  readonly withoutFilesystem?: boolean;
}

const REQUEST: HostedMutationRequest = {
  action: "Apply 3 migrations",
  details: ["  20240101_a.sql", "  20240102_b.sql"],
};

const UNVERIFIED_JSON: CommandTargetJson = {
  kind: "linked",
  project_ref: "abcdefghijklmnopqrst",
  environment: "unverified",
};

const interactiveTerminal: Scenario = { format: "text", interactive: true, stdinIsTty: true };

const harness = (scenario: Scenario) => {
  const out = mockOutput({
    format: scenario.format ?? "text",
    interactive: scenario.interactive,
    promptConfirmResponses: scenario.confirmResponses,
    promptTextResponses: scenario.textResponses,
    promptConfirmFail: scenario.promptFails,
  });
  const layer = Layer.mergeAll(
    out.layer,
    commandTargetLayer.pipe(Layer.provide(out.layer)),
    mockTty({
      stdinIsTty: scenario.stdinIsTty ?? false,
      stdoutIsTty: scenario.stdinIsTty ?? false,
    }),
    Layer.succeed(YesFlag, scenario.yes ?? false),
    Layer.succeed(CliArgs, { args: scenario.args ?? [] }),
    Layer.succeed(
      OutputFlag,
      scenario.outputFlag === undefined ? Option.none() : Option.some(scenario.outputFlag),
    ),
    Layer.succeed(TargetPolicy, scenario.policy ?? { group: "hosted", consent: "no" }),
    scenario.agent === undefined ? Layer.empty : Layer.succeed(AgentFlag, scenario.agent),
    scenario.aiTool === undefined
      ? Layer.empty
      : Layer.succeed(AiTool, { name: Option.some(scenario.aiTool) }),
    scenario.withoutFilesystem === true
      ? Layer.empty
      : Layer.merge(BunServices.layer, mockRuntimeInfo({ cwd: scenario.cwd ?? "/test/project" })),
    scenario.workdir === undefined
      ? Layer.empty
      : mockCommandSettings({ workdir: scenario.workdir }),
  );
  const shellEnv = {
    NODE_ENV: "",
    ...(scenario.shellYes === undefined ? {} : { SUPABASE_YES: scenario.shellYes }),
    ...scenario.env,
  };
  const withShellEnv = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    withEmptyConfigEnv(withConfigEnv(shellEnv, body));
  const prepare = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    withShellEnv(
      (scenario.announced === undefined
        ? body
        : Effect.flatMap(
            announceTarget({ text: scenario.announced, json: UNVERIFIED_JSON }),
            () => body,
          )
      ).pipe(Effect.provide(layer)),
    );
  return { out, prepare };
};

const consent = (scenario: Scenario, request: HostedMutationRequest = REQUEST) => {
  const { out, prepare } = harness(scenario);
  const exit = prepare(requireHostedMutationConsent(request)).pipe(Effect.exit);
  return { out, exit };
};

const successOf = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`);
  return exit.value;
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  const failure = Exit.findErrorOption(exit);
  if (Option.isNone(failure))
    throw new Error(`expected a typed failure, got ${Cause.pretty(exit.cause)}`);
  return failure.value;
};

describe("requireHostedMutationConsent", () => {
  describe("default answer", () => {
    it.effect.each([
      { consent: "no", expected: false },
      { consent: "yes", expected: true },
    ] as const)(
      "offers $expected as the default when the policy says $consent",
      ({ consent: policyConsent, expected }) =>
        Effect.gen(function* () {
          const run = consent({
            ...interactiveTerminal,
            policy: { group: "hosted", consent: policyConsent },
            confirmResponses: [true],
          });
          yield* run.exit;
          expect(run.out.promptConfirmCalls).toEqual([
            { message: "Apply 3 migrations?", opts: { defaultValue: expected } },
          ]);
        }),
    );

    it.effect("dies when the command declares no consent", () =>
      Effect.gen(function* () {
        const exit = yield* consent({
          ...interactiveTerminal,
          policy: { group: "hosted", consent: "none" },
        }).exit;
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      }),
    );
  });

  describe("--yes", () => {
    it.effect("grants without asking and echoes the action and target on stderr", () =>
      Effect.gen(function* () {
        const run = consent({
          yes: true,
          format: "json",
          announced: "project abcdefghijklmnopqrst",
        });
        const token = successOf(yield* run.exit);
        expect(token).toMatchObject({ action: "Apply 3 migrations", via: "yes" });
        expect(run.out.promptConfirmCalls).toEqual([]);
        expect(run.out.stderrText).toContain(
          "Confirmed by --yes: Apply 3 migrations on project abcdefghijklmnopqrst\n",
        );
      }),
    );

    it.effect("omits the target when nothing was announced", () =>
      Effect.gen(function* () {
        const run = consent({ yes: true });
        yield* run.exit;
        expect(run.out.stderrText).toBe("Confirmed by --yes: Apply 3 migrations\n");
      }),
    );

    it.effect("skips a typed confirmation", () =>
      Effect.gen(function* () {
        const run = consent(
          { ...interactiveTerminal, yes: true },
          { action: "delete compute api", confirm: { kind: "typed", expected: "api" } },
        );
        const token = successOf(yield* run.exit);
        expect(token.via).toBe("yes");
        expect(run.out.promptTextCalls).toEqual([]);
      }),
    );

    it.effect("is overridden by an explicit --yes=false even when SUPABASE_YES is set", () =>
      Effect.gen(function* () {
        const exit = yield* consent({ args: ["--yes=false"], shellYes: "1" }).exit;
        expect(failureOf(exit)).toBeInstanceOf(HostedMutationConsentRequiredError);
      }),
    );
  });

  describe("SUPABASE_YES", () => {
    const withDotenvDir = <A, E, R>(
      files: Readonly<Record<string, string>>,
      body: (dir: string) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-consent-" });
        for (const [name, contents] of Object.entries(files)) {
          yield* fs.makeDirectory(path.dirname(path.join(dir, name)), { recursive: true });
          yield* fs.writeFileString(path.join(dir, name), contents);
        }
        return yield* body(dir);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

    it.effect(
      "grants when set in the shell environment and echoes SUPABASE_YES as the source",
      () =>
        Effect.gen(function* () {
          const run = consent({ shellYes: "1", format: "json" });
          const token = successOf(yield* run.exit);
          expect(token.via).toBe("yes");
          expect(run.out.stderrText).toContain("Confirmed by SUPABASE_YES: Apply 3 migrations");
        }),
    );

    it.effect("does not grant when it is only in the project .env", () =>
      withDotenvDir({ "supabase/.env": "SUPABASE_YES=1\n" }, (dir) =>
        Effect.gen(function* () {
          const exit = yield* consent({ cwd: dir, workdir: dir }).exit;
          expect(failureOf(exit)).toBeInstanceOf(HostedMutationConsentRequiredError);
        }),
      ),
    );

    it.effect.each([".env", ".env.local", ".env.development", ".env.development.local"])(
      "does not grant a shell value that matches %s in the working directory",
      (name) =>
        withDotenvDir({ [name]: "SUPABASE_YES=1\n" }, (cwd) =>
          Effect.gen(function* () {
            const exit = yield* consent({ shellYes: "1", cwd }).exit;
            expect(failureOf(exit)).toBeInstanceOf(HostedMutationConsentRequiredError);
          }),
        ),
    );

    it.effect("checks the dotenv files NODE_ENV selects", () =>
      withDotenvDir({ ".env.production": "SUPABASE_YES=1\n" }, (cwd) =>
        Effect.gen(function* () {
          const production = yield* consent({
            shellYes: "1",
            cwd,
            env: { NODE_ENV: "production" },
          }).exit;
          expect(failureOf(production)).toBeInstanceOf(HostedMutationConsentRequiredError);
          const development = yield* consent({ shellYes: "1", cwd }).exit;
          expect(successOf(development).via).toBe("yes");
        }),
      ),
    );

    it.effect.each([
      { name: "a different value", contents: "SUPABASE_YES=true\n" },
      { name: "an inline comment Bun strips", contents: "SUPABASE_YES=1#x\n" },
      { name: "an empty value", contents: "SUPABASE_YES=\n" },
    ])(
      "does not grant a shell value when the working directory's .env sets it with $name",
      ({ contents }) =>
        withDotenvDir({ ".env": contents }, (cwd) =>
          Effect.gen(function* () {
            const exit = yield* consent({ shellYes: "1", cwd }).exit;
            expect(failureOf(exit)).toBeInstanceOf(HostedMutationConsentRequiredError);
          }),
        ),
    );

    it.effect("grants when the working directory's dotenv files do not mention it", () =>
      withDotenvDir({ ".env": "OTHER=1\n" }, (cwd) =>
        Effect.gen(function* () {
          const exit = yield* consent({ shellYes: "1", cwd }).exit;
          expect(successOf(exit).via).toBe("yes");
        }),
      ),
    );

    it.effect("does not grant when a dotenv file that does not parse mentions it", () =>
      withDotenvDir({ ".env": "SUPABASE_YES=1\n!!!\n" }, (cwd) =>
        Effect.gen(function* () {
          const exit = yield* consent({ shellYes: "1", cwd }).exit;
          expect(failureOf(exit)).toBeInstanceOf(HostedMutationConsentRequiredError);
        }),
      ),
    );

    it.effect("does not grant when the filesystem cannot be checked", () =>
      Effect.gen(function* () {
        const exit = yield* consent({ shellYes: "1", withoutFilesystem: true }).exit;
        expect(failureOf(exit)).toBeInstanceOf(HostedMutationConsentRequiredError);
      }),
    );

    it.effect("still grants --yes when a working-directory .env sets the variable", () =>
      withDotenvDir({ ".env": "SUPABASE_YES=1\n" }, (cwd) =>
        Effect.gen(function* () {
          const run = consent({ yes: true, cwd });
          expect(successOf(yield* run.exit).via).toBe("yes");
          expect(run.out.stderrText).toContain("Confirmed by --yes: Apply 3 migrations");
        }),
      ),
    );
  });

  describe("when the run cannot prompt", () => {
    it.effect.each([
      {
        name: "json output",
        scenario: { format: "json", stdinIsTty: true },
        reason: "its output format is json",
      },
      {
        name: "stream-json output",
        scenario: { format: "stream-json", stdinIsTty: true },
        reason: "its output format is stream-json",
      },
      {
        name: "-o yaml in a terminal",
        scenario: { ...interactiveTerminal, outputFlag: "yaml" },
        reason: "it writes machine-readable -o yaml output",
      },
      {
        name: "-o json in a terminal",
        scenario: { ...interactiveTerminal, outputFlag: "json" },
        reason: "it writes machine-readable -o json output",
      },
      {
        name: "piped stdin carrying an affirmative answer",
        scenario: {
          format: "text",
          interactive: true,
          stdinIsTty: false,
          confirmResponses: [true],
        },
        reason: "stdin is not a terminal",
      },
      {
        name: "a non-interactive stdout",
        scenario: { format: "text", interactive: false, stdinIsTty: true },
        reason: "stdout is not a terminal",
      },
    ] as const satisfies ReadonlyArray<{ name: string; scenario: Scenario; reason: string }>)(
      "fails with ConsentRequiredError for $name and never asks",
      ({ scenario, reason }) =>
        Effect.gen(function* () {
          const run = consent({ ...scenario, announced: "project abcdefghijklmnopqrst" });
          const error = failureOf(yield* run.exit);
          expect(error).toBeInstanceOf(HostedMutationConsentRequiredError);
          expect(error).toMatchObject({
            message: `Confirmation required: Apply 3 migrations (target: project abcdefghijklmnopqrst). This run can't ask because ${reason}. Nothing was changed.`,
            suggestion: "Re-run with --yes to confirm.",
          });
          expect(run.out.promptConfirmCalls).toEqual([]);
          expect(run.out.promptTextCalls).toEqual([]);
        }),
    );

    it.effect("leaves the target out of the message when nothing was announced", () =>
      Effect.gen(function* () {
        const error = failureOf(yield* consent({ format: "json" }).exit);
        expect(error).toMatchObject({
          message:
            "Confirmation required: Apply 3 migrations. This run can't ask because its output format is json. Nothing was changed.",
        });
      }),
    );

    it.effect("fails with ConsentRequiredError when the prompt turns out to be unavailable", () =>
      Effect.gen(function* () {
        const error = failureOf(yield* consent({ ...interactiveTerminal, promptFails: true }).exit);
        expect(error).toBeInstanceOf(HostedMutationConsentRequiredError);
        expect(error).toMatchObject({
          message: expect.stringContaining("because no prompt is available"),
        });
      }),
    );

    it.effect("suggests --read-only when the command has a read-only mode", () =>
      Effect.gen(function* () {
        const error = failureOf(
          yield* consent({ format: "json" }, { ...REQUEST, readOnlyAlternative: true }).exit,
        );
        expect(error).toMatchObject({
          suggestion:
            "Re-run with --yes to confirm. For a read-only statement, pass --read-only instead.",
        });
      }),
    );

    it.effect("says a project .env SUPABASE_YES does not confirm hosted changes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-consent-" });
        yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(dir, "supabase", ".env"), "SUPABASE_YES=1\n");
        const error = failureOf(yield* consent({ format: "json", cwd: dir, workdir: dir }).exit);
        expect(error).toMatchObject({
          suggestion:
            "Re-run with --yes to confirm. SUPABASE_YES in supabase/.env does not confirm hosted changes; pass --yes.",
        });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("says a working-directory .env SUPABASE_YES does not confirm hosted changes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-consent-" });
        yield* fs.writeFileString(path.join(dir, ".env"), "SUPABASE_YES=1\n");
        const error = failureOf(yield* consent({ format: "json", shellYes: "1", cwd: dir }).exit);
        expect(error).toMatchObject({
          suggestion:
            "Re-run with --yes to confirm. SUPABASE_YES in .env does not confirm hosted changes; pass --yes.",
        });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("agents", () => {
    it.effect.each([
      { name: "--agent yes", scenario: { agent: "yes" } },
      { name: "a detected agent", scenario: { agent: "auto", aiTool: "claude_code" } },
    ] as const satisfies ReadonlyArray<{ name: string; scenario: Scenario }>)(
      "refuses to prompt for $name in an interactive terminal",
      ({ scenario }) =>
        Effect.gen(function* () {
          const run = consent({ ...interactiveTerminal, ...scenario, confirmResponses: [true] });
          const error = failureOf(yield* run.exit);
          expect(error).toBeInstanceOf(HostedMutationConsentRequiredError);
          expect(error).toMatchObject({
            message: expect.stringContaining("because it is running in agent mode"),
            suggestion: "This is an agent run: ask the user before re-running with --yes.",
          });
          expect(run.out.promptConfirmCalls).toEqual([]);
        }),
    );

    it.effect("prompts when --agent no overrides a detected agent", () =>
      Effect.gen(function* () {
        const run = consent({
          ...interactiveTerminal,
          agent: "no",
          aiTool: "claude_code",
          confirmResponses: [true],
        });
        expect(successOf(yield* run.exit).via).toBe("prompt");
      }),
    );

    it.effect("grants --yes to an agent", () =>
      Effect.gen(function* () {
        const run = consent({ ...interactiveTerminal, yes: true, agent: "yes" });
        expect(successOf(yield* run.exit).via).toBe("yes");
      }),
    );
  });

  describe("in an interactive terminal", () => {
    it.effect("grants an accepted prompt and prints the details first", () =>
      Effect.gen(function* () {
        const run = consent({
          ...interactiveTerminal,
          confirmResponses: [true],
          announced: "project abcdefghijklmnopqrst",
        });
        const token = successOf(yield* run.exit);
        expect(token).toMatchObject({ action: "Apply 3 migrations", via: "prompt" });
        expect(run.out.stderrText).toBe(
          "Target: project abcdefghijklmnopqrst\n  20240101_a.sql\n  20240102_b.sql\n",
        );
        expect(run.out.promptConfirmCalls.map((call) => call.message)).toEqual([
          "Apply 3 migrations on project abcdefghijklmnopqrst?",
        ]);
      }),
    );

    it.effect("fails with DeclinedError when the answer is no", () =>
      Effect.gen(function* () {
        const run = consent({ ...interactiveTerminal, confirmResponses: [false] });
        const error = failureOf(yield* run.exit);
        expect(error).toBeInstanceOf(HostedMutationDeclinedError);
        expect(error).toMatchObject({ message: "context canceled" });
      }),
    );

    describe("typed confirmation", () => {
      const typed: HostedMutationRequest = {
        action: "delete compute api",
        details: ["This permanently deletes the compute."],
        confirm: { kind: "typed", expected: "api" },
      };

      it.effect("grants when the typed answer matches", () =>
        Effect.gen(function* () {
          const run = consent({ ...interactiveTerminal, textResponses: [" api "] }, typed);
          const token = successOf(yield* run.exit);
          expect(token.via).toBe("prompt");
          expect(run.out.promptTextCalls.map((call) => call.message)).toEqual([
            "Type api to confirm",
          ]);
          expect(run.out.promptConfirmCalls).toEqual([]);
          expect(run.out.stderrText).toBe(
            "This permanently deletes the compute.\ndelete compute api\n",
          );
        }),
      );

      it.effect("fails with DeclinedError when the typed answer differs", () =>
        Effect.gen(function* () {
          const run = consent({ ...interactiveTerminal, textResponses: ["apis"] }, typed);
          expect(failureOf(yield* run.exit)).toBeInstanceOf(HostedMutationDeclinedError);
        }),
      );
    });
  });

  it("classifies the errors for telemetry", () => {
    expect(
      classifyCliErrorActionability(
        new HostedMutationConsentRequiredError({ message: "m", suggestion: "s" }),
      ),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "consent_required",
      has_suggestion: true,
      suggestion_type: "provide_flags",
    });
    expect(
      classifyCliErrorActionability(new HostedMutationDeclinedError({ message: "m" })),
    ).toMatchObject({ error_kind: "user_cancelled", error_category: "cancelled" });
  });
});

describe("hostedMutationPreapproval", () => {
  const preapproval = (scenario: Scenario) => harness(scenario).prepare(hostedMutationPreapproval);

  it.effect("is Some under --yes", () =>
    Effect.gen(function* () {
      expect(Option.isSome(yield* preapproval({ yes: true }))).toBe(true);
    }),
  );

  it.effect("is Some under a shell SUPABASE_YES", () =>
    Effect.gen(function* () {
      expect(Option.isSome(yield* preapproval({ shellYes: "1" }))).toBe(true);
    }),
  );

  it.effect("is None in a terminal that could prompt", () =>
    Effect.gen(function* () {
      const { out, prepare } = harness({ ...interactiveTerminal, confirmResponses: [true] });
      expect(Option.isNone(yield* prepare(hostedMutationPreapproval))).toBe(true);
      expect(out.promptConfirmCalls).toEqual([]);
    }),
  );

  it.effect("is None under --yes=false", () =>
    Effect.gen(function* () {
      expect(Option.isNone(yield* preapproval({ args: ["--yes=false"], shellYes: "1" }))).toBe(
        true,
      );
    }),
  );

  it.effect("is None for a shell value that a working-directory .env also sets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-consent-" });
      yield* fs.writeFileString(path.join(cwd, ".env.local"), "SUPABASE_YES=1\n");
      expect(Option.isNone(yield* preapproval({ shellYes: "1", cwd }))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});

describe("requireTargetMutationConsent", () => {
  const dbConfig = (isLocal: boolean): ResolvedDbConfig => ({
    conn: {
      host: "db.example.com",
      port: 5432,
      user: "postgres",
      password: "",
      database: "postgres",
    },
    isLocal,
  });
  const linked: ResolvedTarget = {
    kind: "linked",
    ref: "abcdefghijklmnopqrst",
    source: "file",
    matchesLinkedRef: true,
  };

  const forTarget = (target: ResolvedTarget | ResolvedDbConfig, scenario: Scenario = {}) => {
    const { out, prepare } = harness(scenario);
    return { out, exit: prepare(requireTargetMutationConsent(target, REQUEST)).pipe(Effect.exit) };
  };

  it.effect.each([
    { name: "a local target", target: { kind: "local" } satisfies ResolvedTarget },
    { name: "a connection to the local stack", target: dbConfig(true) },
  ])("is None for $name without asking or echoing", ({ target }) =>
    Effect.gen(function* () {
      const run = forTarget(target, { ...interactiveTerminal, yes: true });
      const result = successOf(yield* run.exit);
      expect(Option.isNone(result)).toBe(true);
      expect(run.out.promptConfirmCalls).toEqual([]);
      expect(run.out.stderrText).toBe("");
    }),
  );

  it.effect.each([
    { name: "a linked target", target: linked },
    {
      name: "an unclassified --db-url target",
      target: {
        kind: "db-url",
        url: Redacted.make("postgresql://postgres:secret@db.example.com:5432/postgres"),
      } satisfies ResolvedTarget,
    },
    { name: "a connection to a hosted database", target: dbConfig(false) },
  ])("asks for $name", ({ target }) =>
    Effect.gen(function* () {
      const run = forTarget(target, { ...interactiveTerminal, confirmResponses: [true] });
      const result = successOf(yield* run.exit);
      expect(Option.map(result, (token) => token.via)).toEqual(Option.some("prompt"));
    }),
  );

  it.effect("fails for a hosted target in a run that cannot prompt", () =>
    Effect.gen(function* () {
      const error = failureOf(yield* forTarget(linked, { format: "json" }).exit);
      expect(error).toBeInstanceOf(HostedMutationConsentRequiredError);
    }),
  );
});
