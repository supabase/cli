import { Crypto, Effect, Path, Redacted, Schema } from "effect";
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
import { DatabaseVersionMap } from "./capabilities/database.ts";
import {
  AuthModule,
  DatabaseModule,
  FunctionsModule,
  MailModule,
  PoolerModule,
  RealtimeModule,
  RestModule,
  StorageModule,
  StudioModule,
  AnalyticsModule,
} from "./capabilities/index.ts";
import { CAPABILITY_MODULES, createExecutionPlan, type ExecutionPlan } from "./ExecutionPlan.ts";
import type { CapabilityModule } from "./CapabilityModule.ts";

export type InputFingerprint = Schema.Schema.Type<typeof InputFingerprintSchema>;
const InputFingerprintSchema = Schema.String.pipe(Schema.brand("InputFingerprint"));

export interface SecretSlot {
  readonly slot: string;
}

type MaterializedValue<T> = [T] extends [Redacted.Redacted<unknown>]
  ? SecretSlot
  : T extends ReadonlyArray<infer Item>
    ? ReadonlyArray<MaterializedValue<Item>>
    : T extends object
      ? {
          readonly [Key in keyof T]-?:
            | MaterializedValue<Exclude<T[Key], undefined>>
            | (undefined extends T[Key] ? null : never);
        }
      : T;

export type MaterializedSettings<T> = MaterializedValue<T>;

export interface MaterializedCapability<T> {
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

export type MaterializedJwtSigning =
  | { readonly kind: "symmetric"; readonly secret: SecretSlot }
  | { readonly kind: "jwks-file"; readonly path: string }
  | null;

export interface MaterializedListener {
  readonly enabled: boolean;
  readonly address: string;
  readonly port: "automatic" | number;
}

export interface SecretSlotInput {
  readonly slot: string;
  readonly value: Redacted.Redacted<unknown>;
}

export interface CompiledStack {
  readonly definition: StackDefinition;
  readonly inputFingerprint: InputFingerprint;
  readonly secrets: ReadonlyArray<SecretSlotInput>;
  readonly executionPlan: ExecutionPlan;
}

export interface PreviousCompilation {
  readonly definition: StackDefinition;
  readonly inputFingerprint: InputFingerprint;
  readonly executionPlan?: ExecutionPlan;
  readonly secrets?: ReadonlyArray<SecretSlotInput>;
}

export interface CompileStackInput {
  readonly projectRoot: string;
  readonly runtime: StackRuntime;
  readonly config?: StackConfig;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
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

function slotsFor<T>(value: T, path: string, slots: SecretSlotInput[]): MaterializedSettings<T>;
function slotsFor(value: unknown, path: string, slots: SecretSlotInput[]): unknown {
  if (Redacted.isRedacted(value)) {
    slots.push({ slot: `secret:${path}`, value });
    return { slot: `secret:${path}` };
  }
  if (Array.isArray(value))
    return value.map((entry, index) => slotsFor(entry, `${path}.${index}`, slots));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      result[key] = slotsFor(value[key], `${path}.${key}`, slots);
    return result;
  }
  return value;
}

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

const versionFor = (
  name: CapabilityName,
  raw: unknown,
): Effect.Effect<string, StackVersionUnsupportedError> => {
  const selected = extract(raw, "version");
  const requested = typeof selected === "string" && selected.length > 0 ? selected : undefined;
  if (name === "database") {
    const value = requested ?? "17";
    for (const [key, version] of Object.entries(DatabaseVersionMap))
      if (key === value) return Effect.succeed(version);
    return Effect.fail(
      new StackVersionUnsupportedError({
        capability: name,
        version: value,
        message: `Unsupported database version: ${value}`,
      }),
    );
  }
  const fallback = CAPABILITY_MODULES[name].workloads[0]?.artifacts.native.release ?? "";
  const value = requested ?? fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))
    return Effect.fail(
      new StackVersionUnsupportedError({
        capability: name,
        version: value,
        message: `Unsupported ${name} version: ${value}`,
      }),
    );
  return Effect.succeed(value);
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
  MaterializedCapability<T>,
  InvalidStackConfigError | StackVersionUnsupportedError,
  Path.Path | Crypto.Crypto
> => {
  const selected = enabledSettings(module.name, { [module.name]: raw });
  const mergedInput = merge(module.defaultSettings, selected.settings);
  const normalized = normalizeFunctions
    ? materializeFunctionsRoot(mergedInput, projectRoot, path)
    : Effect.succeed(mergedInput);
  return Effect.gen(function* () {
    const normalizedSettings = yield* normalized;
    const merged = materializeAbsence(normalizedSettings);
    const slotted = slotsFor(merged, `${module.name}.settings`, slots);
    const version = yield* versionFor(module.name, selected.raw);
    for (const entry of module.workloads) {
      const bytes = yield* crypto.digest(
        "SHA-256",
        new TextEncoder().encode(canonical({ workload: entry, version, settings: slotted })),
      );
      specHashes.set(`${module.name}:${entry.name}`, digestHex(bytes));
    }
    return {
      enabled: selected.enabled,
      activation: selected.activation,
      version,
      settings: slotted,
    };
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new InvalidStackConfigError({ message: error.message })),
    ),
  );
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
    const config = yield* decodeConfig(input.config ?? {});
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
    const slots: SecretSlotInput[] = [];
    const specHashes = new Map<string, string>();
    const database = yield* materializeCapability(
      DatabaseModule,
      extract(rawCapabilities, "database"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const rest = yield* materializeCapability(
      RestModule,
      extract(rawCapabilities, "rest"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const auth = yield* materializeCapability(
      AuthModule,
      extract(rawCapabilities, "auth"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const realtime = yield* materializeCapability(
      RealtimeModule,
      extract(rawCapabilities, "realtime"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const storage = yield* materializeCapability(
      StorageModule,
      extract(rawCapabilities, "storage"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const functions = yield* materializeCapability(
      FunctionsModule,
      extract(rawCapabilities, "functions"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      true,
    );
    const studio = yield* materializeCapability(
      StudioModule,
      extract(rawCapabilities, "studio"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const mail = yield* materializeCapability(
      MailModule,
      extract(rawCapabilities, "mail"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const analytics = yield* materializeCapability(
      AnalyticsModule,
      extract(rawCapabilities, "analytics"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
    const pooler = yield* materializeCapability(
      PoolerModule,
      extract(rawCapabilities, "pooler"),
      input.projectRoot,
      path,
      crypto,
      slots,
      specHashes,
      false,
    );
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
    for (const name of CAPABILITY_NAMES) {
      if (!enabled[name].enabled) continue;
      for (const dependency of CAPABILITY_MODULES[name].dependencies) {
        if (!enabled[dependency].enabled)
          return yield* new InvalidStackConfigError({
            message: `${name} requires disabled capability ${dependency}`,
            capability: name,
            dependency,
          });
      }
    }
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
    const security = {
      jwt: {
        issuer: rawJwt?.issuer ?? null,
        signing:
          rawJwt?.signing === undefined
            ? null
            : slotsFor<JwtSigning>(rawJwt.signing, "security.jwt.signing", slots),
      },
    };
    const definition: StackDefinition = {
      capabilities,
      listeners,
      security,
    };
    const executionPlan = createExecutionPlan(input.runtime, enabled, specHashes);
    if (previous?.inputFingerprint === inputFingerprint)
      return {
        definition: previous.definition,
        inputFingerprint,
        secrets: slots,
        executionPlan: previous.executionPlan ?? executionPlan,
      };
    return { definition, inputFingerprint, secrets: slots, executionPlan };
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new InvalidStackConfigError({ message: error.message })),
    ),
  );

export const canonicalize = canonical;
