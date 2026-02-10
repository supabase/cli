import createClient from "openapi-fetch";
import type { paths } from "./v1.d.ts";

export function createApiClient(options: { baseUrl: string; accessToken: string }) {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
    },
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
