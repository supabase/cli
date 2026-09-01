import { Crypto, Duration, Effect, Path, Redacted, Schema } from "effect";
import { InvalidStackConfigError, StackVersionUnsupportedError } from "../public/Errors.ts";
import { StackConfigSchema, type StackConfig } from "../public/Config.ts";
import type {
  AuthSettings,
  DatabaseSettings,
  RestSettings,
  RealtimeSettings,
  StorageSettings,
  FunctionsSettings,
  StudioSettings,
  MailSettings,
  AnalyticsSettings,
  PoolerSettings,
  JwtSigning,
} from "../public/Config.ts";
import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import { PORT_FIELDS, type PortField } from "../public/Status.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import {
  AuthModule,
  DatabaseModule,
  FunctionsModule,
  MailModule,
  PoolerModule,
  RealtimeModule,
  RestModule,
  StorageModule,
  parseFileSize,
  StudioModule,
  AnalyticsModule,
  parseGoDuration,
} from "./capabilities/index.ts";
import { resolveThirdPartyIssuer } from "./capabilities/auth-third-party.ts";
import { CAPABILITY_MODULES, createExecutionPlan, type ExecutionPlan } from "./ExecutionPlan.ts";
import type {
  CapabilityModule,
  CapabilityRelease,
  MaterializedSettings,
} from "./CapabilityModule.ts";
import type { SecretGenerator, SecretJwtSigning } from "../state/SecretStore.ts";

type InputFingerprint = Schema.Schema.Type<typeof InputFingerprintSchema>;
const InputFingerprintSchema = Schema.String.pipe(Schema.brand("InputFingerprint"));

interface SecretSlot {
  readonly slot: string;
}

interface MaterializedCapability<T> {
  readonly enabled: boolean;
  readonly activation: "eager" | "lazy";
  readonly version: string;
  readonly settings: MaterializedSettings<T>;
}

export interface StackDefinition {
  readonly capabilities: Readonly<{
    readonly database: MaterializedCapability<DatabaseSettings>;
    readonly rest: MaterializedCapability<RestSettings>;
    readonly auth: MaterializedCapability<AuthSettings>;
    readonly realtime: MaterializedCapability<RealtimeSettings>;
    readonly storage: MaterializedCapability<StorageSettings>;
    readonly functions: MaterializedCapability<FunctionsSettings>;
    readonly studio: MaterializedCapability<StudioSettings>;
    readonly mail: MaterializedCapability<MailSettings>;
    readonly analytics: MaterializedCapability<AnalyticsSettings>;
    readonly pooler: MaterializedCapability<PoolerSettings>;
  }>;
  readonly listeners: Readonly<Record<PortField, MaterializedListener>>;
  readonly security: Readonly<{
    readonly jwt: Readonly<{
      readonly issuer: string | null;
      readonly signing: MaterializedJwtSigning;
    }>;
  }>;
}

type MaterializedJwtSigning =
  | { readonly kind: "symmetric"; readonly secret: SecretSlot }
  | { readonly kind: "jwks-file"; readonly path: string }
  | null;

interface MaterializedListener {
  readonly enabled: boolean;
  readonly address: string;
  readonly port: "automatic" | number;
}

export interface SecretSlotInput {
  readonly slot: string;
  readonly policy: "managed" | "passthrough";
  readonly value?: Redacted.Redacted<unknown>;
  /** Private lifecycle-only generator metadata; never materialized into StackDefinition. */
  readonly generator?: SecretGenerator;
}

const AUTH_JWT_SECRET_SLOT = "secret:auth.settings.jwt_secret";
const SECURITY_JWT_SIGNING_SECRET_SLOT = "secret:security.jwt.signing.secret";

/** Internal credentials are not user settings but still need durable managed slots. */
const INTERNAL_MANAGED_SECRET_SLOTS = ["secret:database.internal.password"] as const;

export interface CompiledStack {
  readonly definition: StackDefinition;
  readonly inputFingerprint: InputFingerprint;
  readonly secrets: ReadonlyArray<SecretSlotInput>;
  readonly executionPlan: ExecutionPlan;
}

export interface PreviousCompilation {
  readonly definition: StackDefinition;
  readonly inputFingerprint: InputFingerprint;
}

export interface CompileStackInput {
  readonly projectRoot: string;
  readonly runtime: StackRuntime;
  readonly config?: StackConfig;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !Redacted.isRedacted(value);

const canonical = (value: unknown): string => {
  if (Redacted.isRedacted(value)) return '{"$secret":true}';
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

function merge<T>(defaults: T, supplied: unknown): T;
function merge(defaults: unknown, supplied: unknown): unknown {
  if (!isRecord(defaults) || !isRecord(supplied))
    return supplied === undefined ? defaults : supplied;
  const keys = new Set([...Object.keys(defaults), ...Object.keys(supplied)]);
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = merge(defaults[key], supplied[key]);
  return result;
}

function materializeAbsence<T>(value: T): T;
function materializeAbsence(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(materializeAbsence);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = materializeAbsence(value[key]);
    return result;
  }
  return value;
}

function slotsFor<T>(
  value: T,
  path: string,
  slots: SecretSlotInput[],
  policyForPath?: (path: string) => "managed" | "passthrough",
): MaterializedSettings<T>;
function slotsFor(
  value: unknown,
  path: string,
  slots: SecretSlotInput[],
  policyForPath: (path: string) => "managed" | "passthrough" = () => "passthrough",
): unknown {
  if (Redacted.isRedacted(value)) {
    slots.push({ slot: `secret:${path}`, policy: policyForPath(path), value });
    return { slot: `secret:${path}` };
  }
  if (Array.isArray(value))
    return value.map((entry, index) => slotsFor(entry, `${path}.${index}`, slots, policyForPath));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      result[key] = slotsFor(value[key], `${path}.${key}`, slots, policyForPath);
    return result;
  }
  return value;
}

const canonicalJwtSecret = (
  config: StackConfig,
): Effect.Effect<Redacted.Redacted<string> | undefined, InvalidStackConfigError> =>
  Effect.gen(function* () {
    const auth = config.capabilities?.auth;
    const authSecret =
      auth !== undefined && "settings" in auth ? auth.settings?.jwt_secret : undefined;
    const signing = config.security?.jwt?.signing;
    const signingSecret = signing?.kind === "symmetric" ? signing.secret : undefined;
    if (
      authSecret !== undefined &&
      signingSecret !== undefined &&
      Redacted.value(authSecret) !== Redacted.value(signingSecret)
    )
      return yield* new InvalidStackConfigError({
        message: "Auth and stack JWT signing secrets must match in symmetric mode",
      });
    return signingSecret ?? authSecret;
  });

const ensureCanonicalJwtSlot = (
  slots: SecretSlotInput[],
  value: Redacted.Redacted<string> | undefined,
): void => {
  for (let index = slots.length - 1; index >= 0; index--)
    if (slots[index]?.slot === SECURITY_JWT_SIGNING_SECRET_SLOT) slots.splice(index, 1);
  const existingIndex = slots.findIndex((entry) => entry.slot === AUTH_JWT_SECRET_SLOT);
  if (existingIndex < 0) {
    slots.push({
      slot: AUTH_JWT_SECRET_SLOT,
      policy: "managed",
      ...(value === undefined ? {} : { value }),
    });
    return;
  }
  const existing = slots[existingIndex];
  if (existing !== undefined && existing.value === undefined && value !== undefined)
    slots[existingIndex] = { ...existing, value };
};

const attachAuthSecretGenerators = (
  slots: SecretSlotInput[],
  projectRoot: string,
  signing: JwtSigning | undefined,
): void => {
  const jwtSigning: SecretJwtSigning =
    signing?.kind === "jwks-file"
      ? { kind: "jwks-file", projectRoot, path: signing.path }
      : { kind: "symmetric" };
  for (let index = 0; index < slots.length; index++) {
    const entry = slots[index];
    if (entry === undefined || entry.policy !== "managed") continue;
    const generator =
      entry.slot === "secret:auth.settings.publishable_key"
        ? ({ kind: "publishable-key" } satisfies SecretGenerator)
        : entry.slot === "secret:auth.settings.secret_key"
          ? ({ kind: "secret-key" } satisfies SecretGenerator)
          : entry.slot === AUTH_JWT_SECRET_SLOT
            ? ({ kind: "jwt-secret" } satisfies SecretGenerator)
            : entry.slot === "secret:auth.settings.anon_key"
              ? ({ kind: "jwt-token", role: "anon", signing: jwtSigning } satisfies SecretGenerator)
              : entry.slot === "secret:auth.settings.service_role_key"
                ? ({
                    kind: "jwt-token",
                    role: "service_role",
                    signing: jwtSigning,
                  } satisfies SecretGenerator)
                : undefined;
    if (generator !== undefined) slots[index] = { ...entry, generator };
  }
};

const managedRandomBase64urlGenerators: Readonly<Record<string, SecretGenerator>> = {
  "secret:analytics.settings.api_key": { kind: "random-base64url", bytes: 32 },
  "secret:pooler.settings.encryption_key": { kind: "random-base64url", bytes: 24 },
  "secret:pooler.settings.secret_key_base": { kind: "random-base64url", bytes: 48 },
};

const attachManagedRandomSecretGenerators = (slots: SecretSlotInput[]): void => {
  for (let index = 0; index < slots.length; index++) {
    const entry = slots[index];
    if (entry === undefined || entry.policy !== "managed") continue;
    const generator = managedRandomBase64urlGenerators[entry.slot];
    if (generator !== undefined) slots[index] = { ...entry, generator };
  }
};

const setMaterializedPath = (
  value: unknown,
  parts: ReadonlyArray<string>,
  slot: SecretSlot,
): void => {
  if (!isRecord(value) || parts.length === 0) return;
  const head = parts[0];
  if (head === undefined) return;
  const tail = parts.slice(1);
  if (tail.length === 0) {
    value[head] = slot;
    return;
  }
  if (!isRecord(value[head])) value[head] = {};
  setMaterializedPath(value[head], tail, slot);
};

const ensureManagedSlots = <T>(
  settings: MaterializedSettings<T>,
  module: CapabilityModule<T>,
  enabled: boolean,
  slots: SecretSlotInput[],
): MaterializedSettings<T> => {
  if (!enabled || module.managedSecretSlots.length === 0) return settings;
  const result = settings;
  for (const path of module.managedSecretSlots) {
    const slot = `secret:${path}`;
    const existing = slots.find((candidate) => candidate.slot === slot);
    if (existing === undefined) slots.push({ slot, policy: "managed" });
    setMaterializedPath(result, path.split(".").slice(2), { slot });
  }
  return result;
};

const materializeListener = (value: unknown, enabledByDefault: boolean): MaterializedListener => {
  if (!isRecord(value))
    return { enabled: enabledByDefault, address: "127.0.0.1", port: "automatic" };
  if (value.enabled === false) return { enabled: false, address: "127.0.0.1", port: "automatic" };
  const address =
    typeof value.address === "string" && value.address.length > 0 ? value.address : "127.0.0.1";
  const port = typeof value.port === "number" ? value.port : "automatic";
  return { enabled: true, address, port };
};

const extract = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

function materializeFunctionsRoot<T>(
  settings: T,
  projectRoot: string,
  path: Path.Path,
): Effect.Effect<T, InvalidStackConfigError>;
function materializeFunctionsRoot(
  settings: unknown,
  projectRoot: string,
  path: Path.Path,
): Effect.Effect<unknown, InvalidStackConfigError> {
  if (!isRecord(settings)) return Effect.succeed(settings);
  const supplied = settings.functions_root;
  const root =
    typeof supplied === "string" && supplied.length > 0 ? supplied : "supabase/functions";
  const resolvedProject = path.resolve(projectRoot);
  const resolvedRoot = path.resolve(resolvedProject, root);
  const relative = path.relative(resolvedProject, resolvedRoot);
  if (
    path.isAbsolute(root) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return Effect.fail(
      new InvalidStackConfigError({
        message: "functions_root must remain inside projectRoot",
        functionsRoot: root,
      }),
    );
  }
  return Effect.succeed({ ...settings, functions_root: resolvedRoot });
}

const digestHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const decodeConfig = (config: unknown): Effect.Effect<StackConfig, InvalidStackConfigError> =>
  Schema.decodeUnknownEffect(StackConfigSchema)(config, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (error) =>
        new InvalidStackConfigError({ message: `Invalid stack configuration: ${String(error)}` }),
    ),
  );

const validateStorageFileSizes = (
  config: StackConfig,
): Effect.Effect<void, InvalidStackConfigError> => {
  const storage = config.capabilities?.storage;
  if (storage === undefined || !("settings" in storage) || storage.settings === undefined)
    return Effect.void;
  const values = [
    storage.settings.file_size_limit,
    ...Object.values(storage.settings.buckets ?? {}).map((bucket) => bucket.file_size_limit),
  ];
  for (const value of values) {
    if (value !== undefined && parseFileSize(value) === undefined)
      return Effect.fail(new InvalidStackConfigError({ message: "Invalid storage file size" }));
  }
  return Effect.void;
};

const validateDatabaseHealthTimeout = (
  config: StackConfig,
): Effect.Effect<void, InvalidStackConfigError> => {
  const database = config.capabilities?.database;
  if (database === undefined || !("settings" in database) || database.settings === undefined)
    return Effect.void;
  const value = database.settings.health_timeout;
  if (value === undefined) return Effect.void;
  return Effect.try({
    try: () => parseGoDuration(value),
    catch: (cause) =>
      new InvalidStackConfigError({
        message: `Invalid database health_timeout: ${value}`,
        setting: "capabilities.database.settings.health_timeout",
        cause,
      }),
  }).pipe(
    Effect.flatMap((duration) =>
      Duration.isNegative(duration) || Duration.isZero(duration)
        ? Effect.fail(
            new InvalidStackConfigError({
              message: `Invalid database health_timeout: ${value}; duration must be positive`,
              setting: "capabilities.database.settings.health_timeout",
            }),
          )
        : Effect.void,
    ),
  );
};

const validatePoolerKeys = (config: StackConfig): Effect.Effect<void, InvalidStackConfigError> => {
  const pooler = config.capabilities?.pooler;
  if (pooler === undefined || !("settings" in pooler) || pooler.settings === undefined)
    return Effect.void;
  const settings = pooler.settings;
  const validate = (
    value: Redacted.Redacted<string> | undefined,
    expectedLength: number,
    field: string,
  ): Effect.Effect<void, InvalidStackConfigError> => {
    if (value === undefined) return Effect.void;
    const text = Redacted.value(value);
    if (
      text.length !== expectedLength ||
      [...text].some((character) => character < "!" || character > "~")
    )
      return Effect.fail(
        new InvalidStackConfigError({
          message: `Invalid pooler ${field}: expected ${expectedLength} printable ASCII characters`,
          setting: `capabilities.pooler.settings.${field}`,
        }),
      );
    return Effect.void;
  };
  return Effect.gen(function* () {
    yield* validate(settings.encryption_key, 32, "encryption_key");
    yield* validate(settings.secret_key_base, 64, "secret_key_base");
  });
};

const validateFunctionKeys = (config: unknown): Effect.Effect<void, InvalidStackConfigError> => {
  const capabilities = isRecord(config) ? config.capabilities : undefined;
  const capability = isRecord(capabilities) ? capabilities.functions : undefined;
  const settings = isRecord(capability) ? capability.settings : undefined;
  if (!isRecord(settings)) return Effect.void;
  const functions = settings.functions;
  if (!isRecord(functions)) return Effect.void;
  for (const [slug, value] of Object.entries(functions)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(slug))
      return Effect.fail(
        new InvalidStackConfigError({
          message: `Invalid function slug: ${slug}`,
          function: slug,
        }),
      );
    if (!isRecord(value)) continue;
    const env = value.env;
    if (!isRecord(env)) continue;
    for (const name of Object.keys(env))
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
        return Effect.fail(
          new InvalidStackConfigError({
            message: `Invalid function environment name: ${name}`,
            function: slug,
            environment: name,
          }),
        );
  }
  return Effect.void;
};

const releaseFor = <T>(
  module: CapabilityModule<T>,
  raw: unknown,
): Effect.Effect<CapabilityRelease, StackVersionUnsupportedError> => {
  const selected = extract(raw, "version");
  const selector = typeof selected === "string" ? selected : module.defaultVersion;
  const release = module.releases[selector];
  if (release !== undefined) return Effect.succeed(release);
  return Effect.fail(
    new StackVersionUnsupportedError({
      capability: module.name,
      version: selector,
      message: `Unsupported ${module.name} version: ${selector}`,
    }),
  );
};

const enabledSettings = (
  name: CapabilityName,
  capabilities: Readonly<Record<string, unknown>>,
): { enabled: boolean; activation: "eager" | "lazy"; settings: unknown; raw: unknown } => {
  const raw = capabilities[name];
  if (name === "database")
    return { enabled: true, activation: "eager", settings: extract(raw, "settings") ?? {}, raw };
  if (raw === undefined || raw === null) {
    const module = CAPABILITY_MODULES[name];
    return {
      enabled: module.defaultEnabled,
      activation: module.defaultActivation,
      settings: module.defaultSettings,
      raw: {},
    };
  }
  if (extract(raw, "enabled") === false)
    return {
      enabled: false,
      activation: CAPABILITY_MODULES[name].defaultActivation,
      settings: CAPABILITY_MODULES[name].defaultSettings,
      raw,
    };
  const activation = extract(raw, "activation");
  return {
    enabled: true,
    activation:
      activation === "eager" || activation === "lazy"
        ? activation
        : CAPABILITY_MODULES[name].defaultActivation,
    settings: extract(raw, "settings") ?? {},
    raw,
  };
};

const materializeCapability = <T>(
  module: CapabilityModule<T>,
  raw: unknown,
  projectRoot: string,
  path: Path.Path,
  crypto: Crypto.Crypto,
  slots: SecretSlotInput[],
  specHashes: Map<string, string>,
  normalizeFunctions: boolean,
): Effect.Effect<
  MaterializedCapability<T> & { readonly release: CapabilityRelease },
  InvalidStackConfigError | StackVersionUnsupportedError,
  Path.Path | Crypto.Crypto
> => {
  const selected = enabledSettings(module.name, { [module.name]: raw });
  const mergedInput = merge(module.defaultSettings, selected.settings);
  const materialized = module.materialize?.(mergedInput, projectRoot) ?? mergedInput;
  const normalized = normalizeFunctions
    ? materializeFunctionsRoot(materialized, projectRoot, path)
    : Effect.succeed(materialized);
  return Effect.gen(function* () {
    const normalizedSettings = yield* normalized;
    const merged = materializeAbsence(normalizedSettings);
    const slotted = slotsFor(merged, `${module.name}.settings`, slots, module.secretPolicy);
    const completeSettings = ensureManagedSlots(slotted, module, selected.enabled, slots);
    const selectedRelease = yield* releaseFor(module, selected.raw);
    const version = selectedRelease.version;
    for (const entry of selectedRelease.workloads) {
      const bytes = yield* crypto.digest(
        "SHA-256",
        new TextEncoder().encode(
          canonical({ workload: entry, version, settings: completeSettings }),
        ),
      );
      specHashes.set(`${module.name}:${entry.name}`, digestHex(bytes));
    }
    return {
      enabled: selected.enabled,
      activation: selected.activation,
      version,
      settings: completeSettings,
      release: selectedRelease,
    };
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new InvalidStackConfigError({ message: error.message })),
    ),
  );
};

const withoutRelease = <T>(
  capability: MaterializedCapability<T> & { readonly release: CapabilityRelease },
): MaterializedCapability<T> => ({
  enabled: capability.enabled,
  activation: capability.activation,
  version: capability.version,
  settings: capability.settings,
});

const hashDefinitionWorkloads = (
  definition: StackDefinition,
  crypto: Crypto.Crypto,
  specHashes: Map<string, string>,
): Effect.Effect<void, StackVersionUnsupportedError | InvalidStackConfigError> =>
  Effect.gen(function* () {
    for (const name of CAPABILITY_NAMES) {
      const capability = definition.capabilities[name];
      const module = CAPABILITY_MODULES[name];
      const selectedRelease = module.releases[capability.version];
      if (selectedRelease === undefined)
        return yield* new StackVersionUnsupportedError({
          capability: name,
          version: capability.version,
          message: `Unsupported ${name} version: ${capability.version}`,
        });
      for (const entry of selectedRelease.workloads) {
        const bytes = yield* crypto
          .digest(
            "SHA-256",
            new TextEncoder().encode(
              canonical({
                workload: entry,
                version: capability.version,
                settings: capability.settings,
              }),
            ),
          )
          .pipe(
            Effect.mapError((error) => new InvalidStackConfigError({ message: error.message })),
          );
        specHashes.set(`${name}:${entry.name}`, digestHex(bytes));
      }
    }
  });

const planForDefinition = (
  runtime: StackRuntime,
  definition: StackDefinition,
  crypto: Crypto.Crypto,
): Effect.Effect<ExecutionPlan, InvalidStackConfigError | StackVersionUnsupportedError> => {
  const enabled = {
    database: {
      enabled: definition.capabilities.database.enabled,
      activation: definition.capabilities.database.activation,
    },
    rest: {
      enabled: definition.capabilities.rest.enabled,
      activation: definition.capabilities.rest.activation,
    },
    auth: {
      enabled: definition.capabilities.auth.enabled,
      activation: definition.capabilities.auth.activation,
    },
    realtime: {
      enabled: definition.capabilities.realtime.enabled,
      activation: definition.capabilities.realtime.activation,
    },
    storage: {
      enabled: definition.capabilities.storage.enabled,
      activation: definition.capabilities.storage.activation,
    },
    functions: {
      enabled: definition.capabilities.functions.enabled,
      activation: definition.capabilities.functions.activation,
    },
    studio: {
      enabled: definition.capabilities.studio.enabled,
      activation: definition.capabilities.studio.activation,
    },
    mail: {
      enabled: definition.capabilities.mail.enabled,
      activation: definition.capabilities.mail.activation,
    },
    analytics: {
      enabled: definition.capabilities.analytics.enabled,
      activation: definition.capabilities.analytics.activation,
    },
    pooler: {
      enabled: definition.capabilities.pooler.enabled,
      activation: definition.capabilities.pooler.activation,
    },
  };
  const versions = {
    database: definition.capabilities.database.version,
    rest: definition.capabilities.rest.version,
    auth: definition.capabilities.auth.version,
    realtime: definition.capabilities.realtime.version,
    storage: definition.capabilities.storage.version,
    functions: definition.capabilities.functions.version,
    studio: definition.capabilities.studio.version,
    mail: definition.capabilities.mail.version,
    analytics: definition.capabilities.analytics.version,
    pooler: definition.capabilities.pooler.version,
  };
  const settings = {
    database: definition.capabilities.database.settings,
    rest: definition.capabilities.rest.settings,
    auth: definition.capabilities.auth.settings,
    realtime: definition.capabilities.realtime.settings,
    storage: definition.capabilities.storage.settings,
    functions: definition.capabilities.functions.settings,
    studio: definition.capabilities.studio.settings,
    mail: definition.capabilities.mail.settings,
    analytics: definition.capabilities.analytics.settings,
    pooler: definition.capabilities.pooler.settings,
  };
  const specHashes = new Map<string, string>();
  return hashDefinitionWorkloads(definition, crypto, specHashes).pipe(
    Effect.flatMap(() =>
      createExecutionPlan(runtime, enabled, specHashes, versions, CAPABILITY_MODULES, settings),
    ),
  );
};

/** Rebuilds the private execution plan from a persisted, fully materialized definition. */
export const rebuildExecutionPlan = (
  runtime: StackRuntime,
  definition: StackDefinition,
): Effect.Effect<
  ExecutionPlan,
  InvalidStackConfigError | StackVersionUnsupportedError,
  Crypto.Crypto
> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return yield* planForDefinition(runtime, definition, crypto);
  });

const collectSuppliedSecrets = (
  config: StackConfig,
  slots: SecretSlotInput[],
  jwtSecret: Redacted.Redacted<string> | undefined,
): void => {
  const capabilities = config.capabilities;
  for (const name of CAPABILITY_NAMES) {
    const module = CAPABILITY_MODULES[name];
    const capability = capabilities?.[name];
    if (capability === undefined) {
      if (module.defaultEnabled) {
        for (const path of module.managedSecretSlots)
          slots.push({ slot: `secret:${path}`, policy: "managed" });
      }
      continue;
    }
    slotsFor(
      "settings" in capability ? capability.settings : undefined,
      `${name}.settings`,
      slots,
      module.secretPolicy,
    );
    if ("enabled" in capability && capability.enabled === false) continue;
    for (const path of module.managedSecretSlots) {
      if (!slots.some((entry) => entry.slot === `secret:${path}`))
        slots.push({ slot: `secret:${path}`, policy: "managed" });
    }
  }
  const signing = config.security?.jwt?.signing;
  if (signing?.kind === "jwks-file") slotsFor(signing, "security.jwt.signing", slots);
  ensureCanonicalJwtSlot(slots, jwtSecret);
};

export const compileStack = (
  input: CompileStackInput,
  previous?: PreviousCompilation,
): Effect.Effect<
  CompiledStack,
  InvalidStackConfigError | StackVersionUnsupportedError,
  Crypto.Crypto | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    yield* validateFunctionKeys(input.config ?? {});
    const config = yield* decodeConfig(input.config ?? {});
    yield* validateDatabaseHealthTimeout(config);
    yield* validatePoolerKeys(config);
    yield* validateStorageFileSizes(config);
    const jwtSecret = yield* canonicalJwtSecret(config);
    const rawCapabilities = isRecord(config.capabilities) ? config.capabilities : {};
    const normalizedFunctions = yield* materializeFunctionsRoot(
      extract(extract(rawCapabilities, "functions"), "settings"),
      input.projectRoot,
      path,
    );
    const rawForFingerprint = {
      projectRoot: path.resolve(input.projectRoot),
      runtime: input.runtime,
      config: {
        ...config,
        capabilities: {
          ...rawCapabilities,
          functions: isRecord(rawCapabilities.functions)
            ? { ...rawCapabilities.functions, settings: normalizedFunctions }
            : rawCapabilities.functions,
        },
      },
    };
    const fingerprintBytes = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(rawForFingerprint)),
    );
    const inputFingerprint = yield* Schema.decodeEffect(InputFingerprintSchema)(
      digestHex(fingerprintBytes),
    ).pipe(Effect.mapError((error) => new InvalidStackConfigError({ message: String(error) })));
    if (previous?.inputFingerprint === inputFingerprint) {
      const slots: SecretSlotInput[] = [];
      for (const slot of INTERNAL_MANAGED_SECRET_SLOTS) slots.push({ slot, policy: "managed" });
      collectSuppliedSecrets(config, slots, jwtSecret);
      attachAuthSecretGenerators(slots, input.projectRoot, config.security?.jwt?.signing);
      attachManagedRandomSecretGenerators(slots);
      const executionPlan = yield* planForDefinition(input.runtime, previous.definition, crypto);
      return {
        definition: previous.definition,
        inputFingerprint,
        secrets: slots,
        executionPlan,
      };
    }
    const slots: SecretSlotInput[] = [];
    for (const slot of INTERNAL_MANAGED_SECRET_SLOTS) slots.push({ slot, policy: "managed" });
    const specHashes = new Map<string, string>();
    const databaseResult = yield* materializeCapability(
      DatabaseModule,
      extract(rawCapabilities, "database"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const restResult = yield* materializeCapability(
      RestModule,
      extract(rawCapabilities, "rest"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const authResult = yield* materializeCapability(
      AuthModule,
      extract(rawCapabilities, "auth"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const thirdParty = resolveThirdPartyIssuer(authResult.settings);
    if (!thirdParty.ok)
      return yield* new InvalidStackConfigError({
        message: thirdParty.message,
        ...(thirdParty.provider === undefined ? {} : { provider: thirdParty.provider }),
      });
    const realtimeResult = yield* materializeCapability(
      RealtimeModule,
      extract(rawCapabilities, "realtime"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const storageResult = yield* materializeCapability(
      StorageModule,
      extract(rawCapabilities, "storage"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const functionsResult = yield* materializeCapability(
      FunctionsModule,
      extract(rawCapabilities, "functions"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      true,
    );
    const studioResult = yield* materializeCapability(
      StudioModule,
      extract(rawCapabilities, "studio"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const mailResult = yield* materializeCapability(
      MailModule,
      extract(rawCapabilities, "mail"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const analyticsResult = yield* materializeCapability(
      AnalyticsModule,
      extract(rawCapabilities, "analytics"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const poolerResult = yield* materializeCapability(
      PoolerModule,
      extract(rawCapabilities, "pooler"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const database = withoutRelease(databaseResult);
    const rest = withoutRelease(restResult);
    const auth = withoutRelease(authResult);
    const realtime = withoutRelease(realtimeResult);
    const storage = withoutRelease(storageResult);
    const functions = withoutRelease(functionsResult);
    const studio = withoutRelease(studioResult);
    const mail = withoutRelease(mailResult);
    const analytics = withoutRelease(analyticsResult);
    const pooler = withoutRelease(poolerResult);
    const capabilities = {
      database,
      rest,
      auth,
      realtime,
      storage,
      functions,
      studio,
      mail,
      analytics,
      pooler,
    };
    const enabled: Record<CapabilityName, { enabled: boolean; activation: "eager" | "lazy" }> = {
      database: { enabled: database.enabled, activation: database.activation },
      rest: { enabled: rest.enabled, activation: rest.activation },
      auth: { enabled: auth.enabled, activation: auth.activation },
      realtime: { enabled: realtime.enabled, activation: realtime.activation },
      storage: { enabled: storage.enabled, activation: storage.activation },
      functions: { enabled: functions.enabled, activation: functions.activation },
      studio: { enabled: studio.enabled, activation: studio.activation },
      mail: { enabled: mail.enabled, activation: mail.activation },
      analytics: { enabled: analytics.enabled, activation: analytics.activation },
      pooler: { enabled: pooler.enabled, activation: pooler.activation },
    };
    const rawListeners = isRecord(config.listeners) ? config.listeners : {};
    const listeners = {
      [PORT_FIELDS[0]]: materializeListener(rawListeners[PORT_FIELDS[0]], true),
      [PORT_FIELDS[1]]: materializeListener(rawListeners[PORT_FIELDS[1]], true),
      [PORT_FIELDS[2]]: materializeListener(rawListeners[PORT_FIELDS[2]], false),
      [PORT_FIELDS[3]]: materializeListener(rawListeners[PORT_FIELDS[3]], true),
      [PORT_FIELDS[4]]: materializeListener(rawListeners[PORT_FIELDS[4]], true),
      [PORT_FIELDS[5]]: materializeListener(rawListeners[PORT_FIELDS[5]], false),
      [PORT_FIELDS[6]]: materializeListener(rawListeners[PORT_FIELDS[6]], false),
      [PORT_FIELDS[7]]: materializeListener(rawListeners[PORT_FIELDS[7]], false),
    } satisfies Record<PortField, MaterializedListener>;
    const rawJwt = config.security?.jwt;
    ensureCanonicalJwtSlot(slots, jwtSecret);
    attachAuthSecretGenerators(slots, input.projectRoot, rawJwt?.signing);
    attachManagedRandomSecretGenerators(slots);
    const security = {
      jwt: {
        issuer: rawJwt?.issuer ?? null,
        signing:
          rawJwt?.signing?.kind === "jwks-file"
            ? slotsFor<JwtSigning>(rawJwt.signing, "security.jwt.signing", slots)
            : { kind: "symmetric" as const, secret: { slot: AUTH_JWT_SECRET_SLOT } },
      },
    };
    const definition: StackDefinition = {
      capabilities,
      listeners,
      security,
    };
    const versions = {
      database: database.version,
      rest: rest.version,
      auth: auth.version,
      realtime: realtime.version,
      storage: storage.version,
      functions: functions.version,
      studio: studio.version,
      mail: mail.version,
      analytics: analytics.version,
      pooler: pooler.version,
    };
    const executionPlan = yield* createExecutionPlan(
      input.runtime,
      enabled,
      specHashes,
      versions,
      CAPABILITY_MODULES,
      {
        database: database.settings,
        rest: rest.settings,
        auth: auth.settings,
        realtime: realtime.settings,
        storage: storage.settings,
        functions: functions.settings,
        studio: studio.settings,
        mail: mail.settings,
        analytics: analytics.settings,
        pooler: pooler.settings,
      },
    );
    return { definition, inputFingerprint, secrets: slots, executionPlan };
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new InvalidStackConfigError({ message: error.message })),
    ),
  );

export const canonicalize = canonical;
