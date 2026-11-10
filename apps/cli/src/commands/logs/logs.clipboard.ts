import { Context, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { withChildTraceEnv, withProcessSpan } from "../../shared/telemetry/spans.ts";
import { LogsClipboardError } from "./logs.errors.ts";

export class LogsClipboard extends Context.Service<
  LogsClipboard,
  {
    readonly copy: (text: string) => Effect.Effect<void, LogsClipboardError>;
  }
>()("supabase/logs/Clipboard") {}

export const logsClipboardLayer = Layer.effect(
  LogsClipboard,
  Effect.gen(function* () {
    const runtime = yield* RuntimeInfo;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const windowsScript =
      "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())";
    const commands: ReadonlyArray<readonly [string, ReadonlyArray<string>]> =
      runtime.platform === "darwin"
        ? [["pbcopy", []]]
        : runtime.platform === "win32"
          ? [
              [
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-STA", "-Command", windowsScript],
              ],
            ]
          : runtime.platform === "linux"
            ? [
                ["wl-copy", []],
                ["xclip", ["-selection", "clipboard", "-in"]],
                ["xsel", ["--clipboard", "--input"]],
              ]
            : [];
    return LogsClipboard.of({
      copy: Effect.fn("Logs.clipboard.copy")(
        function* (text) {
          let failed = false;
          for (const [executable, args] of commands) {
            const result = yield* withProcessSpan(
              "Logs.clipboard.write",
              { executable, argCount: args.length, hasFallback: true },
              (traceEnv) =>
                spawner.exitCode(
                  ChildProcess.make(
                    executable,
                    args,
                    withChildTraceEnv(
                      {
                        stdin: Stream.make(new TextEncoder().encode(text)),
                        detached: false,
                        stdout: "ignore",
                        stderr: "ignore",
                        forceKillAfter: "250 millis",
                        env: runtime.platform === "darwin" ? { LC_ALL: "en_US.UTF-8" } : undefined,
                        extendEnv: true,
                      },
                      traceEnv,
                    ),
                  ),
                ),
            ).pipe(Effect.result);
            if (result._tag === "Success") {
              if (result.success === 0) return;
              failed = true;
            } else if (result.failure.reason._tag !== "NotFound") failed = true;
          }
          return yield* new LogsClipboardError({
            reason: failed ? "failed" : "unavailable",
            message: failed
              ? "Copy failed; check clipboard access."
              : runtime.platform === "linux"
                ? "Install wl-clipboard, xclip, or xsel to copy."
                : "Clipboard tool unavailable; check system tools.",
          });
        },
        (effect) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: "3 seconds",
              orElse: () =>
                Effect.fail(
                  new LogsClipboardError({
                    reason: "timeout",
                    message: "Copy timed out; check clipboard access.",
                  }),
                ),
            }),
          ),
      ),
    });
  }),
);
