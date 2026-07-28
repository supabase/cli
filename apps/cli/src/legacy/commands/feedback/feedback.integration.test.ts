import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";
import type { FeedbackSubmission } from "../../../shared/feedback/feedback-submitter.service.ts";
import {
  FeedbackSubmitError,
  FeedbackSubmitter,
} from "../../../shared/feedback/feedback-submitter.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { CurrentAnalyticsContext } from "../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import { AiTool } from "../../../shared/telemetry/ai-tool.service.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
} from "../../../../tests/helpers/mocks.ts";
import { legacyFeedbackHandler } from "./feedback.command.ts";
import { LEGACY_FEEDBACK_EMPTY_MESSAGE } from "./feedback.errors.ts";
import { legacyFeedback } from "./feedback.handler.ts";

function mockFeedbackSubmitter(opts: { failWith?: string } = {}) {
  const submissions: FeedbackSubmission[] = [];
  return {
    layer: Layer.succeed(
      FeedbackSubmitter,
      FeedbackSubmitter.of({
        submit: (submission) =>
          opts.failWith !== undefined
            ? Effect.fail(new FeedbackSubmitError({ message: opts.failWith }))
            : Effect.sync(() => {
                submissions.push(submission);
                return { id: "receipt-1", submittedAt: "2026-07-22T00:00:00.000Z" };
              }),
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

// `withLegacyCommandInstrumentation` threads `flags`/`command`/etc. through
// `CurrentAnalyticsContext`, not the direct `capture()` call args — mirrors
// the identical local helper in `functions/delete/delete.integration.test.ts`.
function mockContextualAnalytics() {
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const layer = Layer.succeed(
    Analytics,
    Analytics.of({
      capture: (event: string, properties: Record<string, unknown> = {}) =>
        Effect.gen(function* () {
          const context = yield* CurrentAnalyticsContext;
          captured.push({ event, properties: { ...context, ...properties } });
        }),
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );
  return { layer, captured };
}

function setupLegacyFeedback(
  opts: {
    output?: Parameters<typeof mockOutput>[0];
    stdinIsTTY?: boolean;
    pipedInput?: string;
    agentName?: string;
    submitFailWith?: string;
  } = {},
) {
  const out = mockOutput(opts.output);
  const submitter = mockFeedbackSubmitter(
    opts.submitFailWith === undefined ? {} : { failWith: opts.submitFailWith },
  );
  const layer = Layer.mergeAll(
    out.layer,
    submitter.layer,
    mockStdin(opts.stdinIsTTY ?? true, opts.pipedInput),
    mockRuntimeInfo({ platform: "darwin", arch: "arm64" }),
    mockTelemetryRuntime({ cliVersion: "9.9.9" }),
    mockAiTool(opts.agentName),
  );
  return { layer, out, submitter };
}

// Extra layers required by the wrapped `legacyFeedbackHandler` (the exact
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
    commandRuntimeLayer(["feedback"]),
    Stdio.layerTest({ args: Effect.succeed([...(opts.args ?? ["feedback"])]) }),
  );
  return { ...base, layer, analytics, processControl };
}

describe("legacy feedback", () => {
  it.live("submits a quoted message with CLI version, os, and arch attached", () => {
    const { layer, out, submitter } = setupLegacyFeedback();
    return Effect.gen(function* () {
      yield* legacyFeedback({ message: ["port conflicts when running two stacks"] });

      expect(submitter.submissions).toEqual([
        {
          message: "port conflicts when running two stacks",
          context: {
            cliVersion: "9.9.9",
            os: "darwin",
            arch: "arm64",
            isAgent: false,
          },
        },
      ]);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Thanks for the feedback!" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("joins bare words into a single message", () => {
    const { layer, submitter } = setupLegacyFeedback();
    return Effect.gen(function* () {
      yield* legacyFeedback({ message: ["ports", "conflict", "a", "lot"] });

      expect(submitter.submissions[0]?.message).toBe("ports conflict a lot");
    }).pipe(Effect.provide(layer));
  });

  it.live("marks the submission as agent feedback when an AI tool is detected", () => {
    const { layer, submitter } = setupLegacyFeedback({ agentName: "claude_code" });
    return Effect.gen(function* () {
      yield* legacyFeedback({ message: ["agents need --yes everywhere"] });

      expect(submitter.submissions[0]?.context.isAgent).toBe(true);
      expect(submitter.submissions[0]?.context.agentName).toBe("claude_code");
    }).pipe(Effect.provide(layer));
  });

  it.live("reads the message from piped stdin when no argument is given", () => {
    const { layer, submitter } = setupLegacyFeedback({
      stdinIsTTY: false,
      pipedInput: "piped feedback\n",
    });
    return Effect.gen(function* () {
      yield* legacyFeedback({ message: [] });

      expect(submitter.submissions[0]?.message).toBe("piped feedback");
    }).pipe(Effect.provide(layer));
  });

  it.live("prompts for the message on an interactive terminal", () => {
    const { layer, submitter } = setupLegacyFeedback({
      output: { interactive: true, promptTextResponses: ["typed feedback"] },
    });
    return Effect.gen(function* () {
      yield* legacyFeedback({ message: [] });

      expect(submitter.submissions[0]?.message).toBe("typed feedback");
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
      const error = yield* legacyFeedback({ message: [" ", ""] }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "LegacyFeedbackEmptyMessageError",
        message: LEGACY_FEEDBACK_EMPTY_MESSAGE,
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a machine-readable acknowledgement in json output format", () => {
    const { layer, out, submitter } = setupLegacyFeedback({ output: { format: "json" } });
    return Effect.gen(function* () {
      yield* legacyFeedback({ message: ["json mode feedback"] });

      expect(submitter.submissions).toHaveLength(1);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Thanks for the feedback!",
          data: { id: "receipt-1", submitted_at: "2026-07-22T00:00:00.000Z" },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a json error and exit code 1 when the message is missing in json mode", () => {
    const { layer, out, submitter, processControl } = setupLegacyFeedbackHandler({
      output: { format: "json" },
      stdinIsTTY: false,
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackHandler({ message: [] });

      expect(submitter.submissions).toHaveLength(0);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "fail", message: LEGACY_FEEDBACK_EMPTY_MESSAGE }),
      );
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a submitter failure", () => {
    const { layer, out } = setupLegacyFeedback({ submitFailWith: "backend unavailable" });
    return Effect.gen(function* () {
      const error = yield* legacyFeedback({ message: ["doomed message"] }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackSubmitError",
        message: "backend unavailable",
      });
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "success" }));
    }).pipe(Effect.provide(layer));
  });

  it.live("never sends the feedback message content to PostHog", () => {
    const { layer, analytics, submitter } = setupLegacyFeedbackHandler({
      args: ["feedback", "my", "secret", "papercut", "--debug"],
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackHandler({ message: ["my", "secret", "papercut"] });

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
