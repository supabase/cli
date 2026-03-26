import { note } from "@clack/prompts";
import { Effect, Layer, Option, Path, Stdio, Stream, Tracer } from "effect";
import type { Exit, ServiceMap } from "effect";

import { CliConfig } from "../config/cli-config.service.ts";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { Tty } from "../runtime/tty.service.ts";
import { getConfigDir, getEffectiveConsent, readTelemetryConfig } from "./consent.ts";
import { makeDebugConsoleExporter } from "./exporters/debug-console.ts";
import { exportSpanToNdjson, initNdjsonExporter } from "./exporters/ndjson.ts";
import { resolveIdentity } from "./identity.ts";
import { Tracing } from "./tracing.service.ts";

/**
 * tracingLayer - CLI tracing implementation.
 *
 * This layer owns telemetry bootstrap, consent evaluation, identifier loading,
 * and exporter wiring. Commands only depend on the `Tracing` service tag.
 */
function generateHexId(length: number): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

class ExportableSpan implements Tracer.Span {
  readonly _tag = "Span" as const;
  readonly spanId: string;
  readonly traceId: string;
  readonly sampled: boolean;
  readonly name: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: ServiceMap.ServiceMap<never>;
  readonly links: ReadonlyArray<Tracer.SpanLink>;
  readonly kind: Tracer.SpanKind;

  status: Tracer.SpanStatus;
  attributes: Map<string, unknown> = new Map();

  private readonly onEnd: (span: ExportableSpan) => void;

  constructor(
    options: {
      readonly name: string;
      readonly parent: Option.Option<Tracer.AnySpan>;
      readonly annotations: ServiceMap.ServiceMap<never>;
      readonly links: Array<Tracer.SpanLink>;
      readonly startTime: bigint;
      readonly kind: Tracer.SpanKind;
      readonly sampled: boolean;
    },
    onEnd: (span: ExportableSpan) => void,
  ) {
    this.name = options.name;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = options.links;
    this.kind = options.kind;
    this.sampled = options.sampled;
    this.status = { _tag: "Started", startTime: options.startTime };
    this.traceId = Option.match(options.parent, {
      onNone: () => generateHexId(32),
      onSome: (parent) => parent.traceId,
    });
    this.spanId = generateHexId(16);
    this.onEnd = onEnd;
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit,
    };
    this.onEnd(this);
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value);
  }

  event(_name: string, _startTime: bigint, _attributes?: Record<string, unknown>): void {}

  addLinks(_links: ReadonlyArray<Tracer.SpanLink>): void {}
}

const CI_ENV_VARS = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "JENKINS_URL", "BUILDKITE"];

export const tracingLayer = Layer.effect(
  Tracing,
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig;
    const path = yield* Path.Path;
    const stdio = yield* Stdio.Stdio;
    const configDir = yield* getConfigDir;
    const tracesDir = path.join(configDir, "traces");
    const exportSpanToDebugConsole = makeDebugConsoleExporter((line) => {
      Effect.runFork(Stream.make(line).pipe(Stream.run(stdio.stderr()), Effect.ignore));
    });
    const tty = yield* Tty;
    const runtimeInfo = yield* RuntimeInfo;

    // First-run bootstrap owns the persisted config and session/device identity.
    let config = yield* readTelemetryConfig(configDir);
    const isTty = tty.stdoutIsTty;
    if (config === null && isTty) {
      yield* Effect.sync(() =>
        note(
          "Supabase collects anonymous usage data to improve the CLI.\nYou can opt out at any time:\n\n  supabase telemetry disable\n\nLearn more: https://supabase.com/docs/cli/telemetry",
          "Telemetry",
        ),
      );
    }
    if (config === null) {
      yield* resolveIdentity(configDir);
      config = yield* readTelemetryConfig(configDir);
    }

    const consent = yield* getEffectiveConsent(config);
    const showDebug =
      (Option.isSome(cliConfig.debug) && cliConfig.debug.value === "1") ||
      (Option.isSome(cliConfig.telemetryDebug) && cliConfig.telemetryDebug.value === "1");

    // Exporters are gated by consent/debug flags before spans start flowing.
    if (consent === "granted") {
      yield* initNdjsonExporter(tracesDir);
    }

    function onSpanEnd(span: ExportableSpan): void {
      if (!span.sampled) return;
      if (consent === "granted") {
        exportSpanToNdjson(span, tracesDir);
      }
      if (showDebug) {
        exportSpanToDebugConsole(span);
      }
    }

    const identity = yield* resolveIdentity(configDir);
    let isCi = false;
    for (const envVar of CI_ENV_VARS) {
      if (process.env[envVar] !== undefined) {
        isCi = true;
        break;
      }
    }

    // Global attributes are attached once here so individual commands stay lean.
    const globalAttrs: Record<string, unknown> = {
      schema_version: 1,
      device_id: identity.deviceId,
      session_id: identity.sessionId,
      is_first_run: identity.isFirstRun,
      is_tty: isTty,
      is_ci: isCi,
      os: runtimeInfo.platform,
      arch: runtimeInfo.arch,
      cli_version: "0.1.0",
    };

    return Tracer.make({
      span(options) {
        const span = new ExportableSpan(options, onSpanEnd);
        for (const [key, value] of Object.entries(globalAttrs)) {
          span.attribute(key, value);
        }
        return span;
      },
    });
  }),
);
