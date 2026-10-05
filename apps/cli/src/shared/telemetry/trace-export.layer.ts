import {
  Cause,
  Config,
  Crypto,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Redacted,
  Scope,
  Stdio,
  Stream,
  Tracer,
} from "effect";
import { Headers, HttpTraceContext } from "effect/http";
import { CLI_VERSION } from "../cli/version.ts";
import { CliSettings } from "../config/cli-settings.service.ts";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { makeDebugConsoleExporter } from "./exporters/debug-console.ts";
import { detectCi } from "./runtime.layer.ts";
import { ChildTracePropagation } from "./spans.ts";
import { errorTypeOf, makeTraceSanitizer, sqlStateOf } from "./trace-sanitize.ts";

const FLUSH_TIMEOUT = Duration.seconds(2);
const OTLP_TRACES_PATH = "/v1/traces";

/** Tracing never stops a command: a setup problem prints one warning and the run continues untraced. */
const warnTracingDisabled = (reason: string) =>
  Effect.flatMap(Stdio.Stdio, (stdio) =>
    Stream.make(`Warning: tracing disabled: ${reason}\n`).pipe(
      Stream.run(stdio.stderr()),
      Effect.ignore,
    ),
  );

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
    Effect.mapError(() => `${name} could not be read`),
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

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/u;

/** Parses `key=value,key2=value2` with percent-encoded parts, as in `OTEL_EXPORTER_OTLP_HEADERS`. */
function parseOtlpHeaders(value: string): Option.Option<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    if (pair.trim().length === 0) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) return Option.none();
    try {
      const name = decodeURIComponent(pair.slice(0, separator).trim());
      const headerValue = decodeURIComponent(pair.slice(separator + 1).trim());
      if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(headerValue)) return Option.none();
      headers[name] = headerValue;
    } catch {
      return Option.none();
    }
  }
  return Option.some(headers);
}

const resolveSink = Effect.fnUntraced(function* () {
  const file = yield* optionalEnv("SUPABASE_TRACE_FILE");
  const endpoint = yield* optionalEnv("SUPABASE_OTLP_ENDPOINT");
  if (Option.isSome(file) && Option.isSome(endpoint)) {
    return yield* Effect.fail(
      "SUPABASE_TRACE_FILE and SUPABASE_OTLP_ENDPOINT are both set; choose one trace destination",
    );
  }
  if (Option.isSome(file)) {
    // Resolved once against the startup cwd, so a later `process.chdir` keeps one trace file.
    const path = yield* Path.Path;
    return Option.some<TraceSink>({ _tag: "File", path: path.resolve(file.value) });
  }
  if (Option.isNone(endpoint)) return Option.none<TraceSink>();

  const url = otlpTracesUrl(endpoint.value);
  if (Option.isNone(url)) {
    return yield* Effect.fail(
      "SUPABASE_OTLP_ENDPOINT must be an http(s) URL, for example http://localhost:4318",
    );
  }
  const rawHeaders = yield* optionalEnv("SUPABASE_OTLP_HEADERS");
  const headers = Option.isSome(rawHeaders) ? parseOtlpHeaders(rawHeaders.value) : Option.some({});
  if (Option.isNone(headers)) {
    return yield* Effect.fail(
      "SUPABASE_OTLP_HEADERS must be a comma-separated list of key=value pairs",
    );
  }
  return Option.some<TraceSink>({
    _tag: "Otlp",
    url: url.value,
    headers: Redacted.make(headers.value, { label: "SUPABASE_OTLP_HEADERS" }),
  });
});

/** Reads the trace sink for this run; an invalid setting warns and leaves tracing off. */
export const resolveTraceSettings: Effect.Effect<TraceSettings, never, Path.Path | Stdio.Stdio> =
  resolveSink().pipe(
    Effect.catch((reason) => warnTracingDisabled(reason).pipe(Effect.as(Option.none<TraceSink>()))),
    Effect.map((sink) => ({ sink })),
  );

// An explicitly configured sink records the run even when the caller's context is unsampled.
const externalParent = optionalEnv("TRACEPARENT").pipe(
  Effect.orElseSucceed(() => Option.none<string>()),
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

/** Records a failure's tag and SQLSTATE on the span, since exported exception events keep only the type. */
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
    const errorType = errorTypeOf(exit);
    if (errorType !== undefined) this.span.attribute("error.type", errorType);
    const sqlState = sqlStateOf(exit);
    if (sqlState !== undefined) this.span.attribute("db.response.status_code", sqlState);
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

const observedTracer = (
  base: Tracer.Tracer,
  onEnd: (span: Tracer.Span) => void = () => {},
): Tracer.Tracer =>
  Tracer.make({
    span: (options) => new ObservedSpan(base.span(options), onEnd),
    context: base.context,
  });

const debugConsoleTracer = Effect.fnUntraced(function* (
  base: Tracer.Tracer,
  root: Option.Option<Tracer.AnySpan>,
) {
  const stdio = yield* Stdio.Stdio;
  const exportSpan = makeDebugConsoleExporter(
    (line) => Stream.make(line).pipe(Stream.run(stdio.stderr()), Effect.asVoid),
    yield* makeTraceSanitizer,
    root,
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
  return observedTracer(base, (span) => {
    Queue.offerUnsafe(queue, span);
  });
});

const sinkTracer = Effect.fnUntraced(function* (sink: TraceSink) {
  const runtimeInfo = yield* RuntimeInfo;
  const crypto = yield* Crypto.Crypto;
  const sinkModule = yield* Effect.promise(() => import("./otlp-trace-sink.ts"));
  const resource = {
    serviceVersion: CLI_VERSION,
    attributes: {
      os: runtimeInfo.platform,
      arch: runtimeInfo.arch,
      is_ci: yield* detectCi,
      "service.instance.id": yield* Effect.orDie(crypto.randomUUIDv4),
    },
  };
  const make = (url: string, headers: Redacted.Redacted<Readonly<Record<string, string>>>) =>
    sinkModule.makeOtlpTracer({ url, headers, resource });
  const tracer =
    sink._tag === "File"
      ? make("file:///v1/traces", Redacted.make({})).pipe(
          Effect.provide(sinkModule.fileTransportLayer(sink.path)),
        )
      : make(sink.url, sink.headers).pipe(Effect.provide(sinkModule.collectorTransportLayer));
  return observedTracer(yield* tracer);
});

/**
 * Prints the finished spans of `effect` to stderr when `SUPABASE_DEBUG=1` or
 * `SUPABASE_TELEMETRY_DEBUG=1`, on top of the active sink tracer when there is one.
 */
export const withDebugConsole = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | CliSettings | Crypto.Crypto | Stdio.Stdio> =>
  Effect.gen(function* () {
    const settings = yield* CliSettings;
    const enabled =
      Option.exists(settings.debug, (value) => value === "1") ||
      Option.exists(settings.telemetryDebug, (value) => value === "1");
    if (!enabled) return yield* effect;
    const base = yield* Effect.tracer;
    const root = yield* Effect.option(Effect.currentParentSpan);
    return yield* Effect.acquireUseRelease(
      Scope.make(),
      (scope) =>
        debugConsoleTracer(base, root).pipe(
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
  ): Effect.Effect<A, E, R | Crypto.Crypto | FileSystem.FileSystem | RuntimeInfo | Stdio.Stdio> => {
    const untraced = effect.pipe(Effect.withTracerEnabled(false));
    if (Option.isNone(settings.sink)) return untraced;
    const sink = settings.sink.value;
    return Effect.gen(function* () {
      const parent = yield* externalParent;
      return yield* Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          Layer.buildWithScope(Layer.effect(Tracer.Tracer, sinkTracer(sink)), scope).pipe(
            Effect.map(Option.some),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
              const reason = Cause.squash(cause);
              return warnTracingDisabled(
                `could not start trace export: ${reason instanceof Error ? reason.message : String(reason)}`,
              ).pipe(Effect.as(Option.none()));
            }),
            Effect.flatMap((context) =>
              Option.isNone(context)
                ? untraced
                : effect.pipe(
                    Effect.withSpan("cli.run", {
                      attributes,
                      ...(Option.isSome(parent) ? { parent: parent.value } : {}),
                    }),
                    Effect.provideService(ChildTracePropagation, true),
                    Effect.provide(context.value),
                  ),
            ),
          ),
        (scope, exit) =>
          Scope.close(scope, exit).pipe(Effect.interruptible, Effect.timeoutOption(FLUSH_TIMEOUT)),
      );
    }).pipe(Effect.withTracerEnabled(true));
  };
