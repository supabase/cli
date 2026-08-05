import type { LoadedProjectConfig, ProjectConfig, ProjectEnvironment } from "@supabase/config";
import type { RealtimeConfig } from "@supabase/stack/effect";
import { resolveEnumOverride, resolveUintOverride } from "./data-plane-stack-config-values.ts";

export function resolveRealtimeStackConfig(input: {
  readonly loaded: LoadedProjectConfig | null;
  readonly config: ProjectConfig["realtime"];
  readonly environment: ProjectEnvironment | null;
  readonly base: RealtimeConfig | false | undefined;
}): RealtimeConfig | false {
  const ipVersion = resolveEnumOverride<"IPv4" | "IPv6">({
    loaded: input.loaded,
    environment: input.environment,
    configured: input.config.ip_version,
    path: "realtime.ip_version",
    values: ["IPv4", "IPv6"],
  });
  const maxHeaderLength = resolveUintOverride({
    loaded: input.loaded,
    environment: input.environment,
    configured: input.config.max_header_length,
    path: "realtime.max_header_length",
  });

  return input.base === false ? false : { ...input.base, ipVersion, maxHeaderLength };
}
