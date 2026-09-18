import { Crypto, Duration, Effect, Path, PlatformError, Redacted, Schema } from "effect";
import { InvalidStackConfigError, StackVersionUnsupportedError } from "../public/Errors.ts";
import { StackConfigSchema, type StackConfig, type PreparationMode } from "../public/Config.ts";
import type { JwtSigning } from "../public/Config.ts";
import type { CapabilityName } from "../public/Capability.ts";
import type { PortField } from "../public/Status.ts";
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
import {
  CAPABILITY_MODULES,
  createExecutionPlan,
  type ExecutionPlan,
  type MaterializedCapabilities,
  type MaterializedCapability,
} from "./ExecutionPlan.ts";
import type { CapabilityModule, MaterializedSettings } from "./CapabilityModule.ts";

export { createExecutionPlan } from "./ExecutionPlan.ts";
import {
  PersistedServiceInstanceSchema,
  PersistedServiceRegistrySchema,
  ServiceInitializationInputsSchema,
  type PersistedServiceEndpoints,
  type PersistedServiceInstance,
  type PersistedServiceRegistry,
  type ServiceResourceIdentity,
  type ServiceInitializationInputs,
} from "./ServiceRegistry.ts";
import type { AnyEffectCreateServiceOptions, AnyEffectServiceConfig } from "../public/Service.ts";
import { ServiceInstanceIdSchema, type ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import { base64UrlEncode } from "../state/SecretStore.ts";
import type { SecretGenerator, SecretJwtSigning } from "../state/SecretStore.ts";
import { AUTH_JWT_SECRET_SLOT } from "../state/SecretStore.ts";

interface SecretSlot {
  readonly slot: string;
}

export interface StackDefinition {
  readonly preparation: PreparationMode;
  readonly capabilities: MaterializedCapabilities;
  readonly listeners: Readonly<Record<PortField, MaterializedListener>>;
  readonly security: Readonly<{
    readonly jwt: Readonly<{
      readonly issuer: string | null;
      readonly expirySeconds: number;
      readonly signing: MaterializedJwtSigning;
    }>;
  }>;
  readonly initialization?: StackConfig["initialization"];
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

export interface CompiledStack {
  readonly definition: StackDefinition;
  /** Raw validated input retained only for first registry seeding. */
  readonly sourceConfig: StackConfig;
  readonly secrets: ReadonlyArray<SecretSlotInput>;
  readonly executionPlan?: ExecutionPlan;
}

export interface PreviousCompilation {
  readonly definition: StackDefinition;
}

export interface CompileStackInput {
  readonly projectRoot: string;
  readonly runtime: StackRuntime;
  readonly config?: StackConfig;
  /** Initialized service registry supplying immutable runtime instance identities. */
  readonly registry?: PersistedServiceRegistry;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !Redacted.isRedacted(value);

export const canonical = (value: unknown): string => {
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
    const isSetting = (path: string): boolean =>
      entry.slot === `secret:${path}` ||
      entry.slot.endsWith(`.${path.slice(path.indexOf(".") + 1)}`);
    const generator = isSetting("auth.settings.publishable_key")
      ? ({ kind: "publishable-key" } satisfies SecretGenerator)
      : isSetting("auth.settings.secret_key")
        ? ({ kind: "secret-key" } satisfies SecretGenerator)
        : entry.slot === AUTH_JWT_SECRET_SLOT || isSetting("auth.settings.jwt_secret")
          ? ({ kind: "jwt-secret" } satisfies SecretGenerator)
          : isSetting("auth.settings.anon_key")
            ? ({ kind: "jwt-token", role: "anon", signing: jwtSigning } satisfies SecretGenerator)
            : isSetting("auth.settings.service_role_key")
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
  // Realtime encrypts with AES-128-ECB and consumes this value as a raw 16-byte key.
  // Twelve random bytes encode to exactly sixteen unpadded base64url characters.
  "secret:realtime.settings.db_enc_key": { kind: "random-base64url", bytes: 12 },
  "secret:realtime.settings.secret_key_base": { kind: "random-base64url", bytes: 48 },
};

const attachManagedRandomSecretGenerators = (slots: SecretSlotInput[]): void => {
  for (let index = 0; index < slots.length; index++) {
    const entry = slots[index];
    if (entry === undefined || entry.policy !== "managed") continue;
    const generator =
      managedRandomBase64urlGenerators[entry.slot] ??
      Object.entries(managedRandomBase64urlGenerators).find(([path]) =>
        entry.slot.endsWith(`.${path.slice(path.lastIndexOf(".") + 1)}`),
      )?.[1];
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
  slotPrefix: string = module.name,
): MaterializedSettings<T> => {
  if (!enabled || module.managedSecretSlots.length === 0) return settings;
  const result = settings;
  for (const path of module.managedSecretSlots) {
    const suffix = path.startsWith(`${module.name}.`) ? path.slice(module.name.length + 1) : path;
    const slot = `secret:${slotPrefix}.${suffix}`;
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
  previousVersion?: string,
): Effect.Effect<string, StackVersionUnsupportedError> => {
  const selected = extract(raw, "version");
  const selector =
    typeof selected === "string" ? selected : (previousVersion ?? module.defaultVersion);
  // The CLI config exposes PostgreSQL as a major selector (`15`, `17`), while the catalog
  // persists a concrete release; resolve a major against the catalog here so the CLI never
  // needs to know artifact patch IDs.
  const majorSelector = module.name === "database" && /^\d+$/.test(selector);
  const resolvedSelector = majorSelector
    ? (() => {
        const sameMajor = (version: string | undefined): boolean =>
          version !== undefined && version.split(".", 1)[0] === selector;
        if (sameMajor(previousVersion) && previousVersion !== undefined) return previousVersion;
        if (sameMajor(module.defaultVersion)) return module.defaultVersion;
        return Object.keys(module.releases).find(
          (version) => version.includes(".") && sameMajor(version),
        );
      })()
    : selector;
  const release = resolvedSelector === undefined ? undefined : module.releases[resolvedSelector];
  if (release !== undefined) return Effect.succeed(release.version);
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
  raw: unknown,
): {
  enabled: boolean;
  activation: "eager" | "lazy";
  idleTimeoutSeconds: number | false;
  settings: unknown;
  raw: unknown;
} => {
  const defaultIdleTimeout = CAPABILITY_MODULES[name].defaultIdleTimeoutSeconds ?? false;
  if (name === "database" && extract(raw, "enabled") === false)
    return {
      enabled: false,
      activation: "eager",
      idleTimeoutSeconds: false,
      settings: CAPABILITY_MODULES.database.defaultSettings,
      raw,
    };
  if (name === "database")
    return {
      enabled: true,
      activation: "eager",
      idleTimeoutSeconds: false,
      settings: extract(raw, "settings") ?? {},
      raw,
    };
  if (raw === undefined || raw === null) {
    const module = CAPABILITY_MODULES[name];
    return {
      enabled: module.defaultEnabled,
      activation: module.defaultActivation,
      idleTimeoutSeconds: module.defaultActivation === "lazy" ? defaultIdleTimeout : false,
      settings: module.defaultSettings,
      raw: {},
    };
  }
  if (extract(raw, "enabled") === false)
    return {
      enabled: false,
      activation: CAPABILITY_MODULES[name].defaultActivation,
      idleTimeoutSeconds: false,
      settings: CAPABILITY_MODULES[name].defaultSettings,
      raw,
    };
  const activation = extract(raw, "activation");
  const idleTimeoutSeconds = extract(raw, "idleTimeoutSeconds");
  const selectedActivation =
    activation === "eager" || activation === "lazy"
      ? activation
      : CAPABILITY_MODULES[name].defaultActivation;
  return {
    enabled: true,
    activation: selectedActivation,
    idleTimeoutSeconds:
      selectedActivation === "eager"
        ? false
        : idleTimeoutSeconds === false
          ? false
          : defaultIdleTimeout === false
            ? false
            : typeof idleTimeoutSeconds === "number" &&
                Number.isFinite(idleTimeoutSeconds) &&
                idleTimeoutSeconds > 0
              ? idleTimeoutSeconds
              : defaultIdleTimeout,
    settings: extract(raw, "settings") ?? {},
    raw,
  };
};

const materializeCapability = <T>(
  module: CapabilityModule<T>,
  raw: unknown,
  projectRoot: string,
  path: Path.Path,
  slots: SecretSlotInput[],
  normalizeFunctions: boolean,
  previousVersion?: string,
  slotPrefix: string = module.name,
): Effect.Effect<
  MaterializedCapability<T>,
  InvalidStackConfigError | StackVersionUnsupportedError,
  Path.Path
> => {
  const selected = enabledSettings(module.name, raw);
  const mergedInput = merge(module.defaultSettings, selected.settings);
  const materialized = module.materialize?.(mergedInput, projectRoot) ?? mergedInput;
  const normalized = normalizeFunctions
    ? materializeFunctionsRoot(materialized, projectRoot, path)
    : Effect.succeed(materialized);
  return Effect.gen(function* () {
    const normalizedSettings = yield* normalized;
    const merged = materializeAbsence(normalizedSettings);
    const slotted = slotsFor(merged, `${slotPrefix}.settings`, slots, module.secretPolicy);
    const completeSettings = ensureManagedSlots(
      slotted,
      module,
      selected.enabled,
      slots,
      slotPrefix,
    );
    const version = yield* releaseFor(module, selected.raw, previousVersion);
    return {
      enabled: selected.enabled,
      activation: selected.activation,
      idleTimeoutSeconds: selected.idleTimeoutSeconds,
      version,
      settings: completeSettings,
    };
  });
};

/** Materializes one service leaf and namespaces every generated secret slot by instance ID. */
const compileServiceCapability = <T>(
  module: CapabilityModule<T>,
  raw: unknown,
  projectRoot: string,
  path: Path.Path,
  instanceId: string,
  slots: SecretSlotInput[] = [],
  previousVersion?: string,
): Effect.Effect<
  MaterializedCapability<T>,
  InvalidStackConfigError | StackVersionUnsupportedError,
  Path.Path
> =>
  materializeCapability(
    module,
    raw,
    projectRoot,
    path,
    slots,
    module.name === "functions",
    previousVersion,
    instanceId,
  );

export interface CompiledServiceInstance {
  readonly id: ServiceInstanceId;
  readonly service: CapabilityName;
  readonly name?: string;
  readonly intent: "stopped";
  readonly config: MaterializedCapabilities[CapabilityName];
  readonly endpoints: PersistedServiceEndpoints[CapabilityName];
  readonly dependencies: Readonly<Record<string, ServiceInstanceId>>;
  readonly resources: ServiceResourceIdentity;
  readonly revisions: { readonly config: 0; readonly intent: 0 };
  readonly pendingOperation: null;
  readonly initializationInputs: ServiceInitializationInputs | null;
  readonly data: { readonly origin: "absent" };
  readonly artifactIdentity?: string;
  readonly runtimeIdentity?: string;
  readonly bootstrapRecipeId?: string;
  readonly bootstrapInputsId?: string;
  readonly creationInputsId?: string;
  readonly passwordSecretRef?: string;
  readonly secretSlots: ReadonlyArray<SecretSlotInput>;
  /** Fully validated candidate ready for registry registration. */
  readonly instance: PersistedServiceInstance;
}

const initializationModules = {
  auth: AuthModule,
  storage: StorageModule,
  realtime: RealtimeModule,
  analytics: AnalyticsModule,
  pooler: PoolerModule,
} as const;

type CatalogService = keyof typeof initializationModules;

const digestId = (
  crypto: Crypto.Crypto,
  prefix: string,
  value: unknown,
): Effect.Effect<string, PlatformError.PlatformError> =>
  crypto
    .digest("SHA-256", new TextEncoder().encode(canonical(value)))
    .pipe(Effect.map((digest) => `${prefix}:${base64UrlEncode(digest)}`));

const profileValue = (value: unknown, slots: ReadonlyArray<SecretSlotInput>): unknown => {
  if (isRecord(value) && typeof value.slot === "string") {
    const source = slots.find((slot) => slot.slot === value.slot);
    return {
      secret: source?.value === undefined ? null : Redacted.value(source.value),
    };
  }
  if (Array.isArray(value)) return value.map((item) => profileValue(item, slots));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, profileValue(item, slots)]),
    );
  return value;
};

export const resolvedStateValue = (
  value: unknown,
  secrets: Readonly<Record<string, { readonly value: string }>>,
): unknown => {
  if (isRecord(value) && typeof value.slot === "string") return secrets[value.slot]?.value ?? null;
  if (Array.isArray(value)) return value.map((item) => resolvedStateValue(item, secrets));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "passwordSecretRef" && typeof item === "string"
          ? (secrets[item]?.value ?? null)
          : resolvedStateValue(item, secrets),
      ]),
    );
  return value;
};

const creationInputValue = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(creationInputValue);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, creationInputValue(item)]),
    );
  return value;
};

/** Computes the client/server identity of a normalized dynamic service creation request. */
export const fingerprintCreationInputs = (
  options: AnyEffectCreateServiceOptions,
): Effect.Effect<string, InvalidStackConfigError | PlatformError.PlatformError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return yield* digestId(crypto, "creation", creationInputValue(options));
  });

/** Computes a semantic bootstrap fingerprint after managed secrets are persisted. */
export const fingerprintBootstrapInputs = (
  instance: Pick<
    PersistedServiceInstance,
    "service" | "config" | "initializationInputs" | "bootstrapRecipeId"
  >,
  security: {
    readonly jwt: {
      readonly issuer: string | null;
      readonly expirySeconds: number;
      readonly signing:
        | null
        | { readonly kind: "symmetric"; readonly secret: { readonly slot: string } }
        | { readonly kind: "jwks-file"; readonly path: string };
    };
  },
  secrets: Readonly<Record<string, { readonly value: string }>>,
): Effect.Effect<string | undefined, PlatformError.PlatformError, Crypto.Crypto> =>
  instance.bootstrapRecipeId === undefined
    ? Effect.map(Effect.void, () => undefined)
    : Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        return yield* digestId(crypto, "bootstrap", {
          service: instance.service,
          version: instance.config.version,
          settings: resolvedStateValue(instance.config.settings, secrets),
          password:
            "passwordSecretRef" in instance.config &&
            typeof instance.config.passwordSecretRef === "string"
              ? (secrets[instance.config.passwordSecretRef]?.value ?? null)
              : null,
          initialization: resolvedStateValue(instance.initializationInputs, secrets),
          jwt: {
            issuer: security.jwt.issuer,
            expirySeconds: security.jwt.expirySeconds,
            signing: resolvedStateValue(security.jwt.signing, secrets),
          },
        });
      });

/** Computes the public configuration identity, including resolved secrets and endpoint intent. */
export const fingerprintEffectiveConfig = (
  instance: Pick<PersistedServiceInstance, "service" | "config" | "initializationInputs">,
  security: {
    readonly jwt: {
      readonly issuer: string | null;
      readonly expirySeconds: number;
      readonly signing:
        | null
        | { readonly kind: "symmetric"; readonly secret: { readonly slot: string } }
        | { readonly kind: "jwks-file"; readonly path: string };
    };
  },
  secrets: Readonly<Record<string, { readonly value: string }>>,
): Effect.Effect<string, PlatformError.PlatformError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(
        canonical({
          service: instance.service,
          config: resolvedStateValue(instance.config, secrets),
          initialization: resolvedStateValue(instance.initializationInputs, secrets),
          jwt: {
            issuer: security.jwt.issuer,
            expirySeconds: security.jwt.expirySeconds,
            signing: resolvedStateValue(security.jwt.signing, secrets),
          },
        }),
      ),
    );
    return Array.from(digest)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  });

const initializationInputsFor = (
  id: ServiceInstanceId,
  initialization: unknown,
  context: {
    readonly projectRoot: string;
    readonly path: Path.Path;
    readonly registry?: PersistedServiceRegistry;
  },
  slots: SecretSlotInput[],
): Effect.Effect<
  ServiceInitializationInputs | null,
  InvalidStackConfigError | StackVersionUnsupportedError | PlatformError.PlatformError,
  Path.Path | Crypto.Crypto
> => {
  if (initialization === undefined || initialization === null) return Effect.succeed(null);
  if (!isRecord(initialization))
    return Effect.fail(
      new InvalidStackConfigError({ message: "Service initialization must be an object" }),
    );
  if ("from" in initialization) {
    const sourceId = initialization.from;
    if (typeof sourceId !== "string")
      return Effect.fail(
        new InvalidStackConfigError({
          message: "Service initialization source must be an instance ID",
        }),
      );
    const source = context.registry?.instances.find((instance) => instance.id === sourceId);
    if (source === undefined || source.service !== "database")
      return Effect.fail(
        new InvalidStackConfigError({
          message: `Service initialization source ${sourceId} must reference an existing database instance`,
        }),
      );
    return Effect.succeed(source.initializationInputs);
  }
  const catalog = initialization.catalog;
  if (catalog === undefined || catalog === null) return Effect.succeed(null);
  if (!isRecord(catalog))
    return Effect.fail(
      new InvalidStackConfigError({ message: "Service initialization catalog must be an object" }),
    );
  const unknownService = Object.keys(catalog).find(
    (service) => !(service in initializationModules),
  );
  if (unknownService !== undefined)
    return Effect.fail(
      new InvalidStackConfigError({
        message: `Unsupported service initialization catalog entry: ${unknownService}`,
      }),
    );
  if (Object.keys(catalog).length === 0) return Effect.succeed(null);
  return Effect.gen(function* () {
    const resolved: Record<string, unknown> = {};
    for (const service of Object.keys(initializationModules) as ReadonlyArray<CatalogService>) {
      const input = catalog[service];
      if (input === undefined) continue;
      const normalized = yield* (() => {
        const raw = { enabled: true, ...input };
        switch (service) {
          case "auth":
            return compileServiceCapability(
              AuthModule,
              raw,
              context.projectRoot,
              context.path,
              id,
              slots,
            );
          case "storage":
            return compileServiceCapability(
              StorageModule,
              raw,
              context.projectRoot,
              context.path,
              id,
              slots,
            );
          case "realtime":
            return compileServiceCapability(
              RealtimeModule,
              raw,
              context.projectRoot,
              context.path,
              id,
              slots,
            );
          case "analytics":
            return compileServiceCapability(
              AnalyticsModule,
              raw,
              context.projectRoot,
              context.path,
              id,
              slots,
            );
          case "pooler":
            return compileServiceCapability(
              PoolerModule,
              raw,
              context.projectRoot,
              context.path,
              id,
              slots,
            );
        }
      })();
      if (service === "auth") {
        const authJwtSecret = extract(normalized.settings, "jwt_secret");
        if (isRecord(authJwtSecret) && typeof authJwtSecret.slot === "string") {
          const slotIndex = slots.findIndex((entry) => entry.slot === authJwtSecret.slot);
          const existing = slots[slotIndex];
          const canonicalIndex = slots.findIndex((entry) => entry.slot === AUTH_JWT_SECRET_SLOT);
          const canonicalSlot = slots[canonicalIndex];
          if (
            existing?.value !== undefined &&
            canonicalSlot?.value !== undefined &&
            Redacted.value(existing.value) !== Redacted.value(canonicalSlot.value)
          )
            return yield* new InvalidStackConfigError({
              message: "Service initialization JWT secret must match stack signing secret",
            });
          if (existing !== undefined && canonicalIndex < 0)
            slots[slotIndex] = { ...existing, slot: AUTH_JWT_SECRET_SLOT };
          else if (existing !== undefined && canonicalIndex !== slotIndex)
            slots.splice(slotIndex, 1);
          setMaterializedPath(normalized.settings, ["jwt_secret"], {
            slot: AUTH_JWT_SECRET_SLOT,
          });
        }
      }
      resolved[service] = { version: normalized.version, settings: normalized.settings };
    }
    const crypto = yield* Crypto.Crypto;
    const profileId = yield* digestId(crypto, "profile", profileValue(resolved, slots));
    const profile = yield* Schema.decodeEffect(ServiceInitializationInputsSchema)({
      profileId,
      catalog: resolved,
    }).pipe(
      Effect.mapError(
        (error) =>
          new InvalidStackConfigError({
            message: `Invalid service initialization requirements: ${String(error)}`,
            cause: error,
          }),
      ),
    );
    return profile;
  });
};

const endpointValue = (config: AnyEffectServiceConfig): unknown =>
  "endpoints" in config ? config.endpoints : undefined;

const mergeEndpointIntents = (
  previous: PersistedServiceEndpoints[CapabilityName],
  replacement: unknown,
): unknown => {
  if (replacement === undefined || replacement === null) return previous;
  if (!isRecord(replacement)) return previous;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(previous)) result[key] = value;
  for (const [key, value] of Object.entries(replacement)) result[key] = value;
  return result;
};

const serviceDependencyKinds: Readonly<Record<CapabilityName, ReadonlyArray<CapabilityName>>> = {
  database: [],
  rest: ["database"],
  auth: ["database"],
  realtime: ["database"],
  storage: ["database"],
  functions: [],
  studio: ["database", "rest", "analytics"],
  mail: [],
  analytics: ["database"],
  pooler: ["database"],
};

const serviceArtifactIdentity = (
  service: CapabilityName,
  version: string,
  runtime: StackRuntime,
): string | undefined => {
  const release = CAPABILITY_MODULES[service].releases[version];
  const workload = release?.workloads[0];
  if (workload === undefined) return undefined;
  return runtime.kind === "container"
    ? `container:${workload.artifacts.container.image}`
    : `native:${workload.artifacts.native.release}`;
};

const serviceRuntimeIdentity = (
  service: CapabilityName,
  version: string,
  runtime: StackRuntime,
): string | undefined => {
  const workload = CAPABILITY_MODULES[service].releases[version]?.workloads[0];
  return workload === undefined
    ? undefined
    : runtime.kind === "container"
      ? `container:${service}:${version}`
      : `native:${service}:${version}`;
};

const completeCompiledInstance = (
  options: {
    readonly service: CapabilityName;
    readonly name?: string;
    readonly dependencies?: Readonly<Record<string, ServiceInstanceId>>;
  },
  id: ServiceInstanceId,
  config: MaterializedCapabilities[CapabilityName],
  endpoints: unknown,
  slots: ReadonlyArray<SecretSlotInput>,
  initializationInputs: ServiceInitializationInputs | null,
  artifactIdentity: string | undefined,
  bootstrapRecipeId: string | undefined,
  bootstrapInputsId: string | undefined,
  passwordSecretRef: string | undefined,
  runtimeIdentity: string | undefined,
): Effect.Effect<CompiledServiceInstance, InvalidStackConfigError> => {
  const dependencies =
    "dependencies" in options && options.dependencies !== undefined ? options.dependencies : {};
  const candidate = {
    id,
    service: options.service,
    ...(options.name === undefined ? {} : { name: options.name }),
    intent: "stopped" as const,
    config: {
      ...config,
      endpoints,
      ...(passwordSecretRef === undefined ? {} : { passwordSecretRef }),
    },
    dependencies,
    resources: {},
    revisions: { config: 0, intent: 0 },
    pendingOperation: null,
    initialization: null,
    initializationInputs,
    data: { origin: "absent" as const },
    ...(artifactIdentity === undefined ? {} : { artifactIdentity }),
    ...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
    ...(bootstrapRecipeId === undefined ? {} : { bootstrapRecipeId }),
    ...(bootstrapInputsId === undefined ? {} : { bootstrapInputsId }),
  };
  return Schema.decodeUnknownEffect(PersistedServiceInstanceSchema)(candidate).pipe(
    Effect.mapError(
      (error) =>
        new InvalidStackConfigError({
          message: `Compiled ${options.service} instance failed validation: ${String(error)}`,
          cause: error,
        }),
    ),
    Effect.map((instance) => ({
      id,
      service: options.service,
      name: options.name,
      intent: "stopped" as const,
      config: instance.config,
      endpoints: instance.config.endpoints,
      dependencies: instance.dependencies,
      resources: instance.resources,
      revisions: { config: 0, intent: 0 } as const,
      pendingOperation: null,
      initializationInputs: instance.initializationInputs,
      data: { origin: "absent" as const },
      ...(instance.artifactIdentity === undefined
        ? {}
        : { artifactIdentity: instance.artifactIdentity }),
      ...(instance.runtimeIdentity === undefined
        ? {}
        : { runtimeIdentity: instance.runtimeIdentity }),
      ...(instance.bootstrapRecipeId === undefined
        ? {}
        : { bootstrapRecipeId: instance.bootstrapRecipeId }),
      ...(instance.bootstrapInputsId === undefined
        ? {}
        : { bootstrapInputsId: instance.bootstrapInputsId }),
      ...(passwordSecretRef === undefined ? {} : { passwordSecretRef }),
      secretSlots: slots,
      instance,
    })),
  );
};

const compileService = (
  options: {
    readonly service: CapabilityName;
    readonly name?: string;
    readonly config: unknown;
    readonly dependencies?: Readonly<Record<string, ServiceInstanceId>>;
    readonly initialization?: unknown;
    /** Restart recompilation retains the persisted password instead of creating a new slot. */
    readonly createPassword?: boolean;
  },
  id: ServiceInstanceId,
  context: {
    readonly projectRoot: string;
    readonly path: Path.Path;
    readonly previousVersion?: string;
    readonly registry?: PersistedServiceRegistry;
    readonly runtime: StackRuntime;
  },
  slots: SecretSlotInput[],
  endpoints: unknown,
): Effect.Effect<
  CompiledServiceInstance,
  InvalidStackConfigError | StackVersionUnsupportedError | PlatformError.PlatformError,
  Path.Path | Crypto.Crypto
> => {
  const module = CAPABILITY_MODULES[options.service];
  const rawPassword = extract(options.config, "password");
  const password =
    options.service !== "database"
      ? undefined
      : Redacted.isRedacted(rawPassword)
        ? rawPassword
        : typeof rawPassword === "string"
          ? Redacted.make(rawPassword)
          : undefined;
  const passwordSlot = `secret:${id}:password`;
  return Effect.gen(function* () {
    if (
      options.service === "database" &&
      options.createPassword !== false &&
      !slots.some((entry) => entry.slot === passwordSlot)
    )
      slots.push({
        slot: passwordSlot,
        policy: "managed",
        ...(password === undefined
          ? { generator: { kind: "random-base64url", bytes: 32 } satisfies SecretGenerator }
          : { value: password }),
      });
    const config = yield* (() => {
      switch (options.service) {
        case "database":
          return compileServiceCapability(
            DatabaseModule,
            options.config,
            context.projectRoot,
            context.path,
            id,
            slots,
            context.previousVersion,
          );
        case "rest":
          return compileServiceCapability(
            RestModule,
            options.config,
            context.projectRoot,
            context.path,
            id,
            slots,
            context.previousVersion,
          );
        case "auth":
          return compileServiceCapability(
            AuthModule,
            options.config,
            context.projectRoot,
            context.path,
            id,
            slots,
            context.previousVersion,
          );
        case "realtime":
          return compileServiceCapability(
            RealtimeModule,
            options.config,
            context.projectRoot,
            context.path,
            id,
            slots,
            context.previousVersion,
          );
        case "storage":
          return compileServiceCapability(
            StorageModule,
            options.config,
            context.projectRoot,
            context.path,
            id,
            slots,
            context.previousVersion,
          );
        case "functions":
          return compileServiceCapability(
            FunctionsModule,
            options.config,
            context.projectRoot,
            context.path,
            id,
            slots,
            context.previousVersion,
          );
        case "studio":
          return compileServiceCapability(
            StudioModule,
            options.config,
            context.projectRoot,
            context.path,
            id,
            slots,
            context.previousVersion,
          );
        case "mail":
          return compileServiceCapability(
            MailModule,
            options.config,
            context.projectRoot,
            context.path,
            id,
            slots,
            context.previousVersion,
          );
        case "analytics":
          return compileServiceCapability(
            AnalyticsModule,
            options.config,
            context.projectRoot,
            context.path,
            id,
            slots,
            context.previousVersion,
          );
        case "pooler":
          return compileServiceCapability(
            PoolerModule,
            options.config,
            context.projectRoot,
            context.path,
            id,
            slots,
            context.previousVersion,
          );
      }
    })();
    const initializationInputs = yield* initializationInputsFor(
      id,
      options.initialization,
      context,
      slots,
    );
    attachAuthSecretGenerators(slots, context.projectRoot, undefined);
    attachManagedRandomSecretGenerators(slots);
    const artifactIdentity = serviceArtifactIdentity(
      options.service,
      config.version,
      context.runtime,
    );
    const runtimeIdentity = serviceRuntimeIdentity(
      options.service,
      config.version,
      context.runtime,
    );
    const bootstrap = module.releases[config.version]?.workloads.find(
      (workload) => workload.bootstrap !== undefined,
    );
    const bootstrapRecipeId =
      bootstrap === undefined ? undefined : `${options.service}:${bootstrap.name}`;
    return yield* completeCompiledInstance(
      options,
      id,
      config,
      endpoints === undefined ? {} : endpoints,
      slots,
      initializationInputs,
      artifactIdentity,
      bootstrapRecipeId,
      undefined,
      options.service === "database" && (password !== undefined || options.createPassword !== false)
        ? passwordSlot
        : undefined,
      runtimeIdentity,
    );
  });
};

/** Compiles one typed Effect service option after allocating its immutable identity. */
export const compileServiceInstance = (
  options: AnyEffectCreateServiceOptions,
  context: {
    readonly projectRoot: string;
    readonly path: Path.Path;
    readonly previousVersion?: string;
    readonly instanceId?: ServiceInstanceId;
    readonly registry?: PersistedServiceRegistry;
    readonly runtime: StackRuntime;
  },
): Effect.Effect<
  CompiledServiceInstance,
  InvalidStackConfigError | StackVersionUnsupportedError | PlatformError.PlatformError,
  Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const id =
      context.instanceId ??
      ServiceInstanceIdSchema.make(yield* (yield* Crypto.Crypto).randomUUIDv4);
    const slots: SecretSlotInput[] = [];
    const compiled = yield* compileService(
      options,
      id,
      context,
      slots,
      endpointValue(options.config),
    );
    const creationInputsId = yield* fingerprintCreationInputs(options);
    return {
      ...compiled,
      creationInputsId,
      instance: { ...compiled.instance, creationInputsId },
    };
  });

/** Recompiles one instance in place, retaining omitted endpoints, password and initialization. */
export const compileServiceRestart = (
  previous: CompiledServiceInstance | PersistedServiceInstance,
  config: AnyEffectServiceConfig | undefined,
  context: {
    readonly projectRoot: string;
    readonly path: Path.Path;
    readonly runtime: StackRuntime;
  },
): Effect.Effect<
  CompiledServiceInstance,
  InvalidStackConfigError | StackVersionUnsupportedError | PlatformError.PlatformError,
  Path.Path | Crypto.Crypto
> => {
  const previousInstance = "instance" in previous ? previous.instance : previous;
  const previousEndpoints = "instance" in previous ? previous.endpoints : previous.config.endpoints;
  const previousPasswordSecretRef =
    "instance" in previous
      ? previous.passwordSecretRef
      : extract(previous.config, "passwordSecretRef");
  if (config === undefined)
    return Effect.fail(
      new InvalidStackConfigError({ message: "Restart configuration is required" }),
    );
  const slots: SecretSlotInput[] = [];
  const rawPassword = extract(config, "password");
  const suppliedPassword =
    previous.service === "database" && Redacted.isRedacted(rawPassword) ? rawPassword : undefined;
  if (suppliedPassword !== undefined)
    slots.push({
      slot: `secret:${previous.id}:password`,
      policy: "managed",
      value: suppliedPassword,
    });
  const replacementEndpoints = mergeEndpointIntents(previousEndpoints, endpointValue(config));
  const compileOptions = {
    service: previous.service,
    name: previous.name,
    config,
    dependencies: previous.dependencies,
    initialization: undefined,
    createPassword: false,
  };
  return compileService(
    compileOptions,
    previous.id,
    {
      ...context,
      previousVersion: previous.config.version,
    },
    slots,
    replacementEndpoints,
  ).pipe(
    Effect.flatMap((next) => {
      const retainedPassword =
        suppliedPassword === undefined && typeof previousPasswordSecretRef === "string"
          ? previousPasswordSecretRef
          : next.passwordSecretRef;
      const nextConfig =
        retainedPassword === undefined
          ? next.instance.config
          : { ...next.instance.config, passwordSecretRef: retainedPassword };
      return Schema.decodeUnknownEffect(PersistedServiceInstanceSchema)({
        ...next.instance,
        config: nextConfig,
        initializationInputs: previousInstance.initializationInputs,
        initialization: previousInstance.initialization,
      }).pipe(
        Effect.mapError(
          (error) =>
            new InvalidStackConfigError({
              message: `Restarted service instance failed validation: ${String(error)}`,
              cause: error,
            }),
        ),
        Effect.map((instance) => ({
          ...next,
          ...(previousInstance.creationInputsId === undefined
            ? {}
            : { creationInputsId: previousInstance.creationInputsId }),
          config: instance.config,
          passwordSecretRef: retainedPassword,
          initializationInputs: previous.initializationInputs,
          instance:
            previousInstance.creationInputsId === undefined
              ? instance
              : { ...instance, creationInputsId: previousInstance.creationInputsId },
        })),
      );
    }),
  );
};

export interface SeededServiceRegistry {
  readonly registry: PersistedServiceRegistry;
  readonly secretSlots: ReadonlyArray<SecretSlotInput>;
}

const mergeSecretSlots = (
  shared: ReadonlyArray<SecretSlotInput>,
  instances: ReadonlyArray<SecretSlotInput>,
): Effect.Effect<ReadonlyArray<SecretSlotInput>, InvalidStackConfigError> => {
  const merged = new Map<string, SecretSlotInput>();
  for (const entry of [...shared, ...instances]) {
    const existing = merged.get(entry.slot);
    if (existing === undefined) {
      merged.set(entry.slot, entry);
      continue;
    }
    if (existing.policy !== entry.policy)
      return Effect.fail(
        new InvalidStackConfigError({
          message: `Secret slot ${entry.slot} has conflicting policies during service seeding`,
        }),
      );
    if (
      existing.value !== undefined &&
      entry.value !== undefined &&
      Redacted.value(existing.value) !== Redacted.value(entry.value)
    )
      return Effect.fail(
        new InvalidStackConfigError({
          message: `Secret slot ${entry.slot} has conflicting values during service seeding`,
        }),
      );
    merged.set(entry.slot, {
      ...existing,
      ...(existing.value === undefined && entry.value !== undefined ? { value: entry.value } : {}),
      ...(existing.generator === undefined && entry.generator !== undefined
        ? { generator: entry.generator }
        : {}),
    });
  }
  return Effect.succeed([...merged.values()]);
};

const seedEndpoint = (definition: StackDefinition, service: CapabilityName): unknown => {
  const listeners = definition.listeners;
  const endpoint = (
    listener: MaterializedListener | undefined,
  ): OptionalEndpointIntentLike | undefined =>
    listener === undefined
      ? undefined
      : listener.enabled
        ? {
            address: listener.address,
            port: listener.port === "automatic" ? "auto" : listener.port,
          }
        : { enabled: false };
  switch (service) {
    case "database":
      return { sql: endpoint(listeners.database) };
    case "functions":
      return { inspector: endpoint(listeners.functionsInspector) };
    case "studio":
      return { studio: endpoint(listeners.studio) };
    case "mail":
      return {
        smtp: endpoint(listeners.smtp),
        pop3: endpoint(listeners.pop3),
        mailUi: endpoint(listeners.mailUi),
      };
    case "pooler":
      return { pooler: endpoint(listeners.pooler) };
    default:
      return {};
  }
};

type OptionalEndpointIntentLike =
  | {
      readonly enabled?: true;
      readonly address?: string;
      readonly port?: "auto" | number;
    }
  | { readonly enabled: false };

/** Seeds every default through the same leaf compiler used by dynamic creation. */
export const seedServiceRegistry = (
  definition: StackDefinition,
  context: {
    readonly projectRoot: string;
    readonly path: Path.Path;
    readonly runtime: StackRuntime;
  },
  sourceConfig: StackConfig,
  sharedSecretSlots: ReadonlyArray<SecretSlotInput>,
): Effect.Effect<
  SeededServiceRegistry,
  InvalidStackConfigError | StackVersionUnsupportedError | PlatformError.PlatformError,
  Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const ids = new Map<CapabilityName, ServiceInstanceId>();
    for (const service of Object.keys(CAPABILITY_MODULES) as ReadonlyArray<CapabilityName>)
      ids.set(service, ServiceInstanceIdSchema.make(yield* crypto.randomUUIDv4));
    const compiled: CompiledServiceInstance[] = [];
    for (const service of Object.keys(CAPABILITY_MODULES) as ReadonlyArray<CapabilityName>) {
      const id = ids.get(service);
      if (id === undefined)
        return yield* new InvalidStackConfigError({ message: `Missing generated ${service} ID` });
      const sourceCapability = sourceConfig.capabilities?.[service];
      const dependencies: Record<string, ServiceInstanceId> = {};
      for (const dependency of serviceDependencyKinds[service]) {
        const dependencyId = ids.get(dependency);
        if (dependencyId === undefined)
          return yield* new InvalidStackConfigError({
            message: `Missing generated ${dependency} ID for ${service}`,
          });
        dependencies[dependency] = dependencyId;
      }
      const initialization =
        service === "database" ? sourceConfig.initialization?.database : undefined;
      const sourceSettings = extract(sourceCapability, "settings");
      const rawSettings = isRecord(sourceSettings) ? sourceSettings : undefined;
      const functionsRoot = extract(rawSettings, "functions_root");
      const normalizedSettings =
        rawSettings !== undefined && service === "functions" && typeof functionsRoot === "string"
          ? {
              ...rawSettings,
              functions_root: context.path.isAbsolute(functionsRoot)
                ? context.path.relative(context.projectRoot, functionsRoot)
                : functionsRoot,
            }
          : rawSettings;
      compiled.push(
        yield* compileService(
          {
            service,
            name: service,
            config: {
              ...sourceCapability,
              settings: normalizedSettings,
              endpoints: seedEndpoint(definition, service),
            },
            dependencies,
            initialization,
          },
          id,
          context,
          [],
          seedEndpoint(definition, service),
        ),
      );
    }
    const registry = yield* Schema.decodeEffect(PersistedServiceRegistrySchema)({
      initialized: true,
      instances: compiled.map(({ instance }) => instance),
      defaultInstanceIds: Object.fromEntries(compiled.map((entry) => [entry.service, entry.id])),
    }).pipe(
      Effect.mapError(
        (error) =>
          new InvalidStackConfigError({
            message: `Seeded service registry failed validation: ${String(error)}`,
            cause: error,
          }),
      ),
    );
    const secretSlots = yield* mergeSecretSlots(
      sharedSecretSlots,
      compiled.flatMap((entry) => entry.secretSlots),
    );
    return { registry, secretSlots };
  });

const planForDefinition = (
  runtime: StackRuntime,
  definition: StackDefinition,
  registry: PersistedServiceRegistry | undefined,
): Effect.Effect<ExecutionPlan, InvalidStackConfigError | StackVersionUnsupportedError> =>
  registry === undefined
    ? Effect.fail(
        new InvalidStackConfigError({
          message: "An initialized service registry is required to build an execution plan",
        }),
      )
    : createExecutionPlan(runtime, registry);

export const compileStack = (
  input: CompileStackInput,
  previous?: PreviousCompilation,
): Effect.Effect<
  CompiledStack,
  InvalidStackConfigError | StackVersionUnsupportedError,
  Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* validateFunctionKeys(input.config ?? {});
    const config = yield* decodeConfig(input.config ?? {});
    yield* validateDatabaseHealthTimeout(config);
    yield* validatePoolerKeys(config);
    yield* validateStorageFileSizes(config);
    const jwtSecret = yield* canonicalJwtSecret(config);
    const rawCapabilities = isRecord(config.capabilities) ? config.capabilities : {};
    const slots: SecretSlotInput[] = [];
    const databaseResult = yield* materializeCapability(
      DatabaseModule,
      extract(rawCapabilities, "database"),
      input.projectRoot,
      path,
      slots,
      false,
      previous?.definition.capabilities.database.version,
    );
    const restResult = yield* materializeCapability(
      RestModule,
      extract(rawCapabilities, "rest"),
      input.projectRoot,
      path,
      slots,
      false,
      previous?.definition.capabilities.rest.version,
    );
    const authResult = yield* materializeCapability(
      AuthModule,
      extract(rawCapabilities, "auth"),
      input.projectRoot,
      path,
      slots,
      false,
      previous?.definition.capabilities.auth.version,
    );
    // The shared API listener uses these keys even when the Auth workload is disabled.
    ensureManagedSlots(authResult.settings, AuthModule, true, slots);
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
      slots,
      false,
      previous?.definition.capabilities.realtime.version,
    );
    const storageResult = yield* materializeCapability(
      StorageModule,
      extract(rawCapabilities, "storage"),
      input.projectRoot,
      path,
      slots,
      false,
      previous?.definition.capabilities.storage.version,
    );
    const functionsResult = yield* materializeCapability(
      FunctionsModule,
      extract(rawCapabilities, "functions"),
      input.projectRoot,
      path,
      slots,
      true,
      previous?.definition.capabilities.functions.version,
    );
    const studioResult = yield* materializeCapability(
      StudioModule,
      extract(rawCapabilities, "studio"),
      input.projectRoot,
      path,
      slots,
      false,
      previous?.definition.capabilities.studio.version,
    );
    const mailResult = yield* materializeCapability(
      MailModule,
      extract(rawCapabilities, "mail"),
      input.projectRoot,
      path,
      slots,
      false,
      previous?.definition.capabilities.mail.version,
    );
    const analyticsResult = yield* materializeCapability(
      AnalyticsModule,
      extract(rawCapabilities, "analytics"),
      input.projectRoot,
      path,
      slots,
      false,
      previous?.definition.capabilities.analytics.version,
    );
    const poolerResult = yield* materializeCapability(
      PoolerModule,
      extract(rawCapabilities, "pooler"),
      input.projectRoot,
      path,
      slots,
      false,
      previous?.definition.capabilities.pooler.version,
    );
    const capabilities = {
      database: databaseResult,
      rest: restResult,
      auth: authResult,
      realtime: realtimeResult,
      storage: storageResult,
      functions: functionsResult,
      studio: studioResult,
      mail: mailResult,
      analytics: analyticsResult,
      pooler: poolerResult,
    };
    const rawListeners = isRecord(config.listeners) ? config.listeners : {};
    const listeners = {
      api: materializeListener(rawListeners.api, true),
      database: materializeListener(rawListeners.database, true),
      pooler: materializeListener(rawListeners.pooler, true),
      studio: materializeListener(rawListeners.studio, true),
      mailUi: materializeListener(rawListeners.mailUi, true),
      smtp: materializeListener(rawListeners.smtp, false),
      pop3: materializeListener(rawListeners.pop3, false),
      functionsInspector: materializeListener(rawListeners.functionsInspector, false),
    } satisfies Record<PortField, MaterializedListener>;
    const rawJwt = config.security?.jwt;
    const configuredAuthExpiry = extract(authResult.settings, "jwt_expiry");
    const expirySeconds =
      rawJwt?.expirySeconds ??
      (typeof configuredAuthExpiry === "number" ? configuredAuthExpiry : 3_600);
    if (!Number.isSafeInteger(expirySeconds) || expirySeconds <= 0)
      return yield* new InvalidStackConfigError({
        message: "JWT expiry must be a finite positive integer",
      });
    ensureCanonicalJwtSlot(slots, jwtSecret);
    attachAuthSecretGenerators(slots, input.projectRoot, rawJwt?.signing);
    attachManagedRandomSecretGenerators(slots);
    const security = {
      jwt: {
        issuer: rawJwt?.issuer ?? null,
        expirySeconds,
        signing:
          rawJwt?.signing?.kind === "jwks-file"
            ? slotsFor<JwtSigning>(rawJwt.signing, "security.jwt.signing", slots)
            : { kind: "symmetric" as const, secret: { slot: AUTH_JWT_SECRET_SLOT } },
      },
    };
    const definition: StackDefinition = {
      preparation: config.preparation ?? "background",
      capabilities,
      listeners,
      security,
      ...(config.initialization === undefined ? {} : { initialization: config.initialization }),
    };
    const executionPlan =
      input.registry === undefined
        ? undefined
        : yield* planForDefinition(input.runtime, definition, input.registry);
    return { definition, sourceConfig: config, secrets: slots, executionPlan };
  });

/** Compares two complete materialized definitions by their canonical schema representation. */
export const sameDefinition = (left: StackDefinition, right: StackDefinition): boolean =>
  canonical(left) === canonical(right);
