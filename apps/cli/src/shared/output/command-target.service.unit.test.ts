import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { CommandTargetJson } from "./command-target.service.ts";

const encode = Schema.encodeUnknownSync(CommandTargetJson);

describe("CommandTargetJson", () => {
  it("encodes each target kind", () => {
    const local = { kind: "local", host: "127.0.0.1", port: 54322 };
    const dbUrl = { kind: "db-url", host: "db.example.com", port: 5432 };
    const linked = {
      kind: "linked",
      project_ref: "abcdefghijklmnopqrst",
      project_name: "alpha",
      environment: "branch",
      parent_project_ref: "qrstuvwxyzabcdefghij",
    };
    expect([encode(local), encode(dbUrl), encode(linked)]).toEqual([local, dbUrl, linked]);
  });

  it("leaves the optional linked fields out when absent", () => {
    const linked = {
      kind: "linked",
      project_ref: "abcdefghijklmnopqrst",
      environment: "unverified",
    };
    expect(encode(linked)).toEqual(linked);
  });

  it("drops fields the schema does not declare", () => {
    expect(
      encode({ kind: "db-url", host: "db.example.com", port: 5432, password: "secret" }),
    ).toEqual({ kind: "db-url", host: "db.example.com", port: 5432 });
  });

  it("rejects an unknown kind or environment", () => {
    expect(() => encode({ kind: "remote", host: "h", port: 1 })).toThrow();
    expect(() =>
      encode({ kind: "linked", project_ref: "abcdefghijklmnopqrst", environment: "staging" }),
    ).toThrow();
  });
});
