import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import type { OutputFormat } from "../../../shared/output/types.ts";
import type { LoginFlags } from "./login.command.ts";
import { login } from "./login.handler.ts";
import type { TelemetryConfig } from "../../../shared/telemetry/types.ts";
import { ApiError } from "../../auth/errors.ts";
import {
  emptyEnv,
  mockApi,
  mockAnalytics,
  mockBrowser,
  mockCredentials,
  mockCrypto,
  mockOutput,
  mockStdin,
  withEnv,
} from "../../../../tests/helpers/mocks.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TOKEN = "sbp_" + "a".repeat(40);
const VALID_OAUTH_TOKEN = "sbp_oauth_" + "b".repeat(40);

const NO_FLAGS: LoginFlags = {
  token: Option.none(),
  name: Option.none(),
  noBrowser: false,
};

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "supabase-login-test-"));
}

function writeTelemetryConfig(dir: string, config: TelemetryConfig) {
  writeFileSync(path.join(dir, "telemetry.json"), JSON.stringify(config));
}

function readTelemetryConfig(dir: string): TelemetryConfig {
  return JSON.parse(readFileSync(path.join(dir, "telemetry.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// Setup helpers — compose layers and return state for assertions
// ---------------------------------------------------------------------------

function setupNonTty(opts: { pipedToken?: string; format?: OutputFormat } = {}) {
  const creds = mockCredentials();
  const out = mockOutput({ format: opts.format });
  const api = mockApi();
  const analytics = mockAnalytics();
  const layer = Layer.mergeAll(
    emptyEnv(),
    analytics.layer,
    api.layer,
    creds.layer,
    mockCrypto(),
    mockBrowser(),
    mockStdin(false, opts.pipedToken),
    out.layer,
  );
  return { layer, creds, out, api, analytics };
}

function setupTty(
  opts: {
    existingToken?: string;
    confirmRelogin?: boolean;
    format?: OutputFormat;
    apiFailTimes?: number;
    promptTextFail?: boolean;
  } = {},
) {
  const creds = mockCredentials({ existingToken: opts.existingToken });
  const out = mockOutput({
    format: opts.format,
    confirmRelogin: opts.confirmRelogin,
    promptTextFail: opts.promptTextFail,
  });
  const api = mockApi({ failTimes: opts.apiFailTimes });
  const analytics = mockAnalytics();
  const layer = Layer.mergeAll(
    emptyEnv(),
    analytics.layer,
    api.layer,
    creds.layer,
    mockCrypto(),
    mockBrowser(),
    mockStdin(true),
    out.layer,
  );
  return { layer, creds, out, api, analytics };
}

function setupWithEnv(
  env: Record<string, string>,
  opts: { existingToken?: string; isTTY?: boolean } = {},
) {
  const creds = mockCredentials({ existingToken: opts.existingToken });
  const out = mockOutput();
  const api = mockApi();
  const analytics = mockAnalytics();
  const layer = Layer.mergeAll(
    withEnv(env),
    analytics.layer,
    api.layer,
    creds.layer,
    mockCrypto(),
    mockBrowser(),
    mockStdin(opts.isTTY ?? false),
    out.layer,
  );
  return { layer, creds, out, api, analytics };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectFailureTag(exit: Exit.Exit<unknown, unknown>, tag: string) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect((failure.value as { _tag: string })._tag).toBe(tag);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("login", () => {
  describe("token resolution order", () => {
    it.live("--token flag takes priority", () => {
      const { layer, creds, out, analytics } = setupNonTty();
      return Effect.gen(function* () {
        yield* login({ ...NO_FLAGS, token: Option.some(VALID_TOKEN) });
        expect(creds.savedToken).toBe(VALID_TOKEN);
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "intro", message: "Log in to Supabase" }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "success", message: "Logged in successfully." }),
        );
        expect(analytics.captured).toContainEqual({
          event: "cli_login_completed",
          properties: {
            login_method: "token",
          },
        });
        expect(analytics.aliased).toContainEqual({
          distinctId: "user-123",
          alias: "test-device-id",
        });
        expect(analytics.identified).toContainEqual({
          distinctId: "user-123",
          properties: {},
        });
      }).pipe(Effect.provide(layer));
    });

    it.live("env token used when no --token flag", () => {
      const { layer, creds } = setupWithEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN });
      return Effect.gen(function* () {
        yield* login(NO_FLAGS);
        expect(creds.savedToken).toBe(VALID_TOKEN);
      }).pipe(Effect.provide(layer));
    });

    it.live("piped stdin used when no flag or env", () => {
      const { layer, creds } = setupNonTty({ pipedToken: VALID_TOKEN });
      return Effect.gen(function* () {
        yield* login(NO_FLAGS);
        expect(creds.savedToken).toBe(VALID_TOKEN);
      }).pipe(Effect.provide(layer));
    });

    it.live("token-based login clears a stale distinct_id when profile lookup fails", () => {
      const homeDir = makeTempDir();
      writeTelemetryConfig(homeDir, {
        consent: "granted",
        device_id: "device-123",
        session_id: "session-123",
        session_last_active: Date.now(),
        distinct_id: "old-user-id",
      });
      const creds = mockCredentials();
      const out = mockOutput();
      const api = mockApi({ profileError: new ApiError({ detail: "Unauthorized" }) });
      const analytics = mockAnalytics();
      const layer = Layer.mergeAll(
        withEnv({ SUPABASE_HOME: homeDir }),
        analytics.layer,
        api.layer,
        creds.layer,
        mockCrypto(),
        mockBrowser(),
        mockStdin(false),
        out.layer,
      );

      return Effect.gen(function* () {
        yield* login({ ...NO_FLAGS, token: Option.some(VALID_TOKEN) });
        expect(creds.savedToken).toBe(VALID_TOKEN);
        expect(readTelemetryConfig(homeDir).distinct_id).toBeUndefined();
        expect(analytics.identified).toEqual([]);
        expect(analytics.aliased).toEqual([]);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(Effect.sync(() => rmSync(homeDir, { recursive: true, force: true }))),
      );
    });

    it.live("returns NoTtyError when piped stdin is empty", () => {
      const { layer } = setupNonTty();
      return Effect.gen(function* () {
        const exit = yield* login(NO_FLAGS).pipe(Effect.exit);
        expectFailureTag(exit, "NoTtyError");
      }).pipe(Effect.provide(layer));
    });
  });

  describe("token validation", () => {
    it.live("accepts valid sbp_oauth_ token", () => {
      const { layer, creds } = setupNonTty();
      return Effect.gen(function* () {
        yield* login({ ...NO_FLAGS, token: Option.some(VALID_OAUTH_TOKEN) });
        expect(creds.savedToken).toBe(VALID_OAUTH_TOKEN);
      }).pipe(Effect.provide(layer));
    });

    it.live("rejects uppercase hex characters", () => {
      const { layer, creds } = setupNonTty();
      return Effect.gen(function* () {
        const exit = yield* login({
          ...NO_FLAGS,
          token: Option.some("sbp_" + "A".repeat(40)),
        }).pipe(Effect.exit);
        expectFailureTag(exit, "InvalidTokenError");
        expect(creds.savedToken).toBeUndefined();
      }).pipe(Effect.provide(layer));
    });

    it.live("rejects wrong length", () => {
      const { layer, creds } = setupNonTty();
      return Effect.gen(function* () {
        const exit = yield* login({
          ...NO_FLAGS,
          token: Option.some("sbp_" + "a".repeat(10)),
        }).pipe(Effect.exit);
        expectFailureTag(exit, "InvalidTokenError");
        expect(creds.savedToken).toBeUndefined();
      }).pipe(Effect.provide(layer));
    });
  });

  describe("already logged in guard", () => {
    it.live("already logged in + confirms → proceeds with OAuth flow", () => {
      const { layer, creds, out } = setupTty({
        existingToken: VALID_TOKEN,
        confirmRelogin: true,
      });
      return Effect.gen(function* () {
        yield* login(NO_FLAGS);
        expect(creds.savedToken).toBe(VALID_TOKEN);
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "warn", message: "You are already logged in." }),
        );
      }).pipe(Effect.provide(layer));
    });

    it.live("already logged in + declines → returns early", () => {
      const { layer, creds, out } = setupTty({
        existingToken: VALID_TOKEN,
        confirmRelogin: false,
      });
      return Effect.gen(function* () {
        yield* login(NO_FLAGS);
        expect(creds.savedToken).toBeUndefined();
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "outro", message: "Already logged in." }),
        );
      }).pipe(Effect.provide(layer));
    });

    it.live("explicit --token skips the check entirely", () => {
      const { layer, creds } = setupTty({ existingToken: VALID_TOKEN });
      return Effect.gen(function* () {
        yield* login({ ...NO_FLAGS, token: Option.some(VALID_TOKEN) });
        expect(creds.savedToken).toBe(VALID_TOKEN);
      }).pipe(Effect.provide(layer));
    });

    it.live("env token skips the check entirely", () => {
      const { layer, creds } = setupWithEnv(
        { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        { existingToken: VALID_TOKEN, isTTY: true },
      );
      return Effect.gen(function* () {
        yield* login(NO_FLAGS);
        expect(creds.savedToken).toBe(VALID_TOKEN);
      }).pipe(Effect.provide(layer));
    });

    it.live("piped stdin skips the check entirely", () => {
      const creds = mockCredentials({ existingToken: VALID_TOKEN });
      const out = mockOutput();
      const layer = Layer.mergeAll(
        emptyEnv(),
        mockApi().layer,
        creds.layer,
        mockCrypto(),
        mockBrowser(),
        mockStdin(false, VALID_TOKEN),
        out.layer,
      );
      return Effect.gen(function* () {
        yield* login(NO_FLAGS);
        expect(creds.savedToken).toBe(VALID_TOKEN);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("browser OAuth flow", () => {
    it.live("successful login via browser flow", () => {
      const { layer, creds, out, analytics } = setupTty();
      return Effect.gen(function* () {
        yield* login(NO_FLAGS);
        expect(creds.savedToken).toBe(VALID_TOKEN);
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            message: expect.stringContaining("cli_test@host_123"),
          }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "outro",
            message: "You are now logged in. Happy coding!",
          }),
        );
        expect(analytics.captured).toContainEqual({
          event: "cli_login_completed",
          properties: {
            login_method: "browser_oauth",
            token_name: "cli_test@host_123",
          },
        });
      }).pipe(Effect.provide(layer));
    });

    it.live("browser OAuth clears a stale distinct_id when profile lookup fails", () => {
      const homeDir = makeTempDir();
      writeTelemetryConfig(homeDir, {
        consent: "granted",
        device_id: "device-123",
        session_id: "session-123",
        session_last_active: Date.now(),
        distinct_id: "old-user-id",
      });
      const creds = mockCredentials();
      const out = mockOutput();
      const api = mockApi({ profileError: new ApiError({ detail: "Unauthorized" }) });
      const analytics = mockAnalytics();
      const layer = Layer.mergeAll(
        withEnv({ SUPABASE_HOME: homeDir }),
        analytics.layer,
        api.layer,
        creds.layer,
        mockCrypto(),
        mockBrowser(),
        mockStdin(true),
        out.layer,
      );

      return Effect.gen(function* () {
        yield* login(NO_FLAGS);
        expect(readTelemetryConfig(homeDir).distinct_id).toBeUndefined();
        expect(analytics.aliased).toEqual([]);
        expect(analytics.identified).toEqual([]);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(Effect.sync(() => rmSync(homeDir, { recursive: true, force: true }))),
      );
    });

    it.live("browser OAuth stitches the authenticated user via /v1/profile", () => {
      const creds = mockCredentials();
      const out = mockOutput();
      const api = mockApi({
        profileResponse: {
          gotrue_id: "user-123",
        },
      });
      const analytics = mockAnalytics();
      const layer = Layer.mergeAll(
        emptyEnv(),
        analytics.layer,
        api.layer,
        creds.layer,
        mockCrypto(),
        mockBrowser(),
        mockStdin(true),
        out.layer,
      );

      return Effect.gen(function* () {
        yield* login(NO_FLAGS);
        expect(analytics.aliased).toContainEqual({
          distinctId: "user-123",
          alias: "test-device-id",
        });
        expect(analytics.identified).toContainEqual({
          distinctId: "user-123",
          properties: {},
        });
        expect(analytics.captured).toContainEqual({
          event: "cli_login_completed",
          properties: {
            login_method: "browser_oauth",
            token_name: "cli_test@host_123",
          },
        });
        expect(api.profileCallCount).toBe(1);
      }).pipe(Effect.provide(layer));
    });

    it.live("uses custom --name flag", () => {
      const { layer, out } = setupTty();
      return Effect.gen(function* () {
        yield* login({ ...NO_FLAGS, name: Option.some("my-custom-token") });
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            message: expect.stringContaining("my-custom-token"),
            data: expect.objectContaining({ tokenName: "my-custom-token" }),
          }),
        );
      }).pipe(Effect.provide(layer));
    });

    it.live("--no-browser skips browser open", () => {
      const { layer, creds, out } = setupTty();
      return Effect.gen(function* () {
        yield* login({ ...NO_FLAGS, noBrowser: true });
        expect(creds.savedToken).toBe(VALID_TOKEN);
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "info",
            message: expect.stringContaining("open it in the browser"),
          }),
        );
      }).pipe(Effect.provide(layer));
    });

    it.live("retries on fetch failure", () => {
      const { layer, creds, out, api } = setupTty({ apiFailTimes: 1 });
      return Effect.gen(function* () {
        yield* login(NO_FLAGS);
        expect(creds.savedToken).toBe(VALID_TOKEN);
        expect(api.callCount).toBe(2);
        const errors = out.messages.filter((m) => m.type === "error");
        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toBe("Verification failed");
      }).pipe(Effect.provide(layer));
    });

    it.live("fails after max retries", () => {
      const { layer, out, api } = setupTty({ apiFailTimes: Infinity });
      return Effect.gen(function* () {
        const exit = yield* login(NO_FLAGS).pipe(Effect.exit);
        expectFailureTag(exit, "LoginFailedError");
        expect(api.callCount).toBe(3);
        const errors = out.messages.filter((m) => m.type === "error");
        expect(errors).toHaveLength(3);
      }).pipe(Effect.provide(layer));
    });

    it.live("non-VerificationError in prompt is not retried", () => {
      const { layer, out, api } = setupTty({ promptTextFail: true });
      return Effect.gen(function* () {
        const exit = yield* login(NO_FLAGS).pipe(Effect.exit);
        expectFailureTag(exit, "NonInteractiveError");
        // Should not retry because the error is not a VerificationError
        expect(api.callCount).toBe(0);
        // Should not log "Verification failed" since tapError takes the Effect.void branch
        const errors = out.messages.filter((m) => m.type === "error");
        expect(errors).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });
  });
});

describe("json output mode", () => {
  it.live("--token emits structured result", () => {
    const { layer, out } = setupNonTty({ pipedToken: VALID_TOKEN, format: "json" });
    return Effect.gen(function* () {
      yield* login({ ...NO_FLAGS, token: Option.some(VALID_TOKEN) });
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Logged in successfully.",
          data: expect.objectContaining({ command: "login" }),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("browser OAuth emits result with tokenName", () => {
    const { layer, out } = setupTty({ format: "json" });
    return Effect.gen(function* () {
      yield* login(NO_FLAGS);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: expect.stringContaining("cli_test@host_123"),
          data: expect.objectContaining({ command: "login", tokenName: "cli_test@host_123" }),
        }),
      );
    }).pipe(Effect.provide(layer));
  });
});
