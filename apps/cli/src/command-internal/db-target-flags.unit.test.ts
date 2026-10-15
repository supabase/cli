import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import {
  changedLinkedLocalFlags,
  rejectPasswordWithDirectTarget,
  resolveDbTargetFlags,
} from "./db-target-flags.ts";

describe("resolveDbTargetFlags", () => {
  it("returns empty setFlags and undefined connType when no args", () => {
    const result = resolveDbTargetFlags([]);
    expect(result.setFlags).toEqual([]);
    expect(result.connType).toBeUndefined();
  });

  it("detects --linked as changed (connType='linked')", () => {
    const result = resolveDbTargetFlags(["--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("detects --linked=false as changed (Changed, not value)", () => {
    const result = resolveDbTargetFlags(["db", "lint", "--linked=false"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("detects --no-linked as changed (boolean negation is still Changed)", () => {
    const result = resolveDbTargetFlags(["--no-linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("detects --db-url as changed", () => {
    const result = resolveDbTargetFlags(["--db-url", "postgres://x"]);
    expect(result.connType).toBe("db-url");
    expect(result.setFlags).toEqual(["db-url"]);
  });

  it("detects --db-url=<value> as changed", () => {
    const result = resolveDbTargetFlags(["--db-url=postgres://x"]);
    expect(result.connType).toBe("db-url");
    expect(result.setFlags).toEqual(["db-url"]);
  });

  it("--local=false --linked produces setFlags length 2 with alphabetical order [linked local]", () => {
    const result = resolveDbTargetFlags(["--local=false", "--linked"]);
    expect(result.setFlags).toEqual(["linked", "local"]);
    expect(result.setFlags).toHaveLength(2);
    expect(result.connType).toBe("local");
  });

  it("--db-url=postgres://x --linked produces setFlags [db-url linked] with connType=db-url", () => {
    const result = resolveDbTargetFlags(["--db-url=postgres://x", "--linked"]);
    expect(result.setFlags).toEqual(["db-url", "linked"]);
    expect(result.connType).toBe("db-url");
  });

  it("tokens after bare -- are not scanned (end-of-options sentinel)", () => {
    const result = resolveDbTargetFlags(["--", "--linked"]);
    expect(result.setFlags).toEqual([]);
    expect(result.connType).toBeUndefined();
  });

  it("--db-url (key only, value as next arg) is still detected as changed", () => {
    const result = resolveDbTargetFlags(["--db-url", "postgres://x"]);
    expect(result.connType).toBe("db-url");
    expect(result.setFlags).toEqual(["db-url"]);
  });

  it("setFlags order is always alphabetical [db-url, linked, local] regardless of argv order", () => {
    const result = resolveDbTargetFlags(["--local", "--db-url=x", "--linked"]);
    expect(result.setFlags).toEqual(["db-url", "linked", "local"]);
  });

  it("Changed-first precedence: db-url > local > linked", () => {
    const all = resolveDbTargetFlags(["--db-url=x", "--linked", "--local"]);
    expect(all.connType).toBe("db-url");

    const localLinked = resolveDbTargetFlags(["--linked", "--local"]);
    expect(localLinked.connType).toBe("local");

    const linkedOnly = resolveDbTargetFlags(["--linked"]);
    expect(linkedOnly.connType).toBe("linked");
  });

  it("skips value token after bare --schema so --linked is not a false positive", () => {
    const result = resolveDbTargetFlags(["db", "lint", "--schema", "--linked"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("skips value token after bare --level so following flags are not false positives", () => {
    const result = resolveDbTargetFlags(["--level", "error", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--schema=value (attached form) does NOT skip the next token", () => {
    const result = resolveDbTargetFlags(["--schema=public", "--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("skips value token after bare -s (short for --schema)", () => {
    const result = resolveDbTargetFlags(["-s", "--linked"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("-svalue (attached short form) does NOT skip the next token", () => {
    const result = resolveDbTargetFlags(["-spublic", "--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("skips value token after bare --output so following flags are not false positives", () => {
    const result = resolveDbTargetFlags(["--output", "json", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--output-dir <value> does NOT mark --local as changed (value consumed)", () => {
    const result = resolveDbTargetFlags(["--output-dir", "--local"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("--output-dir=<value> (attached form) DOES mark --local as changed", () => {
    const result = resolveDbTargetFlags(["--output-dir=./reports", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--schema -- --linked: -- consumed as schema value, --linked is a real flag", () => {
    const result = resolveDbTargetFlags(["db", "lint", "--schema", "--", "--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("bare -- with no pending skip still stops the scan", () => {
    const result = resolveDbTargetFlags(["--linked", "--", "--local"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("skips value token after bare -p so --local is the password value, not a target", () => {
    const result = resolveDbTargetFlags(["migration", "list", "-p", "--local"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("skips value token after bare --password so --linked is its value, not a flag", () => {
    const result = resolveDbTargetFlags(["--password", "--linked"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("-ppwd (attached short password) does NOT consume the next token", () => {
    const result = resolveDbTargetFlags(["-ppwd", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--password=pwd (attached long form) does NOT consume the next token", () => {
    const result = resolveDbTargetFlags(["--password=pwd", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });
});

describe("changedLinkedLocalFlags", () => {
  it("returns nothing when neither selector is present", () => {
    expect(changedLinkedLocalFlags(["seed", "buckets"])).toEqual([]);
    expect(changedLinkedLocalFlags(["storage", "ls", "ss:///"])).toEqual([]);
  });

  it("returns a single selector", () => {
    expect(changedLinkedLocalFlags(["seed", "buckets", "--linked"])).toEqual(["linked"]);
    expect(changedLinkedLocalFlags(["seed", "buckets", "--local"])).toEqual(["local"]);
  });

  it("returns both selectors in sorted order when both are set", () => {
    expect(changedLinkedLocalFlags(["seed", "buckets", "--local", "--linked"])).toEqual([
      "linked",
      "local",
    ]);
  });

  it("handles = forms", () => {
    expect(changedLinkedLocalFlags(["--local=true", "--linked=false"])).toEqual([
      "linked",
      "local",
    ]);
  });

  it("treats the --no-* negation form as changed", () => {
    expect(changedLinkedLocalFlags(["seed", "buckets", "--no-linked"])).toEqual(["linked"]);
    expect(changedLinkedLocalFlags(["storage", "ls", "--no-local"])).toEqual(["local"]);
    expect(changedLinkedLocalFlags(["seed", "buckets", "--no-local", "--linked"])).toEqual([
      "linked",
      "local",
    ]);
  });

  it("does not treat a value-consuming flag's value as a selector", () => {
    expect(changedLinkedLocalFlags(["seed", "buckets", "--workdir", "--linked"])).toEqual([]);
    expect(changedLinkedLocalFlags(["-o", "--linked", "--local"])).toEqual(["local"]);
    expect(
      changedLinkedLocalFlags(["storage", "cp", "--content-type", "--local", "a", "b"]),
    ).toEqual([]);
    expect(
      changedLinkedLocalFlags(["storage", "cp", "--cache-control", "--linked", "a", "b"]),
    ).toEqual([]);
    expect(changedLinkedLocalFlags(["storage", "cp", "--jobs", "--local", "a", "b"])).toEqual([]);
    expect(changedLinkedLocalFlags(["storage", "cp", "-j", "--linked", "a", "b"])).toEqual([]);
  });

  it("still detects a selector after a value-consuming flag's value", () => {
    expect(changedLinkedLocalFlags(["storage", "cp", "--jobs", "5", "--local", "a", "b"])).toEqual([
      "local",
    ]);
  });

  it("stops scanning at the -- terminator", () => {
    expect(changedLinkedLocalFlags(["seed", "buckets", "--", "--local", "--linked"])).toEqual([]);
  });

  it("detects selectors given after positional arguments", () => {
    expect(changedLinkedLocalFlags(["storage", "rm", "ss:///b/x", "--local"])).toEqual(["local"]);
  });
});

describe("rejectPasswordWithDirectTarget", () => {
  const run = (connType: "local" | "db-url", password: string) =>
    Effect.runSyncExit(rejectPasswordWithDirectTarget(connType, Option.some(password)));

  it.each(["local", "db-url"] as const)(
    "treats an empty --password as absent with %s",
    (connType) => {
      expect(Exit.isSuccess(run(connType, ""))).toBe(true);
    },
  );

  it.each(["local", "db-url"] as const)(
    "still rejects a non-empty --password with %s",
    (connType) => {
      expect(Exit.isFailure(run(connType, "x"))).toBe(true);
    },
  );
});
