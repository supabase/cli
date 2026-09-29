import { Effect, FileSystem, Layer, Redacted, Semaphore } from "effect";
import type { Scope, Tracer } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as OtlpExporter from "effect/unstable/observability/OtlpExporter";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";
import { sanitizeTraceData } from "./trace-sanitize.ts";

const EXPORT_TIMEOUT_MS = 2_000;
const NEWLINE = new TextEncoder().encode("\n");

/** Resource identity attached to every exported span. */
export interface OtlpTraceResource {
  readonly serviceVersion: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

const sanitizingSerialization = Layer.succeed(OtlpSerialization.OtlpSerialization, {
  traces: (data) => HttpBody.jsonUnsafe(sanitizeTraceData(data)),
  metrics: (data) => HttpBody.jsonUnsafe(data),
  logs: (data) => HttpBody.jsonUnsafe(data),
});

/** An OTLP tracer whose batches are sanitized before they reach the transport. */
export const makeOtlpTracer = (options: {
  readonly url: string;
  readonly headers: Redacted.Redacted<Readonly<Record<string, string>>>;
  readonly resource: OtlpTraceResource;
}): Effect.Effect<Tracer.Tracer, never, HttpClient.HttpClient | Scope.Scope> =>
  OtlpTracer.make({
    url: options.url,
    headers: Redacted.value(options.headers),
    resource: {
      serviceName: "supabase-cli",
      serviceVersion: options.resource.serviceVersion,
      attributes: { ...options.resource.attributes },
    },
    shutdownTimeout: EXPORT_TIMEOUT_MS,
  }).pipe(Effect.provide(Layer.mergeAll(OtlpExporter.layerFlusher, sanitizingSerialization)));

/**
 * Transport that appends each batch as one JSON line and always answers 2xx, so the exporter
 * never retries, duplicates, or pauses on a local write failure.
 */
export const fileTransportLayer = (path: string) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* Semaphore.make(1);
      yield* fs.writeFile(path, new Uint8Array(), { flag: "a", mode: 0o600 });
      yield* fs.chmod(path, 0o600);
      return HttpClient.make((request) => {
        const write =
          request.body._tag === "Uint8Array"
            ? fs.writeFile(path, appendNewline(request.body.body), { flag: "a", mode: 0o600 })
            : Effect.void;
        return lock
          .withPermits(1)(write)
          .pipe(
            Effect.ignore,
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))),
          );
      });
    }),
  );

function appendNewline(bytes: Uint8Array): Uint8Array {
  const line = new Uint8Array(bytes.length + NEWLINE.length);
  line.set(bytes);
  line.set(NEWLINE, bytes.length);
  return line;
}

/** Transport that posts batches to a collector. */
export const collectorTransportLayer = FetchHttpClient.layer;
