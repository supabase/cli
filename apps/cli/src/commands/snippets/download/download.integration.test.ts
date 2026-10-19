import { type V1GetASnippetOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { describeHostedTargetSelection } from "../../../../tests/helpers/hosted-target-selection.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { snippetsDownload } from "./download.handler.ts";

const VALID_ID = "0b0d48f6-878b-4190-88d7-2ca33ed800bc";
// Raw 32-hex form of VALID_ID, uppercase.
const UPPER_HEX32_ID = "0B0D48F6878B419088D72CA33ED800BC";
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

// `outputFlag` is absent: the download handler doesn't consume `OutputFlag` at
// all — always prints raw SQL. Threading a value through would suggest a
// behavior difference that doesn't exist.
interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  status?: number;
  network?: "fail";
  response?: unknown;
}

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const tempRoot = useTempWorkdir("supabase-snippets-download-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SNIPPET_RESPONSE },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, telemetry, cache };
}

function stringLeaves(value: unknown): Array<string> {
  if (typeof value === "string") return [value];
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringLeaves);
  }
  return [];
}

describe("snippets download integration", () => {
  it.effect("prints raw SQL with a trailing newline in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.none(),
        projectRef: Option.none(),
      });
      expect(out.stdoutText).toBe(`${SQL}\n`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints only a newline in text mode when the snippet has no content", () => {
    const { layer, out } = setup({ response: { ...SNIPPET_RESPONSE, content: null } });
    return Effect.gen(function* () {
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.none(),
        projectRef: Option.none(),
      });
      expect(out.stdoutText).toBe("\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits null owner, updated_by and content as the API returned them under json", () => {
    const body = { ...SNIPPET_RESPONSE, owner: null, updated_by: null, content: null };
    const { layer, out } = setup({ format: "json", response: body });
    return Effect.gen(function* () {
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.none(),
        projectRef: Option.none(),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(toJson(success?.data)).toBe(toJson(body));
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with a decode network error when the body does not match the contract", () => {
    const { layer } = setup({ response: { id: VALID_ID } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        snippetsDownload({ snippetId: VALID_ID, remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "SnippetsDownloadNetworkError",
          decode: true,
        });
      }
    }).pipe(Effect.provide(layer));
  });

  // `--output` is ignored entirely: no read of `OutputFlag`, no branching.
  // Guards against a future refactor adding branch-on-outputFlag logic by
  // mistake — if the flag is consumed, this assertion diverges.
  it.effect("text mode is unaffected by any `--output` value", () => {
    const out = mockOutput({ format: "text" });
    const telemetry = mockTelemetryStateTracked();
    const cache = mockLinkedProjectCacheTracked();
    const api = mockCommandPlatformApi({ response: { status: 200, body: SNIPPET_RESPONSE } });
    const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
      outputFlag: Option.some("json"),
    });
    return Effect.gen(function* () {
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.none(),
        projectRef: Option.none(),
      });
      expect(out.stdoutText).toBe(`${SQL}\n`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a success event with the full response under --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.none(),
        projectRef: Option.none(),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toEqual(SNIPPET_RESPONSE);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a result event with the full response under --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.none(),
        projectRef: Option.none(),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toEqual(SNIPPET_RESPONSE);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "non-UUID input emits `invalid UUID length: N`, flushes telemetry+cache, skips API",
    () => {
      const { layer, api, telemetry, cache } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          snippetsDownload({
            snippetId: INVALID_ID,
            remote: Option.none(),
            projectRef: Option.none(),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("SnippetsInvalidIdError");
          expect(causeText).toContain("invalid snippet ID: invalid UUID length: 10");
        }
        expect(api.requests).toHaveLength(0);
        expect(telemetry.flushed).toBe(true);
        expect(cache.cached).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a 42-char input also produces the length error", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        snippetsDownload({
          snippetId: TOO_LONG_ID,
          remote: Option.none(),
          projectRef: Option.none(),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("invalid snippet ID: invalid UUID length: 42");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("a 36-char input with wrong dash positions emits `invalid UUID format`", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        snippetsDownload({
          snippetId: WRONG_FORMAT_ID,
          remote: Option.none(),
          projectRef: Option.none(),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("invalid snippet ID: invalid UUID format");
        // The offending value must not be embedded anywhere in the failure. The rendered
        // cause covers the message; `message` is a non-enumerable own prop, so the value
        // scan below covers payload fields only. Keep both assertions.
        expect(causeText).not.toContain(WRONG_FORMAT_ID);
        const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        // Guard against a vacuous pass: the failure must be a typed error, not a defect
        // or interruption, for the value scan below to mean anything.
        expect(failure).toBeDefined();
        expect(stringLeaves(failure).some((leaf) => leaf.includes(WRONG_FORMAT_ID))).toBe(false);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("calls GET /v1/snippets/{id} with the validated UUID and no project_ref query", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.none(),
        projectRef: Option.none(),
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(`/v1/snippets/${VALID_ID}`);
      expect(api.requests[0]?.urlParams).toBe("");
      assertPermissionDrift({ command: "snippets download", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a 32-hex UPPERCASE snippet id resolves to the canonical lowercase hyphenated URL",
    () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        yield* snippetsDownload({
          snippetId: UPPER_HEX32_ID,
          remote: Option.none(),
          projectRef: Option.none(),
        });
        expect(api.requests).toHaveLength(1);
        expect(api.requests[0]?.url).toContain(`/v1/snippets/${VALID_ID}`);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("uses the --remote=<ref> value when resolving the linked-project cache", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, cache, api } = setup();
    return Effect.gen(function* () {
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.some({ _tag: "Ref", ref: flagRef }),
        projectRef: Option.none(),
      });
      // The download endpoint itself takes only the snippet ID, but the
      // resolved project ref still flows into the linked-project cache write.
      expect(cache.cached).toBe(true);
      expect(api.requests).toHaveLength(1);
      assertPermissionDrift({
        command: "snippets download",
        activeFlags: { remote: flagRef },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists projects for the picker, sends no ref, and fills the real cache", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.url === "https://api.supabase.com/v1/projects") {
          return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
        }
        if (request.url === `https://api.supabase.com/v1/projects/${VALID_REF}`) {
          return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
        }
        return Effect.succeed(jsonResponse(request, 200, SNIPPET_RESPONSE));
      },
    });
    const cliSettings = mockCommandSettings({
      workdir: tempRoot.current,
      projectId: Option.none(),
    });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings,
      tty: mockTty({ stdinIsTty: true }),
      telemetry: mockTelemetryStateTracked().layer,
      linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.none(),
        projectRef: Option.none(),
      });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `GET https://api.supabase.com/v1/snippets/${VALID_ID}`,
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(api.requests[1]?.urlParams).toBe("");
      expect(out.stdoutText).toBe(`${SQL}\n`);
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({ command: "snippets download", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with SnippetsDownloadUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        snippetsDownload({ snippetId: VALID_ID, remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("SnippetsDownloadUnexpectedStatusError");
        expect(causeText).toContain("unexpected download snippet status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with SnippetsDownloadNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        snippetsDownload({ snippetId: VALID_ID, remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("SnippetsDownloadNetworkError");
        expect(causeText).toContain("failed to download snippet");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.none(),
        projectRef: Option.none(),
      });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry and writes linked-project cache even on API failure", () => {
    const { layer, telemetry, cache } = setup({ status: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(
        snippetsDownload({ snippetId: VALID_ID, remote: Option.none(), projectRef: Option.none() }),
      );
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      yield* snippetsDownload({
        snippetId: VALID_ID,
        remote: Option.none(),
        projectRef: Option.none(),
      }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  describeHostedTargetSelection("snippets download", {
    operands: [VALID_ID],
    respond: (request) => Effect.succeed(jsonResponse(request, 200, SNIPPET_RESPONSE)),
    run: (flags) => snippetsDownload({ ...flags, snippetId: VALID_ID }),
  });
});
