import { describe, expect, it } from "@effect/vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Stdio } from "effect";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  FeedbackBackendError,
  FeedbackClient,
} from "../../../../shared/feedback/feedback-client.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockTelemetryRuntime,
} from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import type { LegacyFeedbackDeleteArgs } from "./delete.command.ts";
import { legacyFeedbackDeleteHandler } from "./delete.command.ts";
import {
  LEGACY_FEEDBACK_INVALID_TOKEN_MESSAGE,
  LEGACY_FEEDBACK_NOT_FOUND_MESSAGE,
} from "./delete.errors.ts";
import { legacyFeedbackDelete } from "./delete.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-feedback-delete-int-");

const TOKEN = "123e4567-e89b-12d3-a456-426614174000";

function deleteArgs(overrides: Partial<LegacyFeedbackDeleteArgs> = {}): LegacyFeedbackDeleteArgs {
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
                  }),
                )
              : Effect.succeed(Option.fromNullishOr(opts.previewText));
          }),
        delete: (token, context) =>
          Effect.suspend(() => {
            deleteCalls.push({ token, projectRef: context?.projectRef, userId: context?.userId });
            return opts.deleteFailWith !== undefined
              ? Effect.fail(
                  new FeedbackBackendError({ message: opts.deleteFailWith, operation: "delete" }),
                )
              : Effect.succeed({ deleted: opts.deleteMatches ?? true });
          }),
      }),
    ),
    previewCalls,
    deleteCalls,
  };
}

function setupLegacyFeedbackDelete(
  opts: {
    output?: Parameters<typeof mockOutput>[0];
    client?: MockClientOpts;
    yes?: boolean;
    /** Simulates `SUPABASE_PROJECT_ID`, the only source `LegacyCliConfig` reads. */
    projectIdEnv?: string;
    /** Simulates the gotrue user id persisted to telemetry.json at login. */
    distinctId?: string;
    consent?: "granted" | "denied";
  } = {},
) {
  const out = mockOutput(opts.output ?? { promptConfirmResponses: [true] });
  const client = mockFeedbackClient(opts.client ?? { previewText: "my papercut" });
  const layer = Layer.mergeAll(
    out.layer,
    client.layer,
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
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(CliArgs, { args: [] }),
    // Real filesystem: the handler reads `supabase/.temp/project-ref` from the
    // temp workdir, so this must not be stubbed out.
    BunServices.layer,
  );
  return { layer, out, client };
}

// Extra layers required by the wrapped `legacyFeedbackDeleteHandler` (the exact
// wiring `Command.withHandler` uses): instrumentation + json error handling.
function setupLegacyFeedbackDeleteHandler(
  opts: Parameters<typeof setupLegacyFeedbackDelete>[0] & { args?: ReadonlyArray<string> } = {},
) {
  const base = setupLegacyFeedbackDelete(opts);
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

describe("legacy feedback delete", () => {
  it.live("previews the feedback, confirms, and deletes it", () => {
    const { layer, out, client } = setupLegacyFeedbackDelete();
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs());

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
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a token that is not a UUID before contacting the backend", () => {
    const { layer, client } = setupLegacyFeedbackDelete();
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackDelete(deleteArgs({ token: "not-a-uuid" })).pipe(
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "LegacyFeedbackInvalidTokenError",
        message: LEGACY_FEEDBACK_INVALID_TOKEN_MESSAGE,
      });
      expect(client.previewCalls).toHaveLength(0);
      expect(client.deleteCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts an uppercase token and lowercases it for the backend", () => {
    const { layer, client } = setupLegacyFeedbackDelete({ yes: true });
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs({ token: TOKEN.toUpperCase() }));

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: undefined }]);
      expect(client.deleteCalls).toEqual([{ token: TOKEN, projectRef: undefined }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("cancels without deleting when the confirmation is declined", () => {
    const { layer, client } = setupLegacyFeedbackDelete({
      output: { promptConfirmResponses: [false] },
    });
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "LegacyFeedbackDeleteCancelledError" });
      expect(client.deleteCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("--yes skips the confirmation prompt", () => {
    const { layer, out, client } = setupLegacyFeedbackDelete({ yes: true });
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs());

      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(client.deleteCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a remediation hint when the token matches no feedback", () => {
    const { layer, client } = setupLegacyFeedbackDelete({ client: {} });
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "LegacyFeedbackNotFoundError",
        message: LEGACY_FEEDBACK_NOT_FOUND_MESSAGE,
      });
      expect(client.deleteCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails as not found when the delete matches zero rows after the preview", () => {
    // The row disappeared between preview and delete (e.g. deleted elsewhere).
    const { layer, client } = setupLegacyFeedbackDelete({
      client: { previewText: "raced", deleteMatches: false },
      yes: true,
    });
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "LegacyFeedbackNotFoundError" });
      expect(client.deleteCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("sends the linked project ref written by supabase link", () => {
    const { layer, client } = setupLegacyFeedbackDelete({ yes: true });
    writeLinkedProjectRef(tempRoot.current, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs());

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: LEGACY_VALID_REF }]);
      expect(client.deleteCalls).toEqual([{ token: TOKEN, projectRef: LEGACY_VALID_REF }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("prefers --project-ref over SUPABASE_PROJECT_ID and the linked ref file", () => {
    const { layer, client } = setupLegacyFeedbackDelete({
      yes: true,
      projectIdEnv: "envenvenvenvenvenvre",
    });
    writeLinkedProjectRef(tempRoot.current, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs({ projectRef: Option.some("flagflagflagflagflag") }));

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: "flagflagflagflagflag" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("prefers SUPABASE_PROJECT_ID over the linked ref file", () => {
    const { layer, client } = setupLegacyFeedbackDelete({
      yes: true,
      projectIdEnv: "envenvenvenvenvenvre",
    });
    writeLinkedProjectRef(tempRoot.current, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs());

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: "envenvenvenvenvenvre" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("presents the persisted gotrue user id with the preview and the delete", () => {
    // Rows submitted while logged in carry a user_id, and the RLS only
    // matches them when the same id arrives as the x-feedback-user-id header.
    const { layer, client } = setupLegacyFeedbackDelete({
      yes: true,
      distinctId: "11111111-2222-3333-4444-555555555555",
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs());

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
    const { layer, client } = setupLegacyFeedbackDelete({
      yes: true,
      distinctId: "11111111-2222-3333-4444-555555555555",
      consent: "denied",
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs());

      expect(client.deleteCalls[0]?.userId).toBe("11111111-2222-3333-4444-555555555555");
    }).pipe(Effect.provide(layer));
  });

  it.live("sends no user id when not logged in", () => {
    const { layer, client } = setupLegacyFeedbackDelete({ yes: true });
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs());

      expect(client.previewCalls[0]?.userId).toBeUndefined();
      expect(client.deleteCalls[0]?.userId).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("degrades to no project ref when the linked ref file cannot be read", () => {
    const { layer, client } = setupLegacyFeedbackDelete({ yes: true });
    writeLinkedProjectRef(tempRoot.current, LEGACY_VALID_REF, { asDirectory: true });
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs());

      expect(client.previewCalls).toEqual([{ token: TOKEN, projectRef: undefined }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("returns the deleted feedback text in json output format", () => {
    const { layer, out } = setupLegacyFeedbackDelete({
      output: { format: "json" },
      client: { previewText: "json feedback" },
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackDelete(deleteArgs());

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

  it.live("fails loudly in json mode without --yes instead of silently deleting", () => {
    const { layer, out, client, processControl } = setupLegacyFeedbackDeleteHandler({
      output: { format: "json", promptConfirmFail: true },
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackDeleteHandler(deleteArgs());

      expect(client.deleteCalls).toHaveLength(0);
      expect(out.messages).toContainEqual(expect.objectContaining({ type: "fail" }));
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a backend failure during the preview", () => {
    const { layer, out, client } = setupLegacyFeedbackDelete({
      client: { previewFailWith: "backend unavailable" },
    });
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "FeedbackBackendError", operation: "preview" });
      expect(client.deleteCalls).toHaveLength(0);
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "success" }));
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a backend failure during the delete", () => {
    const { layer, out } = setupLegacyFeedbackDelete({
      client: { previewText: "doomed", deleteFailWith: "backend unavailable" },
      yes: true,
    });
    return Effect.gen(function* () {
      const error = yield* legacyFeedbackDelete(deleteArgs()).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "FeedbackBackendError", operation: "delete" });
      expect(out.messages).not.toContainEqual(expect.objectContaining({ type: "success" }));
    }).pipe(Effect.provide(layer));
  });

  it.live("never sends the token or project ref value to PostHog", () => {
    const { layer, analytics, client } = setupLegacyFeedbackDeleteHandler({
      yes: true,
      args: ["feedback", "delete", TOKEN, "--project-ref", "abcdefghijklmnopqrst"],
    });
    return Effect.gen(function* () {
      yield* legacyFeedbackDeleteHandler(
        deleteArgs({ projectRef: Option.some("abcdefghijklmnopqrst") }),
      );

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
