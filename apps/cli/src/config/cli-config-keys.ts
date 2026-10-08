import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { Option, type SchemaAST } from "effect";

import {
  CLI_CONFIG_CODEC_OVERRIDES,
  CLI_CONFIG_CONTEXT_DEFAULTS,
  CLI_CONFIG_DOCUMENT_KEYS,
  CLI_CONFIG_ENV_ALIASES,
  CLI_CONFIG_ENV_EXCLUDED,
  CLI_CONFIG_FAMILIES,
  CLI_CONFIG_LINKED_KEYS,
  CLI_CONFIG_NORMALIZERS,
  envRequiresSectionFor,
  type CliConfigFamilyDef,
  type CliConfigKeyDef,
} from "./cli-config-key-annotations.ts";
import {
  cliEnvName,
  commaListCodec,
  goBoolCodec,
  goUintCodec,
  literalCodec,
  makeCliConfigKey,
  portCodec,
  stringCodec,
  type CliConfigKey,
  type CliEnvName,
} from "./cli-config-key.ts";

/** A key with its value types erased, as the registry stores every key. */
export type AnyCliConfigKey = CliConfigKey<unknown, unknown>;

/** `SUPABASE_` + UPPER_SNAKE(path): the env name every key derives unless it is annotated. */
export const deriveCliConfigEnvName = (path: string): string =>
  `SUPABASE_${path
    .split(".")
    .map((segment) => segment.toUpperCase())
    .join("_")}`;

interface SchemaLeaf {
  readonly segments: ReadonlyArray<string>;
  readonly node: SchemaAST.AST;
  readonly optional: boolean;
}

const unwrap = (ast: SchemaAST.AST): SchemaAST.AST =>
  ast._tag === "Suspend" ? unwrap(ast.thunk()) : ast;

const collectSchemaLeaves = (
  ast: SchemaAST.AST,
  segments: ReadonlyArray<string>,
  out: Array<SchemaLeaf>,
): void => {
  const node = unwrap(ast);
  if (node._tag === "Objects") {
    for (const property of node.propertySignatures) {
      if (typeof property.name === "string") {
        collectSchemaLeaves(property.type, [...segments, property.name], out);
      }
    }
    return;
  }
  out.push({ segments, node, optional: node.context?.isOptional === true });
};

const codecForLeaf = (segments: ReadonlyArray<string>, node: SchemaAST.AST) => {
  switch (node._tag) {
    case "Boolean":
      return goBoolCodec;
    case "Number": {
      const last = segments[segments.length - 1] ?? "";
      return last === "port" || last.endsWith("_port") ? portCodec : goUintCodec;
    }
    case "String":
      return stringCodec;
    case "Arrays": {
      const [item] = node.rest;
      return node.elements.length === 0 &&
        node.rest.length === 1 &&
        item !== undefined &&
        unwrap(item)._tag === "String"
        ? commaListCodec
        : undefined;
    }
    case "Union": {
      const values: Array<string> = [];
      for (const member of node.types) {
        if (member._tag !== "Literal" || typeof member.literal !== "string") return undefined;
        values.push(member.literal);
      }
      return literalCodec(values);
    }
    default:
      return undefined;
  }
};

const buildKey = (def: CliConfigKeyDef): AnyCliConfigKey => {
  const canonical = def.env?.[0] ?? deriveCliConfigEnvName(def.path);
  const aliases = CLI_CONFIG_ENV_ALIASES[def.path] ?? [];
  const env = def.noEnv === true ? [] : (def.env ?? [canonical, ...aliases]);
  const section = envRequiresSectionFor(def.path);
  const normalize = CLI_CONFIG_NORMALIZERS[def.path];
  const optional = def.optional === true && def.defaultFrom === undefined;
  return makeCliConfigKey<unknown, unknown>(
    {
      path: def.path,
      env,
      codec: CLI_CONFIG_CODEC_OVERRIDES[def.path] ?? def.codec,
      ...(def.secret === undefined ? {} : { secret: def.secret }),
      ...(normalize === undefined ? {} : { normalize }),
      ...(section === undefined ? {} : { envRequiresSection: section }),
      ...(def.envScope === undefined ? {} : { envScope: def.envScope }),
      ...(def.document === undefined ? {} : { document: def.document }),
      ...(def.defaultFrom === undefined ? {} : { contextDefault: true as const }),
    },
    optional
      ? {
          defaultValue: () => Option.none(),
          wrap: (value) => Option.some(value),
          toDocument: (value) => (Option.isOption(value) ? Option.getOrUndefined(value) : value),
        }
      : {
          defaultValue: def.defaultFrom ?? (() => def.default),
          wrap: (value) => value,
          toDocument: (value) => value,
        },
  );
};

const schemaKeyDefs = (): ReadonlyArray<CliConfigKeyDef> => {
  const leaves: Array<SchemaLeaf> = [];
  for (const property of CliConfigSchema.ast.propertySignatures) {
    if (typeof property.name === "string" && property.name !== "remotes") {
      collectSchemaLeaves(property.type, [property.name], leaves);
    }
  }
  return leaves.flatMap((leaf): ReadonlyArray<CliConfigKeyDef> => {
    const path = leaf.segments.join(".");
    const codec = CLI_CONFIG_CODEC_OVERRIDES[path] ?? codecForLeaf(leaf.segments, leaf.node);
    if (codec === undefined) return [];
    const defaultFrom = CLI_CONFIG_CONTEXT_DEFAULTS[path];
    const configured = leaf.node.annotations?.["default"];
    return [
      {
        path,
        codec,
        ...(leaf.optional && defaultFrom === undefined
          ? { optional: true as const }
          : defaultFrom === undefined
            ? { default: configured }
            : { defaultFrom }),
        ...(leaf.node.annotations?.["x-secret"] === true ? { secret: true as const } : {}),
        ...(CLI_CONFIG_ENV_EXCLUDED[path] === undefined ? {} : { noEnv: true as const }),
      },
    ];
  });
};

const registryKeys: ReadonlyArray<AnyCliConfigKey> = [
  ...schemaKeyDefs(),
  ...CLI_CONFIG_DOCUMENT_KEYS,
  ...CLI_CONFIG_LINKED_KEYS,
].map(buildKey);

const keysByPath: ReadonlyMap<string, AnyCliConfigKey> = new Map(
  registryKeys.map((key) => [key.path, key]),
);

const keysByEnvName: ReadonlyMap<string, AnyCliConfigKey> = new Map(
  registryKeys.flatMap((key) => key.env.map((name): [string, AnyCliConfigKey] => [name, key])),
);

export const cliConfigRegistry = {
  keys: registryKeys,
  keyAt: (path: string): AnyCliConfigKey | undefined => keysByPath.get(path),
  keyForEnvName: (name: string): AnyCliConfigKey | undefined => keysByEnvName.get(name),
  families: CLI_CONFIG_FAMILIES,
} as const;

const familyKeys = new Map<string, AnyCliConfigKey>();

/** The key for one field of a named entry in an arbitrarily-keyed table, e.g. `auth.external.github.secret`. */
export const cliConfigFamilyKey = (
  family: CliConfigFamilyDef,
  name: string,
  field: string,
): AnyCliConfigKey | undefined => {
  const spec = family.fields.find((candidate) => candidate.name === field);
  if (spec === undefined) return undefined;
  const path = `${family.prefix}.${name}.${field}`;
  const cached = familyKeys.get(path);
  if (cached !== undefined) return cached;
  const key = buildKey({
    path,
    codec: spec.codec,
    env: [`${deriveCliConfigEnvName(`${family.prefix}.${name}`)}_${field.toUpperCase()}`],
    ...(spec.optional === undefined ? { default: spec.default } : { optional: true }),
    ...(spec.secret === undefined ? {} : { secret: spec.secret }),
  });
  familyKeys.set(path, key);
  return key;
};

type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

type LeafKey<V, Optional extends boolean> = Optional extends true
  ? CliConfigKey<Option.Option<NonNullable<V>>, NonNullable<V>>
  : CliConfigKey<V>;

type TreeNode<V, Optional extends boolean> =
  NonNullable<V> extends ReadonlyArray<unknown>
    ? LeafKey<V, Optional>
    : NonNullable<V> extends object
      ? string extends keyof NonNullable<V>
        ? never
        : CliConfigKeyTree<NonNullable<V>>
      : LeafKey<V, Optional>;

/** The registry's nested accessor type, derived from the `CliConfig` document type. */
type CliConfigKeyTree<T> = {
  readonly [
    K in keyof T & string as [TreeNode<T[K], false>] extends [never] ? never : CamelCase<K>
  ]-?: TreeNode<T[K], {} extends Pick<T, K> ? true : false>;
};

interface DocumentOnlyKeyTree {
  readonly db: {
    readonly password: CliConfigKey<string>;
    readonly rootKey: CliConfigKey<Option.Option<string>, string>;
  };
  readonly auth: {
    readonly externalUrl: CliConfigKey<Option.Option<string>, string>;
    readonly passkey: { readonly enabled: CliConfigKey<boolean> };
    readonly webauthn: {
      readonly rpId: CliConfigKey<string>;
      readonly rpDisplayName: CliConfigKey<string>;
      readonly rpOrigins: CliConfigKey<ReadonlyArray<string>>;
    };
  };
  readonly linkedDb: { readonly password: CliConfigKey<Option.Option<string>, string> };
}

type CliConfigKeysTree = CliConfigKeyTree<CliConfig> & DocumentOnlyKeyTree;

const camelCase = (segment: string): string =>
  segment.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

const buildTree = (keys: ReadonlyArray<AnyCliConfigKey>): Record<string, unknown> => {
  const root: Record<string, unknown> = {};
  for (const key of keys) {
    const segments = key.path.split(".").map(camelCase);
    const leafName = segments[segments.length - 1] ?? key.path;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = node[segment];
      const next: Record<string, unknown> =
        typeof existing === "object" && existing !== null ? { ...existing } : {};
      node[segment] = next;
      node = next;
    }
    node[leafName] = key;
  }
  return root;
};

const isKeyTree = (value: unknown): value is CliConfigKeysTree =>
  typeof value === "object" && value !== null && Object.keys(value).length > 0;

const builtTree = buildTree(registryKeys);

if (!isKeyTree(builtTree)) {
  throw new Error("The CLI config key registry produced no keys");
}

/** Every config key, addressed by camelCased document path, e.g. `CliConfigKeys.db.seed.enabled`. */
export const CliConfigKeys: CliConfigKeysTree = builtTree;

/** The env name that overrides a `[remotes.<name>]` block's `project_id` for remote selection. */
export const cliRemoteProjectIdEnvName = (remote: string): string =>
  `SUPABASE_REMOTES_${remote.toUpperCase()}_PROJECT_ID`;

/** Env-name-only reads: shell-only, so the name lives in the registry but no tier list applies. */
export const CliEnvNames = {
  projectId: cliEnvName({
    name: deriveCliConfigEnvName("project_id"),
    codec: stringCodec,
    configKeyPath: "project_id",
  }),
  authServiceRoleKey: cliEnvName({
    name: deriveCliConfigEnvName("auth.service_role_key"),
    codec: stringCodec,
    configKeyPath: "auth.service_role_key",
  }),
} as const satisfies Record<string, CliEnvName<string>>;
