import { type V1ListAllSecretsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacySecretsList } from "./list.handler.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type SecretsResponse = typeof V1ListAllSecretsOutput.Type;

const SAMPLE_SECRETS: SecretsResponse = [
  { name: "FOO", value: "digest-foo" },
  { name: "BAR", value: "digest-bar" },
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: SecretsResponse;
  status?: number;
  network?: "fail";
  projectId?: Option.Option<string>;
}

const tempRoot = useLegacyTempWorkdir("supabase-secrets-list-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? [] },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    projectId: opts.projectId,
  });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy secrets list integration", () => {
  it.live("renders a Glamour ASCII table with NAME and DIGEST columns in text mode", () => {
    const { layer, out } = setup({ response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("NAME");
      expect(out.stdoutText).toContain("DIGEST");
      expect(out.stdoutText).toContain("BAR");
      expect(out.stdoutText).toContain("FOO");
      expect(out.stdoutText).toContain("digest-foo");
    }).pipe(Effect.provide(layer));
  });

  it.live("sorts secrets alphabetically by name regardless of API response order", () => {
    const { layer, out } = setup({
      response: [
        { name: "ZED", value: "z-digest" },
        { name: "ALPHA", value: "a-digest" },
        { name: "MID", value: "m-digest" },
      ],
    });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      const alphaPos = out.stdoutText.indexOf("ALPHA");
      const midPos = out.stdoutText.indexOf("MID");
      const zedPos = out.stdoutText.indexOf("ZED");
      expect(alphaPos).toBeGreaterThan(-1);
      expect(midPos).toBeGreaterThan(alphaPos);
      expect(zedPos).toBeGreaterThan(midPos);
    }).pipe(Effect.provide(layer));
  });

  it.live("renders literal `|` characters in secret names without escaping (Go parity)", () => {
    const { layer, out } = setup({
      response: [{ name: "with|pipe", value: "digest" }],
    });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      // Go's pipeline: markdown `\|` → glamour decodes to literal `|`. Our
      // renderer skips the markdown step and emits the literal pipe directly.
      expect(out.stdoutText).toContain("with|pipe");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { secrets } for --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
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

  it.live("emits a success event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact indented JSON to stdout for --output json", () => {
    const { layer, out } = setup({ goOutput: "json", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      // Sorted (BAR before FOO) and alphabetical-key JSON; matches Go's struct
      // declaration order for SecretResponse {Name, UpdatedAt, Value}.
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

  it.live("emits a YAML array to stdout for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("- name: BAR");
      expect(out.stdoutText).toContain("value: digest-bar");
      expect(out.stdoutText).toContain("- name: FOO");
    }).pipe(Effect.provide(layer));
  });

  it.live("wraps the array as { secrets = [...] } for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("[[secrets]]");
      expect(out.stdoutText).toContain('name = "BAR"');
      expect(out.stdoutText).toContain('value = "digest-bar"');
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsEnvNotSupportedError for --output env", () => {
    const { layer } = setup({ goOutput: "env", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySecretsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsEnvNotSupportedError");
        expect(errJson).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode (Glamour table)", () => {
    const { layer, out } = setup({ goOutput: "pretty", response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("DIGEST");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output flag value wins over --output-format when both provided", () => {
    const { layer, out } = setup({
      format: "json",
      goOutput: "yaml",
      response: SAMPLE_SECRETS,
    });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("- name: BAR");
      expect(out.stdoutText.startsWith("[")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes the resolved project ref into the listAllSecrets URL", () => {
    const { layer, api } = setup({ response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/secrets`);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId env", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: SAMPLE_SECRETS });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: [] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySecretsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsListUnexpectedStatusError");
        expect(errJson).toContain("unexpected list secrets status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySecretsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsListNetworkError");
        expect(errJson).toContain("failed to list secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("withJsonErrorHandling emits a fail event in JSON mode on 503", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: [] });
    return Effect.gen(function* () {
      yield* legacySecretsList({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
