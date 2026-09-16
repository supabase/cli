import type { V1GetProfileOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Schema, Stdio } from "effect";

import { GLOBAL_OUTPUT_FORMATS } from "../../command-internal/global-flags.ts";
import { InvalidOutputFormatError } from "../../command-internal/go-output-flag.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
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
import { whoamiHandler } from "./whoami.command.ts";
import { whoami } from "./whoami.handler.ts";

type Profile = typeof V1GetProfileOutput.Type;

const SAMPLE_PROFILE: Profile = {
  gotrue_id: "5a5c1690-8f6f-4b95-b76c-97b80a8868fc",
  primary_email: "identity@example.net",
  username: "cli-owner",
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
      expect(out.stdoutText.split("\n")).toContain(
        "   5a5c1690-8f6f-4b95-b76c-97b80a8868fc | cli-owner | identity@example.net ",
      );
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]).toMatchObject({
        method: "GET",
        url: "https://api.supabase.com/v1/profile",
        body: undefined,
        urlParams: "",
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the bare CLI identity contract for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* whoami({});
      const payload: unknown = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        out.stdoutText,
      );
      expect(payload).toEqual({
        id: SAMPLE_PROFILE.gotrue_id,
        email: SAMPLE_PROFILE.primary_email,
        username: SAMPLE_PROFILE.username,
      });
      expect(payload).not.toHaveProperty("message");
      expect(payload).not.toHaveProperty("gotrue_id");
      expect(payload).not.toHaveProperty("primary_email");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the bare CLI identity contract for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* whoami({});
      expect(out.events).toEqual([
        {
          type: "result",
          data: {
            id: SAMPLE_PROFILE.gotrue_id,
            email: SAMPLE_PROFILE.primary_email,
            username: SAMPLE_PROFILE.username,
          },
          timestamp: expect.any(String),
        },
      ]);
      const data = out.events[0]?.data;
      expect(data).not.toHaveProperty("message");
      expect(data).not.toHaveProperty("gotrue_id");
      expect(data).not.toHaveProperty("primary_email");
    }).pipe(Effect.provide(layer));
  });

  it.live("points an unauthorized profile request at re-authenticating", () => {
    const { layer } = setup({ status: 401, response: { message: "Unauthorized" } });
    return Effect.gen(function* () {
      const error = findError(yield* whoami({}).pipe(Effect.exit));
      expect(error).toBeInstanceOf(WhoamiUnexpectedStatusError);
      if (error instanceof WhoamiUnexpectedStatusError) {
        expect(error.status).toBe(401);
        expect(error.body).toContain("Unauthorized");
        expect(error.message).toBe(
          "Authentication failed: your access token is invalid or has expired. Run `supabase login` to re-authenticate.",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves the generic message for other HTTP errors", () => {
    const { layer } = setup({ status: 503, response: { message: "Unavailable" } });
    return Effect.gen(function* () {
      const error = findError(yield* whoami({}).pipe(Effect.exit));
      expect(error).toBeInstanceOf(WhoamiUnexpectedStatusError);
      if (error instanceof WhoamiUnexpectedStatusError) {
        expect(error.status).toBe(503);
        expect(error.body).toContain("Unavailable");
        expect(error.message).toContain("unexpected get profile status 503");
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

  it.live("maps transport failures without task output in machine modes", () => {
    const run = (format: "json" | "stream-json") => {
      const { layer, out } = setup({ format, network: "fail" });
      return Effect.gen(function* () {
        const error = findError(yield* whoami({}).pipe(Effect.exit));
        expect(error).toBeInstanceOf(WhoamiNetworkError);
        expect(out.progressEvents).toEqual([]);
      }).pipe(Effect.provide(layer));
    };

    return Effect.gen(function* () {
      yield* run("json");
      yield* run("stream-json");
    });
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

  it.live("routes -o table/csv through the command's unsupported-output error", () => {
    const run = (goOutput: "table" | "csv") => {
      const { layer, api } = setup({ goOutput });
      return Effect.gen(function* () {
        const error = findError(yield* whoamiHandler({}).pipe(Effect.exit));
        expect(error).toBeInstanceOf(WhoamiOutputFlagUnsupportedError);
        expect(error).not.toBeInstanceOf(InvalidOutputFormatError);
        expect(api.requests).toHaveLength(0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer,
            commandRuntimeLayer(["whoami"]),
            Stdio.layerTest({ args: Effect.succeed(["whoami", "-o", goOutput]) }),
          ),
        ),
      );
    };

    return Effect.gen(function* () {
      yield* run("table");
      yield* run("csv");
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
