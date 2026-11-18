import { describe, expect, test } from "vitest";
import { errorDocUrl } from "./error-doc-url.ts";
import links from "./error-links.json" with { type: "json" };

describe("errorDocUrl", () => {
  test("every vendored article is an https supabase.com/kb URL", () => {
    expect(Object.keys(links).length).toBeGreaterThan(0);
    for (const url of Object.values(links)) {
      expect(url).toMatch(/^https:\/\/supabase\.com\/kb\//u);
    }
  });

  test("resolves a SQLSTATE on the error", () => {
    expect(errorDocUrl({ code: "23505" }, "duplicate key")).toBe(links["23505"]);
  });

  test("resolves a lower-case SQLSTATE through the upper-case fallback", () => {
    expect(errorDocUrl({ code: "42p01" }, "x")).toBe(links["42P01"]);
  });

  test("resolves a SQLSTATE nested on the cause chain", () => {
    const error = { _tag: "SqlError", cause: { cause: { code: "23505", severity: "ERROR" } } };
    expect(errorDocUrl(error, "query failed")).toBe(links["23505"]);
  });

  test("resolves a TLS verification code", () => {
    const error = new Error("unable to verify the first certificate", {
      cause: Object.assign(new Error("tls"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
    });
    expect(errorDocUrl(error, error.message)).toBe(links["UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
  });

  test("reads the SQLSTATE rendered at the end of an execution error message", () => {
    const message = 'ERROR: relation "nope" does not exist (SQLSTATE 42P01)';
    expect(errorDocUrl({ _tag: "DbQueryExecError", message }, message)).toBe(links["42P01"]);
  });

  test("maps a failed SASL or SCRAM password exchange to 28P01", () => {
    expect(errorDocUrl(new Error("x"), "failed SASL auth (SCRAM exchange: Wrong password)")).toBe(
      links["28P01"],
    );
  });

  test("maps a Management API 403 status to the 403 article", () => {
    expect(errorDocUrl(new Error("x"), "unexpected list status 403: forbidden")).toBe(links["403"]);
  });

  test("returns undefined when the code has no article", () => {
    expect(errorDocUrl({ code: "ZZZZZ" }, "something failed")).toBeUndefined();
    expect(errorDocUrl(new Error("x"), "status 4030: nope")).toBeUndefined();
  });

  test("survives a cyclic cause chain", () => {
    const a: Record<string, unknown> = { code: "ZZZZZ" };
    a["cause"] = a;
    expect(errorDocUrl(a, "loop")).toBeUndefined();
  });
});
