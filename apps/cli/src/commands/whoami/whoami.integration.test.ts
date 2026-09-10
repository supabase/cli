import type { V1GetProfileOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";

import { GLOBAL_OUTPUT_FORMATS } from "../../command-internal/global-flags.ts";
import { ErrorActionabilityId } from "../../shared/telemetry/error-actionability.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import {
  WhoamiNetworkError,
  WhoamiOutputFlagUnsupportedError,
  WhoamiUnexpectedStatusError,
} from "./whoami.errors.ts";
import { whoami } from "./whoami.handler.ts";

type Profile = typeof V1GetProfileOutput.Type;

const SAMPLE_PROFILE: Profile = {
  gotrue_id: "5a5c1690-8f6f-4b95-b76c-97b80a8868fc",
  primary_email: "person@example.com",
  username: "person",
};

const tempRoot = useTempWorkdir("supabase-whoami-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: (typeof GLOBAL_OUTPUT_FORMATS)[number];
  readonly response?: unknown;
  readonly status?: number;
  readonly network?: "fail";
  readonly trackTelemetry?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SAMPLE_PROFILE },
    network: opts.network,
  });
  const telemetry = opts.trackTelemetry ? mockTelemetryStateTracked() : undefined;
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    ...(telemetry === undefined ? {} : { telemetry: telemetry.layer }),
  });
  return { layer, out, api, telemetry };
}

function findError(exit: Exit.Exit<unknown, unknown>): unknown {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return undefined;
  return Option.getOrUndefined(Cause.findErrorOption(exit.cause));
}

describe("whoami integration", () => {
  it.live("fetches the profile and renders all identity fields in text mode", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* whoami({});

      expect(out.stdoutText).toContain("USER ID");
      expect(out.stdoutText).toContain(SAMPLE_PROFILE.gotrue_id);
      expect(out.stdoutText).toContain(SAMPLE_PROFILE.username);
      expect(out.stdoutText).toContain(SAMPLE_PROFILE.primary_email);
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]).toMatchObject({
        method: "GET",
        url: "https://api.supabase.com/v1/profile",
        body: undefined,
        urlParams: "",
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the profile object for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* whoami({});
      expect(out.messages.find((message) => message.type === "success")?.data).toEqual(
        SAMPLE_PROFILE,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the profile object for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* whoami({});
      expect(out.messages.find((message) => message.type === "success")?.data).toEqual(
        SAMPLE_PROFILE,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("maps an HTTP error to WhoamiUnexpectedStatusError", () => {
    const { layer } = setup({ status: 401, response: { message: "Unauthorized" } });
    return Effect.gen(function* () {
      const error = findError(yield* whoami({}).pipe(Effect.exit));
      expect(error).toBeInstanceOf(WhoamiUnexpectedStatusError);
      if (error instanceof WhoamiUnexpectedStatusError) {
        expect(error.status).toBe(401);
        expect(error.body).toContain("Unauthorized");
        expect(error.message).toContain("unexpected get profile status 401");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps a transport failure to WhoamiNetworkError", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const error = findError(yield* whoami({}).pipe(Effect.exit));
      expect(error).toBeInstanceOf(WhoamiNetworkError);
      if (error instanceof WhoamiNetworkError) {
        expect(error.message).toContain("failed to fetch user profile");
        expect(error.decode).not.toBe(true);
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps a malformed successful response to a decoded API response error", () => {
    const { layer } = setup({ response: { ...SAMPLE_PROFILE, username: undefined } });
    return Effect.gen(function* () {
      const error = findError(yield* whoami({}).pipe(Effect.exit));
      expect(error).toBeInstanceOf(WhoamiNetworkError);
      if (error instanceof WhoamiNetworkError) {
        expect(error.decode).toBe(true);
        expect(error[ErrorActionabilityId]).toMatchObject({ fingerprint_suffix: "api_response" });
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps a transport failure without a text-mode spinner", () => {
    const { layer } = setup({ format: "json", network: "fail" });
    return Effect.gen(function* () {
      const error = findError(yield* whoami({}).pipe(Effect.exit));
      expect(error).toBeInstanceOf(WhoamiNetworkError);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects every -o/--output value before calling the API", () => {
    const run = (goOutput: (typeof GLOBAL_OUTPUT_FORMATS)[number]) => {
      const { layer, api } = setup({ goOutput });
      return Effect.gen(function* () {
        const error = findError(yield* whoami({}).pipe(Effect.exit));
        expect(error).toBeInstanceOf(WhoamiOutputFlagUnsupportedError);
        if (error instanceof WhoamiOutputFlagUnsupportedError) {
          expect(error.message).toBe(
            "the -o/--output flag is not supported by whoami; use --output-format json|stream-json instead.",
          );
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    };

    return Effect.gen(function* () {
      for (const value of GLOBAL_OUTPUT_FORMATS) {
        yield* run(value);
      }
    });
  });

  it.live("flushes telemetry state on success", () => {
    const { layer, telemetry } = setup({ trackTelemetry: true });
    return Effect.gen(function* () {
      yield* whoami({});
      expect(telemetry?.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state on failure", () => {
    const { layer, telemetry } = setup({ trackTelemetry: true, status: 503 });
    return Effect.gen(function* () {
      yield* whoami({}).pipe(Effect.exit);
      expect(telemetry?.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
