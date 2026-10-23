import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { commandTreeFor } from "../../../tests/helpers/command-flags.ts";
import type { PermissionVariant } from "../../../tests/helpers/permission-registry.ts";
import { readTargetPolicy } from "../target/target-policy.ts";

const srcDir = fileURLToPath(new URL("../..", import.meta.url));

const VARIANTS: ReadonlyArray<PermissionVariant> = [
  undefined,
  { stackBackend: "stack", computeEnabled: true },
];

const consentDefaultByLeaf: ReadonlyMap<string, "no" | "yes"> = new Map(
  VARIANTS.flatMap((variant) =>
    [...commandTreeFor(variant)].flatMap(([path, node]) => {
      const policy = readTargetPolicy(node.command);
      return node.isLeaf && Option.isSome(policy) && policy.value.consent !== "none"
        ? [[path, policy.value.consent] as const]
        : [];
    }),
  ),
);

const consentLeafPaths: ReadonlySet<string> = new Set(consentDefaultByLeaf.keys());

const LITERAL_CALL = /\bdescribeHostedConsent\(\s*"([^"]+)"/g;
const ANY_CALL = /\bdescribeHostedConsent\(/g;

const testFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => file.split(sep).join("/"));

const callsByLeaf = new Map<string, Array<string>>();
const nonLiteralCallSites: Array<string> = [];

for (const file of testFiles) {
  const source = readFileSync(join(srcDir, file), "utf8");
  const literalCalls = [...source.matchAll(LITERAL_CALL)];
  for (const [, leaf] of literalCalls) {
    callsByLeaf.set(leaf!, [...(callsByLeaf.get(leaf!) ?? []), file]);
  }
  const anyCalls = [...source.matchAll(ANY_CALL)].length;
  if (anyCalls !== literalCalls.length) {
    nonLiteralCallSites.push(`${file} (${anyCalls - literalCalls.length})`);
  }
}

describe("hosted consent coverage", () => {
  it("scans real test files and finds consenting leaves in the command tree", () => {
    expect(testFiles.length).toBeGreaterThan(0);
    expect(consentLeafPaths.size).toBeGreaterThan(0);
  });

  it("has a consent matrix for every leaf whose policy asks for consent", () => {
    const missing = [...consentLeafPaths].filter((path) => !callsByLeaf.has(path)).sort();
    expect(missing, "leaves with consent but no hosted-consent matrix in src/**/*.test.ts").toEqual(
      [],
    );
  });

  it("has no consent matrix for a path that is not a leaf with consent", () => {
    const extra = [...callsByLeaf]
      .filter(([path]) => !consentLeafPaths.has(path))
      .map(([path, files]) => `${path} (${files.join(", ")})`)
      .sort();
    expect(extra, "hosted-consent matrices for paths that are not consenting leaves").toEqual([]);
  });

  it("names the leaf as a string literal at every call site so the scan can see it", () => {
    expect(nonLiteralCallSites).toEqual([]);
  });

  it("defaults the prompt to Yes for create-only leaves and No for everything else", () => {
    expect(Object.fromEntries(consentDefaultByLeaf)).toMatchInlineSnapshot(`
      {
        "backups restore": "no",
        "bootstrap": "yes",
        "branches create": "yes",
        "branches delete": "no",
        "branches disable": "no",
        "branches pause": "no",
        "branches unpause": "no",
        "branches update": "no",
        "compute delete": "no",
        "compute push": "no",
        "config push": "no",
        "db pull": "no",
        "db push": "no",
        "db query": "no",
        "db reset": "no",
        "db test": "no",
        "domains activate": "no",
        "domains create": "yes",
        "domains delete": "no",
        "encryption update-root-key": "no",
        "feedback delete": "no",
        "functions delete": "no",
        "functions deploy": "no",
        "migration down": "no",
        "migration repair": "no",
        "migration squash": "no",
        "migration up": "no",
        "network-bans remove": "no",
        "network-restrictions update": "no",
        "notebooks push": "no",
        "orgs create": "yes",
        "postgres-config delete": "no",
        "postgres-config update": "no",
        "projects create": "yes",
        "projects delete": "no",
        "pull": "no",
        "secrets set": "no",
        "secrets unset": "no",
        "seed buckets": "no",
        "ssl-enforcement update": "no",
        "sso add": "no",
        "sso remove": "no",
        "sso update": "no",
        "storage cp": "no",
        "storage mv": "no",
        "storage rm": "no",
        "test db": "no",
        "vanity-subdomains activate": "no",
        "vanity-subdomains delete": "no",
      }
    `);
  });
});
