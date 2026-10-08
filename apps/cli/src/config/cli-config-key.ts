import type { CliConfigValueOrigin } from "@supabase/config";
import { ENV_CAPTURE_REGEX } from "@supabase/config/internal";
import { Option, Result, type Path } from "effect";
import type { Flag } from "effect/unstable/cli";

import { parseGoBool } from "../command-internal/config-validate.ts";
import { decryptSecret, isEncryptedSecret } from "../command-internal/vault-decrypt.ts";
import { makeCliConfigKeyFlag, type CliConfigFlagOptions } from "./cli-config-flags.ts";
import { CliConfigValueError } from "./cli-config.errors.ts";

export type CliConfigTier = "flag" | "shell" | "projectEnv" | "config" | "default";

/** Resolution order, highest priority first. Nothing per key can reorder or drop a tier. */
export const CLI_CONFIG_TIER_ORDER: ReadonlyArray<CliConfigTier> = [
  "flag",
  "shell",
  "projectEnv",
  "config",
  "default",
];

export type CliConfigKeyOrigin =
  | { readonly tier: "flag"; readonly flag: string }
  | {
      readonly tier: "shell" | "projectEnv";
      readonly envName: string;
      readonly file?: string;
    }
  | {
      readonly tier: "config";
      readonly origin: CliConfigValueOrigin;
      readonly remote?: string;
    }
  | { readonly tier: "default" };

export interface CliConfigValue<A> {
  readonly value: A;
  readonly origin: CliConfigKeyOrigin;
  /** The decoded value before the key's `normalize`; present only when the key normalizes. */
  readonly unnormalized?: A;
  /** Set when the value came from a deprecated env alias, so the caller can warn. */
  readonly deprecatedEnv?: { readonly used: string; readonly canonical: string };
}

export interface CliConfigKeyContext {
  readonly workdir: string;
  readonly projectRef: Option.Option<string>;
  readonly path: Path.Path;
  /** The merged raw document value at a dotted path. */
  readonly configAt: (path: string) => unknown;
}

interface CliConfigFlagValue {
  readonly flag: string;
  readonly value: unknown;
}

interface CliConfigConfigValue {
  readonly value: unknown;
  readonly origin: CliConfigValueOrigin;
  readonly remote?: string;
}

/** What `load(target)` offers each tier; a tier that is absent here simply cannot win. */
export interface CliConfigSources {
  readonly flags: (path: string) => CliConfigFlagValue | undefined;
  /** `undefined` means unset; an empty string is a set-but-empty variable. */
  readonly shell: (name: string) => string | undefined;
  readonly projectEnv: (
    name: string,
  ) => { readonly value: string; readonly file?: string } | undefined;
  readonly config: (path: string) => CliConfigConfigValue | undefined;
  readonly dotenvPrivateKeys: ReadonlyArray<string>;
  readonly context: CliConfigKeyContext;
}

type CliConfigCodecKind = "bool" | "uint" | "port" | "string" | "commaList" | "literal" | "binary";

export interface CliConfigCodec<X> {
  readonly kind: CliConfigCodecKind;
  readonly literals?: ReadonlyArray<string>;
  /** Decodes an env or flag string; `undefined` means invalid. */
  readonly parse: (raw: string) => X | undefined;
  /** Decodes a typed document or flag value; `undefined` means invalid. */
  readonly fromConfig: (value: unknown) => X | undefined;
  readonly describe: (path: string, raw: string, envName?: string) => string;
}

const UINT_MAX = 18446744073709551615n;
const MAX_PORT = 65535;

/** Go's `strconv.ParseUint(value, 0, 64)` grammar: base prefixes, bare-zero octal, `_` separators. */
function parseGoBaseZeroUint(value: string): bigint | undefined {
  if (value.length === 0 || value.startsWith("+") || value.startsWith("-")) return undefined;

  let literal: string | undefined;
  if (/^0[bB](_?[01])+$/.test(value)) {
    literal = `0b${value.slice(2).replaceAll("_", "")}`;
  } else if (/^0[oO](_?[0-7])+$/.test(value)) {
    literal = `0o${value.slice(2).replaceAll("_", "")}`;
  } else if (/^0[xX](_?[0-9a-fA-F])+$/.test(value)) {
    literal = `0x${value.slice(2).replaceAll("_", "")}`;
  } else if (value.startsWith("0") && value.length > 1) {
    literal = /^[0-7](_?[0-7])*$/.test(value) ? `0o${value.replaceAll("_", "")}` : undefined;
  } else {
    literal = /^[0-9](_?[0-9])*$/.test(value) ? value.replaceAll("_", "") : undefined;
  }
  if (literal === undefined) return undefined;

  try {
    return BigInt(literal);
  } catch {
    return undefined;
  }
}

const parseUintUpTo = (max: bigint) => (raw: string) => {
  const parsed = parseGoBaseZeroUint(raw);
  return parsed === undefined || parsed > max ? undefined : Number(parsed);
};

const integerUpTo = (max: number) => (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : undefined;

const parseStringList = (raw: string): Array<string> => (raw.length === 0 ? [] : raw.split(","));

const quoted = (values: ReadonlyArray<string>) => values.map((value) => `"${value}"`).join(", ");

export const goBoolCodec: CliConfigCodec<boolean> = {
  kind: "bool",
  parse: parseGoBool,
  fromConfig: (value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    return typeof value === "string" ? parseGoBool(value) : undefined;
  },
  describe: (path, raw) => `Invalid config for ${path}: cannot parse "${raw}" as a bool`,
};

export const goUintCodec: CliConfigCodec<number> = {
  kind: "uint",
  parse: parseUintUpTo(UINT_MAX),
  fromConfig: (value) =>
    typeof value === "string"
      ? parseUintUpTo(UINT_MAX)(value)
      : integerUpTo(Number.MAX_SAFE_INTEGER)(value),
  describe: (path, raw) => `Failed reading config: Invalid ${path}: ${raw}.`,
};

export const portCodec: CliConfigCodec<number> = {
  kind: "port",
  parse: parseUintUpTo(BigInt(MAX_PORT)),
  fromConfig: (value) =>
    typeof value === "string"
      ? parseUintUpTo(BigInt(MAX_PORT))(value)
      : integerUpTo(MAX_PORT)(value),
  describe: (path, raw) => `Invalid config for ${path}: cannot parse "${raw}" as a port`,
};

export const stringCodec: CliConfigCodec<string> = {
  kind: "string",
  parse: (raw) => raw,
  fromConfig: (value) => (typeof value === "string" ? value : undefined),
  describe: (path, raw) => `Invalid config for ${path}: cannot parse "${raw}" as a string`,
};

/** Comma-separated list: no trimming, and an empty string is the empty list. */
export const commaListCodec: CliConfigCodec<ReadonlyArray<string>> = {
  kind: "commaList",
  parse: parseStringList,
  fromConfig: (value) => {
    if (typeof value === "string") return parseStringList(value);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value.map((item) => String(item));
    }
    return undefined;
  },
  describe: (path, raw) => `Invalid config for ${path}: cannot parse "${raw}" as a list`,
};

export const literalCodec = <const T extends string>(
  values: ReadonlyArray<T>,
): CliConfigCodec<T> => {
  const find = (candidate: unknown): T | undefined =>
    typeof candidate === "string" ? values.find((value) => value === candidate) : undefined;
  return {
    kind: "literal",
    literals: values,
    parse: find,
    fromConfig: find,
    describe: (path, raw) =>
      `Invalid config for ${path}: cannot parse "${raw}" as one of ${quoted(values)}`,
  };
};

/** Strict `0`/`1`, as the experimental feature opt-ins accept. */
export const binaryCodec: CliConfigCodec<boolean> = {
  kind: "binary",
  parse: (raw) => (raw === "1" ? true : raw === "0" ? false : undefined),
  fromConfig: (value) => {
    if (typeof value === "boolean") return value;
    return typeof value === "string" ? binaryCodec.parse(value) : undefined;
  },
  describe: (_path, _raw, envName) => `${envName ?? "value"} must be 0 or 1 when set`,
};

export interface CliConfigKeySpec<X> {
  readonly path: string;
  /** `[0]` is the canonical name; the rest are deprecated aliases. Empty means not env-overridable. */
  readonly env?: ReadonlyArray<string>;
  readonly codec: CliConfigCodec<X>;
  readonly secret?: true;
  readonly normalize?: (value: X, ctx: CliConfigKeyContext) => X;
  /** Env tiers apply only while this dotted section is present in the merged document. */
  readonly envRequiresSection?: string;
  /** Marks a credential for the linked target; the loader may withhold its env sources. */
  readonly envScope?: "linkedTarget";
  /** `false` when the key has no document path, so the config tier never applies. */
  readonly document?: false;
  /** The default depends on the loaded document or target, so `materialize` writes it in. */
  readonly contextDefault?: true;
}

/**
 * A config value descriptor: `A` is the value consumers read, `X` the decoded leaf (they differ
 * only for optional keys, where `A` is `Option<X>`).
 */
export interface CliConfigKey<A, X = A> {
  readonly path: string;
  readonly env: ReadonlyArray<string>;
  readonly codec: CliConfigCodec<X>;
  /** The default-tier value; a context-dependent default reads the merged document. */
  readonly defaultValue: (ctx: CliConfigKeyContext) => A;
  readonly wrap: (value: X) => A;
  readonly toDocument: (value: A) => unknown;
  readonly secret?: true;
  readonly normalize?: (value: X, ctx: CliConfigKeyContext) => X;
  readonly envRequiresSection?: string;
  readonly envScope?: "linkedTarget";
  readonly document?: false;
  readonly contextDefault?: true;
  readonly flag: (options: CliConfigFlagOptions<X>) => Flag.Flag<Option.Option<X>>;
}

/** The primitive behind the typed key factories; the registry uses it to build type-erased keys. */
export const makeCliConfigKey = <A, X>(
  spec: CliConfigKeySpec<X>,
  shape: Pick<CliConfigKey<A, X>, "defaultValue" | "wrap" | "toDocument">,
): CliConfigKey<A, X> => {
  const key: CliConfigKey<A, X> = {
    path: spec.path,
    env: spec.env ?? [],
    codec: spec.codec,
    ...shape,
    ...(spec.secret === undefined ? {} : { secret: spec.secret }),
    ...(spec.normalize === undefined ? {} : { normalize: spec.normalize }),
    ...(spec.envRequiresSection === undefined
      ? {}
      : { envRequiresSection: spec.envRequiresSection }),
    ...(spec.envScope === undefined ? {} : { envScope: spec.envScope }),
    ...(spec.document === undefined ? {} : { document: spec.document }),
    ...(spec.contextDefault === undefined ? {} : { contextDefault: spec.contextDefault }),
    flag: (options) => makeCliConfigKeyFlag(key, options),
  };
  return key;
};

/** A key with a value in every resolution: its default stands in when no tier supplies one. */
export const requiredCliConfigKey = <X>(
  spec: CliConfigKeySpec<X> &
    (
      | { readonly default: X; readonly defaultFrom?: undefined }
      | { readonly default?: undefined; readonly defaultFrom: (ctx: CliConfigKeyContext) => X }
    ),
): CliConfigKey<X> => {
  const { default: fixed, defaultFrom } = spec;
  return makeCliConfigKey<X, X>(spec, {
    defaultValue: defaultFrom ?? (() => fixed),
    wrap: (value) => value,
    toDocument: (value) => value,
  });
};

/** A key that may be absent; consumers read `Option<X>`. */
export const optionalCliConfigKey = <X>(
  spec: CliConfigKeySpec<X> & {
    readonly defaultFrom?: (ctx: CliConfigKeyContext) => Option.Option<X>;
  },
): CliConfigKey<Option.Option<X>, X> =>
  makeCliConfigKey<Option.Option<X>, X>(spec, {
    defaultValue: spec.defaultFrom ?? (() => Option.none()),
    wrap: Option.some,
    toDocument: Option.getOrUndefined,
  });

/** An env-name-only read: shell-only, no config path and no tier list. */
export interface CliEnvName<X> {
  readonly name: string;
  readonly codec: CliConfigCodec<X>;
  /** The config key whose canonical env name this read shares, if any. */
  readonly configKeyPath?: string;
}

export const cliEnvName = <X>(entry: CliEnvName<X>): CliEnvName<X> => entry;

/** The non-empty value of an env name, shell before project `.env*`; a set-but-empty shell name shadows the file. */
export const lookupCliConfigEnv = (
  sources: Pick<CliConfigSources, "shell" | "projectEnv">,
  name: string,
): string | undefined => {
  const shell = sources.shell(name);
  if (shell !== undefined) return shell === "" ? undefined : shell;
  const file = sources.projectEnv(name)?.value;
  return file === undefined || file === "" ? undefined : file;
};

/** Replaces an `env(NAME)` string with the named variable when it resolves to a non-empty value. */
export const expandCliConfigEnvReference = (
  value: string,
  lookup: (name: string) => string | undefined,
): string => {
  const name = ENV_CAPTURE_REGEX.exec(value)?.[1];
  return name === undefined ? value : (lookup(name) ?? value);
};

const expandConfigValue = (
  value: unknown,
  lookup: (name: string) => string | undefined,
): unknown => {
  if (typeof value === "string") return expandCliConfigEnvReference(value, lookup);
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "string" ? expandCliConfigEnvReference(item, lookup) : item,
    );
  }
  return value;
};

const display = (value: unknown, secret: boolean): string => {
  if (secret) return "<redacted>";
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
};

/**
 * The single precedence implementation: flag > shell > projectEnv > config > default. Pure; the
 * caller decides which sources exist and emits any deprecated-alias warning.
 */
export const pickCliConfigKey = <A, X>(
  key: CliConfigKey<A, X>,
  sources: CliConfigSources,
): Result.Result<CliConfigValue<A>, CliConfigValueError> => {
  const lookup = (name: string) => lookupCliConfigEnv(sources, name);
  const secret = key.secret === true;

  const failure = (tier: CliConfigTier, raw: unknown, envName?: string) =>
    Result.fail(
      new CliConfigValueError({
        path: key.path,
        tier,
        message: key.codec.describe(key.path, display(raw, secret), envName),
        ...(envName === undefined ? {} : { envName }),
      }),
    );

  const decrypt = (
    tier: CliConfigTier,
    raw: unknown,
  ): Result.Result<unknown, CliConfigValueError> => {
    if (!secret || typeof raw !== "string" || !isEncryptedSecret(raw)) return Result.succeed(raw);
    const decrypted = decryptSecret(raw, sources.dotenvPrivateKeys);
    return decrypted.ok
      ? Result.succeed(decrypted.value)
      : Result.fail(
          new CliConfigValueError({
            path: key.path,
            tier,
            message: `failed to parse config: ${decrypted.error}`,
          }),
        );
  };

  const settle = (
    decoded: X,
    origin: CliConfigKeyOrigin,
    deprecatedEnv?: CliConfigValue<A>["deprecatedEnv"],
  ): CliConfigValue<A> => {
    const normalized =
      key.normalize === undefined ? decoded : key.normalize(decoded, sources.context);
    return {
      value: key.wrap(normalized),
      origin,
      ...(key.normalize === undefined ? {} : { unnormalized: key.wrap(decoded) }),
      ...(deprecatedEnv === undefined ? {} : { deprecatedEnv }),
    };
  };

  const readEnv = (tier: "shell" | "projectEnv", name: string) => {
    const shell = sources.shell(name);
    if (tier === "shell") return shell === undefined ? undefined : { value: shell };
    return shell === undefined ? sources.projectEnv(name) : undefined;
  };

  const flag = sources.flags(key.path);
  if (flag !== undefined) {
    const decoded = key.codec.fromConfig(flag.value);
    if (decoded === undefined) return failure("flag", flag.value);
    return Result.succeed(settle(decoded, { tier: "flag", flag: flag.flag }));
  }

  const envAllowed =
    key.envRequiresSection === undefined || sources.config(key.envRequiresSection) !== undefined;
  if (envAllowed) {
    for (const tier of ["shell", "projectEnv"] as const) {
      for (const name of key.env) {
        const found = readEnv(tier, name);
        if (found === undefined || found.value === "") continue;

        const raw = expandCliConfigEnvReference(found.value, lookup);
        const plain = decrypt(tier, raw);
        if (Result.isFailure(plain)) return Result.fail(plain.failure);
        const decoded = key.codec.parse(typeof plain.success === "string" ? plain.success : raw);
        if (decoded === undefined) return failure(tier, raw, name);

        const file = "file" in found ? found.file : undefined;
        const canonical = key.env[0];
        return Result.succeed(
          settle(
            decoded,
            file === undefined ? { tier, envName: name } : { tier, envName: name, file },
            canonical !== undefined && name !== canonical ? { used: name, canonical } : undefined,
          ),
        );
      }
    }
  }

  const configured = key.document === false ? undefined : sources.config(key.path);
  if (configured !== undefined) {
    const plain = decrypt("config", expandConfigValue(configured.value, lookup));
    if (Result.isFailure(plain)) return Result.fail(plain.failure);
    const decoded = key.codec.fromConfig(plain.success);
    if (decoded === undefined) return failure("config", plain.success);
    return Result.succeed(
      settle(decoded, {
        tier: "config",
        origin: configured.origin,
        ...(configured.remote === undefined ? {} : { remote: configured.remote }),
      }),
    );
  }

  return Result.succeed({ value: key.defaultValue(sources.context), origin: { tier: "default" } });
};

/** Reads an env-name-only entry from the shell; an empty value counts as unset. */
export const pickCliEnvName = <X>(
  entry: CliEnvName<X>,
  sources: Pick<CliConfigSources, "shell">,
): Result.Result<Option.Option<X>, CliConfigValueError> => {
  const raw = sources.shell(entry.name);
  if (raw === undefined || raw === "") return Result.succeed(Option.none());
  const decoded = entry.codec.parse(raw);
  return decoded === undefined
    ? Result.fail(
        new CliConfigValueError({
          path: entry.configKeyPath ?? entry.name,
          tier: "shell",
          message: entry.codec.describe(entry.configKeyPath ?? entry.name, raw, entry.name),
          envName: entry.name,
        }),
      )
    : Result.succeed(Option.some(decoded));
};
