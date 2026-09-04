import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../..", import.meta.url));
const legacyDir = path.join(srcDir, "legacy");
const sharedDir = path.join(srcDir, "shared");
const legacyCommandsDir = path.join(legacyDir, "commands");
const legacyDbBootstrapDir = path.join(legacyDir, "shared", "db-bootstrap");
const legacyCliDir = path.join(legacyDir, "cli");
const concernSlices = [
  path.join(sharedDir, "auth"),
  path.join(sharedDir, "config"),
  path.join(sharedDir, "output"),
  path.join(sharedDir, "runtime"),
  path.join(sharedDir, "telemetry"),
] as const;

function walk(dir: string): Array<string> {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "__fixtures__") return [];
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return walk(fullPath);
    }
    return [fullPath];
  });
}

function extractRelativeImports(filePath: string): Array<string> {
  const source = readFileSync(filePath, "utf8");
  const imports = Array.from(source.matchAll(/from\s+["']([^"']+)["']/g), (match) => match[1]!);
  return imports.filter((specifier) => specifier.startsWith("."));
}

function resolveImport(filePath: string, specifier: string): string {
  return path.normalize(path.resolve(path.dirname(filePath), specifier));
}

function isSourceFile(filePath: string): boolean {
  return (
    filePath.endsWith(".ts") &&
    !filePath.endsWith(".unit.test.ts") &&
    !filePath.endsWith(".integration.test.ts") &&
    !filePath.endsWith(".e2e.test.ts") &&
    !filePath.endsWith(".d.ts")
  );
}

describe("code structure", () => {
  it("does not keep barrel index.ts files under src", () => {
    const indexFiles = walk(srcDir).filter((filePath) => path.basename(filePath) === "index.ts");
    expect(indexFiles).toEqual([]);
  });

  it("keeps concern slices independent from shell cli and commands", () => {
    const violations: Array<string> = [];

    for (const sliceDir of concernSlices) {
      for (const filePath of walk(sliceDir).filter(isSourceFile)) {
        for (const specifier of extractRelativeImports(filePath)) {
          const resolved = resolveImport(filePath, specifier);
          if (resolved.startsWith(legacyCommandsDir) || resolved.startsWith(legacyCliDir)) {
            violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("prevents legacy commands from importing other legacy command internals", () => {
    const violations: Array<string> = [];

    for (const filePath of walk(legacyCommandsDir).filter(isSourceFile)) {
      const relativeFile = path.relative(legacyCommandsDir, filePath);
      const currentCommand = relativeFile.split(path.sep)[0];
      for (const specifier of extractRelativeImports(filePath)) {
        const resolved = resolveImport(filePath, specifier);
        if (!resolved.startsWith(legacyCommandsDir)) {
          continue;
        }

        const relativeTarget = path.relative(legacyCommandsDir, resolved);
        const targetCommand = relativeTarget.split(path.sep)[0];
        if (targetCommand !== currentCommand) {
          violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps legacy/shared/db-bootstrap independent from legacy commands", () => {
    const violations: Array<string> = [];

    for (const filePath of walk(legacyDbBootstrapDir).filter(isSourceFile)) {
      for (const specifier of extractRelativeImports(filePath)) {
        const resolved = resolveImport(filePath, specifier);
        if (resolved.startsWith(legacyCommandsDir)) {
          violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
