import { describe, expect, it } from "@effect/vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Stdio, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import type { FeedbackSubmission } from "../../../shared/feedback/feedback-client.service.ts";
import {
  FeedbackBackendError,
  FeedbackClient,
} from "../../../shared/feedback/feedback-client.service.ts";
import { AgentFlag, OutputFlag } from "../../../command-internal/global-flags.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayerFrom } from "../../../shared/runtime/stdin.layer.ts";
import type { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { AiTool } from "../../../shared/telemetry/ai-tool.service.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { invalidOutputFormatMessage } from "../../../command-internal/go-output-flag.ts";
import { INVALID_PROJECT_REF_MESSAGE } from "../../../config/project-ref.service.ts";
import { FEEDBACK_OUTPUT_FORMATS } from "../feedback-output.ts";
import type { FeedbackAddArgs } from "./add.command.ts";
import { feedbackAddHandler } from "./add.command.ts";
import {
  FEEDBACK_EMPTY_MESSAGE,
  FEEDBACK_PIPE_CAP_BYTES,
  FEEDBACK_PIPE_TOO_LONG_MESSAGE,
  feedbackTooLongMessage,
} from "./add.errors.ts";
import { feedbackAdd } from "./add.handler.ts";

const tempRoot = useTempWorkdir("supabase-feedback-add-int-");

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

function addArgs(
  message: ReadonlyArray<string>,
  overrides: Partial<FeedbackAddArgs> = {},
): FeedbackAddArgs {
  return { message, projectRef: Option.none(), ...overrides };
}

function mockFeedbackClient(opts: { failWith?: string } = {}) {
  const submissions: FeedbackSubmission[] = [];
  return {
    layer: Layer.succeed(
      FeedbackClient,
      FeedbackClient.of({
        submit: (submission) =>
          opts.failWith !== undefined
            ? Effect.fail(
                new FeedbackBackendError({
                  message: opts.failWith,
                  operation: "submit",
                  reason: "transport",
                }),
              )
            : Effect.sync(() => {
                submissions.push(submission);
                return { deleteToken: MOCK_DELETE_TOKEN };
              }),
        // `feedback add` never deletes.
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

function setupFeedback(
  opts: {
    output?: Parameters<typeof mockOutput>[0];
    stdinIsTTY?: boolean;
    pipedInput?: string;
    /** Replaces the fixed `mockStdin` with a `Stdin` over a controlled byte stream. */
    stdin?: Layer.Layer<Stdin>;
    agentName?: string;
    agentFlag?: "auto" | "yes" | "no";
    /** Simulates the Go-compat `-o`/`--output` global flag. */
    goOutput?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
    submitFailWith?: string;
    /** Simulates `SUPABASE_PROJECT_ID`, the only source `CommandSettings` reads. */
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
  const telemetryState = mockTelemetryStateTracked();
  const layer = Layer.mergeAll(
    out.layer,
    submitter.layer,
    telemetryState.layer,
    opts.stdin ?? mockStdin(opts.stdinIsTTY ?? true, opts.pipedInput),
    mockRuntimeInfo({ platform: "darwin", arch: "arm64" }),
    mockTelemetryRuntime({
      cliVersion: "9.9.9",
      distinctId: opts.distinctId,
      consent: opts.consent,
    }),
    mockCommandSettings({
      workdir: tempRoot.current,
      userAgent: "SupabaseCLI/9.9.9",
      projectId: opts.projectIdEnv === undefined ? Option.none() : Option.some(opts.projectIdEnv),
    }),
    mockAiTool(opts.agentName),
    Layer.succeed(AgentFlag, opts.agentFlag ?? "auto"),
    Layer.succeed(OutputFlag, Option.fromNullishOr(opts.goOutput)),
    // Real filesystem: the handler reads `supabase/.temp/project-ref` from the
    // temp workdir, so this must not be stubbed out.
    BunServices.layer,
  );
  return { layer, out, submitter, telemetryState };
}

// Extra layers required by the wrapped `feedbackAddHandler` (the exact
// wiring `Command.withHandler` uses): instrumentation + json error handling.
function setupFeedbackHandler(
  opts: Parameters<typeof setupFeedback>[0] & { args?: ReadonlyArray<string> } = {},
) {
  const base = setupFeedback(opts);
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

describe("feedback add", () => {
  it.live("submits a quoted message with CLI version, os, and arch attached", () => {
    const { layer, out, submitter, telemetryState } = setupFeedback();
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["port conflicts when running two stacks"]));

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
      // telemetry.json is refreshed on every invocation by the telemetry-state
      // finalizer every command runs.
      expect(telemetryState.flushCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("joins bare words into a single message", () => {
    const { layer, submitter } = setupFeedback();
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["ports", "conflict", "a", "lot"]));

      expect(submitter.submissions[0]?.message).toBe("ports conflict a lot");
    }).pipe(Effect.provide(layer));
  });

  it.live("marks the submission as agent feedback when an AI tool is detected", () => {
    const { layer, submitter } = setupFeedback({ agentName: "claude_code" });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["agents need --yes everywhere"]));

      expect(submitter.submissions[0]?.context.isAgent).toBe(true);
      expect(submitter.submissions[0]?.context.agentName).toBe("claude_code");
    }).pipe(Effect.provide(layer));
  });

  it.live("suppresses agent metadata when --agent no overrides a detected tool", () => {
    const { layer, submitter } = setupFeedback({
      agentName: "claude_code",
      agentFlag: "no",
    });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["human at the keyboard"]));

      expect(submitter.submissions[0]?.context.isAgent).toBe(false);
      // The name is suppressed too — an `is_agent: false` payload must not
      // carry a contradictory `agent_name`.
      expect(submitter.submissions[0]?.context.agentName).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("marks the submission as agent feedback when --agent yes forces it", () => {
    const { layer, submitter } = setupFeedback({ agentFlag: "yes" });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["undetected agent"]));

      expect(submitter.submissions[0]?.context.isAgent).toBe(true);
      expect(submitter.submissions[0]?.context.agentName).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("attaches the linked project ref written by supabase link", () => {
    const { layer, out, submitter } = setupFeedback();
    writeLinkedProjectRef(tempRoot.current, VALID_REF);
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["linked project feedback"]));

      expect(submitter.submissions[0]?.projectRef).toBe(VALID_REF);
      // The row now requires the same ref to delete, so the receipt must be
      // self-contained when copied out of this directory.
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: `To delete this feedback later, run: supabase feedback delete ${MOCK_DELETE_TOKEN} --project-ref ${VALID_REF}`,
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("prefers SUPABASE_PROJECT_ID over the linked ref file", () => {
    const { layer, submitter } = setupFeedback({ projectIdEnv: "envenvenvenvenvenvre" });
    writeLinkedProjectRef(tempRoot.current, VALID_REF);
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["env override feedback"]));

      expect(submitter.submissions[0]?.projectRef).toBe("envenvenvenvenvenvre");
    }).pipe(Effect.provide(layer));
  });

  it.live("prefers --project-ref over SUPABASE_PROJECT_ID and the linked ref file", () => {
    // Attribution from an unlinked (or differently linked) checkout, the same
    // way `feedback delete` and every other command accept the flag.
    const { layer, out, submitter } = setupFeedback({ projectIdEnv: "envenvenvenvenvenvre" });
    writeLinkedProjectRef(tempRoot.current, VALID_REF);
    return Effect.gen(function* () {
      yield* feedbackAdd(
        addArgs(["flag override feedback"], { projectRef: Option.some("flagflagflagflagflag") }),
      );

      expect(submitter.submissions[0]?.projectRef).toBe("flagflagflagflagflag");
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: `To delete this feedback later, run: supabase feedback delete ${MOCK_DELETE_TOKEN} --project-ref flagflagflagflagflag`,
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a malformed --project-ref before any request", () => {
    const { layer, submitter } = setupFeedback();
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(
        addArgs(["typo feedback"], { projectRef: Option.some("Not-A-Ref") }),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "InvalidProjectRefError",
        ref: "Not-A-Ref",
        message: INVALID_PROJECT_REF_MESSAGE,
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("treats an empty --project-ref as unset, like ProjectRefResolver", () => {
    const { layer, submitter } = setupFeedback({ projectIdEnv: "envenvenvenvenvenvre" });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["empty flag feedback"], { projectRef: Option.some("") }));

      expect(submitter.submissions[0]?.projectRef).toBe("envenvenvenvenvenvre");
    }).pipe(Effect.provide(layer));
  });

  it.live("attaches the persisted gotrue user id when logged in", () => {
    const { layer, submitter } = setupFeedback({
      distinctId: "11111111-2222-3333-4444-555555555555",
    });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["logged in feedback"]));

      expect(submitter.submissions[0]?.userId).toBe("11111111-2222-3333-4444-555555555555");
    }).pipe(Effect.provide(layer));
  });

  it.live("sends no user id when not logged in", () => {
    const { layer, submitter } = setupFeedback();
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["logged out feedback"]));

      expect(submitter.submissions[0]?.userId).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("sends no user id when telemetry consent is denied", () => {
    // Submit-side attribution is consent-gated: opted-out users submit
    // anonymously even when a persisted gotrue id exists.
    const { layer, submitter } = setupFeedback({
      distinctId: "11111111-2222-3333-4444-555555555555",
      consent: "denied",
    });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["opted out feedback"]));

      expect(submitter.submissions[0]?.userId).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("sends no project ref when the workdir is not linked", () => {
    const { layer, submitter } = setupFeedback();
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["unlinked feedback"]));

      expect(submitter.submissions[0]?.projectRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("still submits when the linked ref file cannot be read", () => {
    // A broken ref file must not block feedback — it degrades to "unlinked".
    const { layer, out, submitter } = setupFeedback();
    writeLinkedProjectRef(tempRoot.current, VALID_REF, { asDirectory: true });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["broken ref file feedback"]));

      expect(submitter.submissions[0]?.projectRef).toBeUndefined();
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Thanks for the feedback!" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("discards ref-file contents that are not a well-formed project ref", () => {
    // The workdir can be an untrusted checkout where `.temp/project-ref` is a
    // symlink to a local secret (e.g. an access token). Anything that fails the
    // PROJECT_REF_PATTERN boundary must be dropped, not sent as `project_ref`.
    // The fixture is shaped like a credential without matching any real token
    // format, so secret scanners don't flag the test source itself.
    const { layer, submitter } = setupFeedback();
    writeLinkedProjectRef(tempRoot.current, "fake-access-token-0102030405060708");
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["symlinked secret feedback"]));

      expect(submitter.submissions[0]?.projectRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a malformed SUPABASE_PROJECT_ID instead of submitting unlinked", () => {
    // A value the user supplied is validated the way `ProjectRefResolver` does
    // for every command: a typo fails as invalid input rather than silently
    // falling through to the linked ref file (or to "unlinked").
    const { layer, submitter } = setupFeedback({ projectIdEnv: "not-a-valid-ref!" });
    writeLinkedProjectRef(tempRoot.current, VALID_REF);
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(addArgs(["invalid env ref feedback"])).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "InvalidProjectRefError",
        message: INVALID_PROJECT_REF_MESSAGE,
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads the message from piped stdin when no argument is given", () => {
    const { layer, submitter } = setupFeedback({
      stdinIsTTY: false,
      pipedInput: "piped feedback\n",
    });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs([]));

      expect(submitter.submissions[0]?.message).toBe("piped feedback");
    }).pipe(Effect.provide(layer));
  });

  it.live("discards a partially read pipe when stdin fails mid-stream", () => {
    // The pipe delivers a chunk and then the read fails. The buffered prefix
    // must not be submitted as if it were the whole message — a truncated
    // sentence is corrupted feedback, not the user's feedback. With no other
    // source (non-interactive stdout), the command fails as empty instead.
    const readError = systemError({
      module: "Stdin",
      method: "read",
      _tag: "Unknown",
      description: "read EIO",
    });
    const brokenPipe = Stream.concat(
      Stream.make(new TextEncoder().encode("the first half of my feedb")),
      Stream.fail(readError),
    );
    const { layer, submitter } = setupFeedback({
      output: { interactive: false },
      stdin: stdinLayerFrom(brokenPipe).pipe(Layer.provide(mockTty({ stdinIsTty: false }))),
    });
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(addArgs([])).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackEmptyMessageError",
        message: FEEDBACK_EMPTY_MESSAGE,
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("prompts for the message on an interactive terminal", () => {
    const { layer, submitter } = setupFeedback({
      output: { interactive: true, promptTextResponses: ["typed feedback"] },
    });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs([]));

      expect(submitter.submissions[0]?.message).toBe("typed feedback");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not prompt when piped stdin is exhausted, even with a TTY stdout", () => {
    // `printf ' ' | supabase feedback add` in a terminal: stdout is a TTY (so
    // `output.interactive` is true) but stdin is a drained pipe the prompt
    // cannot read from. This must fail like the non-interactive case instead
    // of opening a prompt against exhausted stdin.
    const { layer, submitter } = setupFeedback({
      output: { interactive: true, promptTextResponses: ["never read"] },
      stdinIsTTY: false,
      pipedInput: "   \n",
    });
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(addArgs([])).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackEmptyMessageError",
        message: FEEDBACK_EMPTY_MESSAGE,
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails without prompting when stdout is not interactive, even on a TTY stdin", () => {
    // `supabase feedback add > out.txt` in a terminal: stdin is a TTY but
    // stdout is redirected, so the text layer reports interactive: false and
    // there is nowhere to render a prompt.
    const { layer, submitter } = setupFeedback({ output: { interactive: false } });
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(addArgs([])).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "FeedbackEmptyMessageError" });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a helpful error when there is no message anywhere", () => {
    // Whitespace-only args and whitespace-only pipe both fall through; a
    // non-interactive terminal leaves nothing left to ask.
    const { layer, submitter } = setupFeedback({
      output: { interactive: false },
      stdinIsTTY: false,
      pipedInput: "   \n",
    });
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(addArgs([" ", ""])).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackEmptyMessageError",
        message: FEEDBACK_EMPTY_MESSAGE,
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a message over the 1000 character limit before any request", () => {
    const { layer, submitter } = setupFeedback();
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(addArgs(["x".repeat(1001)])).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackMessageTooLongError",
        message: feedbackTooLongMessage(1001),
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects piped input past the byte cap without buffering the whole pipe", () => {
    // `cat huge.log | supabase feedback add`: the capped reader stops at the
    // 64 KB byte cap and fails as over-limit instead of collecting the stream.
    const { layer, submitter } = setupFeedback({
      stdinIsTTY: false,
      pipedInput: "x".repeat(FEEDBACK_PIPE_CAP_BYTES + 1),
    });
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(addArgs([])).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackMessageTooLongError",
        message: FEEDBACK_PIPE_TOO_LONG_MESSAGE,
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects piped input over the character limit but under the byte cap", () => {
    const { layer, submitter } = setupFeedback({
      stdinIsTTY: false,
      pipedInput: `${"x".repeat(1001)}\n`,
    });
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(addArgs([])).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackMessageTooLongError",
        message: feedbackTooLongMessage(1001),
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts a message at exactly the limit, counted in code points", () => {
    // 1000 astral-plane characters are 2000 UTF-16 units; Postgres
    // `char_length` counts code points, so the client-side check must too or
    // it would reject a message the server accepts.
    const message = "🦆".repeat(1000);
    const { layer, submitter } = setupFeedback();
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs([message]));

      expect(submitter.submissions).toHaveLength(1);
      expect(submitter.submissions[0]?.message).toBe(message);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the delete token in the json acknowledgement", () => {
    const { layer, out, submitter } = setupFeedback({ output: { format: "json" } });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["json mode feedback"]));

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
    const { layer, out, submitter } = setupFeedback({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* feedbackAdd(addArgs(["go machine format feedback"]));

      expect(submitter.submissions).toHaveLength(1);
      expect(out.rawChunks).toHaveLength(1);
      expect(out.rawChunks[0]?.stream).toBe("stdout");
      expect(JSON.parse(out.rawChunks[0]!.text)).toEqual({ delete_token: MOCK_DELETE_TOKEN });
      // No human-readable acknowledgement — stdout is payload-only.
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "success" }));
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "info" }));
    }).pipe(Effect.provide(layer));
  });

  it.live("does not prompt under -o json even on an interactive terminal", () => {
    // `-o json` leaves output.format === "text", so the interactive text layer
    // would happily render the clack prompt — onto stdout, ahead of the raw
    // JSON payload. Machine mode must fail as empty instead.
    const { layer, out, submitter } = setupFeedback({
      goOutput: "json",
      output: { interactive: true, promptTextResponses: ["never read"] },
    });
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(addArgs([])).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackEmptyMessageError",
        message: FEEDBACK_EMPTY_MESSAGE,
      });
      expect(out.promptTextCalls).toHaveLength(0);
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects an -o value outside feedback's pretty|json enum", () => {
    const { layer, submitter } = setupFeedbackHandler({
      goOutput: "yaml",
      args: ["feedback", "add", "doomed", "--output", "yaml"],
    });
    return Effect.gen(function* () {
      const error = yield* feedbackAddHandler(addArgs(["doomed"])).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "InvalidOutputFormatError",
        message: invalidOutputFormatMessage("yaml", FEEDBACK_OUTPUT_FORMATS),
      });
      expect(submitter.submissions).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a json error and exit code 1 when the message is missing in json mode", () => {
    const { layer, out, submitter, processControl } = setupFeedbackHandler({
      output: { format: "json" },
      stdinIsTTY: false,
    });
    return Effect.gen(function* () {
      yield* feedbackAddHandler(addArgs([]));

      expect(submitter.submissions).toHaveLength(0);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "fail", message: FEEDBACK_EMPTY_MESSAGE }),
      );
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a submitter failure", () => {
    const { layer, out, telemetryState } = setupFeedback({
      submitFailWith: "backend unavailable",
    });
    return Effect.gen(function* () {
      const error = yield* feedbackAdd(addArgs(["doomed message"])).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackBackendError",
        message: "backend unavailable",
      });
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "success" }));
      // The finalizer runs on failure too.
      expect(telemetryState.flushCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("records --project-ref by name only, never its value, in PostHog", () => {
    const { layer, analytics, submitter } = setupFeedbackHandler({
      args: ["feedback", "add", "attributed", "--project-ref", "abcdefghijklmnopqrst"],
    });
    return Effect.gen(function* () {
      yield* feedbackAddHandler(
        addArgs(["attributed"], { projectRef: Option.some("abcdefghijklmnopqrst") }),
      );

      expect(submitter.submissions[0]?.projectRef).toBe("abcdefghijklmnopqrst");
      const events = analytics.captured.filter((c) => c.event === "cli_command_executed");
      expect(events).toHaveLength(1);
      // Same treatment as `feedback delete`: the flag has no telemetry-safe
      // marking, so its value redacts and only the name survives.
      expect(JSON.stringify(events[0])).not.toContain("abcdefghijklmnopqrst");
      expect(Object.keys(events[0]?.properties.flags ?? {})).toEqual(["project-ref"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("never sends the feedback message content to PostHog", () => {
    const { layer, analytics, submitter } = setupFeedbackHandler({
      args: ["feedback", "add", "my", "secret", "papercut", "--debug"],
    });
    return Effect.gen(function* () {
      yield* feedbackAddHandler(addArgs(["my", "secret", "papercut"]));

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
