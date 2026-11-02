import { type V1ListAllSnippetsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  VALID_REF,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { describeHostedTargetSelection } from "../../../../tests/helpers/hosted-target-selection.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import { snippetsList } from "./list.handler.ts";

type SnippetsResponse = typeof V1ListAllSnippetsOutput.Type;

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const SNIPPET_ID = "00000000-0000-4000-8000-000000000001";

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
      // `renderGlamourTable` bypasses glamour's markdown-table escaping, so
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

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: unknown;
  status?: number;
  network?: "fail";
}

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const tempRoot = useTempWorkdir("supabase-snippets-list-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SINGLE_RESPONSE },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
  });
  return { layer, out, api, telemetry, cache };
}

describe("snippets list integration", () => {
  it.effect("renders an ASCII table in text mode with all six columns", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
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

  it.effect("preserves literal `|` characters in snippet name and owner username", () => {
    const { layer, out } = setup({ response: PIPE_RESPONSE });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toContain("name|with|pipes");
      expect(out.stdoutText).toContain("user|name");
      expect(out.stdoutText).not.toContain("\\|");
    }).pipe(Effect.provide(layer));
  });

  it.effect("formats RFC3339 timestamps as UTC YYYY-MM-DD HH:MM:SS", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toContain("2023-10-13 17:48:58");
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves a non-RFC3339 inserted_at string untouched", () => {
    const { layer, out } = setup({ response: RAW_TIMESTAMP_RESPONSE });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toContain("not-an-rfc3339");
      // The valid updated_at is still formatted.
      expect(out.stdoutText).toContain("2023-10-13 17:48:58");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a success event with the full response under --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toEqual(SINGLE_RESPONSE);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits the raw response body, keys and unknown fields intact, under json", () => {
    const body = {
      cursor: "next-page",
      data: [
        {
          favorite: true,
          id: SNIPPET_ID,
          project: { name: "Proj", id: 1, ref: "extra-ref" },
          name: "Create table",
          type: "sql",
          visibility: "user",
          description: null,
          inserted_at: "2023-10-13T17:48:58.491Z",
          updated_at: "2023-10-13T17:48:58.491Z",
          owner: null,
          updated_by: null,
        },
      ],
    };
    const { layer, out } = setup({ format: "json", response: body });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(toJson(success?.data)).toBe(toJson(body));
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps an empty data array empty under json", () => {
    const { layer, out } = setup({ format: "json", response: EMPTY_RESPONSE });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(toJson(success?.data)).toBe('{"data":[]}');
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "renders a snippet whose owner and updated_by are null with an empty owner cell",
    () => {
      const { layer, out } = setup({
        response: { data: [{ ...SNIPPET_BASE, owner: null, updated_by: null }] },
      });
      return Effect.gen(function* () {
        yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
        const row = out.stdoutText.split("\n").find((line) => line.includes(SNIPPET_ID));
        const cells = row?.split("|").map((cell) => cell.trim());
        expect(cells?.[1]).toBe("Create table");
        expect(cells?.[3]).toBe("");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("renders a snippet with a visibility the contract does not list", () => {
    const { layer, out } = setup({
      response: { data: [{ ...SNIPPET_BASE, visibility: "team" }] },
    });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toContain("team");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with a decode network error when the body does not match the contract", () => {
    const { layer } = setup({ response: { data: [{ id: SNIPPET_ID }] } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        snippetsList({ remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "SnippetsListNetworkError",
          decode: true,
        });
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a result event under --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output=json emits alphabetically-keyed JSON, preserving empty arrays", () => {
    const { layer, out } = setup({ outputFlag: "json", response: EMPTY_RESPONSE });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      // Raw-HTTP bypass echoes whatever the API sent — no `nullForEmptyArrays`
      // coercion (real responses always send `[]`, never null).
      expect(out.stdoutText).toBe(`{
  "data": []
}
`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output=yaml emits a `data:` block", () => {
    const { layer, out } = setup({ outputFlag: "yaml" });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toContain("data:");
      expect(out.stdoutText).toContain(SNIPPET_ID);
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output=toml fails when a snippet carries a description", () => {
    // The nullable `description` field can't be represented in TOML, so this
    // fails whenever any snippet has a `description` key (present-with-value
    // or explicit null).
    const { layer } = setup({ outputFlag: "toml" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        snippetsList({ remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("SnippetsTomlEncodeError");
        expect(causeText).toContain(
          "failed to output toml: cannot encode a map with non-string keys",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output=toml encodes an empty snippet list", () => {
    const { layer, out } = setup({ outputFlag: "toml", response: EMPTY_RESPONSE });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toBe("Data = []\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "--output=env fails with SnippetsEnvNotSupportedError, flushes telemetry+cache, and does not call the API",
    () => {
      const { layer, api, telemetry, cache } = setup({ outputFlag: "env" });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          snippetsList({ remote: Option.none(), projectRef: Option.none() }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("SnippetsEnvNotSupportedError");
          expect(causeText).toContain("--output env flag is not supported");
        }
        expect(api.requests).toHaveLength(0);
        expect(telemetry.flushed).toBe(true);
        expect(cache.cached).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("--output=pretty falls through to the text renderer", () => {
    const { layer, out } = setup({ outputFlag: "pretty" });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toContain("VISIBILITY");
      expect(out.stdoutText).toContain(SNIPPET_ID);
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output wins over --output-format when both are set", () => {
    const { layer, out } = setup({ format: "json", outputFlag: "yaml" });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toContain("data:");
      expect(out.stdoutText.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes the resolved project_ref as a `project_ref` query parameter", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.urlWithParams).toContain(`/v1/snippets?project_ref=${VALID_REF}`);
      assertPermissionDrift({ command: "snippets list", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses the --remote=<ref> value over the resolver's linked-project default", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* snippetsList({
        remote: Option.some({ _tag: "Ref", ref: flagRef }),
        projectRef: Option.none(),
      });
      expect(api.requests[0]?.urlWithParams).toContain(`project_ref=${flagRef}`);
      assertPermissionDrift({
        command: "snippets list",
        activeFlags: { remote: flagRef },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fills the linked-project cache through the real cache layer", () => {
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.succeed(
          request.url === `https://api.supabase.com/v1/projects/${VALID_REF}`
            ? jsonResponse(request, 200, {
                ref: VALID_REF,
                name: "alpha",
                organization_id: "org-123",
                organization_slug: "acme",
                id: VALID_REF,
                region: "us-east-1",
                created_at: "2026-01-01T00:00:00Z",
                status: "ACTIVE_HEALTHY",
                database: {
                  host: "db.example.com",
                  version: "15",
                  postgres_engine: "15",
                  release_channel: "ga",
                },
              })
            : jsonResponse(request, 200, SINGLE_RESPONSE),
        ),
    });
    const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
    const layer = buildTestRuntime({
      out: mockOutput(),
      api,
      cliSettings,
      linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/snippets",
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      assertPermissionDrift({ command: "snippets list", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with SnippetsListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        snippetsList({ remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("SnippetsListUnexpectedStatusError");
        expect(causeText).toContain("unexpected list snippets status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with SnippetsListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        snippetsList({ remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("SnippetsListNetworkError");
        expect(causeText).toContain("failed to list snippets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry and writes linked-project cache even on API failure", () => {
    const { layer, telemetry, cache } = setup({ status: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(snippetsList({ remote: Option.none(), projectRef: Option.none() }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503 });
    return Effect.gen(function* () {
      yield* snippetsList({ remote: Option.none(), projectRef: Option.none() }).pipe(
        withJsonErrorHandling,
      );
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  describeHostedTargetSelection("snippets list", {
    respond: (request) => Effect.succeed(jsonResponse(request, 200, SINGLE_RESPONSE)),
    run: (flags) => snippetsList(flags),
  });
});
