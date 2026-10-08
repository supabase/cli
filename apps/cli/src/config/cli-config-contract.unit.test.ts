import { CliConfigSchema } from "@supabase/config";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Path, Result, type SchemaAST } from "effect";

import {
  CLI_CONFIG_CODEC_OVERRIDES,
  CLI_CONFIG_CONTEXT_DEFAULTS,
  CLI_CONFIG_DOCUMENT_KEYS,
  CLI_CONFIG_ENV_ALIASES,
  CLI_CONFIG_ENV_EXCLUDED,
  CLI_CONFIG_FAMILIES,
  CLI_CONFIG_FLAGS,
  CLI_CONFIG_LINKED_KEYS,
  CLI_CONFIG_NORMALIZERS,
  CLI_CONFIG_SCHEMA_EXCLUDED,
  CLI_CONFIG_SECTION_ENV_EXEMPT,
} from "./cli-config-key-annotations.ts";
import { pickCliConfigKey, type CliConfigSources } from "./cli-config-key.ts";
import { CliConfigKeys, cliConfigFamilyKey, cliConfigRegistry } from "./cli-config-keys.ts";
import type { AnyCliConfigKey } from "./cli-config-keys.ts";

const pathService = Effect.runSync(
  Effect.gen(function* () {
    return yield* Path.Path;
  }).pipe(Effect.provide(Path.layer)),
);

const CIPHERTEXT =
  "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
const DECRYPTED = "value";
const PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const ENV_FILE = "/work/supabase/.env";
const REMOTE = "staging";

interface Sample {
  readonly env: string;
  readonly typed: unknown;
}

const samplePair = (key: AnyCliConfigKey): readonly [Sample, Sample] => {
  switch (key.codec.kind) {
    case "bool":
      return [
        { env: "true", typed: true },
        { env: "false", typed: false },
      ];
    case "uint":
      return [
        { env: "7", typed: 7 },
        { env: "8", typed: 8 },
      ];
    case "port":
      return [
        { env: "6001", typed: 6001 },
        { env: "6002", typed: 6002 },
      ];
    case "string":
      return [
        { env: "alpha", typed: "alpha" },
        { env: "beta", typed: "beta" },
      ];
    case "commaList":
      return [
        { env: "a,b", typed: ["a", "b"] },
        { env: "c", typed: ["c"] },
      ];
    case "literal": {
      const literals = (key.codec.literals ?? []).filter((literal) => literal !== "");
      const [first, second] = literals;
      if (first === undefined) throw new Error(`${key.path} declares no non-empty literal`);
      return [
        { env: first, typed: first },
        { env: second ?? first, typed: second ?? first },
      ];
    }
  }
};

type Tier = "flag" | "shell" | "projectEnv" | "config";

const PRECEDENCE: ReadonlyArray<Tier> = ["flag", "shell", "projectEnv", "config"];

interface Scenario {
  readonly winner: Tier;
  readonly envName?: string;
  readonly sectionPresent: boolean;
}

const contextFor = (): CliConfigSources["context"] => ({
  workdir: "/work/app",
  projectRef: Option.none(),
  path: pathService,
  configAt: () => undefined,
});

/**
 * Offers every tier at or below the winner: the winner carries value A and every lower tier
 * carries B, so the assertion can only hold if the winner tier actually wins.
 */
const sourcesFor = (key: AnyCliConfigKey, scenario: Scenario): CliConfigSources => {
  const [a, b] = samplePair(key);
  const secret = key.secret === true;
  const rank = PRECEDENCE.indexOf(scenario.winner);
  const present = (tier: Tier) => PRECEDENCE.indexOf(tier) >= rank;
  const valueFor = (tier: Tier): Sample => {
    if (tier !== scenario.winner) return b;
    return secret && tier !== "flag" ? { env: CIPHERTEXT, typed: CIPHERTEXT } : a;
  };
  const canonical = key.env[0];
  const winnerName = scenario.envName ?? canonical;

  return {
    flags: (path) =>
      path === key.path && present("flag")
        ? { flag: `--${path}`, value: valueFor("flag").typed }
        : undefined,
    shell: (name) => {
      if (!present("shell")) return undefined;
      if (scenario.winner === "shell")
        return name === winnerName ? valueFor("shell").env : undefined;
      return name === canonical ? b.env : undefined;
    },
    projectEnv: (name) => {
      if (!present("projectEnv")) return undefined;
      if (scenario.winner === "projectEnv") {
        return name === winnerName
          ? { value: valueFor("projectEnv").env, file: ENV_FILE }
          : undefined;
      }
      return name === canonical ? { value: b.env, file: ENV_FILE } : undefined;
    },
    config: (path) => {
      if (path === key.path && present("config")) {
        return {
          value: valueFor("config").typed,
          origin: { path: path.split("."), source: "local" },
          remote: REMOTE,
        };
      }
      if (path === key.envRequiresSection && scenario.sectionPresent) {
        return { value: {}, origin: { path: path.split("."), source: "local" } };
      }
      return undefined;
    },
    dotenvPrivateKeys: [PRIVATE_KEY],
    context: contextFor(),
  };
};

const applicable = (key: AnyCliConfigKey, tier: Tier, sectionPresent: boolean): boolean => {
  switch (tier) {
    case "flag":
      return true;
    case "shell":
    case "projectEnv":
      return key.env.length > 0 && (key.envRequiresSection === undefined || sectionPresent);
    case "config":
      return key.document !== false;
  }
};

type Expected =
  | { readonly tier: Tier; readonly winnerSample: boolean }
  | { readonly tier: "default" };

const expectedValue = (key: AnyCliConfigKey, tier: Tier, winnerSample: boolean): unknown => {
  const [a, b] = samplePair(key);
  const sample = winnerSample ? a : b;
  const decoded = winnerSample && key.secret === true && tier !== "flag" ? DECRYPTED : sample.typed;
  const normalized = key.normalize === undefined ? decoded : key.normalize(decoded, contextFor());
  return key.wrap(normalized);
};

const expectedOrigin = (key: AnyCliConfigKey, tier: Tier, envName: string | undefined) => {
  switch (tier) {
    case "flag":
      return { tier: "flag", flag: `--${key.path}` };
    case "shell":
      return { tier: "shell", envName };
    case "projectEnv":
      return { tier: "projectEnv", envName, file: ENV_FILE };
    case "config":
      return {
        tier: "config",
        origin: { path: key.path.split("."), source: "local" },
        remote: REMOTE,
      };
  }
};

const subjects: ReadonlyArray<{ readonly label: string; readonly key: AnyCliConfigKey }> = [
  ...cliConfigRegistry.keys.map((key) => ({ label: key.path, key })),
  ...CLI_CONFIG_FAMILIES.flatMap((family) =>
    family.fields.flatMap((field) => {
      const key = cliConfigFamilyKey(family, "sample_entry", field.name);
      return key === undefined ? [] : [{ label: `${family.id}.${field.name}`, key }];
    }),
  ),
];

const failureMessages = (
  label: string,
  key: AnyCliConfigKey,
  scenario: Scenario,
  expected: Expected,
): ReadonlyArray<string> => {
  const picked = pickCliConfigKey(key, sourcesFor(key, scenario));
  const name = `${label} [${scenario.winner}${scenario.envName === undefined ? "" : ` ${scenario.envName}`}${scenario.sectionPresent ? "" : ", section absent"}]`;
  if (Result.isFailure(picked)) return [`${name}: failed with ${picked.failure.message}`];
  const actual = picked.success;
  if (expected.tier === "default") {
    return actual.origin.tier === "default"
      ? []
      : [`${name}: expected default, got ${actual.origin.tier}`];
  }
  const envName = expected.winnerSample ? scenario.envName : key.env[0];
  const origin = expectedOrigin(key, expected.tier, envName);
  const value = expectedValue(key, expected.tier, expected.winnerSample);
  const problems: Array<string> = [];
  if (JSON.stringify(actual.origin) !== JSON.stringify(origin)) {
    problems.push(`${name}: origin ${JSON.stringify(actual.origin)} != ${JSON.stringify(origin)}`);
  }
  if (JSON.stringify(actual.value) !== JSON.stringify(value)) {
    problems.push(`${name}: value ${JSON.stringify(actual.value)} != ${JSON.stringify(value)}`);
  }
  return problems;
};

const schemaPaths = (
  ast: SchemaAST.AST,
  segments: ReadonlyArray<string> = [],
  out: Set<string> = new Set(),
): Set<string> => {
  const node = ast._tag === "Suspend" ? ast.thunk() : ast;
  if (segments.length > 0) out.add(segments.join("."));
  if (node._tag === "Objects") {
    for (const property of node.propertySignatures) {
      if (typeof property.name === "string") {
        schemaPaths(property.type, [...segments, property.name], out);
      }
    }
  }
  return out;
};

describe("config key contract", () => {
  it("covers the whole registry and a sample of every family field", () => {
    expect(cliConfigRegistry.keys.length).toBeGreaterThan(150);
    const familyFields = CLI_CONFIG_FAMILIES.flatMap((family) => family.fields).length;
    expect(subjects.length).toBe(cliConfigRegistry.keys.length + familyFields);
  });

  it("resolves every key from the highest tier that can supply it, with that tier's origin", () => {
    const failures = subjects.flatMap(({ label, key }) => {
      const sectionStates = key.envRequiresSection === undefined ? [true] : [true, false];
      return sectionStates.flatMap((sectionPresent) =>
        PRECEDENCE.flatMap((winner): ReadonlyArray<string> => {
          if (!applicable(key, winner, sectionPresent)) return [];
          const names = winner === "shell" || winner === "projectEnv" ? key.env : [undefined];
          return names.flatMap((envName) =>
            failureMessages(
              label,
              key,
              { winner, sectionPresent, ...(envName === undefined ? {} : { envName }) },
              { tier: winner, winnerSample: true },
            ),
          );
        }),
      );
    });

    expect(failures).toEqual([]);
  });

  it("lets a lower tier win exactly when every higher tier is unavailable for the key", () => {
    const failures = subjects.flatMap(({ label, key }) => {
      const sectionStates = key.envRequiresSection === undefined ? [true] : [true, false];
      return sectionStates.flatMap((sectionPresent) =>
        PRECEDENCE.flatMap((tier): ReadonlyArray<string> => {
          if (applicable(key, tier, sectionPresent)) return [];
          const scenario = { winner: tier, sectionPresent, envName: key.env[0] } as const;
          const fallback = PRECEDENCE.slice(PRECEDENCE.indexOf(tier) + 1).find((lower) =>
            applicable(key, lower, sectionPresent),
          );
          return failureMessages(
            label,
            key,
            scenario,
            fallback === undefined ? { tier: "default" } : { tier: fallback, winnerSample: false },
          );
        }),
      );
    });

    expect(failures).toEqual([]);
  });

  it("falls through a set-but-empty shell variable to the next applicable tier for every key", () => {
    const failures = subjects.flatMap(({ label, key }) => {
      const name = key.env[0];
      if (name === undefined) return [];
      const [a] = samplePair(key);
      const sources: CliConfigSources = {
        ...sourcesFor(key, { winner: "config", sectionPresent: true }),
        shell: (candidate) => (candidate === name ? "" : undefined),
        projectEnv: (candidate) =>
          candidate === name ? { value: a.env, file: ENV_FILE } : undefined,
      };
      const picked = pickCliConfigKey(key, sources);
      if (Result.isFailure(picked)) return [`${label}: ${picked.failure.message}`];
      const expectedTier = key.document === false ? "default" : "config";
      const expected =
        expectedTier === "default"
          ? key.defaultValue(contextFor())
          : expectedValue(key, "config", true);
      return picked.success.origin.tier === expectedTier &&
        JSON.stringify(picked.success.value) === JSON.stringify(expected)
        ? []
        : [`${label}: got ${JSON.stringify(picked.success.origin)}`];
    });

    expect(failures).toEqual([]);
  });

  it("reports a deprecated alias as the winning env name", () => {
    const aliased = subjects.filter(({ key }) => key.env.length > 1);
    expect(aliased.map(({ key }) => key.path)).toEqual(Object.keys(CLI_CONFIG_ENV_ALIASES));

    for (const { key } of aliased) {
      const [, ...aliases] = key.env;
      for (const alias of aliases) {
        const picked = pickCliConfigKey(
          key,
          sourcesFor(key, { winner: "shell", envName: alias, sectionPresent: true }),
        );
        expect(Result.isSuccess(picked) && picked.success.origin).toEqual({
          tier: "shell",
          envName: alias,
        });
      }
    }
  });

  it("keeps every secret key a string key, so tier decryption applies to all of them", () => {
    const secrets = subjects.filter(({ key }) => key.secret === true);

    expect(secrets.length).toBeGreaterThan(5);
    expect(secrets.filter(({ key }) => key.codec.kind !== "string")).toEqual([]);
  });
});

describe("config key annotations", () => {
  const known = schemaPaths(CliConfigSchema.ast);
  const rawOnly = new Set(
    [...CLI_CONFIG_DOCUMENT_KEYS, ...CLI_CONFIG_LINKED_KEYS].map((def) => def.path),
  );
  const exists = (path: string) => known.has(path) || rawOnly.has(path);

  it("annotates only paths that exist in the schema or are declared raw-only", () => {
    const annotated: Readonly<Record<string, ReadonlyArray<string>>> = {
      aliases: Object.keys(CLI_CONFIG_ENV_ALIASES),
      codecOverrides: Object.keys(CLI_CONFIG_CODEC_OVERRIDES),
      schemaExcluded: Object.keys(CLI_CONFIG_SCHEMA_EXCLUDED),
      envExcluded: Object.keys(CLI_CONFIG_ENV_EXCLUDED),
      contextDefaults: Object.keys(CLI_CONFIG_CONTEXT_DEFAULTS),
      normalizers: Object.keys(CLI_CONFIG_NORMALIZERS),
      flags: Object.keys(CLI_CONFIG_FLAGS),
      sectionExempt: Object.keys(CLI_CONFIG_SECTION_ENV_EXEMPT),
    };

    const dangling = Object.entries(annotated).flatMap(([table, paths]) =>
      paths.filter((path) => !exists(path)).map((path) => `${table}: ${path}`),
    );

    expect(Object.values(annotated).every((paths) => paths.length > 0)).toBe(true);
    expect(dangling).toEqual([]);
  });

  it("keeps the local db password out of the environment and apart from the linked password", () => {
    const registered = cliConfigRegistry.keyAt("db.password");
    if (registered === undefined) throw new Error("db.password is not in the registry");
    const sources = (shell: Record<string, string>): CliConfigSources => ({
      ...sourcesFor(registered, { winner: "config", sectionPresent: true }),
      flags: () => undefined,
      shell: (name) => shell[name],
      projectEnv: () => undefined,
      config: () => undefined,
    });
    const env = { SUPABASE_DB_PASSWORD: "from-env", SUPABASE_DB_PASSWORD_LOCAL: "x" };

    const local = pickCliConfigKey(CliConfigKeys.db.password, sources(env));
    const linked = pickCliConfigKey(CliConfigKeys.linkedDb.password, sources(env));

    expect(CliConfigKeys.db.password.env).toEqual([]);
    expect(Result.isSuccess(local) && local.success.origin.tier).toBe("default");
    expect(Result.isSuccess(linked) && linked.success).toMatchObject({
      value: Option.some("from-env"),
      origin: { tier: "shell", envName: "SUPABASE_DB_PASSWORD" },
    });
    expect(Object.keys(CLI_CONFIG_ENV_ALIASES)).not.toContain("db.password");
  });

  it("resolves every deprecated alias to the real key that owns it", () => {
    for (const [path, aliases] of Object.entries(CLI_CONFIG_ENV_ALIASES)) {
      const key = cliConfigRegistry.keyAt(path);
      expect(key).toBeDefined();
      for (const alias of aliases) {
        expect(cliConfigRegistry.keyForEnvName(alias)).toBe(key);
      }
    }
  });

  it("names a real key for every declared flag, carrying its names and aliases", () => {
    for (const [path, declaration] of Object.entries(CLI_CONFIG_FLAGS)) {
      const key = cliConfigRegistry.keyAt(path);
      expect(key?.flagNames).toEqual(declaration.names);
      expect(key?.flagAliases).toEqual("aliases" in declaration ? declaration.aliases : []);
    }
  });

  it("allows only keys the registry owns to carry flags", () => {
    const flagged = cliConfigRegistry.keys
      .filter((key) => key.flagNames.length > 0)
      .map((key) => key.path);

    expect(flagged.sort()).toEqual(Object.keys(CLI_CONFIG_FLAGS).sort());
  });
});
