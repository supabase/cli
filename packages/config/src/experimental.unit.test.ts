import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { experimental } from "./experimental.ts";

const decode = Schema.decodeUnknownSync(experimental);

describe("experimental.compute", () => {
  test("decodes the table form", () => {
    expect(decode({ compute: { enabled: true } })).toMatchObject({ compute: { enabled: true } });
  });

  test("defaults enabled to false when the table is present but empty", () => {
    expect(decode({ compute: {} })).toMatchObject({ compute: { enabled: false } });
  });

  test("names the replacement when the bare boolean is used", () => {
    // Every opt-in that predates the table form wrote `compute = true`, so this is the
    // error those projects hit first. The generic wording would only say the shape is
    // wrong, not what to write instead.
    expect(() => decode({ compute: true })).toThrow(
      /use \[experimental\.compute\] with enabled = true/,
    );
  });

  test("rejects the bare boolean the flag used to be", () => {
    // `compute = true` under `[experimental]` was the previous spelling. It is refused rather
    // than accepted as shorthand, so the table form is the only way to spell it and the
    // `[experimental.pgdelta]`/`[experimental.webhooks]` shape holds across the section.
    expect(() => decode({ compute: true })).toThrow();
  });

  test("leaves the sibling bare-boolean flags alone", () => {
    expect(decode({ stack: true })).toMatchObject({ stack: true });
  });
});
