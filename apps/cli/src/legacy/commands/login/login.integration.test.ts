import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {
  mockAnalytics,
  mockBrowser,
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { LegacyProfileFlag } from "../../../shared/legacy/global-flags.ts";
import {
  LEGACY_VALID_TOKEN,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyCredentialsTracked,
  mockLegacyLoginApi,
  mockLegacyLoginCrypto,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { EventLoginCompleted } from "../../../shared/telemetry/event-catalog.ts";
import { legacyLogin } from "./login.handler.ts";
import type { LegacyLoginFlags } from "./login.command.ts";

const tempRoot = useLegacyTempWorkdir("supabase-login-int-");

const noopHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("unexpected HttpClient.execute in login test")),
);

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly isTTY?: boolean;
  readonly stdoutIsTty?: boolean;
  readonly accessTokenEnv?: string;
  readonly pipedStdin?: string;
  readonly gotrueId?: string;
  readonly profileFails?: boolean;
  readonly failTimes?: number;
  readonly decryptFails?: boolean;
  readonly keygenFails?: boolean;
  readonly tokenName?: string;
  readonly saveFails?: boolean;
  readonly promptTextFail?: boolean;
  readonly profileFlag?: string;
  readonly homeDir?: string;
}

function flags(overrides: Partial<LegacyLoginFlags> = {}): LegacyLoginFlags {
  return {
    token: Option.none(),
    name: Option.none(),
    noBrowser: false,
    ...overrides,
  };
}

function setupLegacyLogin(opts: SetupOpts = {}) {
  const isTTY = opts.isTTY ?? false;
  const out = mockOutput({ format: opts.format ?? "text", promptTextFail: opts.promptTextFail });
  const telemetry = mockLegacyTelemetryStateTracked();
  const credentials = mockLegacyCredentialsTracked({ saveFails: opts.saveFails });
  const crypto = mockLegacyLoginCrypto({
    decryptFails: opts.decryptFails,
    keygenFails: opts.keygenFails,
    tokenName: opts.tokenName,
  });
  const loginApi = mockLegacyLoginApi({
    failTimes: opts.failTimes,
    gotrueId: opts.gotrueId,
    profileFails: opts.profileFails,
  });
  const analytics = mockAnalytics();
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    accessToken:
      opts.accessTokenEnv !== undefined
        ? Option.some(Redacted.make(opts.accessTokenEnv))
        : Option.none(),
  });
  const tty = mockTty({ stdinIsTty: isTTY, stdoutIsTty: opts.stdoutIsTty ?? false });
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api: {
        layer: mockLegacyPlatformApiService({ v1: {} }).layer,
        httpClientLayer: noopHttpClient,
      },
      cliConfig,
      analytics,
      telemetry: telemetry.layer,
      tty,
      ...(opts.homeDir !== undefined
        ? { runtimeInfo: mockRuntimeInfo({ homeDir: opts.homeDir }) }
        : {}),
    }),
    credentials.layer,
    crypto.layer,
    loginApi.layer,
    mockStdin(isTTY, opts.pipedStdin),
    mockBrowser(),
    Layer.succeed(LegacyProfileFlag, opts.profileFlag ?? "supabase"),
  );
  return { layer, out, credentials, crypto, loginApi, telemetry, analytics };
}

describe("legacy login integration", () => {
  it.live("saves the token from --token and reports logged in", () => {
    const { layer, out, credentials, analytics } = setupLegacyLogin();
    return Effect.gen(function* () {
      yield* legacyLogin(flags({ token: Option.some(LEGACY_VALID_TOKEN) }));
      expect(credentials.savedToken).toBe(LEGACY_VALID_TOKEN);
      expect(out.stdoutText).toContain("You are now logged in. Happy coding!");
      expect(analytics.captured.map((c) => c.event)).toContain(EventLoginCompleted);
    }).pipe(Effect.provide(layer));
  });

  it.live("saves the token from SUPABASE_ACCESS_TOKEN env when no flag is given", () => {
    const { layer, credentials } = setupLegacyLogin({ accessTokenEnv: LEGACY_VALID_TOKEN });
    return Effect.gen(function* () {
      yield* legacyLogin(flags());
      expect(credentials.savedToken).toBe(LEGACY_VALID_TOKEN);
    }).pipe(Effect.provide(layer));
  });

  it.live("saves the token piped via stdin in non-TTY", () => {
    const { layer, credentials } = setupLegacyLogin({
      isTTY: false,
      pipedStdin: LEGACY_VALID_TOKEN,
    });
    return Effect.gen(function* () {
      yield* legacyLogin(flags());
      expect(credentials.savedToken).toBe(LEGACY_VALID_TOKEN);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects an invalid --token with 'cannot save provided token:'", () => {
    const { layer } = setupLegacyLogin({ saveFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLogin(flags({ token: Option.some("not-a-token") })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyLoginSaveTokenError");
        expect(json).toContain("cannot save provided token:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails in non-TTY with no token", () => {
    const { layer } = setupLegacyLogin({ isTTY: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLogin(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyLoginMissingTokenError");
        expect(json).toContain("Cannot use automatic login flow inside non-TTY environments");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("browser flow: generates link, opens browser, decrypts, saves, prints created", () => {
    const { layer, out, credentials } = setupLegacyLogin({ isTTY: true, tokenName: "my-machine" });
    return Effect.gen(function* () {
      yield* legacyLogin(flags());
      expect(out.stdoutText).toContain(
        "Hello from Supabase! Press Enter to open browser and login automatically.",
      );
      expect(out.stdoutText).toContain("/cli/login?session_id=test-session-id");
      expect(out.stdoutText).toContain("Token my-machine created successfully.");
      expect(out.stdoutText).toContain("You are now logged in. Happy coding!");
      expect(credentials.savedToken).toBe(LEGACY_VALID_TOKEN);
    }).pipe(Effect.provide(layer));
  });

  it.live("browser flow with --no-browser prints the link without the open-browser banner", () => {
    const { layer, out } = setupLegacyLogin({ isTTY: true });
    return Effect.gen(function* () {
      yield* legacyLogin(flags({ noBrowser: true }));
      expect(out.stdoutText).toContain("Here is your login link, open it in the browser");
      expect(out.stdoutText).not.toContain("Press Enter to open browser");
    }).pipe(Effect.provide(layer));
  });

  it.live("browser flow uses the default token name when --name is absent", () => {
    const { layer, out } = setupLegacyLogin({ isTTY: true });
    return Effect.gen(function* () {
      yield* legacyLogin(flags());
      // mockLegacyLoginCrypto default token name.
      expect(out.stdoutText).toContain("Token cli_test@host_123 created successfully.");
    }).pipe(Effect.provide(layer));
  });

  it.live("retries verification on poll failure then succeeds", () => {
    const { layer, out, loginApi } = setupLegacyLogin({ isTTY: true, failTimes: 2 });
    return Effect.gen(function* () {
      yield* legacyLogin(flags());
      expect(out.stderrText).toContain("Retry (1/2): ");
      expect(out.stderrText).toContain("Retry (2/2): ");
      // 2 failures + 1 success = 3 poll attempts.
      expect(loginApi.loginCallCount).toBe(3);
      expect(out.stdoutText).toContain("You are now logged in. Happy coding!");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails after 2 retries are exhausted", () => {
    const { layer, out } = setupLegacyLogin({ isTTY: true, failTimes: 3 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLogin(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyLoginFailedError");
      }
      // The 3rd (final) failure gives up without printing a Retry notice.
      expect(out.stderrText).toContain("Retry (2/2): ");
      expect(out.stderrText).not.toContain("Retry (3/2): ");
    }).pipe(Effect.provide(layer));
  });

  it.live("decrypt failure surfaces 'cannot decrypt access token'", () => {
    const { layer } = setupLegacyLogin({ isTTY: true, decryptFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLogin(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyLoginDecryptError");
        expect(json).toContain("cannot decrypt access token");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("telemetry: successful profile fetch stitches the gotrue_id", () => {
    const { layer, telemetry, analytics } = setupLegacyLogin({ gotrueId: "gotrue-abc" });
    return Effect.gen(function* () {
      yield* legacyLogin(flags({ token: Option.some(LEGACY_VALID_TOKEN) }));
      expect(telemetry.stitchedDistinctId).toBe("gotrue-abc");
      expect(telemetry.clearedDistinctId).toBe(false);
      expect(analytics.captured.map((c) => c.event)).toContain(EventLoginCompleted);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "telemetry: profile fetch failure clears distinct_id but login still succeeds + still captures",
    () => {
      const { layer, out, telemetry, analytics } = setupLegacyLogin({ profileFails: true });
      return Effect.gen(function* () {
        yield* legacyLogin(flags({ token: Option.some(LEGACY_VALID_TOKEN) }));
        expect(telemetry.clearedDistinctId).toBe(true);
        expect(telemetry.stitchedDistinctId).toBeUndefined();
        expect(analytics.captured.map((c) => c.event)).toContain(EventLoginCompleted);
        expect(out.stdoutText).toContain("You are now logged in. Happy coding!");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("flushes telemetry state via ensuring", () => {
    const { layer, telemetry } = setupLegacyLogin();
    return Effect.gen(function* () {
      yield* legacyLogin(flags({ token: Option.some(LEGACY_VALID_TOKEN) }));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  for (const format of ["json", "stream-json"] as const) {
    it.live(`${format}: --token emits a single success result with no human banner`, () => {
      const { layer, out } = setupLegacyLogin({ format });
      return Effect.gen(function* () {
        yield* legacyLogin(flags({ token: Option.some(LEGACY_VALID_TOKEN) }));
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.message).toBe("You are now logged in.");
        expect(out.stdoutText).not.toContain("Happy coding!");
      }).pipe(Effect.provide(layer));
    });
  }

  it.live("browser flow: keygen failure exits with LegacyLoginCryptoError", () => {
    const { layer } = setupLegacyLogin({ isTTY: true, keygenFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLogin(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyLoginCryptoError");
      }
    }).pipe(Effect.provide(layer));
  });

  for (const format of ["json", "stream-json"] as const) {
    it.live(`${format}: browser flow emits a success result with token_name`, () => {
      const { layer, out } = setupLegacyLogin({ format, isTTY: true, tokenName: "my-machine" });
      return Effect.gen(function* () {
        yield* legacyLogin(flags());
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.message).toBe("You are now logged in.");
        expect(success?.data).toMatchObject({ token_name: "my-machine" });
        expect(out.stdoutText).not.toContain("Happy coding!");
      }).pipe(Effect.provide(layer));
    });
  }

  it.live(
    "prints the Claude Code plugin hint to stderr when in Claude Code with a TTY stdout",
    () => {
      const prev = process.env["CLAUDECODE"];
      process.env["CLAUDECODE"] = "1";
      const { layer, out } = setupLegacyLogin({ stdoutIsTty: true });
      return Effect.gen(function* () {
        yield* legacyLogin(flags({ token: Option.some(LEGACY_VALID_TOKEN) }));
        expect(out.stderrText).toContain("claude-code-hint");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env["CLAUDECODE"];
            else process.env["CLAUDECODE"] = prev;
          }),
        ),
      );
    },
  );

  it.live("persists ~/.supabase/profile on success when --profile is set", () => {
    const { layer } = setupLegacyLogin({
      profileFlag: "supabase-staging",
      homeDir: tempRoot.current,
    });
    return Effect.gen(function* () {
      yield* legacyLogin(flags({ token: Option.some(LEGACY_VALID_TOKEN) }));
      const profilePath = join(tempRoot.current, ".supabase", "profile");
      expect(existsSync(profilePath)).toBe(true);
      expect(readFileSync(profilePath, "utf8")).toBe("supabase-staging");
    }).pipe(Effect.provide(layer));
  });

  it.live("browser flow in json mode fails cleanly at the prompt", () => {
    const { layer } = setupLegacyLogin({ format: "json", isTTY: true, promptTextFail: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLogin(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("NonInteractiveError");
      }
    }).pipe(Effect.provide(layer));
  });
});
