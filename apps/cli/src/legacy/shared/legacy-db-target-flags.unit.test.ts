import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveLegacyDbTargetFlags,
  VALUE_CONSUMING_LONG_FLAGS,
  VALUE_CONSUMING_SHORT_FLAGS,
} from "./legacy-db-target-flags.ts";

describe("resolveLegacyDbTargetFlags", () => {
  it("returns empty setFlags and undefined connType when no args", () => {
    const result = resolveLegacyDbTargetFlags([]);
    expect(result.setFlags).toEqual([]);
    expect(result.connType).toBeUndefined();
  });

  it("detects --linked as changed (connType='linked')", () => {
    const result = resolveLegacyDbTargetFlags(["--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("detects --linked=false as changed (Changed, not value)", () => {
    const result = resolveLegacyDbTargetFlags(["db", "lint", "--linked=false"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("detects --no-linked as changed (boolean negation is still Changed)", () => {
    const result = resolveLegacyDbTargetFlags(["--no-linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("detects --db-url as changed", () => {
    const result = resolveLegacyDbTargetFlags(["--db-url", "postgres://x"]);
    expect(result.connType).toBe("db-url");
    expect(result.setFlags).toEqual(["db-url"]);
  });

  it("detects --db-url=<value> as changed", () => {
    const result = resolveLegacyDbTargetFlags(["--db-url=postgres://x"]);
    expect(result.connType).toBe("db-url");
    expect(result.setFlags).toEqual(["db-url"]);
  });

  it("--local=false --linked produces setFlags length 2 with alphabetical order [linked local]", () => {
    const result = resolveLegacyDbTargetFlags(["--local=false", "--linked"]);
    expect(result.setFlags).toEqual(["linked", "local"]);
    expect(result.setFlags).toHaveLength(2);
    // connType: local wins over linked in Changed-first precedence
    expect(result.connType).toBe("local");
  });

  it("--db-url=postgres://x --linked produces setFlags [db-url linked] with connType=db-url", () => {
    const result = resolveLegacyDbTargetFlags(["--db-url=postgres://x", "--linked"]);
    expect(result.setFlags).toEqual(["db-url", "linked"]);
    expect(result.connType).toBe("db-url");
  });

  it("tokens after bare -- are not scanned (end-of-options sentinel)", () => {
    const result = resolveLegacyDbTargetFlags(["--", "--linked"]);
    expect(result.setFlags).toEqual([]);
    expect(result.connType).toBeUndefined();
  });

  it("--db-url (key only, value as next arg) is still detected as changed", () => {
    // `--db-url` matches the token exactly, even without `=value`.
    const result = resolveLegacyDbTargetFlags(["--db-url", "postgres://x"]);
    expect(result.connType).toBe("db-url");
    expect(result.setFlags).toEqual(["db-url"]);
  });

  it("setFlags order is always alphabetical [db-url, linked, local] regardless of argv order", () => {
    // All three present — setFlags must be sorted to match cobra's %v rendering.
    const result = resolveLegacyDbTargetFlags(["--local", "--db-url=x", "--linked"]);
    expect(result.setFlags).toEqual(["db-url", "linked", "local"]);
  });

  it("Changed-first precedence: db-url > local > linked", () => {
    // db-url wins when all three are present
    const all = resolveLegacyDbTargetFlags(["--db-url=x", "--linked", "--local"]);
    expect(all.connType).toBe("db-url");

    // local wins over linked when db-url absent
    const localLinked = resolveLegacyDbTargetFlags(["--linked", "--local"]);
    expect(localLinked.connType).toBe("local");

    // linked wins when only linked is present
    const linkedOnly = resolveLegacyDbTargetFlags(["--linked"]);
    expect(linkedOnly.connType).toBe("linked");
  });

  it("skips value token after bare --schema so --linked is not a false positive", () => {
    // `--schema --linked` in space form: --linked is the VALUE of --schema, not a flag.
    const result = resolveLegacyDbTargetFlags(["db", "lint", "--schema", "--linked"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("skips value token after bare --level so following flags are not false positives", () => {
    const result = resolveLegacyDbTargetFlags(["--level", "error", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--schema=value (attached form) does NOT skip the next token", () => {
    // `--schema=public --linked`: --linked is a real flag here.
    const result = resolveLegacyDbTargetFlags(["--schema=public", "--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("skips value token after bare -s (short for --schema)", () => {
    // `-s --linked`: --linked is the VALUE of -s, not a flag.
    const result = resolveLegacyDbTargetFlags(["-s", "--linked"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("-svalue (attached short form) does NOT skip the next token", () => {
    // `-spublic --linked`: --linked is a real flag.
    const result = resolveLegacyDbTargetFlags(["-spublic", "--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("skips value token after bare --output so following flags are not false positives", () => {
    // --output is a value-consuming global flag.
    const result = resolveLegacyDbTargetFlags(["--output", "json", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--output-dir <value> does NOT mark --local as changed (value consumed)", () => {
    // inspect report has --output-dir (StringVar, no short alias). In space form
    // the next token is the dir value, not a flag. Without output-dir in the
    // value-consuming set, --local would be falsely detected as changed.
    const result = resolveLegacyDbTargetFlags(["--output-dir", "--local"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("--output-dir=<value> (attached form) DOES mark --local as changed", () => {
    // Attached form does not consume the next token, so --local is a real flag.
    const result = resolveLegacyDbTargetFlags(["--output-dir=./reports", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--schema -- --linked: -- consumed as schema value, --linked is a real flag (Go pflag parity)", () => {
    // pflag: a bare value-consuming flag consumes the very next token as its
    // value, even when that token is "--". Only a "--" with no pending value
    // terminates the scan.
    const result = resolveLegacyDbTargetFlags(["db", "lint", "--schema", "--", "--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("bare -- with no pending skip still stops the scan", () => {
    // --linked sets changed; bare -- terminates; --local after is not scanned.
    const result = resolveLegacyDbTargetFlags(["--linked", "--", "--local"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("skips value token after bare -p so --local is the password value, not a target", () => {
    // Go: `StringVarP(&dbPassword, "password", "p", …)` — `-p --local` means the
    // password is `--local`, so `local` is not Changed (linked default applies).
    const result = resolveLegacyDbTargetFlags(["migration", "list", "-p", "--local"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("skips value token after bare --password so --linked is its value, not a flag", () => {
    const result = resolveLegacyDbTargetFlags(["--password", "--linked"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("-ppwd (attached short password) does NOT consume the next token", () => {
    // Attached value: `--local` is a real selector.
    const result = resolveLegacyDbTargetFlags(["-ppwd", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--password=pwd (attached long form) does NOT consume the next token", () => {
    const result = resolveLegacyDbTargetFlags(["--password=pwd", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });
});

describe("VALUE_CONSUMING_LONG_FLAGS / VALUE_CONSUMING_SHORT_FLAGS completeness (CLI-1896 review)", () => {
  // `legacy/telemetry/legacy-command-instrumentation.ts`'s `extractChangedFlagNames`
  // relies on these two sets to know which flag consumes the next raw-argv
  // token as its value, across EVERY legacy command (not just the db-target
  // subset this file's other describe block covers) — see the doc comment on
  // `VALUE_CONSUMING_LONG_FLAGS` in `legacy-db-target-flags.ts`. This scan is
  // static-source-based (same technique as
  // `shared/cli/code-structure.unit.test.ts`) rather than importing every
  // command module, so it can only see flag names declared as a literal
  // string argument to `Flag.string`/`Flag.integer`/`Flag.choice`/
  // `Flag.choiceWithValue`/`Flag.float` — it cannot trace a name passed
  // through a helper function (`issue.command.ts`'s
  // `legacyIssueOptionalTextFlag`, `status.command.ts`'s
  // `csvStringSliceFlag`), so those two files are excluded below; their flag
  // names are registered by hand in `VALUE_CONSUMING_LONG_FLAGS` instead.
  const commandsDir = fileURLToPath(new URL("../commands", import.meta.url));
  const INDIRECT_NAME_FILES = new Set(["issue.command.ts", "status.command.ts"]);
  const VALUE_FLAG_KINDS = ["string", "integer", "choice", "choiceWithValue", "float"];

  function walk(dir: string): Array<string> {
    return readdirSync(dir).flatMap((entry) => {
      const fullPath = path.join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) return walk(fullPath);
      return entry.endsWith(".command.ts") ? [fullPath] : [];
    });
  }

  interface DeclaredFlag {
    readonly file: string;
    readonly name: string;
    readonly alias: string | undefined;
  }

  function extractDeclaredFlags(filePath: string): Array<DeclaredFlag> {
    const source = readFileSync(filePath, "utf8");
    const callRegex = /Flag\.(string|integer|choice|choiceWithValue|float|boolean)\(/g;
    const calls = Array.from(source.matchAll(callRegex), (match) => ({
      index: match.index,
      kind: match[1]!,
    }));

    const declared: Array<DeclaredFlag> = [];
    for (let i = 0; i < calls.length; i++) {
      const current = calls[i]!;
      if (!VALUE_FLAG_KINDS.includes(current.kind)) continue;

      // Name declared as a literal string (e.g. `Flag.string("schema")`).
      // A name passed as an identifier (`Flag.string(name)`) doesn't match
      // and is silently skipped — see INDIRECT_NAME_FILES above.
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

  it("registers every directly-declared value-consuming flag name in VALUE_CONSUMING_LONG_FLAGS", () => {
    const missing: Array<string> = [];

    for (const filePath of walk(commandsDir)) {
      if (INDIRECT_NAME_FILES.has(path.basename(filePath))) continue;

      for (const flag of extractDeclaredFlags(filePath)) {
        if (!VALUE_CONSUMING_LONG_FLAGS.has(flag.name)) {
          missing.push(`${flag.name} (${path.relative(commandsDir, flag.file)})`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("registers every directly-declared value-consuming flag's shorthand in VALUE_CONSUMING_SHORT_FLAGS", () => {
    const missing: Array<string> = [];

    for (const filePath of walk(commandsDir)) {
      if (INDIRECT_NAME_FILES.has(path.basename(filePath))) continue;

      for (const flag of extractDeclaredFlags(filePath)) {
        if (flag.alias !== undefined && !VALUE_CONSUMING_SHORT_FLAGS.has(flag.alias)) {
          missing.push(`-${flag.alias} (--${flag.name}, ${path.relative(commandsDir, flag.file)})`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
