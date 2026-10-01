import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Clock, Context, Effect, Exit, Option, Schema, Tracer } from "effect";
import { makeTraceSanitizer } from "../trace-sanitize.ts";
import { formatSpanForDebugConsole, makeDebugConsoleExporter } from "./debug-console.ts";

const sanitizer = makeTraceSanitizer.pipe(Effect.provide(BunServices.layer));

const makeEndedSpan = (name: string, attrs: Record<string, unknown> = {}) =>
  Effect.map(Clock.currentTimeMillis, (now): Tracer.Span => {
    const startTime = BigInt(now) * BigInt(1_000_000);
    const endTime = startTime + BigInt(50_000_000); // 50ms later
    const attributes = new Map(Object.entries(attrs));
    return {
      _tag: "Span",
      name,
      spanId: "abc123",
      traceId: "def456",
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      sampled: true,
      kind: "internal",
      status: {
        _tag: "Ended",
        startTime,
        endTime,
        exit: { _tag: "Success", value: undefined } as any,
      },
      attributes,
      end: () => {},
      attribute: () => {},
      event: () => {},
      addLinks: () => {},
    };
  });

describe("debug-console exporter", () => {
  it.effect("formats and writes ended span info", () =>
    Effect.gen(function* () {
      let stderrOutput = "";
      const span = yield* makeEndedSpan("test-span", { command: "login" });
      const exportSpanToDebugConsole = makeDebugConsoleExporter(
        (line) =>
          Effect.sync(() => {
            stderrOutput += line;
          }),
        yield* sanitizer,
      );

      yield* exportSpanToDebugConsole(span);

      expect(stderrOutput).toContain("test-span");
      expect(stderrOutput).toContain("50ms");
      expect(stderrOutput).toContain("login");
      expect(stderrOutput).toContain("\n");
    }),
  );

  it.effect("caps long attribute output so each line stays readable", () =>
    Effect.gen(function* () {
      const span = yield* makeEndedSpan("command.status", {
        "service.names":
          "auth,rest,realtime,storage,imgproxy,kong,meta,studio,edge_runtime,logflare,vector,pooler",
        "service.running_count": 12,
      });

      const line = yield* formatSpanForDebugConsole(span, yield* sanitizer);

      expect(Option.getOrThrow(line)).toMatch(/…\n$/u);
      expect(Option.getOrThrow(line).length).toBeLessThan(200);
    }),
  );

  it.effect("returns undefined for spans that have not ended", () =>
    Effect.gen(function* () {
      const span = {
        ...(yield* makeEndedSpan("pending-span")),
        status: {
          _tag: "Started",
          startTime: BigInt(yield* Clock.currentTimeMillis) * BigInt(1_000_000),
        } as Tracer.SpanStatus,
      };

      expect(yield* formatSpanForDebugConsole(span, yield* sanitizer)).toEqual(Option.none());
    }),
  );

  it.effect("returns a typed failure for unserializable attributes", () =>
    Effect.gen(function* () {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const result = yield* Effect.exit(
        formatSpanForDebugConsole(yield* makeEndedSpan("cyclic", cyclic), yield* sanitizer),
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(Schema.isSchemaError(error.value)).toBe(true);
        }
      }
    }),
  );
});
