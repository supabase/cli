import { Effect, FileSystem, Path } from "effect";

import { legacyExtensionDeclaration } from "./declarative.flow.ts";

interface LegacyExtensionRepairResult {
  readonly path: string;
  readonly addedExtensions: ReadonlyArray<string>;
  readonly addedDeclarations: ReadonlyArray<string>;
}

const declaredExtensions = (sql: string): ReadonlySet<string> => {
  const extensions = new Set<string>();
  const pattern =
    /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][\w$-]*))/gi;
  for (const match of sql.matchAll(pattern)) {
    const extension = match[1] ?? match[2];
    if (extension !== undefined) extensions.add(extension);
  }
  return extensions;
};

/** Appends missing legacy extension declarations without replacing existing SQL. */
export const legacyAppendExtensionDeclarations = Effect.fnUntraced(function* (
  declarativeDir: string,
  extensions: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const extensionPath = path.join(declarativeDir, "extension.sql");
  const exists = yield* fs.exists(extensionPath);
  const existing = exists ? yield* fs.readFileString(extensionPath) : "";
  const declared = declaredExtensions(existing);
  const addedExtensions = [...new Set(extensions)]
    .filter((extension) => !declared.has(extension))
    .sort();
  const addedDeclarations = addedExtensions.map(legacyExtensionDeclaration);

  if (addedDeclarations.length > 0) {
    const newline = existing.includes("\r\n") ? "\r\n" : "\n";
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : newline;
    const appended = `${separator}${addedDeclarations.join(newline)}${newline}`;
    yield* fs.writeFileString(extensionPath, `${existing}${appended}`);
  }

  return {
    path: extensionPath,
    addedExtensions,
    addedDeclarations,
  } satisfies LegacyExtensionRepairResult;
});
