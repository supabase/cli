import { Effect, FileSystem, Path } from "effect";

import { declaredExtensions, extensionDeclaration } from "./declarative.flow.ts";

interface ExtensionRepairResult {
  readonly path: string;
  readonly addedExtensions: ReadonlyArray<string>;
  readonly addedDeclarations: ReadonlyArray<string>;
}

/** Appends missing legacy extension declarations without replacing existing SQL. */
export const appendExtensionDeclarations = Effect.fnUntraced(function* (
  declarativeDir: string,
  extensions: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const extensionPath = path.join(declarativeDir, "extension.sql");
  const exists = yield* fs.exists(extensionPath);
  const existing = exists ? yield* fs.readFileString(extensionPath) : "";
  const declared = declaredExtensions([{ name: "extension.sql", sql: existing }]);
  const addedExtensions = [...new Set(extensions)]
    .filter((extension) => !declared.has(extension))
    .sort();
  const addedDeclarations = addedExtensions.map(extensionDeclaration);

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
  } satisfies ExtensionRepairResult;
});
