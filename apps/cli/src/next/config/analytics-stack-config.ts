import type { ProjectConfig, ProjectEnvironment } from "@supabase/config";
import type { AnalyticsConfig } from "@supabase/stack/effect";
import { resolve } from "node:path";
import {
  environmentOverride,
  invalidDataPlaneConfig,
  resolveBooleanOverride,
  resolveEnumOverride,
} from "./data-plane-stack-config-values.ts";

function required(value: string | undefined, path: string): string {
  if (value === undefined || value.length === 0 || /^env\([^)]+\)$/.test(value)) {
    throw invalidDataPlaneConfig(path, "Provide a non-empty value when Analytics uses BigQuery.");
  }
  return value;
}

export function resolveAnalyticsStackConfig(input: {
  readonly config: ProjectConfig["analytics"];
  readonly environment: ProjectEnvironment | null;
  readonly configDir: string;
  readonly base: AnalyticsConfig | false | undefined;
}): AnalyticsConfig | false {
  const enabled = resolveBooleanOverride({
    environment: input.environment,
    envName: "SUPABASE_ANALYTICS_ENABLED",
    configured: input.config.enabled,
    path: "analytics.enabled",
  });
  const backend = resolveEnumOverride<"postgres" | "bigquery">({
    environment: input.environment,
    envName: "SUPABASE_ANALYTICS_BACKEND",
    configured: input.config.backend,
    path: "analytics.backend",
    values: ["postgres", "bigquery"],
  });
  const gcp =
    enabled && backend === "bigquery"
      ? {
          projectId: required(
            environmentOverride(
              "SUPABASE_ANALYTICS_GCP_PROJECT_ID",
              input.config.gcp_project_id,
              input.environment,
            ),
            "analytics.gcp_project_id",
          ),
          projectNumber: required(
            environmentOverride(
              "SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER",
              input.config.gcp_project_number,
              input.environment,
            ),
            "analytics.gcp_project_number",
          ),
          credentialsPath: resolve(
            input.configDir,
            required(
              environmentOverride(
                "SUPABASE_ANALYTICS_GCP_JWT_PATH",
                input.config.gcp_jwt_path,
                input.environment,
              ),
              "analytics.gcp_jwt_path",
            ),
          ),
        }
      : undefined;

  return input.base === false ? false : { ...input.base, backend, gcp };
}
