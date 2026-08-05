import { Effect, FileSystem, Option, Path, Redacted } from "effect";

import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { saveLegacyProfileName } from "../../config/legacy-profile-file.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import {
  LEGACY_LOGGED_IN_MSG,
  legacyBrowserLogin,
  legacyPostLoginTelemetry,
} from "../../shared/legacy-ensure-login.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { hasExplicitLongFlag } from "../../../shared/cli/cobra-flag-groups.ts";
import { LegacyProfileFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { legacySuggestClaudePlugin } from "./login-claude-hint.ts";
import {
  LEGACY_LOGIN_MISSING_TOKEN_MESSAGE,
  LegacyLoginMissingTokenError,
  LegacyLoginSaveTokenError,
} from "./login.errors.ts";
import type { LegacyLoginFlags } from "./login.command.ts";

export const legacyLogin = Effect.fn("legacy.login")(function* (flags: LegacyLoginFlags) {
  const output = yield* Output;
  const credentials = yield* LegacyCredentials;
  const telemetryState = yield* LegacyTelemetryState;
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const profileFlag = yield* LegacyProfileFlag;

  const claudeHint = legacySuggestClaudePlugin({ stdoutIsTty: tty.stdoutIsTty });

  // Mirrors Go's login `PostRunE` (`cmd/login.go:42-48`): persist the chosen
  // profile to `<SUPABASE_HOME or ~/.supabase>/profile` on success. The raw
  // token is written so a YAML-path profile round-trips; a write failure is
  // fatal. An explicitly passed flag counts even at its default value (pflag
  // `Changed`, same argv scan as the config layer), so `login --profile
  // supabase` persists "supabase" — shadowing SUPABASE_PROFILE and healing a
  // stale profile file like Go, never re-persisting the shadowed env value.
  const cliArgs = yield* Effect.serviceOption(CliArgs);
  const profileFlagExplicit = Option.match(cliArgs, {
    onNone: () => false,
    onSome: ({ args }) => hasExplicitLongFlag(args, [], "profile"),
  });
  const envProfile = process.env["SUPABASE_PROFILE"];
  const profileToken =
    profileFlagExplicit || profileFlag !== "supabase"
      ? profileFlag
      : envProfile !== undefined && envProfile.length > 0
        ? envProfile
        : undefined;
  const saveProfileName =
    profileToken === undefined
      ? Effect.void
      : saveLegacyProfileName(fs, path, runtimeInfo.homeDir, profileToken);

  const tokenPath = (token: string) =>
    Effect.gen(function* () {
      yield* credentials.saveAccessToken(token).pipe(
        Effect.catchTag("LegacyInvalidAccessTokenError", (cause) =>
          Effect.fail(
            new LegacyLoginSaveTokenError({
              message: `cannot save provided token: ${cause.message}`,
            }),
          ),
        ),
      );
      yield* legacyPostLoginTelemetry(token);

      if (output.format !== "text") {
        yield* output.success("You are now logged in.");
        return;
      }
      yield* output.raw(LEGACY_LOGGED_IN_MSG, "stdout");
      if (claudeHint.length > 0) yield* output.raw(`${claudeHint}\n`, "stderr");
    });

  const body = Effect.gen(function* () {
    // Token resolution priority: --token → SUPABASE_ACCESS_TOKEN → piped stdin
    // (non-TTY only). Matches `cmd/login.go:31-39` + `login.go:236-247`.
    const resolved = yield* resolveToken(flags);
    if (Option.isSome(resolved)) {
      return yield* tokenPath(resolved.value);
    }
    return yield* legacyBrowserLogin({ openBrowser: !flags.noBrowser, tokenName: flags.name });
  });

  // `Effect.tap` runs the profile save only on success (Go's `PostRunE`);
  // `Effect.ensuring` persists telemetry state on success and failure alike
  // (PersistentPostRun parity, `cmd/root.go:176`).
  return yield* body.pipe(
    Effect.tap(() => saveProfileName),
    Effect.ensuring(telemetryState.flush),
  );
});

const resolveToken = Effect.fnUntraced(function* (flags: LegacyLoginFlags) {
  if (Option.isSome(flags.token)) return Option.some(flags.token.value);
  const cliConfig = yield* LegacyCliConfig;
  if (Option.isSome(cliConfig.accessToken)) {
    return Option.some(Redacted.value(cliConfig.accessToken.value));
  }
  const stdin = yield* Stdin;
  if (!stdin.isTTY) {
    const piped = yield* stdin.readPipedText;
    if (Option.isSome(piped)) return Option.some(piped.value);
    return yield* Effect.fail(
      new LegacyLoginMissingTokenError({ message: LEGACY_LOGIN_MISSING_TOKEN_MESSAGE }),
    );
  }
  return Option.none<string>();
});
