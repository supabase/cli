import { type V1GetNetworkRestrictionsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
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
import { describeHostedRemoteSelection } from "../../../../tests/helpers/hosted-remote-selection.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { networkRestrictionsGet } from "./get.handler.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const APPLIED_WITH_CIDRS: typeof V1GetNetworkRestrictionsOutput.Type = {
  entitlement: "allowed",
  config: {
    dbAllowedCidrs: ["1.2.3.0/24", "5.6.7.0/24"],
    dbAllowedCidrsV6: ["2001:db8::/64"],
  },
  status: "applied",
};

const APPLIED_NO_CIDRS: typeof V1GetNetworkRestrictionsOutput.Type = {
  entitlement: "allowed",
  config: { dbAllowedCidrs: [], dbAllowedCidrsV6: [] },
  status: "applied",
};

const STORED_WITH_OMITTED_CIDRS: typeof V1GetNetworkRestrictionsOutput.Type = {
  entitlement: "allowed",
  config: {},
  status: "stored",
};

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1GetNetworkRestrictionsOutput.Type;
  status?: number;
  network?: "fail";
}

const tempRoot = useTempWorkdir("supabase-network-restrictions-get-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? APPLIED_WITH_CIDRS },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
  });
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? APPLIED_WITH_CIDRS },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
  });
  return { layer, out, api, telemetry, cache };
}

describe("network-restrictions get integration", () => {
  it.effect("prints the formatted text block when the response has v4 and v6 entries", () => {
    const { layer, out } = setup({ response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[1.2.3.0/24 5.6.7.0/24]\n" +
          "DB Allowed IPv6 CIDRs: &[2001:db8::/64]\n" +
          "Restrictions applied successfully: true\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints `&[]` for both arrays when the API returns empty arrays", () => {
    const { layer, out } = setup({ response: APPLIED_NO_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[]\n" +
          "DB Allowed IPv6 CIDRs: &[]\n" +
          "Restrictions applied successfully: true\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints `<nil>` when the API omits the dbAllowedCidrs fields", () => {
    const { layer, out } = setup({ response: STORED_WITH_OMITTED_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: <nil>\n" +
          "DB Allowed IPv6 CIDRs: <nil>\n" +
          "Restrictions applied successfully: false\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints `Restrictions applied successfully: false` when status is `stored`", () => {
    const stored: typeof V1GetNetworkRestrictionsOutput.Type = {
      entitlement: "allowed",
      config: { dbAllowedCidrs: ["1.2.3.0/24"], dbAllowedCidrsV6: [] },
      status: "stored",
    };
    const { layer, out } = setup({ response: stored });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[1.2.3.0/24]\n" +
          "DB Allowed IPv6 CIDRs: &[]\n" +
          "Restrictions applied successfully: false\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured JSON success payload via --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        status: "applied",
        config: {
          dbAllowedCidrs: ["1.2.3.0/24", "5.6.7.0/24"],
          dbAllowedCidrsV6: ["2001:db8::/64"],
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a result event via --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ status: "applied" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits JSON when --output=json", () => {
    const { layer, out } = setup({ outputFlag: "json", response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText.startsWith("{")).toBe(true);
      expect(out.stdoutText.endsWith("\n")).toBe(true);
      expect(out.stdoutText).toContain('"status": "applied"');
      expect(out.stdoutText).toContain('"dbAllowedCidrs"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits YAML when --output=yaml", () => {
    const { layer, out } = setup({ outputFlag: "yaml", response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toContain("status: applied");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits TOML when --output=toml", () => {
    const { layer, out } = setup({ outputFlag: "toml", response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toContain("status = ");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits env output when --output=env", () => {
    const { layer, out } = setup({ outputFlag: "env", response: APPLIED_NO_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toContain('STATUS="applied"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats --output pretty identically to text mode", () => {
    const { layer, out } = setup({ outputFlag: "pretty", response: APPLIED_NO_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[]\n" +
          "DB Allowed IPv6 CIDRs: &[]\n" +
          "Restrictions applied successfully: true\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output wins over --output-format when both are set", () => {
    const { layer, out } = setup({
      format: "json",
      outputFlag: "yaml",
      response: APPLIED_WITH_CIDRS,
    });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(out.stdoutText.startsWith("{")).toBe(false);
      expect(out.stdoutText).toContain("status: applied");
    }).pipe(Effect.provide(layer));
  });

  it.effect("hits the GET /v1/projects/{ref}/network-restrictions URL", () => {
    const { layer, api } = setup({ response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/network-restrictions`);
      assertPermissionDrift({
        command: "network-restrictions get",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the picker's projects, the restrictions and fills the real cache", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.url === "https://api.supabase.com/v1/projects") {
          return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
        }
        if (request.url === `https://api.supabase.com/v1/projects/${VALID_REF}`) {
          return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
        }
        return Effect.succeed(jsonResponse(request, 200, APPLIED_WITH_CIDRS));
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
      linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `GET https://api.supabase.com/v1/projects/${VALID_REF}/network-restrictions`,
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(out.stdoutText).toBe(
        "DB Allowed IPv4 CIDRs: &[1.2.3.0/24 5.6.7.0/24]\n" +
          "DB Allowed IPv6 CIDRs: &[2001:db8::/64]\n" +
          "Restrictions applied successfully: true\n",
      );
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "network-restrictions get",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses the --remote=<ref> value over CommandSettings.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({
        remote: Option.some({ _tag: "Ref", ref: flagRef }),
        projectRef: Option.none(),
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports an error message when the API returns a non-200 status", () => {
    const { layer } = setup({ status: 503, response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("NetworkRestrictionsGetUnexpectedStatusError");
        expect(causeText).toContain("failed to retrieve network restrictions; received:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports an error message when the network is unreachable", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("NetworkRestrictionsGetNetworkError");
        expect(causeText).toContain("failed to retrieve network restrictions:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() }).pipe(
        withJsonErrorHandling,
      );
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry and writes linked-project cache on success", () => {
    const { layer, telemetry, cache } = setupTracked({ response: APPLIED_WITH_CIDRS });
    return Effect.gen(function* () {
      yield* networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry even on API failure", () => {
    const { layer, telemetry, cache } = setupTracked({
      status: 500,
      response: APPLIED_WITH_CIDRS,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        networkRestrictionsGet({ remote: Option.none(), projectRef: Option.none() }).pipe(
          Effect.provide(layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      // Linked-project cache wraps the inner effect, so it still fires after
      // ref resolution succeeded, once ref is known.
      expect(cache.cached).toBe(true);
    });
  });

  describeHostedRemoteSelection({
    command: ["network-restrictions", "get"],
    workdir: () => tempRoot.current,
    respond: (request) => jsonResponse(request, 200, APPLIED_WITH_CIDRS),
    run: (selector, layer) => networkRestrictionsGet(selector).pipe(Effect.provide(layer)),
  });
});
