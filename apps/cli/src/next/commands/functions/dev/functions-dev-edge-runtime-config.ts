import {
  loadProjectConfig,
  loadProjectEnvironment,
  resolveProjectSubtree,
  type ProjectConfig,
} from "@supabase/config";
import type { EdgeRuntimeConfig } from "@supabase/stack/effect";
import { Data, Effect, Redacted } from "effect";
import { ProjectHome } from "../../../config/project-home.service.ts";

type ResolvedSecretValue = string | Redacted.Redacted<string>;
type EdgeRuntimePolicy = "oneshot" | "per_worker";

interface ResolvedProjectEdgeRuntimeConfig {
  readonly enabled: ProjectConfig["edge_runtime"]["enabled"];
  readonly inspector_port: ProjectConfig["edge_runtime"]["inspector_port"];
  readonly policy: ResolvedSecretValue;
  readonly secrets?: Readonly<Record<string, ResolvedSecretValue>>;
}

export class FunctionsDevEdgeRuntimeDisabledError extends Data.TaggedError(
  "FunctionsDevEdgeRuntimeDisabledError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return `${this.detail}\n  Suggestion: ${this.suggestion}`;
  }
}

export interface ResolvedFunctionsDevEdgeRuntimeConfig {
  readonly config: EdgeRuntimeConfig;
  readonly fingerprint: string;
}

function revealSecret(value: ResolvedSecretValue): string {
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
}

function normalizePolicy(value: ResolvedSecretValue): EdgeRuntimePolicy {
  const policy = revealSecret(value);
  if (policy === "oneshot" || policy === "per_worker") {
    return policy;
  }
  return "per_worker";
}

function normalizeSecrets(
  secrets: Readonly<Record<string, ResolvedSecretValue>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets ?? {})) {
    env[key.toUpperCase()] = revealSecret(value);
  }
  return env;
}

function stableRecord(
  record: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function fingerprintEdgeRuntimeConfig(config: EdgeRuntimeConfig): string {
  return JSON.stringify({
    enabled: config.enabled,
    inspectorPort: config.inspectorPort,
    policy: config.policy,
    env: stableRecord(config.env),
  });
}

function toStackEdgeRuntimeConfig(config: ResolvedProjectEdgeRuntimeConfig): EdgeRuntimeConfig {
  return {
    enabled: config.enabled,
    inspectorPort: config.inspector_port,
    policy: normalizePolicy(config.policy),
    env: normalizeSecrets(config.secrets),
  };
}

export const resolveFunctionsDevEdgeRuntimeConfig = Effect.fnUntraced(function* () {
  const projectHome = yield* ProjectHome;
  const loadedConfig = yield* loadProjectConfig(projectHome.projectRoot);

  if (loadedConfig === null) {
    const config = {};
    return {
      config,
      fingerprint: fingerprintEdgeRuntimeConfig(config),
    };
  }

  const projectEnv = yield* loadProjectEnvironment({
    cwd: projectHome.projectRoot,
    baseEnv: process.env,
  });

  if (projectEnv === null) {
    const config = {};
    return {
      config,
      fingerprint: fingerprintEdgeRuntimeConfig(config),
    };
  }

  const resolved = yield* resolveProjectSubtree(
    loadedConfig.config.edge_runtime,
    projectEnv,
    "edge_runtime",
  );
  const config = toStackEdgeRuntimeConfig(resolved);

  if (config.enabled === false) {
    return yield* Effect.fail(
      new FunctionsDevEdgeRuntimeDisabledError({
        detail: "`supabase functions dev` requires edge_runtime.enabled to be true.",
        suggestion: "Set edge_runtime.enabled to true or remove the override, then save again.",
      }),
    );
  }

  return {
    config,
    fingerprint: fingerprintEdgeRuntimeConfig(config),
  } satisfies ResolvedFunctionsDevEdgeRuntimeConfig;
});
