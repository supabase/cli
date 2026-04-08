import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../..", import.meta.url));
const nextDir = path.join(srcDir, "next");
const legacyDir = path.join(srcDir, "legacy");
const sharedDir = path.join(srcDir, "shared");
const nextCommandsDir = path.join(nextDir, "commands");
const legacyCommandsDir = path.join(legacyDir, "commands");
const nextCliDir = path.join(nextDir, "cli");
const legacyCliDir = path.join(legacyDir, "cli");
const nextDocsDir = path.join(nextDir, "docs");
const concernSlices = [
  path.join(nextDir, "auth"),
  path.join(nextDir, "config"),
  path.join(sharedDir, "output"),
  path.join(sharedDir, "runtime"),
  path.join(sharedDir, "telemetry"),
] as const;

function walk(dir: string): Array<string> {
  return readdirSync(dir).flatMap((entry) => {
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
          if (
            resolved.startsWith(nextCommandsDir) ||
            resolved.startsWith(legacyCommandsDir) ||
            resolved.startsWith(nextCliDir) ||
            resolved.startsWith(legacyCliDir)
          ) {
            violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps next docs independent from cli and commands", () => {
    const violations: Array<string> = [];

    for (const filePath of walk(nextDocsDir).filter(isSourceFile)) {
      for (const specifier of extractRelativeImports(filePath)) {
        const resolved = resolveImport(filePath, specifier);
        if (
          resolved.startsWith(nextCliDir) ||
          resolved.startsWith(legacyCliDir) ||
          resolved.startsWith(nextCommandsDir) ||
          resolved.startsWith(legacyCommandsDir)
        ) {
          violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("prevents next commands from importing other next command internals", () => {
    const violations: Array<string> = [];

    for (const filePath of walk(nextCommandsDir).filter(isSourceFile)) {
      const relativeFile = path.relative(nextCommandsDir, filePath);
      const currentCommand = relativeFile.split(path.sep)[0];
      for (const specifier of extractRelativeImports(filePath)) {
        const resolved = resolveImport(filePath, specifier);
        if (!resolved.startsWith(nextCommandsDir)) {
          continue;
        }

        const relativeTarget = path.relative(nextCommandsDir, resolved);
        const targetCommand = relativeTarget.split(path.sep)[0];
        if (targetCommand !== currentCommand) {
          violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
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

  it("prevents next and legacy from importing each other", () => {
    const violations: Array<string> = [];

    for (const [shellDir, otherShellDir] of [
      [nextDir, legacyDir],
      [legacyDir, nextDir],
    ] as const) {
      for (const filePath of walk(shellDir).filter(isSourceFile)) {
        for (const specifier of extractRelativeImports(filePath)) {
          const resolved = resolveImport(filePath, specifier);
          if (resolved.startsWith(otherShellDir)) {
            violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
