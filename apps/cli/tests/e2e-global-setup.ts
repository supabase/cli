import { prefetch } from "@supabase/stack";

const CLI_E2E_WARMUP_SERVICES = ["postgres", "postgrest", "auth"] as const;

export default async function globalSetup() {
  await prefetch({ services: CLI_E2E_WARMUP_SERVICES });
}
