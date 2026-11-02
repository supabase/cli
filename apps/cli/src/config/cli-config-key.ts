import type { CliConfigValueOrigin } from "@supabase/config";
import { ENV_CAPTURE_REGEX } from "@supabase/config/internal";
import { Option, Result, Schema, type Path } from "effect";
import type { Flag } from "effect/cli";

import { decryptSecret, isEncryptedSecret } from "../shared/config/vault-decrypt.ts";
import {
  boolSchemas,
  commaListSchemas,
  globEntries,
  globListSchemas,
  literalSchemas,
  portSchemas,
  stringSchemas,
  uintSchemas,
  unsupportedTypeName,
  type CliConfigCodecSchemas,
} from "./cli-config-codec-schemas.ts";
import {
  makeCliConfigKeyFlag,
  type CliConfigFlagDeclaration,
  type CliConfigFlagOptions,
  type CliConfigNoFlags,
} from "./cli-config-flags.ts";
import { CliConfigValueError } from "./cli-config.errors.ts";

export type CliConfigTier = "flag" | "shell" | "projectEnv" | "config" | "default";

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
      readonly file?: string;
    }
  | { readonly tier: "default" };

export interface CliConfigValue<A> {
  readonly value: A;
  readonly origin: CliConfigKeyOrigin;
  /** The decoded value before the key's `normalize`; present only when the key normalizes. */
  readonly unnormalized?: A;
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
  /** The absolute path of the config file the value was read from. */
  readonly file?: string;
}

/** What `load(target)` offers each tier; a tier that is absent here simply cannot win. */
export interface CliConfigSources {
  readonly flags: (path: string) => CliConfigFlagValue | undefined;
  /** `undefined` means unset; an empty string is a set-but-empty variable. */
  readonly shell: (name: string) => string | undefined;
  readonly projectEnv: (
    name: string,
  ) => { readonly value: string; readonly file?: string } | undefined;
  readonly config: (segments: ReadonlyArray<string>) => CliConfigConfigValue | undefined;
  readonly dotenvPrivateKeys: ReadonlyArray<string>;
  readonly context: CliConfigKeyContext;
}

type CliConfigCodecKind = "bool" | "uint" | "port" | "string" | "commaList" | "literal";

export interface CliConfigCodec<X> {
  readonly kind: CliConfigCodecKind;
  readonly literals?: ReadonlyArray<string>;
  /** Decodes an env or flag string; `undefined` means invalid. */
  readonly parse: (raw: string) => X | undefined;
  /** Decodes a typed document or flag value; `undefined` means invalid. */
  readonly fromConfig: (value: unknown) => X | undefined;
  /** What a valid value is, completing "expected …" and "… is not …" in error messages. */
  readonly expected: string;
  /** Per-entry failures of an invalid document value, reported together across keys. */
  readonly issues?: (path: string, value: unknown) => ReadonlyArray<string>;
}

export const decodingFailedMessage = (issues: ReadonlyArray<string>): string =>
  `failed to parse config:\n${issues.join("\n")}`;

const quoted = (values: ReadonlyArray<string>) => values.map((value) => `"${value}"`).join(", ");

const codecFromSchemas = <X>(spec: {
  readonly kind: CliConfigCodecKind;
  readonly expected: string;
  readonly schemas: CliConfigCodecSchemas<X>;
  readonly literals?: ReadonlyArray<string>;
  readonly issues?: CliConfigCodec<X>["issues"];
}): CliConfigCodec<X> => {
  const decodeString = Schema.decodeUnknownOption(spec.schemas.fromString);
  const decodeDocument = Schema.decodeUnknownOption(spec.schemas.fromDocument);
  return {
    kind: spec.kind,
    ...(spec.literals === undefined ? {} : { literals: spec.literals }),
    parse: (raw) => Option.getOrUndefined(decodeString(raw)),
    fromConfig: (value) => Option.getOrUndefined(decodeDocument(value)),
    expected: spec.expected,
    ...(spec.issues === undefined ? {} : { issues: spec.issues }),
  };
};

export const boolCodec = codecFromSchemas({
  kind: "bool",
  expected: "true or false",
  schemas: boolSchemas,
});

export const uintCodec = codecFromSchemas({
  kind: "uint",
  expected: "a non-negative integer",
  schemas: uintSchemas,
});

export const portCodec = codecFromSchemas({
  kind: "port",
  expected: "a port (0-65535)",
  schemas: portSchemas,
});

export const stringCodec = codecFromSchemas({
  kind: "string",
  expected: "a string",
  schemas: stringSchemas,
});

/** Comma-separated list: no trimming, and an empty string is the empty list. */
export const commaListCodec = codecFromSchemas({
  kind: "commaList",
  expected: "a comma-separated list",
  schemas: commaListSchemas,
});

/**
 * A glob list that decodes weakly: a bare string is comma-split, a scalar or an array entry that
 * is a number or bool becomes its text, and an empty table is the empty list. Nested lists, tables
 * and datetimes are invalid.
 */
export const globListCodec = codecFromSchemas({
  kind: "commaList",
  expected: "a comma-separated list",
  schemas: globListSchemas,
  issues: (path, value) =>
    (globEntries(value) ?? []).flatMap((entry, index) => {
      const type = unsupportedTypeName(entry);
      return type === undefined ? [] : [`${path}[${index}]: expected a string, got ${type}`];
    }),
});

export const literalCodec = <const T extends string>(values: ReadonlyArray<T>): CliConfigCodec<T> =>
  codecFromSchemas({
    kind: "literal",
    literals: values,
    expected: `one of ${quoted(values)}`,
    schemas: literalSchemas(values),
  });

export interface CliConfigKeySpec<X, F extends CliConfigFlagDeclaration = CliConfigNoFlags> {
  readonly path: string;
  /** The document path as segments when a segment may itself contain `.`; defaults to `path` split on `.`. */
  readonly segments?: ReadonlyArray<string>;
  /** `[0]` is the canonical name; the rest are deprecated aliases. Empty means not env-overridable. */
  readonly env?: ReadonlyArray<string>;
  readonly codec: CliConfigCodec<X>;
  readonly secret?: true;
  readonly normalize?: (value: X, ctx: CliConfigKeyContext) => X;
  /** Env tiers apply only while this section (as path segments) is present in the merged document. */
  readonly envRequiresSection?: ReadonlyArray<string>;
  /** Marks a credential for the linked target; the loader may withhold its env sources. */
  readonly envScope?: "linkedTarget";
  /** `false` when the key has no document path, so the config tier never applies. */
  readonly document?: false;
  /** `materialize` writes the default into the decoded config when no tier supplies a value. */
  readonly materializeDefault?: true;
  /** The flag names and aliases that may override this key. */
  readonly flags?: F;
}

/**
 * A config value descriptor: `A` is the value consumers read, `X` the decoded leaf (they differ
 * only for optional keys, where `A` is `Option<X>`), and `F` the flag names it declares.
 */
export interface CliConfigKey<A, X = A, F extends CliConfigFlagDeclaration = CliConfigNoFlags> {
  readonly path: string;
  /** The document path; a dynamic table name stays one segment even if it contains `.`. */
  readonly segments: ReadonlyArray<string>;
  readonly env: ReadonlyArray<string>;
  readonly codec: CliConfigCodec<X>;
  /** The default-tier value; a context-dependent default reads the merged document. */
  readonly defaultValue: (ctx: CliConfigKeyContext) => A;
  readonly wrap: (value: X) => A;
  readonly toDocument: (value: A) => unknown;
  readonly secret?: true;
  readonly normalize?: (value: X, ctx: CliConfigKeyContext) => X;
  readonly envRequiresSection?: ReadonlyArray<string>;
  readonly envScope?: "linkedTarget";
  readonly document?: false;
  readonly materializeDefault?: true;
  readonly flagNames: ReadonlyArray<string>;
  readonly flagAliases: ReadonlyArray<string>;
  readonly flag: (options: CliConfigFlagOptions<X, F>) => Flag.Flag<Option.Option<X>>;
}

/** The primitive behind the typed key factories; the registry uses it to build type-erased keys. */
export const makeCliConfigKey = <A, X, F extends CliConfigFlagDeclaration = CliConfigNoFlags>(
  spec: CliConfigKeySpec<X, F>,
  shape: Pick<CliConfigKey<A, X, F>, "defaultValue" | "wrap" | "toDocument">,
): CliConfigKey<A, X, F> => {
  const key: CliConfigKey<A, X, F> = {
    path: spec.path,
    segments: spec.segments ?? spec.path.split("."),
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
    ...(spec.materializeDefault === undefined
      ? {}
      : { materializeDefault: spec.materializeDefault }),
    flagNames: spec.flags?.names ?? [],
    flagAliases: spec.flags?.aliases ?? [],
    flag: (options) => makeCliConfigKeyFlag(key, options),
  };
  return key;
};

/** A key with a value in every resolution: its default stands in when no tier supplies one. */
export const requiredCliConfigKey = <
  X,
  const F extends CliConfigFlagDeclaration = CliConfigNoFlags,
>(
  spec: CliConfigKeySpec<X, F> &
    (
      | { readonly default: X; readonly defaultFrom?: undefined }
      | { readonly default?: undefined; readonly defaultFrom: (ctx: CliConfigKeyContext) => X }
    ),
): CliConfigKey<X, X, F> => {
  const { default: fixed, defaultFrom } = spec;
  return makeCliConfigKey<X, X, F>(spec, {
    defaultValue: defaultFrom ?? (() => fixed),
    wrap: (value) => value,
    toDocument: (value) => value,
  });
};

/** A key that may be absent; consumers read `Option<X>`. */
export const optionalCliConfigKey = <
  X,
  const F extends CliConfigFlagDeclaration = CliConfigNoFlags,
>(
  spec: CliConfigKeySpec<X, F> & {
    readonly defaultFrom?: (ctx: CliConfigKeyContext) => Option.Option<X>;
  },
): CliConfigKey<Option.Option<X>, X, F> =>
  makeCliConfigKey<Option.Option<X>, X, F>(spec, {
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

interface RedactionSubject {
  readonly secret?: true;
  readonly codec: { readonly kind: CliConfigCodecKind };
}

const describeTomlType = (value: unknown): string => {
  if (typeof value === "number" || typeof value === "bigint") return "a number";
  if (typeof value === "boolean") return "a boolean";
  if (Array.isArray(value)) return "an array";
  if (value instanceof Date) return "a date-time";
  return typeof value === "object" && value !== null ? "a table" : typeof value;
};

/** A string codec's parse is the identity, so it fails only on type and the value is never echoed. */
const isTypeOnlyFailure = (key: RedactionSubject): boolean =>
  key.codec.kind === "string" && key.secret !== true;

const display = (value: unknown, key: RedactionSubject): string => {
  if (key.secret === true) return "<redacted>";
  if (isTypeOnlyFailure(key)) return describeTomlType(value);
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
};

const displayFile = (ctx: Pick<CliConfigKeyContext, "workdir" | "path">, file: string): string =>
  ctx.path.relative(ctx.workdir, file) || file;

/** Where a value came from, in the words error and warning messages use. */
export const describeCliConfigOrigin = (
  origin: CliConfigKeyOrigin,
  ctx: Pick<CliConfigKeyContext, "workdir" | "path">,
): string => {
  switch (origin.tier) {
    case "flag":
      return `--${origin.flag}`;
    case "shell":
      return `${origin.envName} (shell)`;
    case "projectEnv":
      return origin.file === undefined
        ? `${origin.envName} (project env file)`
        : `${origin.envName} (${displayFile(ctx, origin.file)})`;
    case "config": {
      const file = origin.file === undefined ? undefined : displayFile(ctx, origin.file);
      if (origin.remote === undefined) return file ?? "config";
      return file === undefined
        ? `[remotes.${origin.remote}]`
        : `[remotes.${origin.remote}] (${file})`;
    }
    case "default":
      return "default";
  }
};

/** Where an env name's value was set, for `set in …` messages: the shell, or the project env file relative to the workdir. */
export const describeCliConfigEnvLocation = (
  sources: Pick<CliConfigSources, "shell" | "projectEnv">,
  ctx: Pick<CliConfigKeyContext, "workdir" | "path">,
  name: string,
): string => {
  if (sources.shell(name) !== undefined) return "the shell environment";
  const file = sources.projectEnv(name)?.file;
  return file === undefined ? "the project env file" : displayFile(ctx, file);
};

interface CliConfigValueFailure {
  readonly path: string;
  readonly raw: string;
  readonly expected: string;
  readonly origin: Exclude<CliConfigKeyOrigin, { readonly tier: "default" }>;
  /** `raw` names the value's type rather than quoting it. */
  readonly typeOnly?: true;
}

/** The error for a value a codec rejected; the message names the source that supplied it. */
const invalidCliConfigValue = (
  failure: CliConfigValueFailure,
  ctx: Pick<CliConfigKeyContext, "workdir" | "path">,
): CliConfigValueError => {
  const { path, raw, expected, origin, typeOnly } = failure;
  const source = describeCliConfigOrigin(origin, ctx);
  switch (origin.tier) {
    case "flag":
      return new CliConfigValueError({
        path,
        tier: "flag",
        source,
        flag: origin.flag,
        message: `Invalid --${origin.flag}="${raw}" (sets ${path}): expected ${expected}.`,
      });
    case "shell":
    case "projectEnv": {
      const file =
        origin.tier === "projectEnv" && origin.file !== undefined
          ? ` in ${displayFile(ctx, origin.file)}`
          : "";
      return new CliConfigValueError({
        path,
        tier: origin.tier,
        source,
        envName: origin.envName,
        message: `Invalid ${origin.envName}="${raw}"${file} (sets ${path}): expected ${expected}.`,
      });
    }
    case "config": {
      const where = describeCliConfigOrigin(origin, ctx);
      return new CliConfigValueError({
        path,
        tier: "config",
        source,
        message: typeOnly
          ? `Invalid ${path}${where === "config" ? "" : ` in ${where}`}: expected ${expected}, got ${raw}.`
          : where === "config"
            ? `Invalid ${path}: "${raw}" is not ${expected}.`
            : `Invalid ${path} in ${where}: "${raw}" is not ${expected}.`,
      });
    }
  }
};

/**
 * The single precedence implementation: flag > shell > projectEnv > config > default. Pure; the
 * caller decides which sources exist. `configOnly` skips the flag and env tiers.
 */
export const pickCliConfigKey = <A, X, F extends CliConfigFlagDeclaration = CliConfigNoFlags>(
  key: CliConfigKey<A, X, F>,
  sources: CliConfigSources,
  options: { readonly configOnly?: true } = {},
): Result.Result<CliConfigValue<A>, CliConfigValueError> => {
  const lookup = (name: string) => lookupCliConfigEnv(sources, name);
  const secret = key.secret === true;
  const typeOnly = isTypeOnlyFailure(key);

  const failure = (
    origin: Exclude<CliConfigKeyOrigin, { readonly tier: "default" }>,
    raw: unknown,
  ) =>
    Result.fail(
      invalidCliConfigValue(
        {
          path: key.path,
          raw: display(raw, key),
          expected: key.codec.expected,
          origin,
          ...(typeOnly ? { typeOnly } : {}),
        },
        sources.context,
      ),
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

  const settle = (decoded: X, origin: CliConfigKeyOrigin): CliConfigValue<A> => {
    const normalized =
      key.normalize === undefined ? decoded : key.normalize(decoded, sources.context);
    return {
      value: key.wrap(normalized),
      origin,
      ...(key.normalize === undefined ? {} : { unnormalized: key.wrap(decoded) }),
    };
  };

  const readEnv = (tier: "shell" | "projectEnv", name: string) => {
    const shell = sources.shell(name);
    if (tier === "shell") return shell === undefined ? undefined : { value: shell };
    return shell === undefined ? sources.projectEnv(name) : undefined;
  };

  const flag = options.configOnly === true ? undefined : sources.flags(key.path);
  if (flag !== undefined) {
    const origin = { tier: "flag", flag: flag.flag } as const;
    const decoded = key.codec.fromConfig(flag.value);
    if (decoded === undefined) return failure(origin, flag.value);
    return Result.succeed(settle(decoded, origin));
  }

  const envAllowed =
    key.envRequiresSection === undefined || sources.config(key.envRequiresSection) !== undefined;
  if (envAllowed && options.configOnly !== true) {
    for (const tier of ["shell", "projectEnv"] as const) {
      for (const name of key.env) {
        const found = readEnv(tier, name);
        if (found === undefined || found.value === "") continue;

        const file = "file" in found ? found.file : undefined;
        const origin: CliConfigKeyOrigin =
          file === undefined ? { tier, envName: name } : { tier, envName: name, file };
        const raw = expandCliConfigEnvReference(found.value, lookup);
        const plain = decrypt(tier, raw);
        if (Result.isFailure(plain)) return Result.fail(plain.failure);
        const decoded = key.codec.parse(typeof plain.success === "string" ? plain.success : raw);
        if (decoded === undefined) return failure(origin, raw);
        return Result.succeed(settle(decoded, origin));
      }
    }
  }

  const configured = key.document === false ? undefined : sources.config(key.segments);
  if (configured !== undefined) {
    const origin: CliConfigKeyOrigin = {
      tier: "config",
      origin: configured.origin,
      ...(configured.remote === undefined ? {} : { remote: configured.remote }),
      ...(configured.file === undefined ? {} : { file: configured.file }),
    };
    const plain = decrypt("config", expandConfigValue(configured.value, lookup));
    if (Result.isFailure(plain)) return Result.fail(plain.failure);
    const decoded = key.codec.fromConfig(plain.success);
    if (decoded === undefined) {
      const issues = key.codec.issues?.(key.path, plain.success) ?? [];
      return issues.length === 0
        ? failure(origin, plain.success)
        : Result.fail(
            new CliConfigValueError({
              path: key.path,
              tier: "config",
              source: describeCliConfigOrigin(origin, sources.context),
              message: decodingFailedMessage(issues),
              issues,
            }),
          );
    }
    return Result.succeed(settle(decoded, origin));
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
  const path = entry.configKeyPath ?? entry.name;
  return decoded === undefined
    ? Result.fail(
        new CliConfigValueError({
          path,
          tier: "shell",
          source: `${entry.name} (shell)`,
          message: `Invalid ${entry.name}="${raw}" (sets ${path}): expected ${entry.codec.expected}.`,
          envName: entry.name,
        }),
      )
    : Result.succeed(Option.some(decoded));
};
