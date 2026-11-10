import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { flattenSchemaIssues } from "./cli-config-schema-issues.ts";

const schemaError = (schema: Schema.Top, value: unknown) => {
  try {
    Schema.decodeUnknownSync(schema as Schema.Decoder<unknown>)(value, { errors: "all" });
  } catch (cause) {
    return cause;
  }
  throw new Error("expected the decode to fail");
};

const schema = Schema.Struct({
  flag: Schema.Boolean,
  count: Schema.Finite,
  mode: Schema.Literals(["fast", "slow"]),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  list: Schema.Array(Schema.String),
  table: Schema.Struct({ inner: Schema.Finite }),
  secret: Schema.String,
});

describe("flattenSchemaIssues", () => {
  const flat = flattenSchemaIssues(
    schemaError(schema, {
      flag: "hunter2",
      count: "hunter2",
      mode: "hunter2",
      rows: 99,
      list: [1],
      table: "hunter2",
    }),
  );

  it("codes each leaf by what is wrong and keeps its path", () => {
    expect(flat.map(({ path, code }) => [path.join("."), code])).toEqual([
      ["flag", "invalid_type"],
      ["count", "invalid_type"],
      ["mode", "invalid_enum"],
      ["rows", "invalid_value"],
      ["list.0", "invalid_type"],
      ["table", "invalid_type"],
      ["secret", "missing_required"],
    ]);
  });

  it("words each reason without quoting the input", () => {
    expect(flat.map(({ reason }) => reason)).toEqual([
      "expected a boolean",
      "expected a number",
      "expected one of fast, slow",
      "expected a value between 1 and 5",
      "expected a string",
      "expected a table",
      "missing required key",
    ]);
    expect(JSON.stringify(flat)).not.toContain("hunter2");
  });

  it("offers the allowed values for an enum", () => {
    expect(flat[2]?.help).toBe("use one of fast, slow");
  });

  it("returns nothing for a cause that is not a schema error", () => {
    expect(flattenSchemaIssues(new Error("boom"))).toEqual([]);
  });
});
