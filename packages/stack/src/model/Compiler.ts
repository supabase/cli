import { Duration, Effect, Path, Redacted, Schema } from "effect";
import { InvalidStackConfigError, StackVersionUnsupportedError } from "../public/Errors.ts";
import { StackConfigSchema, type StackConfig } from "../public/Config.ts";
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
import type { SecretGenerator, SecretJwtSigning } from "../state/SecretStore.ts";
import { AUTH_JWT_SECRET_SLOT, DATABASE_INTERNAL_PASSWORD_SLOT } from "../state/SecretStore.ts";

interface SecretSlot {
  readonly slot: string;
}

export interface StackDefinition {
  readonly capabilities: MaterializedCapabilities;
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

/** Internal credentials are not user settings but still need durable managed slots. */
const INTERNAL_MANAGED_SECRET_SLOTS = [DATABASE_INTERNAL_PASSWORD_SLOT] as const;

export interface CompiledStack {
  readonly definition: StackDefinition;
  readonly secrets: ReadonlyArray<SecretSlotInput>;
  readonly executionPlan: ExecutionPlan;
}

export interface PreviousCompilation {
  readonly definition: StackDefinition;
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
  // Realtime encrypts with AES-128-ECB and consumes this value as a raw 16-byte key.
  // Twelve random bytes encode to exactly sixteen unpadded base64url characters.
  "secret:realtime.settings.db_enc_key": { kind: "random-base64url", bytes: 12 },
  "secret:realtime.settings.secret_key_base": { kind: "random-base64url", bytes: 48 },
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
  const release = module.releases[selector];
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
): { enabled: boolean; activation: "eager" | "lazy"; settings: unknown; raw: unknown } => {
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
  slots: SecretSlotInput[],
  normalizeFunctions: boolean,
  previousVersion?: string,
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
    const slotted = slotsFor(merged, `${module.name}.settings`, slots, module.secretPolicy);
    const completeSettings = ensureManagedSlots(slotted, module, selected.enabled, slots);
    const version = yield* releaseFor(module, selected.raw, previousVersion);
    return {
      enabled: selected.enabled,
      activation: selected.activation,
      version,
      settings: completeSettings,
    };
  });
};

const planForDefinition = (
  runtime: StackRuntime,
  definition: StackDefinition,
): Effect.Effect<ExecutionPlan, InvalidStackConfigError | StackVersionUnsupportedError> =>
  createExecutionPlan(runtime, definition.capabilities);

/** Rebuilds the private execution plan from a persisted, fully materialized definition. */
export const rebuildExecutionPlan = (
  runtime: StackRuntime,
  definition: StackDefinition,
): Effect.Effect<ExecutionPlan, InvalidStackConfigError | StackVersionUnsupportedError> =>
  planForDefinition(runtime, definition);

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
    for (const slot of INTERNAL_MANAGED_SECRET_SLOTS) slots.push({ slot, policy: "managed" });
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
    const executionPlan = yield* planForDefinition(input.runtime, definition);
    return { definition, secrets: slots, executionPlan };
  });

export const canonicalize = canonical;

/** Compares two complete materialized definitions by their canonical schema representation. */
export const sameDefinition = (left: StackDefinition, right: StackDefinition): boolean =>
  canonical(left) === canonical(right);
