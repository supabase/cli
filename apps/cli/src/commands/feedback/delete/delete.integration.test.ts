import { describe, expect, it } from "@effect/vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Stdio } from "effect";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  FeedbackBackendError,
  FeedbackClient,
} from "../../../shared/feedback/feedback-client.service.ts";
import { OutputFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockStdin,
  mockTelemetryRuntime,
} from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import type { FeedbackDeleteArgs } from "./delete.command.ts";
import { feedbackDeleteHandler } from "./delete.command.ts";
import { INVALID_PROJECT_REF_MESSAGE } from "../../../config/project-ref.service.ts";
import { FEEDBACK_INVALID_TOKEN_MESSAGE, FEEDBACK_NOT_FOUND_MESSAGE } from "./delete.errors.ts";
import { feedbackDelete } from "./delete.handler.ts";

const tempRoot = useTempWorkdir("supabase-feedback-delete-int-");

const TOKEN = "123e4567-e89b-12d3-a456-426614174000";

function deleteArgs(overrides: Partial<FeedbackDeleteArgs> = {}): FeedbackDeleteArgs {
  return { token: TOKEN, projectRef: Option.none(), ...overrides };
}

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

interface MockClientOpts {
  /** Feedback text the preview finds; leave unset for a zero-row (not found) preview. */
  previewText?: string;
  previewFailWith?: string;
  /** Whether the delete matches a row; defaults to true. */
  deleteMatches?: boolean;
  deleteFailWith?: string;
}

interface RecordedCall {
  token: string;
  projectRef: string | undefined;
  userId: string | undefined;
}

function mockFeedbackClient(opts: MockClientOpts = {}) {
  const previewCalls: Array<RecordedCall> = [];
  const deleteCalls: Array<RecordedCall> = [];
  return {
    layer: Layer.succeed(
      FeedbackClient,
      FeedbackClient.of({
        submit: () => Effect.die("submit is not reachable from feedback delete"),
        preview: (token, context) =>
          Effect.suspend(() => {
            previewCalls.push({ token, projectRef: context?.projectRef, userId: context?.userId });
            return opts.previewFailWith !== undefined
              ? Effect.fail(
                  new FeedbackBackendError({
                    message: opts.previewFailWith,
                    operation: "preview",
                    reason: "transport",
                  }),
                )
              : Effect.succeed(Option.fromNullishOr(opts.previewText));
          }),
        delete: (token, context) =>
          Effect.suspend(() => {
            deleteCalls.push({ token, projectRef: context?.projectRef, userId: context?.userId });
            return opts.deleteFailWith !== undefined
              ? Effect.fail(
                  new FeedbackBackendError({
                    message: opts.deleteFailWith,
                    operation: "delete",
                    reason: "transport",
                  }),
                )
              : Effect.succeed({ deleted: opts.deleteMatches ?? true });
          }),
      }),
    ),
    previewCalls,
    deleteCalls,
  };
}

function setupFeedbackDelete(
  opts: {
    output?: Parameters<typeof mockOutput>[0];
    stdinIsTTY?: boolean;
    client?: MockClientOpts;
    yes?: boolean;
    /** Simulates the Go-compat `-o`/`--output` global flag. */
    goOutput?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
    /** Simulates `SUPABASE_PROJECT_ID`, the only source `CommandSettings` reads. */
    projectIdEnv?: string;
    /** Simulates the gotrue user id persisted to telemetry.json at login. */
    distinctId?: string;
    consent?: "granted" | "denied";
  } = {},
) {
  const out = mockOutput(opts.output ?? { promptConfirmResponses: [true] });
  const client = mockFeedbackClient(opts.client ?? { previewText: "my papercut" });
  const telemetryState = mockTelemetryStateTracked();
  const layer = Layer.mergeAll(
    out.layer,
    client.layer,
    telemetryState.layer,
    mockStdin(opts.stdinIsTTY ?? true),
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
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(OutputFlag, Option.fromNullishOr(opts.goOutput)),
    Layer.succeed(CliArgs, { args: [] }),
    // Real filesystem: the handler reads `supabase/.temp/project-ref` from the
    // temp workdir, so this must not be stubbed out.
    BunServices.layer,
  );
  return { layer, out, client, telemetryState };
}

// Extra layers required by the wrapped `feedbackDeleteHandler` (the exact
// wiring `Command.withHandler` uses): instrumentation + json error handling.
function setupFeedbackDeleteHandler(
  opts: Parameters<typeof setupFeedbackDelete>[0] & { args?: ReadonlyArray<string> } = {},
) {
  const base = setupFeedbackDelete(opts);
  const analytics = mockContextualAnalytics();
  const processControl = mockProcessControl();
  const layer = Layer.mergeAll(
    base.layer,
    analytics.layer,
    processControl.layer,
    commandRuntimeLayer(["feedback", "delete"]),
    Stdio.layerTest({ args: Effect.succeed([...(opts.args ?? ["feedback", "delete", TOKEN])]) }),
  );
  return { ...base, layer, analytics, processControl };
}

describe("feedback delete", () => {
  it.live("previews the feedback, confirms, and deletes it", () => {
    const { layer, out, client, telemetryState } = setupFeedbackDelete();
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: 'Found feedback: "my papercut"' }),
      );
      expect(out.promptConfirmCalls).toEqual([
        { message: "Permanently delete this feedback?", opts: { defaultValue: false } },
      ]);
      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: undefined }]);
      expect(client.deleteCalls).toEqual([{ token: TOKEN, projectRef: undefined }]);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Feedback deleted." }),
      );
      // telemetry.json is refreshed on every invocation by the telemetry-state
      // finalizer every command runs.
      expect(telemetryState.flushCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("strips terminal control sequences from the text-mode preview", () => {
    // A malicious submitter can hand another user its token; the stored text
    // must not be able to forge the confirmation display (CSI clear + fake
    // line), write the clipboard (OSC 52), or reorder the line (bidi override).
    const hostile =
      "\x1b[2J\x1b[HPermanently delete ALL feedback?" +
      "\x1b]52;c;aGVsbG8=\x07" +
      "\u202esecret\u202c" +
      " legit\x00tail\r";
    const { layer, out } = setupFeedbackDelete({
      client: { previewText: hostile },
      yes: true,
    });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      const preview = out.messages.find((m) => m.type === "info");
      expect(preview?.message).toBe(
        'Found feedback: "[2J[HPermanently delete ALL feedback?]52;c;aGVsbG8=secret legittail"',
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("returns the stored text verbatim in machine payloads", () => {
    // Only the human-readable preview is sanitized; structured consumers get
    // the exact row contents.
    const raw = "line one\x1b[31m red\n";
    const { layer, out } = setupFeedbackDelete({
      output: { format: "json" },
      client: { previewText: raw },
      yes: true,
    });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", data: { feedback: raw } }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a token that is not a UUID before contacting the backend", () => {
    const { layer, client } = setupFeedbackDelete();
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(deleteArgs({ token: "not-a-uuid" })).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackInvalidTokenError",
        message: FEEDBACK_INVALID_TOKEN_MESSAGE,
      });
      expect(client.previewCalls).toHaveLength(0);
      expect(client.deleteCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts an uppercase token and lowercases it for the backend", () => {
    const { layer, client } = setupFeedbackDelete({ yes: true });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs({ token: TOKEN.toUpperCase() }));

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: undefined }]);
      expect(client.deleteCalls).toEqual([{ token: TOKEN, projectRef: undefined }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("cancels without deleting when the confirmation is declined", () => {
    const { layer, client } = setupFeedbackDelete({
      output: { promptConfirmResponses: [false] },
    });
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "FeedbackDeleteCancelledError" });
      expect(client.deleteCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("--yes skips the confirmation prompt", () => {
    const { layer, out, client } = setupFeedbackDelete({ yes: true });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(client.deleteCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses to confirm from piped stdin, even with a TTY stdout", () => {
    // `printf 'y' | supabase feedback delete <token>` in a terminal: stdout is
    // a TTY (so `output.interactive` is true) but the confirm would answer on a
    // single keypress read from the pipe, deleting without --yes. It must fail
    // as non-interactive instead of consuming the piped byte.
    const { layer, out, client } = setupFeedbackDelete({ stdinIsTTY: false });
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "NonInteractiveError" });
      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(client.deleteCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses to confirm when stdout is not interactive, even on a TTY stdin", () => {
    const { layer, out, client } = setupFeedbackDelete({ output: { interactive: false } });
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "NonInteractiveError" });
      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(client.deleteCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("--yes deletes without prompting when stdin is piped", () => {
    // The documented escape hatch for non-interactive contexts.
    const { layer, out, client } = setupFeedbackDelete({ yes: true, stdinIsTTY: false });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(client.deleteCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a remediation hint when the token matches no feedback", () => {
    const { layer, client } = setupFeedbackDelete({ client: {} });
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "FeedbackNotFoundError",
        message: FEEDBACK_NOT_FOUND_MESSAGE,
      });
      expect(client.deleteCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails as not found when the delete matches zero rows after the preview", () => {
    // The row disappeared between preview and delete (e.g. deleted elsewhere).
    const { layer, client } = setupFeedbackDelete({
      client: { previewText: "raced", deleteMatches: false },
      yes: true,
    });
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "FeedbackNotFoundError" });
      expect(client.deleteCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("sends the linked project ref written by supabase link", () => {
    const { layer, client } = setupFeedbackDelete({ yes: true });
    writeLinkedProjectRef(tempRoot.current, VALID_REF);
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: VALID_REF }]);
      expect(client.deleteCalls).toEqual([{ token: TOKEN, projectRef: VALID_REF }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("prefers --project-ref over SUPABASE_PROJECT_ID and the linked ref file", () => {
    const { layer, client } = setupFeedbackDelete({
      yes: true,
      projectIdEnv: "envenvenvenvenvenvre",
    });
    writeLinkedProjectRef(tempRoot.current, VALID_REF);
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs({ projectRef: Option.some("flagflagflagflagflag") }));

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: "flagflagflagflagflag" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a malformed --project-ref instead of falling through", () => {
    // The user typed the ref: report the typo (the same InvalidProjectRefError
    // every other command raises) rather than silently sending the linked
    // checkout's context and reporting a misleading "not found".
    const { layer, client } = setupFeedbackDelete({ yes: true });
    writeLinkedProjectRef(tempRoot.current, VALID_REF);
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(
        deleteArgs({ projectRef: Option.some("Not-A-Ref") }),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "InvalidProjectRefError",
        ref: "Not-A-Ref",
        message: INVALID_PROJECT_REF_MESSAGE,
      });
      expect(client.previewCalls).toHaveLength(0);
      expect(client.deleteCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a malformed SUPABASE_PROJECT_ID instead of falling through", () => {
    const { layer, client } = setupFeedbackDelete({ yes: true, projectIdEnv: "not-a-valid-ref!" });
    writeLinkedProjectRef(tempRoot.current, VALID_REF);
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "InvalidProjectRefError", ref: "not-a-valid-ref!" });
      expect(client.previewCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("treats an empty --project-ref as unset, like ProjectRefResolver", () => {
    const { layer, client } = setupFeedbackDelete({
      yes: true,
      projectIdEnv: "envenvenvenvenvenvre",
    });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs({ projectRef: Option.some("") }));

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: "envenvenvenvenvenvre" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("prefers SUPABASE_PROJECT_ID over the linked ref file", () => {
    const { layer, client } = setupFeedbackDelete({
      yes: true,
      projectIdEnv: "envenvenvenvenvenvre",
    });
    writeLinkedProjectRef(tempRoot.current, VALID_REF);
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: "envenvenvenvenvenvre" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("presents the persisted gotrue user id with the preview and the delete", () => {
    // Rows submitted while logged in carry a user_id, and the RLS only
    // matches them when the same id arrives as the x-feedback-user-id header.
    const { layer, client } = setupFeedbackDelete({
      yes: true,
      distinctId: "11111111-2222-3333-4444-555555555555",
    });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(client.previewCalls).toEqual([
        { token: TOKEN, projectRef: undefined, userId: "11111111-2222-3333-4444-555555555555" },
      ]);
      expect(client.deleteCalls).toEqual([
        { token: TOKEN, projectRef: undefined, userId: "11111111-2222-3333-4444-555555555555" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("still presents the user id when telemetry consent is denied", () => {
    // Unlike submit-side attribution, the header is functional auth context —
    // gating it on consent would strand rows submitted before an opt-out.
    const { layer, client } = setupFeedbackDelete({
      yes: true,
      distinctId: "11111111-2222-3333-4444-555555555555",
      consent: "denied",
    });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(client.deleteCalls[0]?.userId).toBe("11111111-2222-3333-4444-555555555555");
    }).pipe(Effect.provide(layer));
  });

  it.live("sends no user id when not logged in", () => {
    const { layer, client } = setupFeedbackDelete({ yes: true });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(client.previewCalls[0]?.userId).toBeUndefined();
      expect(client.deleteCalls[0]?.userId).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("degrades to no project ref when the linked ref file cannot be read", () => {
    const { layer, client } = setupFeedbackDelete({ yes: true });
    writeLinkedProjectRef(tempRoot.current, VALID_REF, { asDirectory: true });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: undefined }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("returns the deleted feedback text in json output format", () => {
    const { layer, out } = setupFeedbackDelete({
      output: { format: "json" },
      client: { previewText: "json feedback" },
      yes: true,
    });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      // Machine modes carry the text in the result payload instead of the
      // text-mode "Found feedback" info line.
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "info" }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Feedback deleted.",
          data: { feedback: "json feedback" },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits only the machine payload on stdout with -o json", () => {
    const { layer, out } = setupFeedbackDelete({
      goOutput: "json",
      client: { previewText: "go machine feedback" },
      yes: true,
    });
    return Effect.gen(function* () {
      yield* feedbackDelete(deleteArgs());

      expect(out.rawChunks).toHaveLength(1);
      expect(out.rawChunks[0]?.stream).toBe("stdout");
      expect(JSON.parse(out.rawChunks[0]!.text)).toEqual({ feedback: "go machine feedback" });
      // The payload carries the feedback text; no "Found feedback" info line
      // and no human-readable acknowledgement — stdout is payload-only.
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "info" }));
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "success" }));
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses to prompt under -o json without --yes, even on a TTY", () => {
    // `-o json` leaves output.format === "text", so the interactive text layer
    // would render the clack confirm onto stdout ahead of the raw JSON payload.
    // Machine mode must fail loudly instead — the same contract as
    // --output-format json.
    const { layer, out, client } = setupFeedbackDelete({ goOutput: "json" });
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "NonInteractiveError" });
      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(client.deleteCalls).toHaveLength(0);
      expect(out.rawChunks).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails loudly in json mode without --yes instead of silently deleting", () => {
    const { layer, out, client, processControl } = setupFeedbackDeleteHandler({
      output: { format: "json", promptConfirmFail: true },
    });
    return Effect.gen(function* () {
      yield* feedbackDeleteHandler(deleteArgs());

      expect(client.deleteCalls).toHaveLength(0);
      expect(out.messages).toContainEqual(expect.objectContaining({ type: "fail" }));
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a backend failure during the preview", () => {
    const { layer, out, client } = setupFeedbackDelete({
      client: { previewFailWith: "backend unavailable" },
    });
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "FeedbackBackendError", operation: "preview" });
      expect(client.deleteCalls).toHaveLength(0);
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "success" }));
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a backend failure during the delete", () => {
    const { layer, out, telemetryState } = setupFeedbackDelete({
      client: { previewText: "doomed", deleteFailWith: "backend unavailable" },
      yes: true,
    });
    return Effect.gen(function* () {
      const error = yield* feedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "FeedbackBackendError", operation: "delete" });
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "success" }));
      // The finalizer runs on failure too.
      expect(telemetryState.flushCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("never sends the token or project ref value to PostHog", () => {
    const { layer, analytics, client } = setupFeedbackDeleteHandler({
      yes: true,
      args: ["feedback", "delete", TOKEN, "--project-ref", "abcdefghijklmnopqrst"],
    });
    return Effect.gen(function* () {
      yield* feedbackDeleteHandler(deleteArgs({ projectRef: Option.some("abcdefghijklmnopqrst") }));

      expect(client.deleteCalls).toHaveLength(1);
      const events = analytics.captured.filter((c) => c.event === "cli_command_executed");
      expect(events).toHaveLength(1);
      const serialized = JSON.stringify(events[0]);
      // The token is a positional (structurally excluded from the flags map)
      // and --project-ref has no telemetry-safe marking, so its value redacts.
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain("abcdefghijklmnopqrst");
      expect(Object.keys(events[0]?.properties.flags ?? {})).toEqual(["project-ref"]);
    }).pipe(Effect.provide(layer));
  });
});
