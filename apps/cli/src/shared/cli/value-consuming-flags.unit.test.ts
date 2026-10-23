import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";
import { CLI_CONFIG_FLAGS } from "../../config/cli-config-key-annotations.ts";
import { cliConfigRegistry } from "../../config/cli-config-keys.ts";
import {
  VALUE_CONSUMING_LONG_FLAGS,
  VALUE_CONSUMING_SHORT_FLAGS,
} from "./value-consuming-flags.ts";

describe("VALUE_CONSUMING_LONG_FLAGS / VALUE_CONSUMING_SHORT_FLAGS completeness", () => {
  // `extractChangedFlagNames` relies on these two sets across every command — see the doc comment
  // on `VALUE_CONSUMING_LONG_FLAGS` in `value-consuming-flags.ts`. This scan is static-source-based
  // rather than importing every command module, so it can only see flag names declared as a
  // literal string; a name passed through a helper function is registered by hand instead.
  // Config-bound flags (`CliConfigKeys.<path>.flag({ name })`) take their value-consuming kind
  // from the key's codec in the registry.
  const commandsDir = fileURLToPath(new URL("../../commands", import.meta.url));
  const INDIRECT_NAME_FILES = new Set(["issue.command.ts"]);
  const VALUE_FLAG_KINDS = ["String", "Int", "Finite", "Literals", "ChoiceWithValue"];
  const configFlagPath = new Map<string, string>(
    Object.entries(CLI_CONFIG_FLAGS).flatMap(([keyPath, { names }]) =>
      names.map((name) => [name, keyPath] as const),
    ),
  );

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

  const consumesValue = (kind: string | undefined, name: string): boolean => {
    if (kind !== undefined) return VALUE_FLAG_KINDS.includes(kind);
    const keyPath = configFlagPath.get(name);
    const codecKind =
      keyPath === undefined ? undefined : cliConfigRegistry.keyAt(keyPath)?.codec.kind;
    return codecKind !== "bool";
  };

  function extractDeclaredFlags(filePath: string, source: string): Array<DeclaredFlag> {
    const callRegex = /\bFlag\.([A-Z]\w*)\(|\.flag\(\{/g;
    const calls = Array.from(source.matchAll(callRegex), (match) => ({
      index: match.index,
      kind: match[1],
    }));

    const declared: Array<DeclaredFlag> = [];
    for (let i = 0; i < calls.length; i++) {
      const current = calls[i]!;

      // Name declared as a literal string (e.g. `Flag.String("schema")` or
      // `.flag({ name: "sql-paths" })`); a name passed as an identifier doesn't match and is
      // silently skipped — see INDIRECT_NAME_FILES above.
      const remainder = source.slice(current.index);
      const nameMatch = remainder.match(/^(?:Flag\.\w+\(|\.flag\(\{\s*name:)\s*"([a-zA-Z0-9-]+)"/);
      if (!nameMatch || !consumesValue(current.kind, nameMatch[1]!)) continue;

      // The alias, if any, is somewhere in the `.pipe(...)` chain or options object between
      // this flag declaration and the next one.
      const windowEnd = i + 1 < calls.length ? calls[i + 1]!.index : source.length;
      const window = source.slice(current.index, windowEnd);
      const aliasMatch = window.match(
        /withAlias\(\s*"([a-zA-Z0-9])"\s*\)|\balias:\s*"([a-zA-Z0-9])"/,
      );

      declared.push({
        file: filePath,
        name: nameMatch[1]!,
        alias: aliasMatch?.[1] ?? aliasMatch?.[2],
      });
    }
    return declared;
  }

  it.effect("finds both directly-declared and config-bound value flags in the scan", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = new Set<string>();
      for (const filePath of yield* walk(commandsDir)) {
        for (const flag of extractDeclaredFlags(filePath, yield* fs.readFileString(filePath))) {
          names.add(flag.name);
        }
      }

      expect(names).toContain("schema");
      expect(names).toContain("sql-paths");
      expect(names).toContain("password");
      expect(names).not.toContain("no-seed");
    }).pipe(Effect.provide(BunServices.layer)),
  );

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
