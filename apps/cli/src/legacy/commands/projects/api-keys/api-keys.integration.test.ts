import type { V1GetProjectApiKeysOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyProjectsApiKeys } from "./api-keys.handler.ts";

type ApiKeys = typeof V1GetProjectApiKeysOutput.Type;

const SAMPLE_KEYS: ApiKeys = [
  { name: "anon", api_key: "anon-secret" },
  { name: "service_role", api_key: null },
];

const FLAG_REF = "qrstuvwxyzabcdefghij";

const tempRoot = useLegacyTempWorkdir("supabase-projects-apikeys-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: ApiKeys;
  readonly status?: number;
  readonly network?: "fail";
  readonly projectId?: Option.Option<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SAMPLE_KEYS },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    projectId: opts.projectId ?? Option.some(LEGACY_VALID_REF),
  });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api };
}

describe("legacy projects api-keys integration", () => {
  it.live("lists api keys as a NAME / KEY VALUE table and masks null values", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyProjectsApiKeys({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("KEY VALUE");
      expect(out.stdoutText).toContain("anon-secret");
      expect(out.stdoutText).toContain("******");
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves the ref from --project-ref", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyProjectsApiKeys({ projectRef: Option.some(FLAG_REF) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${FLAG_REF}/api-keys`);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves the ref from the linked project when --project-ref is omitted", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyProjectsApiKeys({ projectRef: Option.none() });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/api-keys`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectNotLinkedError when no ref can be resolved", () => {
    const { layer } = setup({ projectId: Option.none() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsApiKeys({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectNotLinkedError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { keys } for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyProjectsApiKeys({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ keys: SAMPLE_KEYS });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyProjectsApiKeys({ projectRef: Option.none() });
      expect(out.messages.find((m) => m.type === "success")).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("encodes the SUPABASE_<NAME>_KEY map for --output env", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacyProjectsApiKeys({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('SUPABASE_ANON_KEY="anon-secret"');
      expect(out.stdoutText).toContain('SUPABASE_SERVICE_ROLE_KEY="******"');
    }).pipe(Effect.provide(layer));
  });

  it.live("encodes the SUPABASE_<NAME>_KEY map for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacyProjectsApiKeys({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('SUPABASE_ANON_KEY = "anon-secret"');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON array of api keys for --output json", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyProjectsApiKeys({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('"name": "anon"');
      expect(out.stdoutText.startsWith("[\n")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a YAML array for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyProjectsApiKeys({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("name: anon");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectsApiKeysNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsApiKeys({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyProjectsApiKeysNetworkError");
        expect(json).toContain("failed to get api keys");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps HTTP 503 to `unexpected get api keys status 503`", () => {
    const { layer } = setup({ status: 503, response: [] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsApiKeys({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyProjectsApiKeysUnexpectedStatusError");
        expect(json).toContain("unexpected get api keys status 503");
      }
    }).pipe(Effect.provide(layer));
  });
});
