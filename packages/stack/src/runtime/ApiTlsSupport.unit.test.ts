import { describe, expect, it } from "@effect/vitest";
import { readApiTlsCheck } from "./ApiTlsSupport.ts";

const body = "supabase-stack s1 3f1c";
const ok = (reply: string) => `HTTP/1.1 200 OK\r\nContent-Length: ${reply.length}\r\n\r\n${reply}`;
const foreign = (detail: string) => ({ outcome: "foreign", detail });

describe("api.tls start check reply", () => {
  it("passes only a 200 with exactly this check's body, read to its end", () => {
    expect(readApiTlsCheck(`1 ${ok(body)}`, body, 5)).toEqual({ outcome: "passed" });
    expect(readApiTlsCheck(`1 HTTP/1.0 200 OK\r\n\r\n${body}`, body, 5)).toEqual({
      outcome: "passed",
    });
    /* The body is everything after the head, compared byte for byte. */
    const split = "a\r\n\r\nb";
    expect(readApiTlsCheck(`1 ${ok(split)}`, split, 5)).toEqual({ outcome: "passed" });
    expect(readApiTlsCheck(`1 ${ok(`${body}\n`)}`, body, 5)).toEqual(
      foreign("a 200 with another body"),
    );
    expect(readApiTlsCheck(`1 ${ok("supabase-stack s1 9a0b")}`, body, 5)).toEqual(
      foreign("a 200 with another body"),
    );
  });

  it("reads a reply closed with nothing as closed, and a read cut short as foreign", () => {
    expect(readApiTlsCheck("1 ", body, 5)).toEqual({ outcome: "closed" });
    for (const output of ["142 ", `142 ${ok(body)}`])
      expect(readApiTlsCheck(output, body, 3), output).toEqual(
        foreign("no complete reply within 3 s"),
      );
    /* `read` stops at a NUL with status 0, so the rest of the reply was never read. */
    expect(readApiTlsCheck(`0 ${ok(body)}`, body, 5)).toEqual(foreign("a 200 with a NUL byte"));
  });

  it("names any other status line, its control bytes masked", () => {
    expect(readApiTlsCheck("1 HTTP/1.1 404 Not Found\r\n\r\nNot Found", body, 5)).toEqual(
      foreign("replied HTTP/1.1 404 Not Found"),
    );
    expect(readApiTlsCheck("1 HTTP/1.1 502 Bad Gateway\r\n\r\n", body, 5)).toEqual(
      foreign("replied HTTP/1.1 502 Bad Gateway"),
    );
    expect(readApiTlsCheck("1 \u001b[31mSSH-2.0\u0007\tx", body, 5)).toEqual(
      foreign("replied ?[31mSSH-2.0??x"),
    );
    expect(readApiTlsCheck(`1 \r\n${ok(body)}`, body, 5)).toEqual(
      foreign("replied without a status line"),
    );
    expect(readApiTlsCheck(`1 HTTP/1.1 2000 OK\r\n\r\n${body}`, body, 5)).toEqual(
      foreign("replied HTTP/1.1 2000 OK"),
    );
  });
});
