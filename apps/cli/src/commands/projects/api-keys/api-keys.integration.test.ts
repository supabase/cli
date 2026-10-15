import type { V1GetProjectApiKeysOutput, V1ListAllProjectsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import { projectsApiKeys } from "./api-keys.handler.ts";

type ApiKeys = typeof V1GetProjectApiKeysOutput.Type;

const SAMPLE_KEYS: ApiKeys = [
  { name: "anon", api_key: "anon-secret" },
  { name: "service_role", api_key: null },
];

const REVEALED_KEYS: ApiKeys = [
  { name: "anon", api_key: "anon-secret" },
  { name: "service_role", api_key: "sb_secret_revealed" },
];

const FLAG_REF = "qrstuvwxyzabcdefghij";
const API = "https://api.supabase.com";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const PROJECT: (typeof V1ListAllProjectsOutput.Type)[number] = {
  id: VALID_REF,
  ref: VALID_REF,
  organization_id: "org-123",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  created_at: "2026-05-27T01:02:03Z",
  status: "ACTIVE_HEALTHY",
  database: {
    host: "db.alpha.supabase.co",
    version: "15.1",
    postgres_engine: "15",
    release_channel: "ga",
  },
};

const tempRoot = useTempWorkdir("supabase-projects-apikeys-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: ApiKeys;
  readonly status?: number;
  readonly network?: "fail";
  readonly projectId?: Option.Option<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SAMPLE_KEYS },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    projectId: opts.projectId ?? Option.some(VALID_REF),
  });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
  });
  return { layer, out, api };
}

describe("projects api-keys integration", () => {
  it.effect("lists api keys as a NAME / KEY VALUE table and masks null values", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: false });
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("KEY VALUE");
      expect(out.stdoutText).toContain("anon-secret");
      expect(out.stdoutText).toContain("******");
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the ref from --project-ref", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.some(FLAG_REF), reveal: false });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${FLAG_REF}/api-keys`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the ref from the linked project when --project-ref is omitted", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: false });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/api-keys`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("omits the reveal query param by default", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: false });
      expect(api.requests[0]?.urlWithParams).not.toContain("reveal");
      assertPermissionDrift({
        command: "projects api-keys",
        activeFlags: { reveal: false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends reveal=true when --reveal is passed", () => {
    const { layer, api } = setup({ response: REVEALED_KEYS });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: true });
      expect(api.requests[0]?.urlWithParams).toContain("reveal=true");
      assertPermissionDrift({
        command: "projects api-keys",
        activeFlags: { reveal: true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders the revealed secret key in full in the text table", () => {
    const { layer, out } = setup({ response: REVEALED_KEYS });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: true });
      expect(out.stdoutText).toContain("sb_secret_revealed");
      expect(out.stdoutText).not.toContain("******");
    }).pipe(Effect.provide(layer));
  });

  it.effect("includes the revealed secret in the env map for --output env --reveal", () => {
    const { layer, out } = setup({ outputFlag: "env", response: REVEALED_KEYS });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: true });
      expect(out.stdoutText).toContain('SUPABASE_SERVICE_ROLE_KEY="sb_secret_revealed"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("carries the revealed secret in the { keys } payload for --output-format json", () => {
    const { layer, out } = setup({ format: "json", response: REVEALED_KEYS });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: true });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ keys: REVEALED_KEYS });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits the revealed secret in the JSON array for --output json --reveal", () => {
    const { layer, out } = setup({ outputFlag: "json", response: REVEALED_KEYS });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: true });
      expect(out.stdoutText).toContain('"api_key": "sb_secret_revealed"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ProjectRefNotLinkedError when no ref can be resolved", () => {
    const { layer } = setup({ projectId: Option.none() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        projectsApiKeys({ projectRef: Option.none(), reveal: false }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ProjectRefNotLinkedError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a success event with { keys } for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: false });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ keys: SAMPLE_KEYS });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a success event for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: false });
      expect(out.messages.find((m) => m.type === "success")).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("encodes the SUPABASE_<NAME>_KEY map for --output env", () => {
    const { layer, out } = setup({ outputFlag: "env" });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: false });
      expect(out.stdoutText).toContain('SUPABASE_ANON_KEY="anon-secret"');
      expect(out.stdoutText).toContain('SUPABASE_SERVICE_ROLE_KEY="******"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("encodes the SUPABASE_<NAME>_KEY map for --output toml", () => {
    const { layer, out } = setup({ outputFlag: "toml" });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: false });
      expect(out.stdoutText).toContain('SUPABASE_ANON_KEY = "anon-secret"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a JSON array of api keys for --output json", () => {
    const { layer, out } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: false });
      expect(out.stdoutText).toContain('"name": "anon"');
      expect(out.stdoutText.startsWith("[\n")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a YAML array for --output yaml", () => {
    const { layer, out } = setup({ outputFlag: "yaml" });
    return Effect.gen(function* () {
      yield* projectsApiKeys({ projectRef: Option.none(), reveal: false });
      expect(out.stdoutText).toContain("name: anon");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ProjectsApiKeysNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        projectsApiKeys({ projectRef: Option.none(), reveal: false }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ProjectsApiKeysNetworkError");
        expect(causeText).toContain("failed to get api keys");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps HTTP 503 to `unexpected get api keys status 503`", () => {
    const { layer } = setup({ status: 503, response: [] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        projectsApiKeys({ projectRef: Option.none(), reveal: false }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ProjectsApiKeysUnexpectedStatusError");
        expect(causeText).toContain("unexpected get api keys status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the keys of the project chosen in the picker and fills the real cache", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.sync(() => {
          if (request.method === "GET" && request.url === `${API}/v1/projects`) {
            return jsonResponse(request, 200, [PROJECT]);
          }
          if (request.method === "GET" && request.url === `${API}/v1/projects/${VALID_REF}`) {
            return jsonResponse(request, 200, PROJECT);
          }
          if (request.url === `${API}/v1/projects/${VALID_REF}/api-keys`) {
            return jsonResponse(request, 200, SAMPLE_KEYS);
          }
          return jsonResponse(request, 404, { message: "unexpected request" });
        }),
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
      linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);

      yield* projectsApiKeys({ projectRef: Option.none(), reveal: false });

      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET ${API}/v1/projects`,
        `GET ${API}/v1/projects/${VALID_REF}/api-keys`,
        `GET ${API}/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stdoutText).toContain("anon-secret");
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "projects api-keys",
        activeFlags: { reveal: false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });
});
