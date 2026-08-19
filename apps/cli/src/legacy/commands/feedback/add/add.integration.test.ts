import { describe, expect, it } from "@effect/vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Stdio } from "effect";
import type { FeedbackSubmission } from "../../../../shared/feedback/feedback-client.service.ts";
import {
  FeedbackBackendError,
  FeedbackClient,
} from "../../../../shared/feedback/feedback-client.service.ts";
import { LegacyAgentFlag, LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { AiTool } from "../../../../shared/telemetry/ai-tool.service.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
} from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyInvalidOutputFormatMessage } from "../../../shared/legacy-go-output-flag.ts";
import { LEGACY_FEEDBACK_OUTPUT_FORMATS } from "../feedback-output.ts";
import { legacyFeedbackAddHandler } from "./add.command.ts";
import { LEGACY_FEEDBACK_EMPTY_MESSAGE, legacyFeedbackTooLongMessage } from "./add.errors.ts";
import { legacyFeedbackAdd } from "./add.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-feedback-add-int-");

// Seeds `<workdir>/supabase/.temp/project-ref`, the file `supabase link` writes.
// Passing `asDirectory` creates the path as a directory instead, which makes the
// read fail with a non-NotFound error (the "broken ref file" degradation path).
function writeLinkedProjectRef(workdir: string, ref: string, opts: { asDirectory?: boolean } = {}) {
  const tempDir = join(workdir, "supabase", ".temp");
  mkdirSync(tempDir, { recursive: true });
  const refPath = join(tempDir, "project-ref");
  if (opts.asDirectory === true) {
    mkdirSync(refPath, { recursive: true });
    return;
  }
  writeFileSync(refPath, `${ref}\n`);
}

const MOCK_DELETE_TOKEN = "123e4567-e89b-12d3-a456-426614174000";

function mockFeedbackClient(opts: { failWith?: string } = {}) {
  const submissions: FeedbackSubmission[] = [];
  return {
    layer: Layer.succeed(
      FeedbackClient,
      FeedbackClient.of({
        submit: (submission) =>
          opts.failWith !== undefined
            ? Effect.fail(new FeedbackBackendError({ message: opts.failWith, operation: "submit" }))
            : Effect.sync(() => {
                submissions.push(submission);
                return { deleteToken: MOCK_DELETE_TOKEN };
              }),
        // `feedback add` never previews or deletes.
        preview: () => Effect.die("preview is not reachable from feedback add"),
        delete: () => Effect.die("delete is not reachable from feedback add"),
      }),
    ),
    submissions,
  };
}

function mockAiTool(agentName?: string) {
  return Layer.succeed(
    AiTool,
    AiTool.of({ name: agentName === undefined ? Option.none() : Option.some(agentName) }),
  );
}

function setupLegacyFeedback(
  opts: {
    output?: Parameters<typeof mockOutput>[0];
    stdinIsTTY?: boolean;
    pipedInput?: string;
    agentName?: string;
    agentFlag?: "auto" | "yes" | "no";
    /** Simulates the Go-compat `-o`/`--output` global flag. */
    goOutput?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
    submitFailWith?: string;
    /** Simulates `SUPABASE_PROJECT_ID`, the only source `LegacyCliConfig` reads. */
    projectIdEnv?: string;
    /** Simulates the gotrue user id persisted to telemetry.json at login. */
    distinctId?: string;
    consent?: "granted" | "denied";
  } = {},
) {
  const out = mockOutput(opts.output);
  const submitter = mockFeedbackClient(
    opts.submitFailWith === undefined ? {} : { failWith: opts.submitFailWith },
  );
  const telemetryState = mockLegacyTelemetryStateTracked();
  const layer = Layer.mergeAll(
    out.layer,
    submitter.layer,
    telemetryState.layer,
    mockStdin(opts.stdinIsTTY ?? true, opts.pipedInput),
    mockRuntimeInfo({ platform: "darwin", arch: "arm64" }),
    mockTelemetryRuntime({
      cliVersion: "9.9.9",
      distinctId: opts.distinctId,
      consent: opts.consent,
    }),
    mockLegacyCliConfig({
      workdir: tempRoot.current,
      userAgent: "SupabaseCLI/9.9.9",
      projectId: opts.projectIdEnv === undefined ? Option.none() : Option.some(opts.projectIdEnv),
    }),
    mockAiTool(opts.agentName),
    Layer.succeed(LegacyAgentFlag, opts.agentFlag ?? "auto"),
    Layer.succeed(LegacyOutputFlag, Option.fromNullishOr(opts.goOutput)),
    // Real filesystem: the handler reads `supabase/.temp/project-ref` from the
    // temp workdir, so this must not be stubbed out.
    BunServices.layer,
  );
  return { layer, out, submitter, telemetryState };
}

// Extra layers required by the wrapped `legacyFeedbackAddHandler` (the exact
// wiring `Command.withHandler` uses): instrumentation + json error handling.
function setupLegacyFeedbackHandler(
  opts: Parameters<typeof setupLegacyFeedback>[0] & { args?: ReadonlyArray<string> } = {},
) {
  const base = setupLegacyFeedback(opts);
  const analytics = mockContextualAnalytics();
  const processControl = mockProcessControl();
  const layer = Layer.mergeAll(
    base.layer,
    analytics.layer,
    processControl.layer,
    commandRuntimeLayer(["feedback", "add"]),
    Stdio.layerTest({ args: Effect.succeed([...(opts.args ?? ["feedback", "add"])]) }),
  );
  return { ...base, layer, analytics, processControl };
}

describe("legacy feedback add", () => {
  it.live("submits a quoted message with CLI version, os, and arch attached", () => {
    const { layer, out, submitter, telemetryState } = setupLegacyFeedback();
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["port conflicts when running two stacks"] });

      expect(submitter.submissions).toEqual([
        {
          message: "port conflicts when running two stacks",
          context: {
            cliVersion: "9.9.9",
            userAgent: "SupabaseCLI/9.9.9",
            os: "darwin",
            arch: "arm64",
            isAgent: false,
          },
        },
      ]);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Thanks for the feedback!" }),
      );
      // The delete token is shown exactly once, at submit time — the user must
      // keep it to delete the feedback later.
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: `To delete this feedback later, run: supabase feedback delete ${MOCK_DELETE_TOKEN}`,
        }),
      );
      // telemetry.json is refreshed on every invocation, like every other
      // legacy command's PersistentPostRun-shaped finalizer.
      expect(telemetryState.flushCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("joins bare words into a single message", () => {
    const { layer, submitter } = setupLegacyFeedback();
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["ports", "conflict", "a", "lot"] });

      expect(submitter.submissions[0]?.message).toBe("ports conflict a lot");
    }).pipe(Effect.provide(layer));
  });

  it.live("marks the submission as agent feedback when an AI tool is detected", () => {
    const { layer, submitter } = setupLegacyFeedback({ agentName: "claude_code" });
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["agents need --yes everywhere"] });

      expect(submitter.submissions[0]?.context.isAgent).toBe(true);
      expect(submitter.submissions[0]?.context.agentName).toBe("claude_code");
    }).pipe(Effect.provide(layer));
  });

  it.live("suppresses agent metadata when --agent no overrides a detected tool", () => {
    const { layer, submitter } = setupLegacyFeedback({
      agentName: "claude_code",
      agentFlag: "no",
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["human at the keyboard"] });

      expect(submitter.submissions[0]?.context.isAgent).toBe(false);
      // The name is suppressed too — an `is_agent: false` payload must not
      // carry a contradictory `agent_name`.
      expect(submitter.submissions[0]?.context.agentName).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("marks the submission as agent feedback when --agent yes forces it", () => {
    const { layer, submitter } = setupLegacyFeedback({ agentFlag: "yes" });
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["undetected agent"] });

      expect(submitter.submissions[0]?.context.isAgent).toBe(true);
      expect(submitter.submissions[0]?.context.agentName).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("attaches the linked project ref written by supabase link", () => {
    const { layer, submitter } = setupLegacyFeedback();
    writeLinkedProjectRef(tempRoot.current, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["linked project feedback"] });

      expect(submitter.submissions[0]?.projectRef).toBe(LEGACY_VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("prefers SUPABASE_PROJECT_ID over the linked ref file", () => {
    const { layer, submitter } = setupLegacyFeedback({ projectIdEnv: "envenvenvenvenvenvre" });
    writeLinkedProjectRef(tempRoot.current, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["env override feedback"] });

      expect(submitter.submissions[0]?.projectRef).toBe("envenvenvenvenvenvre");
    }).pipe(Effect.provide(layer));
  });

  it.live("attaches the persisted gotrue user id when logged in", () => {
    const { layer, submitter } = setupLegacyFeedback({
      distinctId: "11111111-2222-3333-4444-555555555555",
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["logged in feedback"] });

      expect(submitter.submissions[0]?.userId).toBe("11111111-2222-3333-4444-555555555555");
    }).pipe(Effect.provide(layer));
  });

  it.live("sends no user id when not logged in", () => {
    const { layer, submitter } = setupLegacyFeedback();
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["logged out feedback"] });

      expect(submitter.submissions[0]?.userId).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("sends no user id when telemetry consent is denied", () => {
    // Submit-side attribution is consent-gated: opted-out users submit
    // anonymously even when a persisted gotrue id exists.
    const { layer, submitter } = setupLegacyFeedback({
      distinctId: "11111111-2222-3333-4444-555555555555",
      consent: "denied",
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["opted out feedback"] });

      expect(submitter.submissions[0]?.userId).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("sends no project ref when the workdir is not linked", () => {
    const { layer, submitter } = setupLegacyFeedback();
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["unlinked feedback"] });

      expect(submitter.submissions[0]?.projectRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("still submits when the linked ref file cannot be read", () => {
    // A broken ref file must not block feedback — it degrades to "unlinked".
    const { layer, out, submitter } = setupLegacyFeedback();
    writeLinkedProjectRef(tempRoot.current, LEGACY_VALID_REF, { asDirectory: true });
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["broken ref file feedback"] });

      expect(submitter.submissions[0]?.projectRef).toBeUndefined();
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Thanks for the feedback!" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reads the message from piped stdin when no argument is given", () => {
    const { layer, submitter } = setupLegacyFeedback({
      stdinIsTTY: false,
      pipedInput: "piped feedback\n",
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: [] });

      expect(submitter.submissions[0]?.message).toBe("piped feedback");
    }).pipe(Effect.provide(layer));
  });

  it.live("prompts for the message on an interactive terminal", () => {
    const { layer, submitter } = setupLegacyFeedback({
      output: { interactive: true, promptTextResponses: ["typed feedback"] },
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: [] });

      expect(submitter.submissions[0]?.message).toBe("typed feedback");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not prompt when piped stdin is exhausted, even with a TTY stdout", () => {
    // `printf ' ' | supabase feedback add` in a terminal: stdout is a TTY (so
    // `output.interactive` is true) but stdin is a drained pipe the prompt
    // cannot read from. This must fail like the non-interactive case instead
    // of opening a prompt against exhausted stdin.
    const { layer, submitter } = setupLegacyFeedback({
      output: { interactive: true, promptTextResponses: ["never read"] },
      stdinIsTTY: false,
      pipedInput: "   \n",
    });
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackAdd({ message: [] }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "LegacyFeedbackEmptyMessageError",
        message: LEGACY_FEEDBACK_EMPTY_MESSAGE,
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails without prompting when stdout is not interactive, even on a TTY stdin", () => {
    // `supabase feedback add > out.txt` in a terminal: stdin is a TTY but
    // stdout is redirected, so the text layer reports interactive: false and
    // there is nowhere to render a prompt.
    const { layer, submitter } = setupLegacyFeedback({ output: { interactive: false } });
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackAdd({ message: [] }).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "LegacyFeedbackEmptyMessageError" });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a helpful error when there is no message anywhere", () => {
    // Whitespace-only args and whitespace-only pipe both fall through; a
    // non-interactive terminal leaves nothing left to ask.
    const { layer, submitter } = setupLegacyFeedback({
      output: { interactive: false },
      stdinIsTTY: false,
      pipedInput: "   \n",
    });
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackAdd({ message: [" ", ""] }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "LegacyFeedbackEmptyMessageError",
        message: LEGACY_FEEDBACK_EMPTY_MESSAGE,
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a message over the 1000 character limit before any request", () => {
    const { layer, submitter } = setupLegacyFeedback();
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackAdd({ message: ["x".repeat(1001)] }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "LegacyFeedbackMessageTooLongError",
        message: legacyFeedbackTooLongMessage(1001),
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts a message at exactly the limit, counted in code points", () => {
    // 1000 astral-plane characters are 2000 UTF-16 units; Postgres
    // `char_length` counts code points, so the client-side check must too or
    // it would reject a message the server accepts.
    const message = "🦆".repeat(1000);
    const { layer, submitter } = setupLegacyFeedback();
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: [message] });

      expect(submitter.submissions).toHaveLength(1);
      expect(submitter.submissions[0]?.message).toBe(message);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the delete token in the json acknowledgement", () => {
    const { layer, out, submitter } = setupLegacyFeedback({ output: { format: "json" } });
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["json mode feedback"] });

      expect(submitter.submissions).toHaveLength(1);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Thanks for the feedback!",
          data: { delete_token: MOCK_DELETE_TOKEN },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits only the machine payload on stdout with -o json", () => {
    const { layer, out, submitter } = setupLegacyFeedback({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyFeedbackAdd({ message: ["go machine format feedback"] });

      expect(submitter.submissions).toHaveLength(1);
      expect(out.rawChunks).toHaveLength(1);
      expect(out.rawChunks[0]?.stream).toBe("stdout");
      expect(JSON.parse(out.rawChunks[0]!.text)).toEqual({ delete_token: MOCK_DELETE_TOKEN });
      // No human-readable acknowledgement — stdout is payload-only.
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "success" }));
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "info" }));
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects an -o value outside feedback's pretty|json enum", () => {
    const { layer, submitter } = setupLegacyFeedbackHandler({
      goOutput: "yaml",
      args: ["feedback", "add", "doomed", "--output", "yaml"],
    });
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackAddHandler({ message: ["doomed"] }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "LegacyInvalidOutputFormatError",
        message: legacyInvalidOutputFormatMessage("yaml", LEGACY_FEEDBACK_OUTPUT_FORMATS),
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a json error and exit code 1 when the message is missing in json mode", () => {
    const { layer, out, submitter, processControl } = setupLegacyFeedbackHandler({
      output: { format: "json" },
      stdinIsTTY: false,
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackAddHandler({ message: [] });

      expect(submitter.submissions).toHaveLength(0);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "fail", message: LEGACY_FEEDBACK_EMPTY_MESSAGE }),
      );
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a submitter failure", () => {
    const { layer, out, telemetryState } = setupLegacyFeedback({
      submitFailWith: "backend unavailable",
    });
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackAdd({ message: ["doomed message"] }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackBackendError",
        message: "backend unavailable",
      });
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "success" }));
      // The finalizer runs on failure too, matching Go's PersistentPostRun.
      expect(telemetryState.flushCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("never sends the feedback message content to PostHog", () => {
    const { layer, analytics, submitter } = setupLegacyFeedbackHandler({
      args: ["feedback", "add", "my", "secret", "papercut", "--debug"],
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackAddHandler({ message: ["my", "secret", "papercut"] });

      expect(submitter.submissions[0]?.message).toBe("my secret papercut");
      const events = analytics.captured.filter((c) => c.event === "cli_command_executed");
      expect(events).toHaveLength(1);
      const serialized = JSON.stringify(events[0]);
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("papercut");
      // Only the flag name survives into the event; positionals are
      // structurally excluded from the flags map.
      expect(Object.keys(events[0]?.properties.flags ?? {})).toEqual(["debug"]);
    }).pipe(Effect.provide(layer));
  });
});
