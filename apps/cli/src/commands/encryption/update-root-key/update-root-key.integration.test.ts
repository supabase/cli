import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { mockOutput, mockStdin } from "../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  VALID_REF,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { encryptionUpdateRootKey } from "./update-root-key.handler.ts";

const ROOT_KEY_RESPONSE = { root_key: "new-key" };

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly status?: number;
  readonly network?: "fail";
  readonly projectId?: Option.Option<string>;
  // stdin
  readonly stdinIsTty?: boolean;
  readonly pipedInput?: string;
  readonly promptPasswordResponses?: ReadonlyArray<string>;
}

const tempRoot = useTempWorkdir("supabase-encryption-update-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptPasswordResponses: opts.promptPasswordResponses,
  });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: ROOT_KEY_RESPONSE },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    projectId: opts.projectId ?? Option.some(VALID_REF),
  });
  const telemetry = mockTelemetryStateTracked();
  const linkedProjectCache = mockLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings,
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
    }),
    mockStdin(opts.stdinIsTty ?? false, opts.pipedInput),
  );
  return { layer, out, api, telemetry, linkedProjectCache };
}

const baseFlags = { projectRef: Option.none<string>() };

describe("encryption update-root-key integration", () => {
  it.live("reads a piped root key and PUTs it, printing the finished message to stderr", () => {
    const { layer, out, api } = setup({ pipedInput: "new-key" });
    return Effect.gen(function* () {
      yield* encryptionUpdateRootKey(baseFlags);
      const put = api.requests.find((r) => r.method === "PUT");
      expect(put?.url).toContain(`/v1/projects/${VALID_REF}/pgsodium`);
      expect(put?.body).toEqual({ root_key: "new-key" });
      // Prompt to stderr, trailing newline to stdout (defer Println),
      // finished notice to stderr.
      expect(out.stderrText).toContain("Enter a new root key: ");
      // The command path is wrapped in ANSI (aqua) in colour-capable
      // environments, so assert on the tokens around it — same convention as
      // `db/reset/reset.integration.test.ts`'s aqua'd branch name.
      expect(out.stderrText).toContain("Finished ");
      expect(out.stderrText).toContain("supabase root-key update");
      expect(out.stdoutText).toBe("\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("prompts for a masked root key when stdin is a TTY", () => {
    const { layer, api } = setup({
      stdinIsTty: true,
      promptPasswordResponses: ["tty-key"],
    });
    return Effect.gen(function* () {
      yield* encryptionUpdateRootKey(baseFlags);
      const put = api.requests.find((r) => r.method === "PUT");
      expect(put?.body).toEqual({ root_key: "tty-key" });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends an empty root key when piped stdin is empty", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* encryptionUpdateRootKey(baseFlags);
      const put = api.requests.find((r) => r.method === "PUT");
      expect(put?.body).toEqual({ root_key: "" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the updated config as a structured result in json mode", () => {
    const { layer, out } = setup({ format: "json", pipedInput: "new-key" });
    return Effect.gen(function* () {
      yield* encryptionUpdateRootKey(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("");
      expect(success?.data).toEqual({ root_key: "new-key" });
      // json mode reserves stdout for the structured result — no prompt newline.
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event in stream-json mode", () => {
    const { layer, out } = setup({ format: "stream-json", pipedInput: "new-key" });
    return Effect.gen(function* () {
      yield* encryptionUpdateRootKey(baseFlags);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toEqual({ root_key: "new-key" });
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a transport error when the network is down", () => {
    const { layer } = setup({ network: "fail", pipedInput: "new-key" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(encryptionUpdateRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("EncryptionNetworkError");
        expect(json).toContain("failed to update pgsodium config");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with an unexpected-status error on a 503", () => {
    const { layer } = setup({ status: 503, pipedInput: "new-key" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(encryptionUpdateRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("EncryptionUnexpectedStatusError");
        expect(json).toContain("unexpected update pgsodium config status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("does not start a spinner in json mode on failure", () => {
    const { layer, out } = setup({ format: "json", status: 503, pipedInput: "new-key" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(encryptionUpdateRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.progressEvents).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when no project ref can be resolved", () => {
    const { layer } = setup({ projectId: Option.none(), pipedInput: "new-key" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(encryptionUpdateRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("ProjectRefNotLinkedError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("writes the linked-project cache and flushes telemetry on success", () => {
    const { layer, telemetry, linkedProjectCache } = setup({ pipedInput: "new-key" });
    return Effect.gen(function* () {
      yield* encryptionUpdateRootKey(baseFlags);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes the linked-project cache and flushes telemetry on failure", () => {
    const { layer, telemetry, linkedProjectCache } = setup({
      status: 503,
      pipedInput: "new-key",
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(encryptionUpdateRootKey(baseFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
