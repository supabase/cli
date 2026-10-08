import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";
import {
  changedLinkedLocalFlags,
  resolveDbTargetFlags,
  VALUE_CONSUMING_LONG_FLAGS,
  VALUE_CONSUMING_SHORT_FLAGS,
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

  it("--schema -- --linked: -- consumed as schema value, --linked is a real flag (Go pflag parity)", () => {
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

describe("VALUE_CONSUMING_LONG_FLAGS / VALUE_CONSUMING_SHORT_FLAGS completeness (CLI-1896 review)", () => {
  // `extractChangedFlagNames` relies on these two sets across every command, not just the
  // db-target subset this file's other describe block covers — see the doc comment on
  // `VALUE_CONSUMING_LONG_FLAGS` in `db-target-flags.ts`. This scan is static-source-based
  // rather than importing every command module, so it can only see flag names declared as a
  // literal string; a name passed through a helper function is registered by hand instead.
  const commandsDir = fileURLToPath(new URL("../commands", import.meta.url));
  const INDIRECT_NAME_FILES = new Set(["issue.command.ts"]);
  const VALUE_FLAG_KINDS = ["string", "integer", "choice", "choiceWithValue", "float"];

  const walk = Effect.fnUntraced(function* (dir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(dir, { recursive: true });
    return entries
      .filter((entry) => entry.endsWith(".command.ts"))
      .map((entry) => path.join(dir, entry));
  });

  interface DeclaredFlag {
    readonly file: string;
    readonly name: string;
    readonly alias: string | undefined;
  }

  function extractDeclaredFlags(filePath: string, source: string): Array<DeclaredFlag> {
    const callRegex = /Flag\.(string|integer|choice|choiceWithValue|float|boolean)\(/g;
    const calls = Array.from(source.matchAll(callRegex), (match) => ({
      index: match.index,
      kind: match[1]!,
    }));

    const declared: Array<DeclaredFlag> = [];
    for (let i = 0; i < calls.length; i++) {
      const current = calls[i]!;
      if (!VALUE_FLAG_KINDS.includes(current.kind)) continue;

      // Name declared as a literal string (e.g. `Flag.string("schema")`); a name passed as an
      // identifier doesn't match and is silently skipped — see INDIRECT_NAME_FILES above.
      const remainder = source.slice(current.index);
      const nameMatch = remainder.match(/^Flag\.\w+\(\s*"([a-zA-Z0-9-]+)"/);
      if (!nameMatch) continue;

      // The alias, if any, is somewhere in the `.pipe(...)` chain between
      // this flag declaration and the next one.
      const windowEnd = i + 1 < calls.length ? calls[i + 1]!.index : source.length;
      const window = source.slice(current.index, windowEnd);
      const aliasMatch = window.match(/withAlias\(\s*"([a-zA-Z0-9])"\s*\)/);

      declared.push({ file: filePath, name: nameMatch[1]!, alias: aliasMatch?.[1] });
    }
    return declared;
  }

  it.effect(
    "registers every directly-declared value-consuming flag name in VALUE_CONSUMING_LONG_FLAGS",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const missing: Array<string> = [];

        for (const filePath of yield* walk(commandsDir)) {
          if (INDIRECT_NAME_FILES.has(path.basename(filePath))) continue;

          for (const flag of extractDeclaredFlags(filePath, yield* fs.readFileString(filePath))) {
            if (!VALUE_CONSUMING_LONG_FLAGS.has(flag.name)) {
              missing.push(`${flag.name} (${path.relative(commandsDir, flag.file)})`);
            }
          }
        }

        expect(missing).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "registers every directly-declared value-consuming flag's shorthand in VALUE_CONSUMING_SHORT_FLAGS",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const missing: Array<string> = [];

        for (const filePath of yield* walk(commandsDir)) {
          if (INDIRECT_NAME_FILES.has(path.basename(filePath))) continue;

          for (const flag of extractDeclaredFlags(filePath, yield* fs.readFileString(filePath))) {
            if (flag.alias !== undefined && !VALUE_CONSUMING_SHORT_FLAGS.has(flag.alias)) {
              missing.push(
                `-${flag.alias} (--${flag.name}, ${path.relative(commandsDir, flag.file)})`,
              );
            }
          }
        }

        expect(missing).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
  );
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

  it("returns both selectors in cobra's sorted order when both are set", () => {
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
