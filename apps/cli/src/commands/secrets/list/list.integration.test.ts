import { type V1ListAllProjectsOutput, type V1ListAllSecretsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
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
import { secretsList } from "./list.handler.ts";

type SecretsResponse = typeof V1ListAllSecretsOutput.Type;

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const SAMPLE_SECRETS: SecretsResponse = [
  { name: "FOO", value: "digest-foo" },
  { name: "BAR", value: "digest-bar" },
];

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

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: SecretsResponse;
  status?: number;
  network?: "fail";
  projectId?: Option.Option<string>;
}

const tempRoot = useTempWorkdir("supabase-secrets-list-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? [] },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    projectId: opts.projectId,
  });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
  });
  return { layer, out, api };
}

describe("secrets list integration", () => {
  it.effect("renders a Glamour ASCII table with NAME and DIGEST columns in text mode", () => {
    const { layer, out } = setup({ response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("DIGEST");
      expect(out.stdoutText).toContain("BAR");
      expect(out.stdoutText).toContain("FOO");
      expect(out.stdoutText).toContain("digest-foo");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sorts secrets alphabetically by name regardless of API response order", () => {
    const { layer, out } = setup({
      response: [
        { name: "ZED", value: "z-digest" },
        { name: "ALPHA", value: "a-digest" },
        { name: "MID", value: "m-digest" },
      ],
    });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      const alphaPos = out.stdoutText.indexOf("ALPHA");
      const midPos = out.stdoutText.indexOf("MID");
      const zedPos = out.stdoutText.indexOf("ZED");
      expect(alphaPos).toBeGreaterThan(-1);
      expect(midPos).toBeGreaterThan(alphaPos);
      expect(zedPos).toBeGreaterThan(midPos);
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders literal `|` characters in secret names without escaping", () => {
    const { layer, out } = setup({
      response: [{ name: "with|pipe", value: "digest" }],
    });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      // The renderer skips markdown escaping entirely, so the pipe passes through literally.
      expect(out.stdoutText).toContain("with|pipe");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a success event with { secrets } for --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        secrets: [
          { name: "BAR", value: "digest-bar" },
          { name: "FOO", value: "digest-foo" },
        ],
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a success event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits byte-exact indented JSON to stdout for --output json", () => {
    const { layer, out } = setup({ outputFlag: "json", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        `[
  {
    "name": "BAR",
    "value": "digest-bar"
  },
  {
    "name": "FOO",
    "value": "digest-foo"
  }
]
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a YAML array to stdout for --output yaml", () => {
    const { layer, out } = setup({ outputFlag: "yaml", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("- name: BAR");
      expect(out.stdoutText).toContain("value: digest-bar");
      expect(out.stdoutText).toContain("- name: FOO");
    }).pipe(Effect.provide(layer));
  });

  it.effect("wraps the array as { secrets = [...] } for --output toml", () => {
    const { layer, out } = setup({ outputFlag: "toml", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("[[secrets]]");
      expect(out.stdoutText).toContain('  Name = "BAR"');
      expect(out.stdoutText).toContain('  Value = "digest-bar"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with SecretsEnvNotSupportedError for --output env", () => {
    const { layer } = setup({ outputFlag: "env", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(secretsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("SecretsEnvNotSupportedError");
        expect(causeText).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats --output pretty as identical to text mode (Glamour table)", () => {
    const { layer, out } = setup({ outputFlag: "pretty", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("DIGEST");
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output flag value wins over --output-format when both provided", () => {
    const { layer, out } = setup({
      format: "json",
      outputFlag: "yaml",
      response: SAMPLE_SECRETS,
    });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("- name: BAR");
      expect(out.stdoutText.startsWith("[")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes the resolved project ref into the listAllSecrets URL", () => {
    const { layer, api } = setup({ response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/secrets`);
      assertPermissionDrift({ command: "secrets list", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses --project-ref flag value over CommandSettings.projectId env", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
      assertPermissionDrift({
        command: "secrets list",
        activeFlags: { "project-ref": true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the projects for the picker when no project is configured", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.succeed(
          request.url === "https://api.supabase.com/v1/projects"
            ? jsonResponse(request, 200, [PROJECT])
            : jsonResponse(request, 200, SAMPLE_SECRETS),
        ),
    });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: tempRoot.current, projectId: Option.none() }),
      tty: mockTty({ stdinIsTty: true }),
    });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `GET https://api.supabase.com/v1/projects/${VALID_REF}/secrets`,
      ]);
      expect(out.stdoutText).toContain("digest-foo");
      assertPermissionDrift({ command: "secrets list", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fills the linked-project cache through the real cache layer", () => {
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.succeed(
          request.url === `https://api.supabase.com/v1/projects/${VALID_REF}`
            ? jsonResponse(request, 200, PROJECT)
            : jsonResponse(request, 200, SAMPLE_SECRETS),
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
      yield* secretsList({ projectRef: Option.none() });
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}/secrets`,
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      assertPermissionDrift({ command: "secrets list", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with SecretsListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: [] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(secretsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("SecretsListUnexpectedStatusError");
        expect(causeText).toContain("unexpected list secrets status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with SecretsListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(secretsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("SecretsListNetworkError");
        expect(causeText).toContain("failed to list secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("withJsonErrorHandling emits a fail event in JSON mode on 503", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: [] });
    return Effect.gen(function* () {
      yield* secretsList({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
