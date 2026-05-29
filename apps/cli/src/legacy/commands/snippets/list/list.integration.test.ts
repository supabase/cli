import { type V1ListAllSnippetsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacySnippetsList } from "./list.handler.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type SnippetsResponse = typeof V1ListAllSnippetsOutput.Type;

const SNIPPET_ID = "00000000-0000-0000-0000-000000000001";

const SNIPPET_BASE = {
  id: SNIPPET_ID,
  inserted_at: "2023-10-13T17:48:58.491Z",
  updated_at: "2023-10-13T17:48:58.491Z",
  type: "sql" as const,
  visibility: "user" as const,
  name: "Create table",
  description: null,
  project: { id: 1, name: "Proj" },
  owner: { id: 7, username: "supaseed" },
  updated_by: { id: 7, username: "supaseed" },
  favorite: false,
};

const SINGLE_RESPONSE: SnippetsResponse = {
  data: [SNIPPET_BASE],
};

const PIPE_RESPONSE: SnippetsResponse = {
  data: [
    {
      ...SNIPPET_BASE,
      // Go's `strings.ReplaceAll(value, "|", "\\|")` is a markdown-intermediate
      // escape that glamour decodes back to literal `|` in the rendered ASCII
      // bytes. `renderGlamourTable` bypasses glamour, so we pass raw values —
      // any `|` in `name` / `owner.username` must appear literally in stdout.
      name: "name|with|pipes",
      owner: { id: 7, username: "user|name" },
    },
  ],
};

const RAW_TIMESTAMP_RESPONSE: SnippetsResponse = {
  data: [
    {
      ...SNIPPET_BASE,
      inserted_at: "not-an-rfc3339",
      updated_at: "2023-10-13T17:48:58.491Z",
    },
  ],
};

const EMPTY_RESPONSE: SnippetsResponse = {
  data: [],
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: SnippetsResponse;
  status?: number;
  network?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-snippets-list-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SINGLE_RESPONSE },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api, telemetry, cache };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy snippets list integration", () => {
  it.live("renders an ASCII table in text mode with all six columns", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("ID");
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("VISIBILITY");
      expect(out.stdoutText).toContain("OWNER");
      expect(out.stdoutText).toContain("CREATED AT (UTC)");
      expect(out.stdoutText).toContain("UPDATED AT (UTC)");
      expect(out.stdoutText).toContain(SNIPPET_ID);
      expect(out.stdoutText).toContain("Create table");
      expect(out.stdoutText).toContain("supaseed");
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves literal `|` characters in snippet name and owner username (Go parity)", () => {
    const { layer, out } = setup({ response: PIPE_RESPONSE });
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("name|with|pipes");
      expect(out.stdoutText).toContain("user|name");
      // No `\|` escape — Go's intermediate escape is round-tripped by glamour.
      expect(out.stdoutText).not.toContain("\\|");
    }).pipe(Effect.provide(layer));
  });

  it.live("formats RFC3339 timestamps as UTC YYYY-MM-DD HH:MM:SS", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("2023-10-13 17:48:58");
    }).pipe(Effect.provide(layer));
  });

  it.live("leaves a non-RFC3339 inserted_at string untouched", () => {
    const { layer, out } = setup({ response: RAW_TIMESTAMP_RESPONSE });
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("not-an-rfc3339");
      // The valid updated_at is still formatted.
      expect(out.stdoutText).toContain("2023-10-13 17:48:58");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with the full response under --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      const data = success?.data as SnippetsResponse | undefined;
      expect(data?.data).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event under --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=json emits alphabetically-keyed JSON with `data: null` for empty", () => {
    const { layer, out } = setup({ goOutput: "json", response: EMPTY_RESPONSE });
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      // Mirrors Go's `api.SnippetList{}` → `{"data": null}\n` (no other keys).
      expect(out.stdoutText).toBe(`{
  "data": null
}
`);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=yaml emits a `data:` block", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("data:");
      expect(out.stdoutText).toContain(SNIPPET_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=toml emits the response", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(out.stdoutText.length).toBeGreaterThan(0);
      expect(out.stdoutText).toContain(SNIPPET_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "Go --output=env fails with LegacySnippetsEnvNotSupportedError, flushes telemetry+cache, and does not call the API",
    () => {
      const { layer, api, telemetry, cache } = setup({ goOutput: "env" });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySnippetsList({ projectRef: Option.none() }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySnippetsEnvNotSupportedError");
          // Byte-exact match against Go's `ErrEnvNotSupported`
          // (apps/cli-go/internal/utils/output.go:41).
          expect(dump).toContain("--output env flag is not supported");
        }
        expect(api.requests).toHaveLength(0);
        // Go's PersistentPostRun + Execute both fire on this error path.
        expect(telemetry.flushed).toBe(true);
        expect(cache.cached).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("Go --output=pretty falls through to the text renderer", () => {
    const { layer, out } = setup({ goOutput: "pretty" });
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("VISIBILITY");
      expect(out.stdoutText).toContain(SNIPPET_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output wins over --output-format when both are set", () => {
    const { layer, out } = setup({ format: "json", goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("data:");
      expect(out.stdoutText.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes the resolved project_ref as a `project_ref` query parameter", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.urlWithParams).toContain(
        `/v1/snippets?project_ref=${LEGACY_VALID_REF}`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over the resolver's linked-project default", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.urlWithParams).toContain(`project_ref=${flagRef}`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySnippetsListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySnippetsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySnippetsListUnexpectedStatusError");
        expect(dump).toContain("unexpected list snippets status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySnippetsListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySnippetsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySnippetsListNetworkError");
        expect(dump).toContain("failed to list snippets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and writes linked-project cache even on API failure", () => {
    const { layer, telemetry, cache } = setup({ status: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(legacySnippetsList({ projectRef: Option.none() }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      yield* legacySnippetsList({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
