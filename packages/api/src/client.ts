import createClient from "openapi-fetch";
import type { paths } from "./v1.d.ts";

export function createApiClient(options: {
  baseUrl: string;
  accessToken: string;
  version?: string;
}) {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "User-Agent": `supabase-cli/${options.version ?? "unknown"}`,
    },
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
