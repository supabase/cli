import { describe, expect, it } from "@effect/vitest";
import { SupabaseApiInputError } from "@supabase/api/effect";
import { Data, Effect } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import { classifyCliErrorActionability } from "../../shared/telemetry/error-actionability.ts";

import { legacySanitizeInlineName, mapLegacyHttpError } from "./legacy-http-errors.ts";

class TestNetworkError extends Data.TaggedError("TestNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {}

class TestStatusError extends Data.TaggedError("TestStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

const mapError = mapLegacyHttpError({
  networkError: TestNetworkError,
  statusError: TestStatusError,
  networkMessage: (cause) => cause,
  statusMessage: (status, body) => `${status}: ${body}`,
});

describe("mapLegacyHttpError", () => {
  it.effect("preserves generated API input errors", () =>
    Effect.gen(function* () {
      const inputError = new SupabaseApiInputError("invalid request input");

      const error = yield* mapError(inputError).pipe(Effect.flip);

      expect(error).toBe(inputError);
      expect(inputError.source).toBe("generated_client");
      expect(classifyCliErrorActionability(error)).toMatchObject({
        error_kind: "internal_bug",
        error_category: "impossible_state",
        error_fingerprint: "tag:SupabaseApiInputError:request_encoding",
      });
    }),
  );

  it.effect("preserves request-body construction errors", () =>
    Effect.gen(function* () {
      const bodyError = new HttpBody.HttpBodyError({
        reason: { _tag: "JsonError" },
        cause: new Error("body read failed"),
      });

      const error = yield* mapError(bodyError).pipe(Effect.flip);

      expect(error).toBe(bodyError);
      expect(classifyCliErrorActionability(error)).toMatchObject({
        error_kind: "internal_bug",
        error_category: "impossible_state",
        error_fingerprint: "tag:HttpBodyError:request_encoding",
      });
    }),
  );
});

describe("legacySanitizeInlineName", () => {
  it("strips a right-to-left override so a path segment survives without the control char", () => {
    // U+202E (RLO) can visually reorder everything after it in a terminal/log
    // line — e.g. disguising a malicious path segment as something benign.
    const rlo = String.fromCodePoint(0x202e);
    const sanitized = legacySanitizeInlineName(`evil${rlo}name`);
    expect(sanitized).not.toContain(rlo);
    expect(sanitized).toBe("evilname");
  });

  it("strips other bidi controls (LRM/RLM, embeddings, isolates)", () => {
    const controls = [0x200e, 0x200f, 0x202a, 0x202b, 0x2066, 0x2069].map((code) =>
      String.fromCodePoint(code),
    );
    const hostile = ["a", "b", "c", "d", "e", "f"]
      .map((letter, index) => `${letter}${controls[index]}`)
      .join("");
    const sanitized = legacySanitizeInlineName(hostile);
    expect(sanitized).toBe("abcdef");
  });

  it("strips C1 controls, including U+009B (CSI on some terminals)", () => {
    // Equivalent to the ESC `[` sequence the ASCII control strip already
    // guards against, just reachable via a single C1 code point.
    const csi = String.fromCodePoint(0x9b);
    const sanitized = legacySanitizeInlineName(`evil${csi}[31mname`);
    expect(sanitized).not.toContain(csi);
    expect(sanitized).toBe("evil[31mname");
  });

  it("strips unicode line separators, which can fracture single-line output like \\n does", () => {
    const lineSep = String.fromCodePoint(0x2028);
    const paraSep = String.fromCodePoint(0x2029);
    const sanitized = legacySanitizeInlineName(`first${lineSep}second${paraSep}third`);
    expect(sanitized).not.toContain(lineSep);
    expect(sanitized).not.toContain(paraSep);
    expect(sanitized).toBe("firstsecondthird");
  });
});
