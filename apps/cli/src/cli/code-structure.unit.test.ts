import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("..", import.meta.url));
const concernSlices = ["auth", "config", "output", "runtime", "telemetry", "agents"] as const;
const commandsDir = path.join(srcDir, "commands");
const cliDir = path.join(srcDir, "cli");
const docsDir = path.join(srcDir, "docs");

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

  it("keeps concern slices independent from cli and commands", () => {
    const violations: Array<string> = [];

    for (const slice of concernSlices) {
      const sliceDir = path.join(srcDir, slice);
      for (const filePath of walk(sliceDir).filter(isSourceFile)) {
        for (const specifier of extractRelativeImports(filePath)) {
          const resolved = resolveImport(filePath, specifier);
          if (resolved.startsWith(commandsDir) || resolved.startsWith(cliDir)) {
            violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps docs independent from cli and only dependent on command guide assets", () => {
    const violations: Array<string> = [];

    for (const filePath of walk(docsDir).filter(isSourceFile)) {
      for (const specifier of extractRelativeImports(filePath)) {
        const resolved = resolveImport(filePath, specifier);
        if (resolved.startsWith(cliDir)) {
          violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
          continue;
        }
        if (resolved.startsWith(commandsDir) && !resolved.endsWith(".guide.md")) {
          violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("prevents commands from importing other command internals", () => {
    const violations: Array<string> = [];

    for (const filePath of walk(commandsDir).filter(isSourceFile)) {
      const relativeFile = path.relative(commandsDir, filePath);
      const currentCommand = relativeFile.split(path.sep)[0];
      for (const specifier of extractRelativeImports(filePath)) {
        const resolved = resolveImport(filePath, specifier);
        if (!resolved.startsWith(commandsDir)) {
          continue;
        }

        const relativeTarget = path.relative(commandsDir, resolved);
        const targetCommand = relativeTarget.split(path.sep)[0];
        if (targetCommand !== currentCommand) {
          violations.push(`${path.relative(srcDir, filePath)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
