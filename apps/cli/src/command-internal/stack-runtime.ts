import { defaultRuntime } from "@supabase/stack/internal/artifacts";

/** Selects native execution where the catalog publishes portable artifacts. */
export const defaultStackRuntime = (runtime: {
  readonly platform: string;
  readonly arch: string;
}): "native" | "docker" => defaultRuntime({ os: runtime.platform, arch: runtime.arch });
