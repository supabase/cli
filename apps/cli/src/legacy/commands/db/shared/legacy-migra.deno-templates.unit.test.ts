import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  legacyMigraDiffScript,
  legacyMigraDiffShellScript,
} from "./legacy-migra.deno-templates.ts";

// Resolve the Go template sources relative to this file so the byte-equality
// assertion fails loudly if the embedded copies drift from upstream.
const goDiffTemplatesDir = fileURLToPath(
  new URL("../../../../../../cli-go/internal/db/diff/templates/", import.meta.url),
);
const readGoTemplate = (name: string) => readFileSync(`${goDiffTemplatesDir}${name}`, "utf8");

describe("embedded migra templates", () => {
  it("match the Go sources byte-for-byte", () => {
    expect(legacyMigraDiffScript).toBe(readGoTemplate("migra.ts"));
    expect(legacyMigraDiffShellScript).toBe(readGoTemplate("migra.sh"));
  });
});
