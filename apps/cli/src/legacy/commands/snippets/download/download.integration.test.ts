import { type V1GetASnippetOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacySnippetsDownload } from "./download.handler.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ID = "0b0d48f6-878b-4190-88d7-2ca33ed800bc";
const INVALID_ID = "not-a-uuid"; // length 10 → "invalid UUID length: 10"
const TOO_LONG_ID = "0b0d48f6-878b-4190-88d7-2ca33ed800bc-extra"; // length 42 (3 ungrouped: 32, 36, 38, 41)
const WRONG_FORMAT_ID = "0b0d48f6.878b.4190.88d7.2ca33ed800bc"; // length 36, no dashes in canonical positions
const SQL = "select 1;";

type SnippetResponse = typeof V1GetASnippetOutput.Type;

const SNIPPET_RESPONSE: SnippetResponse = {
  id: VALID_ID,
  inserted_at: "2023-10-13T17:48:58.491Z",
  updated_at: "2023-10-13T17:48:58.491Z",
  type: "sql",
  visibility: "user",
  name: "Create table",
  description: null,
  project: { id: 1, name: "Proj" },
  owner: { id: 7, username: "supaseed" },
  updated_by: { id: 7, username: "supaseed" },
  favorite: false,
  content: { schema_version: "1.0.0", sql: SQL },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// `goOutput` is intentionally absent: the download handler does not consume
// `LegacyOutputFlag` at all (matches Go's `download.Run`, which calls
// `fmt.Println(resp.JSON200.Content.Sql)` unconditionally). Threading a value
// through here would suggest a behaviour difference that does not exist.
interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  status?: number;
  network?: "fail";
  response?: SnippetResponse;
}

const tempRoot = useLegacyTempWorkdir("supabase-snippets-download-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SNIPPET_RESPONSE },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, telemetry, cache };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy snippets download integration", () => {
  it.live("prints raw SQL with a trailing newline in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.none() });
      expect(out.stdoutText).toBe(`${SQL}\n`);
    }).pipe(Effect.provide(layer));
  });

  // Go's `download.Run` ignores `--output` entirely (download.go:25). The TS
  // handler must reproduce that: no read of `LegacyOutputFlag`, no branching.
  // This regression guards against a future refactor that adds branch-on-goOutput
  // logic by mistake — if the flag is consumed, this assertion will diverge.
  it.live("text mode is unaffected by any Go `--output` value (Go parity)", () => {
    const out = mockOutput({ format: "text" });
    const telemetry = mockLegacyTelemetryStateTracked();
    const cache = mockLegacyLinkedProjectCacheTracked();
    const api = mockLegacyPlatformApi({ response: { status: 200, body: SNIPPET_RESPONSE } });
    const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
    const layer = buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
      goOutput: Option.some("json"),
    });
    return Effect.gen(function* () {
      yield* legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.none() });
      expect(out.stdoutText).toBe(`${SQL}\n`);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with the full response under --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      const data = success?.data as SnippetResponse | undefined;
      expect(data?.id).toBe(VALID_ID);
      expect(data?.name).toBe("Create table");
      expect(data?.content.sql).toBe(SQL);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event with the full response under --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      const data = success?.data as SnippetResponse | undefined;
      expect(data?.content.sql).toBe(SQL);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "non-UUID input emits Go-format `invalid UUID length: N`, flushes telemetry+cache, skips API",
    () => {
      const { layer, api, telemetry, cache } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySnippetsDownload({ snippetId: INVALID_ID, projectRef: Option.none() }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySnippetsInvalidIdError");
          // Go's `uuid.Parse` returns `invalid UUID length: 10` for "not-a-uuid"
          // (length 10), wrapped by download.go:17 as `invalid snippet ID: %w`.
          expect(dump).toContain("invalid snippet ID: invalid UUID length: 10");
        }
        expect(api.requests).toHaveLength(0);
        // Go's PersistentPostRun + Execute both still fire on this error path.
        expect(telemetry.flushed).toBe(true);
        expect(cache.cached).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a 42-char input also produces the length error", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySnippetsDownload({ snippetId: TOO_LONG_ID, projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("invalid snippet ID: invalid UUID length: 42");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("a 36-char input with wrong dash positions emits `invalid UUID format`", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySnippetsDownload({ snippetId: WRONG_FORMAT_ID, projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("invalid snippet ID: invalid UUID format");
        // The offending value must NOT be embedded (Go does not include it).
        expect(dump).not.toContain(WRONG_FORMAT_ID);
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("calls GET /v1/snippets/{id} with the validated UUID and no project_ref query", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(`/v1/snippets/${VALID_ID}`);
      expect(api.requests[0]?.urlParams).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value when resolving the linked-project cache", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, cache } = setup();
    return Effect.gen(function* () {
      yield* legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.some(flagRef) });
      // The download endpoint itself takes only the snippet ID, but the
      // resolved project ref still flows into the linked-project cache write
      // (Go's PersistentPostRun behaviour).
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySnippetsDownloadUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySnippetsDownloadUnexpectedStatusError");
        expect(dump).toContain("unexpected download snippet status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySnippetsDownloadNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySnippetsDownloadNetworkError");
        expect(dump).toContain("failed to download snippet");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and writes linked-project cache even on API failure", () => {
    const { layer, telemetry, cache } = setup({ status: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(
        legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.none() }),
      );
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      yield* legacySnippetsDownload({ snippetId: VALID_ID, projectRef: Option.none() }).pipe(
        withJsonErrorHandling,
      );
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
