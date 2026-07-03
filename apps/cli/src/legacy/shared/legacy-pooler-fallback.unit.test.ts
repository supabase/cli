import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";
import { legacyRunWithPoolerFallback } from "./legacy-pooler-fallback.ts";

interface AttemptResult {
  readonly exitCode: number;
  readonly stderr: string;
}

const poolerConn: LegacyPgConnInput = {
  host: "aws-0-us-east-1.pooler.supabase.com",
  port: 5432,
  user: "postgres.abcdefghijklmnopqrst",
  password: "secret",
  database: "postgres",
};

function captureOutput() {
  const chunks: Array<{ text: string; stream: "stdout" | "stderr" }> = [];
  return {
    layer: Layer.succeed(Output, {
      format: "text",
      interactive: true,
      intro: () => Effect.void,
      outro: () => Effect.void,
      info: () => Effect.void,
      warn: () => Effect.void,
      error: () => Effect.void,
      event: () => Effect.void,
      task: () =>
        Effect.succeed({
          message: () => Effect.void,
          succeed: () => Effect.void,
          fail: () => Effect.void,
          info: () => Effect.void,
          cancel: () => Effect.void,
          clear: () => Effect.void,
        }),
      promptText: () => Effect.die("unexpected promptText"),
      promptPassword: () => Effect.die("unexpected promptPassword"),
      promptConfirm: () => Effect.die("unexpected promptConfirm"),
      promptSelect: () => Effect.die("unexpected promptSelect"),
      promptMultiSelect: () => Effect.die("unexpected promptMultiSelect"),
      progress: () =>
        Effect.succeed({
          start: () => Effect.void,
          advance: () => Effect.void,
          message: () => Effect.void,
          stop: () => Effect.void,
        }),
      success: () => Effect.void,
      fail: () => Effect.void,
      raw: (text: string, stream: "stdout" | "stderr" = "stdout") =>
        Effect.sync(() => {
          chunks.push({ text, stream });
        }),
      rawBytes: (bytes: Uint8Array, stream: "stdout" | "stderr" = "stdout") =>
        Effect.sync(() => {
          chunks.push({ text: new TextDecoder().decode(bytes), stream });
        }),
    }),
    get stderrText() {
      return chunks
        .filter((chunk) => chunk.stream === "stderr")
        .map((chunk) => chunk.text)
        .join("");
    },
  };
}

describe("legacyRunWithPoolerFallback", () => {
  it.live("returns the retry outcome verbatim without re-classifying it", () => {
    const out = captureOutput();
    let fallbackResolutions = 0;
    let retryRuns = 0;

    return Effect.gen(function* () {
      const result = yield* legacyRunWithPoolerFallback({
        run: Effect.succeed({ exitCode: 1, stderr: "network is unreachable" }),
        retry: () =>
          Effect.sync(() => {
            retryRuns += 1;
            return { exitCode: 1, stderr: "network is unreachable" };
          }),
        directHost: "db.abcdefghijklmnopqrst.supabase.co",
        eligible: true,
        resolveFallback: Effect.sync(() => {
          fallbackResolutions += 1;
          return Option.some(poolerConn);
        }),
        classifyResult: (result: AttemptResult) => result.exitCode !== 0,
      });

      expect(result).toEqual({ exitCode: 1, stderr: "network is unreachable" });
      expect(fallbackResolutions).toBe(1);
      expect(retryRuns).toBe(1);
      expect(out.stderrText).toContain(
        "Warning: Direct connection to db.abcdefghijklmnopqrst.supabase.co is unavailable",
      );
    }).pipe(Effect.provide(out.layer));
  });

  it.live("propagates a result-path retry failure without retrying a second time", () => {
    const out = captureOutput();
    const retryError = new Error("network is unreachable");
    let fallbackResolutions = 0;
    let retryRuns = 0;

    return Effect.gen(function* () {
      const exit = yield* legacyRunWithPoolerFallback({
        run: Effect.succeed({ exitCode: 1, stderr: "network is unreachable" }),
        retry: () =>
          Effect.sync(() => {
            retryRuns += 1;
          }).pipe(Effect.andThen(Effect.fail(retryError))),
        directHost: "db.abcdefghijklmnopqrst.supabase.co",
        eligible: true,
        resolveFallback: Effect.sync(() => {
          fallbackResolutions += 1;
          return Option.some(poolerConn);
        }),
        classifyResult: (result: AttemptResult) => result.exitCode !== 0,
        classifyError: (error: Error) => error === retryError,
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fallbackResolutions).toBe(1);
      expect(retryRuns).toBe(1);
      expect(out.stderrText.match(/Retrying via the IPv4 connection pooler/g)).toHaveLength(1);
    }).pipe(Effect.provide(out.layer));
  });

  it.live("does not resolve a fallback when the failure is not eligible", () => {
    const out = captureOutput();
    let fallbackResolutions = 0;

    return Effect.gen(function* () {
      const result = yield* legacyRunWithPoolerFallback({
        run: Effect.succeed({ exitCode: 1, stderr: "network is unreachable" }),
        retry: () => Effect.succeed({ exitCode: 0, stderr: "" }),
        directHost: "aws-0-us-east-1.pooler.supabase.com",
        eligible: false,
        resolveFallback: Effect.sync(() => {
          fallbackResolutions += 1;
          return Option.some(poolerConn);
        }),
        classifyResult: (result: AttemptResult) => result.exitCode !== 0,
      });

      expect(result).toEqual({ exitCode: 1, stderr: "network is unreachable" });
      expect(fallbackResolutions).toBe(0);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(out.layer));
  });

  it.live("falls back from the error channel when the caller classifies the cause", () => {
    const out = captureOutput();
    const directError = new Error("probe failed");

    return Effect.gen(function* () {
      const result = yield* legacyRunWithPoolerFallback({
        run: Effect.fail(directError),
        retry: () => Effect.succeed({ exitCode: 0, stderr: "" }),
        directHost: "db.abcdefghijklmnopqrst.supabase.co",
        eligible: true,
        resolveFallback: Effect.succeed(Option.some(poolerConn)),
        classifyError: (error: Error) => error === directError,
      });

      expect(result).toEqual({ exitCode: 0, stderr: "" });
      expect(out.stderrText).toContain("Retrying via the IPv4 connection pooler.");
    }).pipe(Effect.provide(out.layer));
  });
});
