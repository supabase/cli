import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { parseNamedRemote, parseRemoteValue } from "./remote-value.ts";
import { couldNameBranch, stripUserinfo } from "./remote-vocabulary.ts";

const REF = "abcdefghijklmnopqrst";

describe("parseRemoteValue", () => {
  it.each([
    { raw: " true ", expected: { _tag: "Linked" } },
    { raw: "YES", expected: { _tag: "Linked" } },
    { raw: ` ${REF} `, expected: { _tag: "Ref", ref: REF } },
    { raw: "Postgres://h/db", expected: { _tag: "DbUrl", url: "postgres://h/db" } },
    { raw: " POSTGRESQL://u@h/db", expected: { _tag: "DbUrl", url: "postgresql://u@h/db" } },
    { raw: " staging ", expected: { _tag: "Branch", name: "staging" } },
  ])("reads $raw as $expected", ({ raw, expected }) => {
    expect(parseRemoteValue(raw)).toEqual(Result.succeed(expected));
  });

  it.each([
    { raw: "", expected: { _tag: "Empty" } },
    { raw: "  ", expected: { _tag: "Empty" } },
    { raw: "False", expected: { _tag: "Off" } },
    { raw: " 0 ", expected: { _tag: "Off" } },
    { raw: `https://${REF}.supabase.co`, expected: { _tag: "ForeignUrl", ref: REF } },
    { raw: `HTTPS://${REF}.SUPABASE.CO:443/x`, expected: { _tag: "ForeignUrl", ref: REF } },
    { raw: `https://${REF}.supabase.com?x=1`, expected: { _tag: "ForeignUrl", ref: REF } },
    { raw: "https://db.supabase.co", expected: { _tag: "ForeignUrl", ref: undefined } },
    { raw: "ftp://example.com", expected: { _tag: "ForeignUrl", ref: undefined } },
    { raw: "host=db.example.com user=postgres", expected: { _tag: "KeywordDsn" } },
    { raw: "dbname=postgres", expected: { _tag: "KeywordDsn" } },
    { raw: "my branch", expected: { _tag: "KeywordDsn" } },
  ])("rejects $raw as $expected", ({ raw, expected }) => {
    expect(parseRemoteValue(raw)).toEqual(Result.fail(expected));
  });

  it.each(["y", "Y"])("reads %s as the linked project, not a branch", (raw) => {
    expect(parseRemoteValue(raw)).toEqual(Result.succeed({ _tag: "Linked" }));
  });

  it.each(["n", "N"])("rejects %s as an off switch, not a branch", (raw) => {
    expect(parseRemoteValue(raw)).toEqual(Result.fail({ _tag: "Off" }));
  });
});

describe("parseNamedRemote", () => {
  it("treats the words an off switch uses as branch names", () => {
    expect(parseNamedRemote("false")).toEqual(Result.succeed({ _tag: "Branch", name: "false" }));
  });
});

describe("couldNameBranch", () => {
  it.each(["feature-x", "feature/x", "v1.2"])("reads %s as a branch name", (word) => {
    expect(couldNameBranch(word)).toBe(true);
  });

  it.each([
    "",
    "STRIPE_KEY=sk_live_123",
    "host=db.example.com",
    "two words",
    "ss:///bucket",
    "123",
    "./path",
  ])("reads %j as something else", (word) => {
    expect(couldNameBranch(word)).toBe(false);
  });
});

describe("stripUserinfo", () => {
  it.each([
    { value: "postgresql://u:pw@h/db", expected: "postgresql://h/db" },
    { value: "postgresql://u@h/db", expected: "postgresql://h/db" },
    { value: "u:pw@staging", expected: "staging" },
    { value: "u:p@ss@h", expected: "h" },
    { value: "postgresql://u:p@ss@h/db", expected: "postgresql://h/db" },
    { value: "postgresql://u:pw@h/db?x=a@b", expected: "postgresql://h/db?x=a@b" },
    { value: "staging", expected: "staging" },
    {
      value: "a message with postgresql://u:pw@h and more",
      expected: "a message with postgresql://h and more",
    },
  ])("turns $value into $expected", ({ value, expected }) => {
    expect(stripUserinfo(value)).toBe(expected);
  });
});
