import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

import { mockOutput, mockStdin, mockTty } from "../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import {
  mockCommandCredentialsTracked,
  mockTelemetryStateTracked,
} from "../../../tests/helpers/command-mocks.ts";
import { YesFlag } from "../../command-internal/global-flags.ts";
import { logout } from "./logout.handler.ts";

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly confirm?: boolean;
  readonly yes?: boolean;
  readonly deleteOutcome?: "ok" | "notLoggedIn" | "deleteError";
  readonly promptConfirmFail?: boolean;
  /** stdin interactivity; defaults to a TTY so prompt-driven tests reach the confirm. */
  readonly stdinIsTty?: boolean;
  /** Piped (non-TTY) stdin answers, one consumed per confirmation prompt. */
  readonly pipedAnswers?: ReadonlyArray<string>;
}

function setupLogout(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    confirmLogout: opts.confirm ?? false,
    promptConfirmFail: opts.promptConfirmFail,
  });
  const telemetry = mockTelemetryStateTracked();
  const credentials = mockCommandCredentialsTracked({ deleteOutcome: opts.deleteOutcome ?? "ok" });
  const layer = Layer.mergeAll(
    out.layer,
    credentials.layer,
    telemetry.layer,
    Layer.succeed(YesFlag, opts.yes ?? false),
    mockTty({ stdinIsTty: opts.stdinIsTty ?? true, stdoutIsTty: false }),
    mockStdin(
      opts.stdinIsTty ?? true,
      opts.pipedAnswers ? `${opts.pipedAnswers.join("\n")}\n` : undefined,
    ),
    Layer.succeed(CliArgs, { args: [] }),
  );
  return { layer, out, telemetry, credentials };
}

describe("logout integration", () => {
  it.live("confirms then deletes the token + all project credentials", () => {
    const { layer, out, credentials } = setupLogout({ confirm: true });
    return Effect.gen(function* () {
      yield* logout();
      expect(credentials.deletedAll).toBe(true);
      expect(out.stdoutText).toContain(
        "Access token deleted successfully. You are now logged out.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("--yes skips the prompt and logs out", () => {
    const { layer, out, credentials } = setupLogout({ yes: true });
    return Effect.gen(function* () {
      yield* logout();
      expect(credentials.deletedAll).toBe(true);
      // The `viper.GetBool("YES")` branch still echoes the accepted prompt to
      // stderr (`console.go:70-72`) — `--yes` runs must not be silent (CLI-1974).
      expect(out.stderrText).toContain(
        "Do you want to log out? This will remove the access token from your system. [y/N] y\n",
      );
      expect(out.stdoutText).toContain(
        "Access token deleted successfully. You are now logged out.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("declining the prompt cancels with a failure and does not sweep credentials", () => {
    const { layer, credentials } = setupLogout({ confirm: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(logout());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LogoutCancelledError");
      }
      expect(credentials.deletedAll).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("empty non-interactive stdin takes Go's default (false) and cancels", () => {
    // `PromptYesNo(..., false)` scans stdin and falls back to the default when
    // the scan is empty (`logout.go:16`, `console.go:64-82`). With no piped input
    // logout cancels — without hanging on the clack confirm.
    const { layer, credentials } = setupLogout({ stdinIsTty: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(logout());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LogoutCancelledError");
      }
      expect(credentials.deletedAll).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors a piped 'y' on non-interactive stdin and logs out", () => {
    // Regression: Go scans piped stdin before defaulting (`console.go:74-82`), so
    // `printf 'y\n' | supabase logout` deletes the token even on a non-terminal.
    const { layer, credentials } = setupLogout({ stdinIsTty: false, pipedAnswers: ["y"] });
    return Effect.gen(function* () {
      yield* logout();
      expect(credentials.deletedAll).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors SUPABASE_YES and logs out even when a piped 'n' is present", () => {
    // Go reads `viper.GetBool("YES")` (incl. the SUPABASE_YES env var) BEFORE
    // scanning stdin (`console.go:71`), so `SUPABASE_YES=1 printf 'n\n' | supabase
    // logout` auto-confirms and deletes rather than consuming the piped `n`. The
    // handler resolves `yes` via resolveYes, not the raw --yes flag.
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    const { layer, credentials } = setupLogout({ stdinIsTty: false, pipedAnswers: ["n"] });
    return Effect.gen(function* () {
      yield* logout();
      expect(credentials.deletedAll).toBe(true);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.provide(layer),
    );
  });

  it.live("not logged in: prints to stderr, exits 0, and does not sweep credentials", () => {
    const { layer, out, credentials } = setupLogout({
      yes: true,
      deleteOutcome: "notLoggedIn",
    });
    return Effect.gen(function* () {
      yield* logout();
      expect(out.stderrText).toContain("You were not logged in, nothing to do.");
      expect(out.stdoutText).not.toContain("Access token deleted successfully.");
      expect(credentials.deletedAll).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("delete failure propagates as a failure", () => {
    const { layer, credentials } = setupLogout({ yes: true, deleteOutcome: "deleteError" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(logout());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("DeleteTokenError");
      }
      expect(credentials.deletedAll).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("resets the telemetry identity on successful logout", () => {
    const { layer, telemetry } = setupLogout({ confirm: true });
    return Effect.gen(function* () {
      yield* logout();
      expect(telemetry.identityReset).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("resets the telemetry identity even when not logged in", () => {
    const { layer, telemetry } = setupLogout({ confirm: true, deleteOutcome: "notLoggedIn" });
    return Effect.gen(function* () {
      yield* logout();
      expect(telemetry.identityReset).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state on success", () => {
    const { layer, telemetry } = setupLogout({ yes: true });
    return Effect.gen(function* () {
      yield* logout();
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state on cancel", () => {
    const { layer, telemetry } = setupLogout({ confirm: false });
    return Effect.gen(function* () {
      yield* Effect.exit(logout());
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  for (const format of ["json", "stream-json"] as const) {
    it.live(`${format} with --yes emits a single success result`, () => {
      const { layer, out } = setupLogout({ format, yes: true });
      return Effect.gen(function* () {
        yield* logout();
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.message).toBe("Access token deleted successfully. You are now logged out.");
        expect(out.stdoutText).not.toContain("Access token deleted successfully.");
      }).pipe(Effect.provide(layer));
    });
  }

  for (const format of ["json", "stream-json"] as const) {
    it.live(`${format} not-logged-in emits the not-logged-in message as the result`, () => {
      const { layer, out, credentials } = setupLogout({
        format,
        yes: true,
        deleteOutcome: "notLoggedIn",
      });
      return Effect.gen(function* () {
        yield* logout();
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.message).toBe("You were not logged in, nothing to do.");
        expect(credentials.deletedAll).toBe(false);
      }).pipe(Effect.provide(layer));
    });
  }

  it.live("json mode without --yes fails cleanly at the confirm prompt", () => {
    const { layer } = setupLogout({ format: "json", yes: false, promptConfirmFail: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(logout());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("NonInteractiveError");
      }
    }).pipe(Effect.provide(layer));
  });
});
