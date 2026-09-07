import { describe, expect, it } from "vitest";
import { Option } from "effect";

import { legacyRemoteCommitToPullFlags } from "./commit.handler.ts";
import type { LegacyDbRemoteCommitFlags } from "./commit.command.ts";

const flags = (over: Partial<LegacyDbRemoteCommitFlags> = {}): LegacyDbRemoteCommitFlags => ({
  schema: over.schema ?? [],
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  password: over.password ?? Option.none(),
});

describe("legacyRemoteCommitToPullFlags", () => {
  it("maps to a migration-style pull named remote_commit", () => {
    expect(legacyRemoteCommitToPullFlags(flags())).toEqual({
      name: Option.some("remote_commit"),
      declarative: Option.none(),
      usePgDelta: Option.none(),
      diffEngine: Option.none(),
      strictCoverage: false,
      schema: [],
      dbUrl: Option.none(),
      linked: Option.none(),
      local: Option.none(),
      projectRef: Option.none(),
      password: Option.none(),
    });
  });

  it("passes --linked only when the flag is set", () => {
    expect(legacyRemoteCommitToPullFlags(flags({ linked: true })).linked).toEqual(
      Option.some(true),
    );
  });

  it("forwards schema, db-url, and password", () => {
    const mapped = legacyRemoteCommitToPullFlags(
      flags({
        schema: ["public", "auth"],
        dbUrl: Option.some("postgresql://u:p@h/db"),
        password: Option.some("secret"),
      }),
    );
    expect(mapped.schema).toEqual(["public", "auth"]);
    expect(mapped.dbUrl).toEqual(Option.some("postgresql://u:p@h/db"));
    expect(mapped.password).toEqual(Option.some("secret"));
  });
});
