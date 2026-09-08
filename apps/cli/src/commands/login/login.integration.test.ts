import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
} from "../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { ProfileFlag } from "../../command-internal/global-flags.ts";
import {
  VALID_TOKEN,
  buildTestRuntime,
  mockCommandSettings,
  mockCommandCredentialsTracked,
  mockLoginApi,
  mockLoginCrypto,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { EventLoginCompleted } from "../../shared/telemetry/event-catalog.ts";
import { login } from "./login.handler.ts";
import type { LoginFlags } from "./login.command.ts";

const tempRoot = useTempWorkdir("supabase-login-int-");

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
  /** Raw argv for explicit `--profile` detection. */
  readonly argv?: ReadonlyArray<string>;
}

function flags(overrides: Partial<LoginFlags> = {}): LoginFlags {
  return {
    token: Option.none(),
    name: Option.none(),
    noBrowser: false,
    ...overrides,
  };
}

function setupLogin(opts: SetupOpts = {}) {
  const isTTY = opts.isTTY ?? false;
  const out = mockOutput({ format: opts.format ?? "text", promptTextFail: opts.promptTextFail });
  const telemetry = mockTelemetryStateTracked();
  const credentials = mockCommandCredentialsTracked({ saveFails: opts.saveFails });
  const crypto = mockLoginCrypto({
    decryptFails: opts.decryptFails,
    keygenFails: opts.keygenFails,
    tokenName: opts.tokenName,
  });
  const loginApi = mockLoginApi({
    failTimes: opts.failTimes,
    gotrueId: opts.gotrueId,
    profileFails: opts.profileFails,
  });
  const analytics = mockAnalytics();
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    accessToken:
      opts.accessTokenEnv !== undefined
        ? Option.some(Redacted.make(opts.accessTokenEnv))
        : Option.none(),
  });
  const tty = mockTty({ stdinIsTty: isTTY, stdoutIsTty: opts.stdoutIsTty ?? false });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api: {
        layer: mockCommandPlatformApiService({ v1: {} }).layer,
        httpClientLayer: noopHttpClient,
      },
      cliSettings,
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
    Layer.succeed(ProfileFlag, opts.profileFlag ?? "supabase"),
    ...(opts.argv !== undefined ? [Layer.succeed(CliArgs, { args: opts.argv })] : []),
  );
  return { layer, out, credentials, crypto, loginApi, telemetry, analytics };
}

describe("legacy login integration", () => {
  it.live("saves the token from --token and reports logged in", () => {
    const { layer, out, credentials, analytics } = setupLogin();
    return Effect.gen(function* () {
      yield* login(flags({ token: Option.some(VALID_TOKEN) }));
      expect(credentials.savedToken).toBe(VALID_TOKEN);
      expect(out.stdoutText).toContain("You are now logged in. Happy coding!");
      expect(analytics.captured.map((c) => c.event)).toContain(EventLoginCompleted);
    }).pipe(Effect.provide(layer));
  });

  it.live("saves the token from SUPABASE_ACCESS_TOKEN env when no flag is given", () => {
    const { layer, credentials } = setupLogin({ accessTokenEnv: VALID_TOKEN });
    return Effect.gen(function* () {
      yield* login(flags());
      expect(credentials.savedToken).toBe(VALID_TOKEN);
    }).pipe(Effect.provide(layer));
  });

  it.live("saves the token piped via stdin in non-TTY", () => {
    const { layer, credentials } = setupLogin({
      isTTY: false,
      pipedStdin: VALID_TOKEN,
    });
    return Effect.gen(function* () {
      yield* login(flags());
      expect(credentials.savedToken).toBe(VALID_TOKEN);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects an invalid --token with 'cannot save provided token:'", () => {
    const { layer } = setupLogin({ saveFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(login(flags({ token: Option.some("not-a-token") })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LoginSaveTokenError");
        expect(json).toContain("cannot save provided token:");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails in non-TTY with no token", () => {
    const { layer } = setupLogin({ isTTY: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(login(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LoginMissingTokenError");
        expect(json).toContain("Cannot use automatic login flow inside non-TTY environments");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("browser flow: generates link, opens browser, decrypts, saves, prints created", () => {
    const { layer, out, credentials } = setupLogin({ isTTY: true, tokenName: "my-machine" });
    return Effect.gen(function* () {
      yield* login(flags());
      expect(out.stdoutText).toContain(
        "Hello from Supabase! Press Enter to open browser and login automatically.",
      );
      expect(out.stdoutText).toContain("/cli/login?session_id=test-session-id");
      expect(out.stdoutText).toContain("Token my-machine created successfully.");
      expect(out.stdoutText).toContain("You are now logged in. Happy coding!");
      expect(credentials.savedToken).toBe(VALID_TOKEN);
    }).pipe(Effect.provide(layer));
  });

  it.live("browser flow with --no-browser prints the link without the open-browser banner", () => {
    const { layer, out } = setupLogin({ isTTY: true });
    return Effect.gen(function* () {
      yield* login(flags({ noBrowser: true }));
      expect(out.stdoutText).toContain("Here is your login link, open it in the browser");
      expect(out.stdoutText).not.toContain("Press Enter to open browser");
    }).pipe(Effect.provide(layer));
  });

  it.live("browser flow uses the default token name when --name is absent", () => {
    const { layer, out } = setupLogin({ isTTY: true });
    return Effect.gen(function* () {
      yield* login(flags());
      // mockLoginCrypto default token name.
      expect(out.stdoutText).toContain("Token cli_test@host_123 created successfully.");
    }).pipe(Effect.provide(layer));
  });

  it.live("retries verification on poll failure then succeeds", () => {
    const { layer, out, loginApi } = setupLogin({ isTTY: true, failTimes: 2 });
    return Effect.gen(function* () {
      yield* login(flags());
      expect(out.stderrText).toContain("Retry (1/2): ");
      expect(out.stderrText).toContain("Retry (2/2): ");
      // 2 failures + 1 success = 3 poll attempts.
      expect(loginApi.loginCallCount).toBe(3);
      expect(out.stdoutText).toContain("You are now logged in. Happy coding!");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails after 2 retries are exhausted", () => {
    const { layer, out } = setupLogin({ isTTY: true, failTimes: 3 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(login(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LoginFailedError");
      }
      // The 3rd (final) failure gives up without printing a Retry notice.
      expect(out.stderrText).toContain("Retry (2/2): ");
      expect(out.stderrText).not.toContain("Retry (3/2): ");
    }).pipe(Effect.provide(layer));
  });

  it.live("decrypt failure surfaces 'cannot decrypt access token'", () => {
    const { layer } = setupLogin({ isTTY: true, decryptFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(login(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LoginDecryptError");
        expect(json).toContain("cannot decrypt access token");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("telemetry: successful profile fetch stitches the gotrue_id", () => {
    const { layer, telemetry, analytics } = setupLogin({ gotrueId: "gotrue-abc" });
    return Effect.gen(function* () {
      yield* login(flags({ token: Option.some(VALID_TOKEN) }));
      expect(telemetry.stitchedDistinctId).toBe("gotrue-abc");
      expect(telemetry.clearedDistinctId).toBe(false);
      expect(analytics.captured.map((c) => c.event)).toContain(EventLoginCompleted);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "telemetry: profile fetch failure clears distinct_id but login still succeeds + still captures",
    () => {
      const { layer, out, telemetry, analytics } = setupLogin({ profileFails: true });
      return Effect.gen(function* () {
        yield* login(flags({ token: Option.some(VALID_TOKEN) }));
        expect(telemetry.clearedDistinctId).toBe(true);
        expect(telemetry.stitchedDistinctId).toBeUndefined();
        expect(analytics.captured.map((c) => c.event)).toContain(EventLoginCompleted);
        expect(out.stdoutText).toContain("You are now logged in. Happy coding!");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("flushes telemetry state via ensuring", () => {
    const { layer, telemetry } = setupLogin();
    return Effect.gen(function* () {
      yield* login(flags({ token: Option.some(VALID_TOKEN) }));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  for (const format of ["json", "stream-json"] as const) {
    it.live(`${format}: --token emits a single success result with no human banner`, () => {
      const { layer, out } = setupLogin({ format });
      return Effect.gen(function* () {
        yield* login(flags({ token: Option.some(VALID_TOKEN) }));
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.message).toBe("You are now logged in.");
        expect(out.stdoutText).not.toContain("Happy coding!");
      }).pipe(Effect.provide(layer));
    });
  }

  it.live("browser flow: keygen failure exits with LoginCryptoError", () => {
    const { layer } = setupLogin({ isTTY: true, keygenFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(login(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LoginCryptoError");
      }
    }).pipe(Effect.provide(layer));
  });

  for (const format of ["json", "stream-json"] as const) {
    it.live(`${format}: browser flow emits a success result with token_name`, () => {
      const { layer, out } = setupLogin({ format, isTTY: true, tokenName: "my-machine" });
      return Effect.gen(function* () {
        yield* login(flags());
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
      const { layer, out } = setupLogin({ stdoutIsTty: true });
      return Effect.gen(function* () {
        yield* login(flags({ token: Option.some(VALID_TOKEN) }));
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
    const { layer } = setupLogin({
      profileFlag: "supabase-staging",
      homeDir: tempRoot.current,
    });
    return Effect.gen(function* () {
      yield* login(flags({ token: Option.some(VALID_TOKEN) }));
      const profilePath = join(tempRoot.current, ".supabase", "profile");
      expect(existsSync(profilePath)).toBe(true);
      expect(readFileSync(profilePath, "utf8")).toBe("supabase-staging");
    }).pipe(Effect.provide(layer));
  });

  // The shadowed env value must never be re-persisted (Go: pflag `Changed`).
  it.live("explicit --profile supabase persists 'supabase', shadowing SUPABASE_PROFILE", () => {
    const prev = process.env["SUPABASE_PROFILE"];
    process.env["SUPABASE_PROFILE"] = "rogue-profile";
    const { layer } = setupLogin({
      argv: ["login", "--profile", "supabase", "--token", VALID_TOKEN],
      homeDir: tempRoot.current,
    });
    return Effect.gen(function* () {
      yield* login(flags({ token: Option.some(VALID_TOKEN) }));
      const profilePath = join(tempRoot.current, ".supabase", "profile");
      expect(readFileSync(profilePath, "utf8")).toBe("supabase");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_PROFILE"];
          else process.env["SUPABASE_PROFILE"] = prev;
        }),
      ),
    );
  });

  // Permanently heals a file persisted by an older lenient version (#6091).
  it.live("explicit --profile supabase heals a stale persisted profile file", () => {
    mkdirSync(join(tempRoot.current, ".supabase"), { recursive: true });
    writeFileSync(join(tempRoot.current, ".supabase", "profile"), "resms");
    const { layer } = setupLogin({
      argv: ["login", "--profile=supabase"],
      homeDir: tempRoot.current,
    });
    return Effect.gen(function* () {
      yield* login(flags({ token: Option.some(VALID_TOKEN) }));
      expect(readFileSync(join(tempRoot.current, ".supabase", "profile"), "utf8")).toBe("supabase");
    }).pipe(Effect.provide(layer));
  });

  it.live("browser flow in json mode fails cleanly at the prompt", () => {
    const { layer } = setupLogin({ format: "json", isTTY: true, promptTextFail: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(login(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("NonInteractiveError");
      }
    }).pipe(Effect.provide(layer));
  });
});
