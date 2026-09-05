import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Stdio } from "effect";
import { Flag } from "effect/unstable/cli";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import {
  LegacyAgentFlag,
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyOutputFlag,
  LegacyWorkdirFlag,
} from "../../shared/legacy/global-flags.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import {
  PropErrorCategory,
  PropErrorFingerprint,
  PropErrorKind,
  PropHasSuggestion,
  PropSuggestedCommand,
  PropSuggestionType,
  PropWorkflow,
} from "../../shared/telemetry/event-catalog.ts";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { LegacyConfigDiffLoadConfigError } from "../commands/config/diff/diff.errors.ts";
import { LegacyDbDumpRunError } from "../commands/db/dump/dump.errors.ts";
import { LegacyIdentityStitch } from "../shared/legacy-identity-stitch.ts";
import { withLegacyCommandInstrumentation } from "./legacy-command-instrumentation.ts";
import {
  LEGACY_QUERY_OUTPUT_FORMATS,
  LegacyInvalidOutputFormatError,
} from "../shared/legacy-go-output-flag.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
} from "../../../tests/helpers/mocks.ts";

const FAILURE_PROPERTY_NAMES = [
  PropErrorKind,
  PropErrorCategory,
  PropErrorFingerprint,
  PropHasSuggestion,
  PropSuggestionType,
  PropSuggestedCommand,
  PropWorkflow,
] as const;

function mockLegacyIdentityStitch(opts: { stitchedDistinctId?: string }) {
  return {
    layer: Layer.succeed(
      LegacyIdentityStitch,
      LegacyIdentityStitch.of({
        stitch: () => Effect.void,
        stitchedDistinctId: () => opts.stitchedDistinctId,
      }),
    ),
  };
}

function failingAnalytics(defect: unknown) {
  return Layer.succeed(
    Analytics,
    Analytics.of({
      capture: () => Effect.die(defect),
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );
}

function interruptingAnalytics() {
  return Layer.succeed(
    Analytics,
    Analytics.of({
      capture: () => Effect.interrupt,
      identify: () => Effect.void,
      alias: () => Effect.void,
      groupIdentify: () => Effect.void,
    }),
  );
}

describe("withLegacyCommandInstrumentation", () => {
  it.live("annotates the command span and emits cli_command_executed", () => {
    const analytics = mockContextualAnalytics();

    return Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      expect(span.name).toBe("command.backups.list");
      expect(span.attributes.get("command")).toBe("backups list");
      expect(typeof span.attributes.get("command_run_id")).toBe("string");
    }).pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["backups", "list"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          const event = analytics.captured[0];
          expect(event?.event).toBe("cli_command_executed");
          expect(event?.properties.command).toBe("backups list");
          expect(event?.properties.exit_code).toBe(0);
          expect(typeof event?.properties.duration_ms).toBe("number");
          expect(event?.properties.output_format).toBe("text");
          for (const property of FAILURE_PROPERTY_NAMES) {
            expect(event?.properties).not.toHaveProperty(property);
          }
        }),
      ),
    );
  });

  it.live("reports legacy Go machine output formats emitted through the text layer", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["backups", "list", "--output", "yaml"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured[0]?.properties.output_format).toBe("yaml");
        }),
      ),
    );
  });

  it.live("keeps the TS output format when legacy --output pretty defers to it", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "json" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "backups",
            "list",
            "--output",
            "pretty",
            "--output-format",
            "json",
          ]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured[0]?.properties.output_format).toBe("json");
        }),
      ),
    );
  });

  it.live("emits a single `flags` map (no `flags_used`/`flag_values`)", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { projectRef: Option.some("abcdefghijklmnopqrst") },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["secrets", "list", "--project-ref", "abcdefghijklmnopqrst"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["secrets", "list"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ "project-ref": "<redacted>" });
          expect(event?.properties).not.toHaveProperty("flags_used");
          expect(event?.properties).not.toHaveProperty("flag_values");
        }),
      ),
    );
  });

  it.live("redacts unsafe string flag values", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { envFile: Option.some("/path/to/.env") },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["secrets", "set", "--env-file=/path/to/.env"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["secrets", "set"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ "env-file": "<redacted>" });
        }),
      ),
    );
  });

  it.live("redacts the --password credential (never safe-listed)", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { password: Option.some("super-secret") },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({ args: Effect.succeed(["db", "dump", "--password", "super-secret"]) }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "dump"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ password: "<redacted>" });
        }),
      ),
    );
  });

  it.live("records a flag set via its shorthand under the canonical name", () => {
    // Go's changedFlags() uses pflag Visit, which reports the canonical `schema`
    // name even when the user typed the `-s` shorthand (cmd/db.go:506). The alias
    // map lets the TS instrumentation match the single-dash form.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { schema: Option.some(["public"]) },
        aliases: { s: "schema" },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["db", "lint", "-s", "public"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "lint"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          // Slice flag stays redacted (not an EnumFlag/bool), but it IS recorded.
          expect(event?.properties.flags).toEqual({ schema: "<redacted>" });
        }),
      ),
    );
  });

  it.live("records db dump shorthand flags (-x/-f) under their canonical names", () => {
    // db dump declares -s/-x/-f/-p shorthands; Go's changedFlags() reports the
    // canonical long names, so the instrumentation alias map must map all of them.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { exclude: ["public.users"], file: Option.some("out.sql") },
        aliases: { s: "schema", x: "exclude", f: "file", p: "password" },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["db", "dump", "-x", "public.users", "-f", "out.sql"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "dump"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ exclude: "<redacted>", file: "<redacted>" });
        }),
      ),
    );
  });

  it.live("records db query shorthand -f under its canonical name file", () => {
    // db query declares only the -f/file shorthand; Go's changedFlags() reports the
    // canonical `file`, so `db query -f query.sql` must log `file`, not `f`.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { file: Option.some("query.sql") },
        aliases: { f: "file" },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["db", "query", "-f", "query.sql"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "query"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ file: "<redacted>" });
        }),
      ),
    );
  });

  it.live("records declarative generate shorthands -s/-p under canonical names", () => {
    // Go registers --schema/-s and --password/-p (cmd/db_schema_declarative.go:495,500);
    // changedFlags() reports the canonical schema/password.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { schema: ["public"], password: Option.some("secret") },
        aliases: { s: "schema", p: "password" },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "db",
            "schema",
            "declarative",
            "generate",
            "-s",
            "public",
            "-p",
            "secret",
          ]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "schema", "declarative", "generate"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ schema: "<redacted>", password: "<redacted>" });
        }),
      ),
    );
  });

  it.live("records declarative sync shorthands -s/-f under canonical names", () => {
    // Go registers --schema/-s and --file/-f (cmd/db_schema_declarative.go:484-485);
    // changedFlags() reports the canonical schema/file.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { schema: ["public"], file: Option.some("out.sql") },
        aliases: { s: "schema", f: "file" },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "db",
            "schema",
            "declarative",
            "sync",
            "-s",
            "public",
            "-f",
            "out.sql",
          ]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "schema", "declarative", "sync"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ schema: "<redacted>", file: "<redacted>" });
        }),
      ),
    );
  });

  it.live("passes boolean flag values through verbatim", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: {
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "ssl-enforcement",
            "update",
            "--enable-db-ssl-enforcement",
            "--disable-db-ssl-enforcement",
          ]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["ssl-enforcement", "update"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({
            "disable-db-ssl-enforcement": false,
            "enable-db-ssl-enforcement": true,
          });
        }),
      ),
    );
  });

  it.live("passes safeFlags values through verbatim", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { projectRef: Option.some("abcdefghijklmnopqrst") },
        safeFlags: ["project-ref"],
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["link", "--project-ref", "abcdefghijklmnopqrst"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["link"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({
            "project-ref": "abcdefghijklmnopqrst",
          });
        }),
      ),
    );
  });

  it.live("passes Flag.choice values through verbatim (Go parity: isEnumFlag)", () => {
    const analytics = mockContextualAnalytics();
    const config = {
      lang: Flag.choice("lang", ["typescript", "go", "python"] as const),
    };

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { lang: "python" },
        config,
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({ args: Effect.succeed(["gen", "types", "--lang", "python"]) }),
      ),
      Effect.provide(commandRuntimeLayer(["gen", "types"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ lang: "python" });
        }),
      ),
    );
  });

  it.live(
    "passes a Flag.withDefault-wrapped Flag.choice value through verbatim (Map(Optional(Single)))",
    () => {
      const analytics = mockContextualAnalytics();
      // Mirrors gen signing-key's real `algorithm` flag construction exactly —
      // `.pipe(Flag.withDefault(...))` composes as `Map(Optional(Single))`.
      const config = {
        algorithm: Flag.choice("algorithm", ["RS256", "ES256"] as const).pipe(
          Flag.withDefault("ES256" as const),
        ),
      };

      return Effect.void.pipe(
        withLegacyCommandInstrumentation({
          flags: { algorithm: "RS256" },
          config,
        }),
        Effect.provide(analytics.layer),
        Effect.provide(mockProcessControl().layer),
        Effect.provide(mockOutput({ format: "text" }).layer),
        Effect.provide(
          Stdio.layerTest({ args: Effect.succeed(["gen", "signing-key", "--algorithm", "RS256"]) }),
        ),
        Effect.provide(commandRuntimeLayer(["gen", "signing-key"])),
        Effect.tap(() =>
          Effect.sync(() => {
            const event = analytics.captured[0];
            expect(event?.properties.flags).toEqual({ algorithm: "RS256" });
          }),
        ),
      );
    },
  );

  it.live(
    "resolves a Flag.choice's shorthand alias to its canonical name (Go parity: pflag.Visit)",
    () => {
      const analytics = mockContextualAnalytics();
      // Mirrors sso add's real `type` flag construction exactly — `-t` is a
      // registered alias (Flag.withAlias("t")) that must be mapped to the
      // canonical "type" name for extractChangedFlagNames to record it at all.
      const config = {
        type: Flag.choice("type", ["saml"] as const).pipe(Flag.withAlias("t")),
      };

      return Effect.void.pipe(
        withLegacyCommandInstrumentation({
          flags: { type: "saml" },
          config,
          aliases: { t: "type" },
        }),
        Effect.provide(analytics.layer),
        Effect.provide(mockProcessControl().layer),
        Effect.provide(mockOutput({ format: "text" }).layer),
        Effect.provide(Stdio.layerTest({ args: Effect.succeed(["sso", "add", "-t", "saml"]) })),
        Effect.provide(commandRuntimeLayer(["sso", "add"])),
        Effect.tap(() =>
          Effect.sync(() => {
            const event = analytics.captured[0];
            expect(event?.properties.flags).toEqual({ type: "saml" });
          }),
        ),
      );
    },
  );

  it.live("passes an Optional-wrapped Flag.choice value through verbatim", () => {
    const analytics = mockContextualAnalytics();
    const config = {
      algorithm: Flag.choice("algorithm", ["RS256", "ES256"] as const).pipe(Flag.optional),
    };

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { algorithm: Option.some("ES256") },
        config,
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({ args: Effect.succeed(["gen", "signing-key", "--algorithm", "ES256"]) }),
      ),
      Effect.provide(commandRuntimeLayer(["gen", "signing-key"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ algorithm: "ES256" });
        }),
      ),
    );
  });

  it.live("still redacts non-choice string flags even when config is provided", () => {
    const analytics = mockContextualAnalytics();
    const config = {
      lang: Flag.choice("lang", ["typescript", "go"] as const),
      schema: Flag.string("schema"),
    };

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { lang: "go", schema: "public" },
        config,
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["gen", "types", "--lang", "go", "--schema", "public"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["gen", "types"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ lang: "go", schema: "<redacted>" });
        }),
      ),
    );
  });

  it.live("omits the `flags` property when no flags changed", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({ flags: {} }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["backups", "list"]) })),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toBeUndefined();
        }),
      ),
    );
  });

  it.live("adds sanitized metadata from the original typed failure", () => {
    const analytics = mockContextualAnalytics();
    const secret = "dump failed for postgres://customer.internal/private";

    return withLegacyCommandInstrumentation()(
      Effect.fail(new LegacyDbDumpRunError({ message: secret })),
    ).pipe(
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["backups", "list"]) })),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.exit,
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.properties).toMatchObject({
            exit_code: 1,
            error_kind: "user_actionable",
            error_category: "db_connection",
            error_fingerprint: "tag:LegacyDbDumpRunError",
            has_suggestion: true,
            suggestion_type: "update_config",
          });
          expect(analytics.captured[0]?.properties).not.toHaveProperty(PropSuggestedCommand);
          expect(analytics.captured[0]?.properties).not.toHaveProperty(PropWorkflow);
          expect(JSON.stringify(analytics.captured[0])).not.toContain(secret);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("preserves the command failure when telemetry capture defects", () => {
    const failure = new LegacyDbDumpRunError({ message: "command failure" });

    return Effect.fail(failure).pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(failingAnalytics(new Error("telemetry defect"))),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["db", "dump"]) })),
      Effect.provide(commandRuntimeLayer(["db", "dump"])),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(failure);
            expect(Cause.hasDies(exit.cause)).toBe(false);
          }
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("propagates fiber interruption from telemetry capture", () => {
    // A capture failure or defect is swallowed (best-effort telemetry), but an
    // interruption landing during the trailing capture must not be — the fiber
    // is being cancelled and swallowing would fight the cancellation.
    return Effect.void.pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(interruptingAnalytics()),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["db", "dump"]) })),
      Effect.provide(commandRuntimeLayer(["db", "dump"])),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          }
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("classifies db lint machine-mode fail-on like its typed text-mode error", () => {
    // Go records the telemetry exit code from the real process exit code
    // (`cmd/root.go:177` -> `exitCode(err)` = 1). `db lint`/`db advisors` set
    // ProcessControl's exit code in json/stream-json mode after a --fail-on
    // trigger and return success (to keep the machine payload on stdout intact),
    // so the instrumentation must report 1, not the Effect's success.
    const analytics = mockContextualAnalytics();
    const processControl = mockProcessControl();

    return Effect.gen(function* () {
      const pc = yield* ProcessControl;
      yield* pc.setExitCode(1);
    }).pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(processControl.layer),
      Effect.provide(mockOutput({ format: "json" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["db", "lint"]) })),
      Effect.provide(commandRuntimeLayer(["db", "lint"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.properties).toMatchObject({
            exit_code: 1,
            error_kind: "user_actionable",
            error_category: "invalid_config",
            error_fingerprint: "tag:LegacyDbLintFailOnError",
            has_suggestion: false,
            suggestion_type: "none",
          });
        }),
      ),
    );
  });

  it.live("classifies db advisors machine-mode fail-on like its typed text-mode error", () => {
    const analytics = mockContextualAnalytics();
    const processControl = mockProcessControl();

    return Effect.gen(function* () {
      const pc = yield* ProcessControl;
      yield* pc.setExitCode(1);
    }).pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(processControl.layer),
      Effect.provide(mockOutput({ format: "json" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["db", "advisors"]) })),
      Effect.provide(commandRuntimeLayer(["db", "advisors"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured[0]?.properties).toMatchObject({
            exit_code: 1,
            error_kind: "user_actionable",
            error_category: "invalid_config",
            error_fingerprint: "tag:LegacyDbAdvisorsFailOnError",
            has_suggestion: false,
            suggestion_type: "none",
          });
        }),
      ),
    );
  });

  it.live("classifies a command that sets its exit code outside the instrumentation", () => {
    // `db dump` converts its run failure into an exit code in the command pipe
    // (`Effect.catchTag(...)` applied AFTER this wrapper), not inside the
    // handler like `db lint`/`db advisors`. Instrumentation is the innermost
    // wrapper, so it still sees the typed failure and must classify it rather
    // than fall back to the process-controlled `unknown` bucket. Reordering
    // that pipe would silently degrade this command's telemetry.
    const analytics = mockContextualAnalytics();
    const processControl = mockProcessControl();
    const failure = new LegacyDbDumpRunError({ message: "container exited 1" });

    return Effect.fail(failure).pipe(
      withLegacyCommandInstrumentation(),
      Effect.catchTag("LegacyDbDumpRunError", () =>
        Effect.gen(function* () {
          const pc = yield* ProcessControl;
          yield* pc.setExitCode(1);
        }),
      ),
      Effect.provide(analytics.layer),
      Effect.provide(processControl.layer),
      Effect.provide(mockOutput({ format: "json" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["db", "dump"]) })),
      Effect.provide(commandRuntimeLayer(["db", "dump"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured[0]?.properties).toMatchObject({
            exit_code: 1,
            error_kind: "user_actionable",
            error_category: "db_connection",
            error_fingerprint: "tag:LegacyDbDumpRunError",
          });
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("uses a static unknown fallback for other process-controlled failures", () => {
    const analytics = mockContextualAnalytics();
    const processControl = mockProcessControl();

    return Effect.gen(function* () {
      const pc = yield* ProcessControl;
      yield* pc.setExitCode(2);
    }).pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(processControl.layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["unknown", "command"]) })),
      Effect.provide(commandRuntimeLayer(["unknown", "command"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured[0]?.properties).toMatchObject({
            exit_code: 1,
            error_kind: "unknown",
            error_category: "unknown",
            error_fingerprint: "error:ProcessControlledFailure",
            has_suggestion: false,
            suggestion_type: "none",
          });
        }),
      ),
    );
  });

  it.live(
    "records config diff --exit-code drift (exit 2) truthfully, without failure metadata",
    () => {
      // `config diff --exit-code` sets ProcessControl's exit code to 2 to signal
      // drift WITHOUT failing the Effect (diff.handler.ts's own 0/1/2 convention:
      // 2 means "drift found", not "command failed"). That is the command's own
      // successful outcome, not a process-controlled failure — it must not
      // collapse to 1 or attach db lint/db advisors-style failure classification.
      const analytics = mockContextualAnalytics();
      const processControl = mockProcessControl();

      return Effect.gen(function* () {
        const pc = yield* ProcessControl;
        yield* pc.setExitCode(2);
      }).pipe(
        withLegacyCommandInstrumentation(),
        Effect.provide(analytics.layer),
        Effect.provide(processControl.layer),
        Effect.provide(mockOutput({ format: "json" }).layer),
        Effect.provide(
          Stdio.layerTest({ args: Effect.succeed(["config", "diff", "--exit-code"]) }),
        ),
        Effect.provide(commandRuntimeLayer(["config", "diff"])),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(analytics.captured).toHaveLength(1);
            const event = analytics.captured[0];
            expect(event?.properties.exit_code).toBe(2);
            for (const property of FAILURE_PROPERTY_NAMES) {
              expect(event?.properties).not.toHaveProperty(property);
            }
          }),
        ),
      );
    },
  );

  it.live(
    "still collapses another command's process-controlled exit 2 to 1 (unknown classification)",
    () => {
      // Only `config diff` gets the drift-signal exception above — any other
      // command setting exit code 2 without failing the Effect keeps today's
      // behavior: collapse to 1 and fall back to the unknown classification.
      const analytics = mockContextualAnalytics();
      const processControl = mockProcessControl();

      return Effect.gen(function* () {
        const pc = yield* ProcessControl;
        yield* pc.setExitCode(2);
      }).pipe(
        withLegacyCommandInstrumentation(),
        Effect.provide(analytics.layer),
        Effect.provide(processControl.layer),
        Effect.provide(mockOutput({ format: "text" }).layer),
        Effect.provide(Stdio.layerTest({ args: Effect.succeed(["backups", "list"]) })),
        Effect.provide(commandRuntimeLayer(["backups", "list"])),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(analytics.captured[0]?.properties).toMatchObject({
              exit_code: 1,
              error_kind: "unknown",
              error_category: "unknown",
              error_fingerprint: "error:ProcessControlledFailure",
              has_suggestion: false,
              suggestion_type: "none",
            });
          }),
        ),
      );
    },
  );

  it.live("classifies a config diff load failure normally (exit 1, cause-derived metadata)", () => {
    // A real command failure on `config diff` (e.g. an unparseable config
    // file) must not be swept into the drift-signal exception above — it
    // still fails the Effect, so recordedExitCode stays 1 with the usual
    // cause-derived classification.
    const analytics = mockContextualAnalytics();
    const failure = new LegacyConfigDiffLoadConfigError({ message: "invalid config" });

    return Effect.fail(failure).pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["config", "diff"]) })),
      Effect.provide(commandRuntimeLayer(["config", "diff"])),
      Effect.exit,
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured[0]?.properties).toMatchObject({
            exit_code: 1,
            error_kind: "user_actionable",
            error_category: "invalid_config",
            error_fingerprint: "tag:LegacyConfigDiffLoadConfigError",
            has_suggestion: true,
            suggestion_type: "update_config",
          });
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("skips analytics capture when analytics are disabled", () => {
    const analytics = mockContextualAnalytics();

    return Effect.sync(() => "ok").pipe(
      withLegacyCommandInstrumentation({ analytics: false }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["telemetry", "enable"]) })),
      Effect.provide(commandRuntimeLayer(["telemetry", "enable"])),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toEqual([]);
        }),
      ),
    );
  });

  it.live("sorts flag names alphabetically to match Go", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: {
          projectRef: Option.some("abcdefghijklmnopqrst"),
          timestamp: Option.some(1707407047),
        },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "backups",
            "restore",
            "--timestamp=1707407047",
            "--project-ref",
            "abcdefghijklmnopqrst",
          ]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["backups", "restore"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          const flags = event?.properties.flags as Record<string, unknown>;
          // Keys should be insertion-ordered alphabetically.
          expect(Object.keys(flags)).toEqual(["project-ref", "timestamp"]);
        }),
      ),
    );
  });

  it.live("rejects an -o value outside the command's enum, before running it", () => {
    const analytics = mockContextualAnalytics();

    return Effect.sync(() => "must not run").pipe(
      withLegacyCommandInstrumentation({ flags: {} }),
      Effect.provide(analytics.layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["backups", "list", "-o", "table"]) })),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      // `table` is valid on the shared global union but not for a resource command.
      Effect.provide(Layer.succeed(LegacyOutputFlag, Option.some("table" as const))),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(LegacyInvalidOutputFormatError);
          expect((error as LegacyInvalidOutputFormatError).message).toBe(
            'invalid argument "table" for "-o, --output" flag: must be one of [ env | pretty | json | toml | yaml ]',
          );
          // Go rejects at parse time, before telemetry — so no event is emitted.
          expect(analytics.captured).toEqual([]);
        }),
      ),
    );
  });

  it.live("accepts a command-specific -o value declared via outputFormats", () => {
    const analytics = mockContextualAnalytics();

    return Effect.sync(() => "ok").pipe(
      withLegacyCommandInstrumentation({ flags: {}, outputFormats: LEGACY_QUERY_OUTPUT_FORMATS }),
      Effect.provide(analytics.layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["db", "query", "-o", "csv"]) })),
      Effect.provide(commandRuntimeLayer(["db", "query"])),
      Effect.provide(Layer.succeed(LegacyOutputFlag, Option.some("csv" as const))),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.properties.exit_code).toBe(0);
        }),
      ),
    );
  });

  // Identity stitching parity: Go's Execute() reads s.distinctID() after the
  // command handler runs (cmd/root.go:177) and the post-run cli_command_executed
  // capture uses the stitched id. Mirror that with Effect.serviceOption.

  it.live("attributes cli_command_executed to the stitched gotrue id", () => {
    const analytics = mockContextualAnalytics();
    const stitch = mockLegacyIdentityStitch({ stitchedDistinctId: "gotrue-user-123" });

    return Effect.void.pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["link"]) })),
      Effect.provide(commandRuntimeLayer(["link"])),
      Effect.provide(stitch.layer),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.properties.distinct_id).toBe("gotrue-user-123");
        }),
      ),
    );
  });

  it.live("rejects a resource-only -o value for db query's narrower enum", () => {
    const analytics = mockContextualAnalytics();

    return Effect.sync(() => "must not run").pipe(
      withLegacyCommandInstrumentation({ flags: {}, outputFormats: LEGACY_QUERY_OUTPUT_FORMATS }),
      Effect.provide(analytics.layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["db", "query", "-o", "yaml"]) })),
      Effect.provide(commandRuntimeLayer(["db", "query"])),
      Effect.provide(Layer.succeed(LegacyOutputFlag, Option.some("yaml" as const))),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect((error as LegacyInvalidOutputFormatError).message).toBe(
            'invalid argument "yaml" for "-o, --output" flag: must be one of [ json | table | csv ]',
          );
        }),
      ),
    );
  });

  it.live("does not set distinct_id when no stitch occurred", () => {
    const analytics = mockContextualAnalytics();
    const stitch = mockLegacyIdentityStitch({ stitchedDistinctId: undefined });

    return Effect.void.pipe(
      withLegacyCommandInstrumentation(),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["link"]) })),
      Effect.provide(commandRuntimeLayer(["link"])),
      Effect.provide(stitch.layer),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(analytics.captured).toHaveLength(1);
          expect(analytics.captured[0]?.properties.distinct_id).toBeUndefined();
        }),
      ),
    );
  });

  it.live(
    "does not require LegacyIdentityStitch — capture fires and distinct_id is absent when service is not provided",
    () => {
      // Proves Effect.serviceOption adds no hard R requirement: the stitch layer is
      // intentionally absent and the instrumentation must still fire the event.
      const analytics = mockContextualAnalytics();

      return Effect.void.pipe(
        withLegacyCommandInstrumentation(),
        Effect.provide(analytics.layer),
        Effect.provide(mockProcessControl().layer),
        Effect.provide(mockOutput({ format: "text" }).layer),
        Effect.provide(Stdio.layerTest({ args: Effect.succeed(["backups", "list"]) })),
        Effect.provide(commandRuntimeLayer(["backups", "list"])),
        // Note: no stitch layer provided — serviceOption must default to None
        Effect.tap(() =>
          Effect.sync(() => {
            expect(analytics.captured).toHaveLength(1);
            expect(analytics.captured[0]?.properties.distinct_id).toBeUndefined();
          }),
        ),
      );
    },
  );

  // Value-consuming flag skip parity: Go's pflag.Changed records only the flag
  // name, not the value token that follows it in space-separated form.
  // `--schema --linked` must record only `schema` (--linked is the value for
  // --schema, consumed by pflag, so pflag.Changed("linked") is false).

  it.live("does not record a flag token that was consumed as another flag's value", () => {
    // `db lint --schema --linked`: Go pflag consumes `--linked` as the value
    // for `--schema`. changedFlags() sees only `schema`.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { schema: Option.some(["--linked"]) },
        aliases: { s: "schema" },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["db", "lint", "--schema", "--linked"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "lint"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const flags = analytics.captured[0]?.properties.flags as Record<string, unknown>;
          // Only `schema` should be recorded; `linked` was consumed as the value.
          expect(flags).toEqual({ schema: "<redacted>" });
          expect(Object.keys(flags)).not.toContain("linked");
        }),
      ),
    );
  });

  it.live("records both flags when the value is attached via = (--schema=public --linked)", () => {
    // `--schema=public` carries the value inline; `--linked` is a separate flag.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { schema: Option.some(["public"]), linked: true },
        aliases: { s: "schema" },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["db", "lint", "--schema=public", "--linked"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "lint"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const flags = analytics.captured[0]?.properties.flags as Record<string, unknown>;
          // Both flags recorded: `schema` (= form, no skip) and `linked` (boolean).
          expect(Object.keys(flags).sort()).toEqual(["linked", "schema"]);
        }),
      ),
    );
  });

  it.live("skips value token for bare short value-consuming flag (-s public --linked)", () => {
    // `-s public` bare short form: `public` is consumed as the schema value.
    // `--linked` is a separate boolean flag and IS recorded.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { schema: Option.some(["public"]), linked: true },
        aliases: { s: "schema" },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["db", "lint", "-s", "public", "--linked"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "lint"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const flags = analytics.captured[0]?.properties.flags as Record<string, unknown>;
          // `schema` (via -s alias) and `linked` (separate boolean flag) recorded.
          expect(Object.keys(flags).sort()).toEqual(["linked", "schema"]);
          // `public` was consumed as the -s value, not treated as a flag name.
          expect(Object.keys(flags)).not.toContain("public");
        }),
      ),
    );
  });

  it.live("skips value token after bare --db-url and records only db-url", () => {
    // `--db-url x --local`: `x` is consumed as the db-url value; `--local` is
    // a separate boolean flag and is recorded. This mirrors Go's pflag.Changed.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { dbUrl: Option.some("x"), local: true },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["db", "lint", "--db-url", "x", "--local"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "lint"])),
      Effect.tap(() =>
        Effect.sync(() => {
          const flags = analytics.captured[0]?.properties.flags as Record<string, unknown>;
          expect(Object.keys(flags).sort()).toEqual(["db-url", "local"]);
          // "x" must not appear as a recorded flag name.
          expect(Object.keys(flags)).not.toContain("x");
        }),
      ),
    );
  });

  // Global/persistent flag parity (CLI-1896): Go's changedFlags() walks
  // cmd.Parent()'s PersistentFlags() in addition to the leaf's own flags
  // (cmd/root_analytics.go:53-76), so a global flag like --debug resolves to
  // its real value even though no command declares it locally. The wrapper
  // reads shared/legacy/global-flags.ts itself rather than relying on the
  // per-command `flags` option to carry global flag values.

  it.live("records a changed global boolean flag's real value (e.g. --debug)", () => {
    // Go reports `flags: {debug: true}` for `supabase --debug telemetry disable`
    // (isBooleanFlag is always safe, regardless of markFlagTelemetrySafe) — the
    // TS port previously had no way to resolve `debug` at all and fell back to
    // "<redacted>" for every global flag, even booleans.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({ flags: {} }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["backups", "list", "--debug"]) })),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.provide(Layer.succeed(LegacyDebugFlag, true)),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ debug: true });
        }),
      ),
    );
  });

  it.live("merges a changed global flag alongside the command's own local flags", () => {
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({
        flags: { projectRef: Option.some("abcdefghijklmnopqrst") },
      }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed([
            "secrets",
            "list",
            "--project-ref",
            "abcdefghijklmnopqrst",
            "--debug",
          ]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["secrets", "list"])),
      Effect.provide(Layer.succeed(LegacyDebugFlag, true)),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({
            "project-ref": "<redacted>",
            debug: true,
          });
        }),
      ),
    );
  });

  it.live(
    "still redacts a changed global string flag like --workdir (Go never marks it telemetry-safe)",
    () => {
      const analytics = mockContextualAnalytics();

      return Effect.void.pipe(
        withLegacyCommandInstrumentation({ flags: {} }),
        Effect.provide(analytics.layer),
        Effect.provide(mockProcessControl().layer),
        Effect.provide(mockOutput({ format: "text" }).layer),
        Effect.provide(
          Stdio.layerTest({
            args: Effect.succeed(["backups", "list", "--workdir", "/tmp/project"]),
          }),
        ),
        Effect.provide(commandRuntimeLayer(["backups", "list"])),
        Effect.provide(Layer.succeed(LegacyWorkdirFlag, Option.some("/tmp/project"))),
        Effect.tap(() =>
          Effect.sync(() => {
            const event = analytics.captured[0];
            expect(event?.properties.flags).toEqual({ workdir: "<redacted>" });
          }),
        ),
      );
    },
  );

  it.live(
    "passes a changed global choice flag like --dns-resolver through verbatim (Go parity: isEnumFlag, CLI-1904)",
    () => {
      const analytics = mockContextualAnalytics();

      return Effect.void.pipe(
        withLegacyCommandInstrumentation({ flags: {} }),
        Effect.provide(analytics.layer),
        Effect.provide(mockProcessControl().layer),
        Effect.provide(mockOutput({ format: "text" }).layer),
        Effect.provide(
          Stdio.layerTest({
            args: Effect.succeed(["backups", "list", "--dns-resolver", "https"]),
          }),
        ),
        Effect.provide(commandRuntimeLayer(["backups", "list"])),
        Effect.provide(Layer.succeed(LegacyDnsResolverFlag, "https" as const)),
        Effect.tap(() =>
          Effect.sync(() => {
            const event = analytics.captured[0];
            expect(event?.properties.flags).toEqual({ "dns-resolver": "https" });
          }),
        ),
      );
    },
  );

  it.live(
    "passes a changed global choice flag like --agent through verbatim (Go parity: isEnumFlag, CLI-1904)",
    () => {
      const analytics = mockContextualAnalytics();

      return Effect.void.pipe(
        withLegacyCommandInstrumentation({ flags: {} }),
        Effect.provide(analytics.layer),
        Effect.provide(mockProcessControl().layer),
        Effect.provide(mockOutput({ format: "text" }).layer),
        Effect.provide(
          Stdio.layerTest({
            args: Effect.succeed(["backups", "list", "--agent", "yes"]),
          }),
        ),
        Effect.provide(commandRuntimeLayer(["backups", "list"])),
        Effect.provide(Layer.succeed(LegacyAgentFlag, "yes" as const)),
        Effect.tap(() =>
          Effect.sync(() => {
            const event = analytics.captured[0];
            expect(event?.properties.flags).toEqual({ agent: "yes" });
          }),
        ),
      );
    },
  );

  it.live(
    "still redacts a global choice flag shadowed by a command's own differently-typed local flag (db diff's local string --output, Go parity)",
    () => {
      // `db diff` declares its own local `output: Flag.string("output")` (a
      // file path, `cmd/db.go:622`) rather than a `Flag.choice` — mirroring
      // Go, where that command's own non-enum flag object governs
      // `isEnumFlag`, not root's persistent `*utils.EnumFlag`. Simulate that
      // shape here: `output` is declared in the handler's own `flags` record
      // (so `isFromHandler` is true) but absent from `config`, so it must NOT
      // inherit safety from `GLOBAL_CHOICE_FLAG_NAMES` just because the CLI
      // name collides with the global `--output` choice flag.
      const analytics = mockContextualAnalytics();

      return Effect.void.pipe(
        withLegacyCommandInstrumentation({ flags: { output: "diff.sql" } }),
        Effect.provide(analytics.layer),
        Effect.provide(mockProcessControl().layer),
        Effect.provide(mockOutput({ format: "text" }).layer),
        Effect.provide(
          Stdio.layerTest({
            args: Effect.succeed(["db", "diff", "--output", "diff.sql"]),
          }),
        ),
        Effect.provide(commandRuntimeLayer(["db", "diff"])),
        Effect.tap(() =>
          Effect.sync(() => {
            const event = analytics.captured[0];
            expect(event?.properties.flags).toEqual({ output: "<redacted>" });
          }),
        ),
      );
    },
  );

  it.live("falls back to redacted when a changed global flag's service isn't wired", () => {
    // Defensive case: `Effect.serviceOption` must never throw/defect when a
    // narrow harness (or, hypothetically, an incompletely-wired real command)
    // doesn't provide a global flag's context — it degrades to the prior
    // REDACTED_VALUE behavior instead of crashing.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({ flags: {} }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["backups", "list", "--debug"]) })),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      // Note: no LegacyDebugFlag layer provided.
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          expect(event?.properties.flags).toEqual({ debug: "<redacted>" });
        }),
      ),
    );
  });

  it.live("stops recording flags at the -- end-of-options sentinel", () => {
    // `test db -- --linked`: pflag stops parsing flags at `--`, so `--linked`
    // is a positional arg, not a changed flag. changedFlags() never sees it.
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({ flags: {} }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(
        Stdio.layerTest({
          args: Effect.succeed(["test", "db", "--", "--linked"]),
        }),
      ),
      Effect.provide(commandRuntimeLayer(["test", "db"])),
      Effect.tap(() =>
        Effect.sync(() => {
          // No changed flags → the flags map is omitted entirely; `--linked`
          // after `--` must never be recorded.
          const flags = analytics.captured[0]?.properties.flags;
          expect(flags).toBeUndefined();
        }),
      ),
    );
  });

  // CLI-1896 review follow-up (Codex): a global flag's SHORTHAND must resolve
  // through the same fallback its long form already does.

  it.live("resolves a global flag's shorthand (-o) through the global fallback", () => {
    // `-o json` must resolve to the canonical `output` flag the same way
    // `--output json` already does: Go's `pflag.Visit` reports the canonical
    // `flag.Name` for either form (`cmd/root_analytics.go:53-76`), and `-o` is
    // `--output`'s only registered persistent shorthand (`cmd/root.go:330`).
    const analytics = mockContextualAnalytics();

    return Effect.void.pipe(
      withLegacyCommandInstrumentation({ flags: {} }),
      Effect.provide(analytics.layer),
      Effect.provide(mockProcessControl().layer),
      Effect.provide(mockOutput({ format: "text" }).layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(["backups", "list", "-o", "json"]) })),
      Effect.provide(commandRuntimeLayer(["backups", "list"])),
      Effect.provide(Layer.succeed(LegacyOutputFlag, Option.some("json" as const))),
      Effect.tap(() =>
        Effect.sync(() => {
          const event = analytics.captured[0];
          // `output` is a global choice flag — passed through verbatim
          // (Go parity: isEnumFlag, CLI-1904), and it must be PRESENT, not
          // silently dropped.
          expect(event?.properties.flags).toEqual({ output: "json" });
        }),
      ),
    );
  });

  it.live(
    "does not fabricate a global flag from a local flag's value token (secrets set --env-file --debug)",
    () => {
      // `--env-file` is a value-consuming local string flag. In bare
      // space-separated form, pflag consumes the very next token as its
      // VALUE regardless of its shape, so Go's changedFlags() never marks
      // `debug` as changed for this invocation — the whole token is
      // `env-file`'s value. Without `env-file` registered in
      // VALUE_CONSUMING_LONG_FLAGS, extractChangedFlagNames would wrongly
      // treat the trailing `--debug` as a separate flag, and CLI-1896's
      // global-flag fallback would then fabricate a `flags.debug` value Go
      // never records.
      const analytics = mockContextualAnalytics();

      return Effect.void.pipe(
        withLegacyCommandInstrumentation({
          flags: { envFile: Option.some("--debug") },
        }),
        Effect.provide(analytics.layer),
        Effect.provide(mockProcessControl().layer),
        Effect.provide(mockOutput({ format: "text" }).layer),
        Effect.provide(
          Stdio.layerTest({
            args: Effect.succeed(["secrets", "set", "--env-file", "--debug"]),
          }),
        ),
        Effect.provide(commandRuntimeLayer(["secrets", "set"])),
        Effect.tap(() =>
          Effect.sync(() => {
            const event = analytics.captured[0];
            expect(event?.properties.flags).toEqual({ "env-file": "<redacted>" });
          }),
        ),
      );
    },
  );
});
