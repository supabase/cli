import { type V1ListAllNetworkBansOutput } from "@supabase/api/effect";
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
import { legacyNetworkBansGet } from "./get.handler.ts";

const SAMPLE_BANS: typeof V1ListAllNetworkBansOutput.Type = {
  banned_ipv4_addresses: ["192.168.0.1", "192.168.0.2"],
};

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  legacyOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1ListAllNetworkBansOutput.Type;
  status?: number;
  network?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-network-bans-get-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 201, body: opts.response ?? SAMPLE_BANS },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.legacyOutput === undefined ? Option.none() : Option.some(opts.legacyOutput),
  });
  return { layer, out, api };
}

describe("legacy network-bans get integration", () => {
  it.live("writes the stderr heading and JSON array bytes in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(out.stderrText).toBe("DB banned IPs:\n");
      expect(out.stdoutText).toBe(
        `[
  "192.168.0.1",
  "192.168.0.2"
]
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits TOML bytes for --output toml", () => {
    const { layer, out } = setup({ legacyOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(out.stderrText).toBe("DB banned IPs:\n");
      expect(out.stdoutText).toBe('banned_ips = ["192.168.0.1", "192.168.0.2"]\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with the env-not-supported error for --output env", () => {
    const { layer, out } = setup({ legacyOutput: "env" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyNetworkBansGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.stderrText).toBe("DB banned IPs:\n");
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacyNetworkBansEnvNotSupportedError");
        expect(errJson).toContain("--output env flag is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("posts to the /network-bans/retrieve endpoint with the resolved ref", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyNetworkBansGet({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/network-bans/retrieve`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyNetworkBansGetUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyNetworkBansGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacyNetworkBansGetUnexpectedStatusError");
        expect(errJson).toContain("unexpected list bans status 503");
      }
    }).pipe(Effect.provide(layer));
  });
});
