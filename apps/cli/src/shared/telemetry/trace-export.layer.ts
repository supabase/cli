import {
  Cause,
  Config,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Queue,
  Redacted,
  Scope,
  Stdio,
  Stream,
  Tracer,
} from "effect";
import { Headers, HttpTraceContext } from "effect/unstable/http";
import { CLI_VERSION } from "../cli/version.ts";
import { CliSettings } from "../config/cli-settings.service.ts";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "./error-actionability.ts";
import { makeDebugConsoleExporter } from "./exporters/debug-console.ts";
import { detectCi } from "./runtime.layer.ts";
import { ChildTracePropagation } from "./spans.ts";

const FLUSH_TIMEOUT = Duration.seconds(2);
const OTLP_TRACES_PATH = "/v1/traces";

/** Raised when the trace export environment is contradictory or malformed. */
export class TraceExportConfigError extends Data.TaggedError("TraceExportConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

type TraceSink =
  | { readonly _tag: "File"; readonly path: string }
  | {
      readonly _tag: "Otlp";
      readonly url: string;
      readonly headers: Redacted.Redacted<Readonly<Record<string, string>>>;
    };

/** Trace export decision for one CLI run. */
export interface TraceSettings {
  readonly sink: Option.Option<TraceSink>;
}

const optionalEnv = (name: string) =>
  Config.option(Config.string(name)).pipe(
    Effect.map(Option.filter((value) => value.trim().length > 0)),
    Effect.mapError((error) => new TraceExportConfigError({ message: error.message })),
  );

function otlpTracesUrl(endpoint: string): Option.Option<string> {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return Option.none();
    if (!url.pathname.endsWith(OTLP_TRACES_PATH)) {
      url.pathname = `${url.pathname.replace(/\/+$/u, "")}${OTLP_TRACES_PATH}`;
    }
    return Option.some(url.toString());
  } catch {
    return Option.none();
  }
}

/** Parses `key=value,key2=value2` with percent-encoded parts, as in `OTEL_EXPORTER_OTLP_HEADERS`. */
function parseOtlpHeaders(value: string): Option.Option<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    if (pair.trim().length === 0) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) return Option.none();
    try {
      headers[decodeURIComponent(pair.slice(0, separator).trim())] = decodeURIComponent(
        pair.slice(separator + 1).trim(),
      );
    } catch {
      return Option.none();
    }
  }
  return Option.some(headers);
}

const resolveSink = Effect.fnUntraced(function* (
  file: Option.Option<string>,
  endpoint: Option.Option<string>,
) {
  if (Option.isSome(file) && Option.isSome(endpoint)) {
    return yield* new TraceExportConfigError({
      message:
        "SUPABASE_TRACE_FILE and SUPABASE_OTLP_ENDPOINT are both set; choose one trace destination.",
    });
  }
  if (Option.isSome(file)) {
    return Option.some<TraceSink>({ _tag: "File", path: file.value });
  }
  if (Option.isNone(endpoint)) return Option.none<TraceSink>();

  const url = otlpTracesUrl(endpoint.value);
  if (Option.isNone(url)) {
    return yield* new TraceExportConfigError({
      message: "SUPABASE_OTLP_ENDPOINT must be an http(s) URL, for example http://localhost:4318.",
    });
  }
  const rawHeaders = yield* optionalEnv("SUPABASE_OTLP_HEADERS");
  const headers = Option.isSome(rawHeaders) ? parseOtlpHeaders(rawHeaders.value) : Option.some({});
  if (Option.isNone(headers)) {
    return yield* new TraceExportConfigError({
      message: "SUPABASE_OTLP_HEADERS must be a comma-separated list of key=value pairs.",
    });
  }
  return Option.some<TraceSink>({
    _tag: "Otlp",
    url: url.value,
    headers: Redacted.make(headers.value, { label: "SUPABASE_OTLP_HEADERS" }),
  });
});

/** Reads the trace sink for this run. */
export const resolveTraceSettings = Effect.gen(function* () {
  const sink = yield* resolveSink(
    yield* optionalEnv("SUPABASE_TRACE_FILE"),
    yield* optionalEnv("SUPABASE_OTLP_ENDPOINT"),
  );
  return { sink } satisfies TraceSettings;
});

// An explicitly configured sink records the run even when the caller's context is unsampled.
const externalParent = optionalEnv("TRACEPARENT").pipe(
  Effect.map(
    Option.flatMap((traceparent) =>
      HttpTraceContext.w3c(Headers.fromRecordUnsafe({ traceparent })),
    ),
  ),
  Effect.map(
    Option.map((parent) =>
      Tracer.externalSpan({
        traceId: parent.traceId,
        spanId: parent.spanId,
        sampled: true,
        annotations: parent.annotations,
      }),
    ),
  ),
);

class ObservedSpan implements Tracer.Span {
  readonly _tag = "Span";
  constructor(
    private readonly span: Tracer.Span,
    private readonly onEnd: (span: Tracer.Span) => void,
  ) {}
  get name() {
    return this.span.name;
  }
  get spanId() {
    return this.span.spanId;
  }
  get traceId() {
    return this.span.traceId;
  }
  get parent() {
    return this.span.parent;
  }
  get annotations() {
    return this.span.annotations;
  }
  get status() {
    return this.span.status;
  }
  get attributes() {
    return this.span.attributes;
  }
  get links() {
    return this.span.links;
  }
  get sampled() {
    return this.span.sampled;
  }
  get kind() {
    return this.span.kind;
  }
  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.span.end(endTime, exit);
    this.onEnd(this);
  }
  attribute(key: string, value: unknown): void {
    this.span.attribute(key, value);
  }
  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.span.event(name, startTime, attributes);
  }
  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.span.addLinks(links);
  }
}

const debugConsoleTracer = Effect.fnUntraced(function* (base: Tracer.Tracer) {
  const stdio = yield* Stdio.Stdio;
  const exportSpan = makeDebugConsoleExporter((line) =>
    Stream.make(line).pipe(Stream.run(stdio.stderr()), Effect.asVoid),
  );
  const queue = yield* Queue.unbounded<Tracer.Span, Cause.Done>();
  const worker = yield* Queue.take(queue).pipe(
    Effect.flatMap((span) => Effect.ignore(exportSpan(span))),
    Effect.forever,
    Effect.catchTag("Done", () => Effect.void),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Queue.end(queue).pipe(
      Effect.andThen(Effect.interruptible(Fiber.join(worker)).pipe(Effect.timeout(FLUSH_TIMEOUT))),
      Effect.ignore,
    ),
  );
  const onEnd = (span: Tracer.Span) => {
    Queue.offerUnsafe(queue, span);
  };
  return Tracer.make({
    span: (options) => new ObservedSpan(base.span(options), onEnd),
    context: base.context,
  });
});

const sinkTracer = Effect.fnUntraced(function* (sink: TraceSink) {
  const runtimeInfo = yield* RuntimeInfo;
  const sinkModule = yield* Effect.promise(() => import("./otlp-trace-sink.ts"));
  const resource = {
    serviceVersion: CLI_VERSION,
    attributes: { os: runtimeInfo.platform, arch: runtimeInfo.arch, is_ci: yield* detectCi },
  };
  const make = (url: string, headers: Redacted.Redacted<Readonly<Record<string, string>>>) =>
    sinkModule.makeOtlpTracer({ url, headers, resource });
  switch (sink._tag) {
    case "File":
      return yield* make("file:///v1/traces", Redacted.make({})).pipe(
        Effect.provide(sinkModule.fileTransportLayer(sink.path)),
      );
    case "Otlp":
      return yield* make(sink.url, sink.headers).pipe(
        Effect.provide(sinkModule.collectorTransportLayer),
      );
  }
});

/**
 * Prints the finished spans of `effect` to stderr when `SUPABASE_DEBUG=1` or
 * `SUPABASE_TELEMETRY_DEBUG=1`, on top of the active sink tracer when there is one.
 */
export const withDebugConsole = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | CliSettings | Stdio.Stdio> =>
  Effect.gen(function* () {
    const settings = yield* CliSettings;
    const enabled =
      Option.exists(settings.debug, (value) => value === "1") ||
      Option.exists(settings.telemetryDebug, (value) => value === "1");
    if (!enabled) return yield* effect;
    const base = yield* Effect.tracer;
    return yield* Effect.acquireUseRelease(
      Scope.make(),
      (scope) =>
        debugConsoleTracer(base).pipe(
          Scope.provide(scope),
          Effect.flatMap((tracer) =>
            effect.pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true)),
          ),
        ),
      (scope, exit) => Scope.close(scope, exit),
    );
  });

/**
 * Runs `effect` as the `cli.run` root span with the configured exporter, then flushes it within a
 * bounded, uninterruptible window so the caller can exit the process right after.
 */
export const withTraceExport =
  (settings: TraceSettings, attributes: Readonly<Record<string, unknown>>) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | TraceExportConfigError, R | FileSystem.FileSystem | RuntimeInfo> => {
    if (Option.isNone(settings.sink)) return effect.pipe(Effect.withTracerEnabled(false));
    const sink = settings.sink.value;
    return Effect.gen(function* () {
      const parent = yield* externalParent;
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        Layer.effect(Tracer.Tracer, sinkTracer(sink)),
        scope,
      ).pipe(
        Effect.catchCause((cause) => {
          const reason = Cause.squash(cause);
          return Scope.close(scope, Exit.failCause(cause)).pipe(
            Effect.andThen(
              Effect.fail(
                new TraceExportConfigError({
                  message: `Could not start trace export: ${reason instanceof Error ? reason.message : String(reason)}`,
                }),
              ),
            ),
          );
        }),
      );
      const exit = yield* effect.pipe(
        Effect.withSpan("cli.run", {
          attributes,
          ...(Option.isSome(parent) ? { parent: parent.value } : {}),
        }),
        Effect.provideService(ChildTracePropagation, true),
        Effect.provide(context),
        Effect.exit,
      );
      yield* Scope.close(scope, exit).pipe(
        Effect.interruptible,
        Effect.timeoutOption(FLUSH_TIMEOUT),
        Effect.uninterruptible,
      );
      return yield* exit;
    }).pipe(Effect.withTracerEnabled(true));
  };
