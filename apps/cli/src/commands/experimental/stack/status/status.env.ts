import { Effect } from "effect";
import type { StackCredentials } from "@supabase/stack/effect";
import { formatEnvValue } from "../../../../command-internal/go-output.encoders.ts";
import { StackCommandStatusError } from "./status.errors.ts";

const variableNames = [
  "API_URL",
  "DB_URL",
  "ANON_KEY",
  "SERVICE_ROLE_KEY",
  "PUBLISHABLE_KEY",
  "SECRET_KEY",
  "STUDIO_URL",
  "INBUCKET_URL",
  "S3_PROTOCOL_ACCESS_KEY_ID",
  "S3_PROTOCOL_ACCESS_KEY_SECRET",
  "S3_PROTOCOL_REGION",
  "S3_PROTOCOL_URL",
] as const;

export const stackEnvOverrides = (entries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const names = new Map(variableNames.map((name) => [String(name), String(name)]));
    const sources = new Set<string>();
    for (const entry of entries) {
      const [source, target, extra] = entry.split("=");
      if (
        source === undefined ||
        !names.has(source) ||
        target === undefined ||
        extra !== undefined ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(target)
      )
        return yield* new StackCommandStatusError({
          reason: "flags",
          message:
            "--override-name must be EXPORTED_VARIABLE=VALID_ENV_NAME; for example API_URL=NEXT_PUBLIC_SUPABASE_URL.",
        });
      if (sources.has(source))
        return yield* new StackCommandStatusError({
          reason: "flags",
          message: `--override-name lists ${source} more than once.`,
        });
      sources.add(source);
      names.set(source, target);
    }
    if (new Set(names.values()).size !== names.size)
      return yield* new StackCommandStatusError({
        reason: "flags",
        message: "--override-name produces duplicate environment variable names.",
      });
    return names;
  });

export const stackEnvValues = (
  status: {
    readonly endpoints: Readonly<{
      readonly api?: { readonly url: string };
      readonly studio?: { readonly url: string };
      readonly mailUi?: { readonly url: string };
    }>;
    readonly credentials?: Pick<
      StackCredentials,
      "publishableKey" | "secretKey" | "anonKey" | "serviceRoleKey"
    >;
  },
  credentials: Readonly<Record<string, string>>,
  names: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {};
  if (credentials.databaseUrl !== undefined) values.DB_URL = credentials.databaseUrl;
  if (status.credentials !== undefined) {
    values.ANON_KEY = status.credentials.anonKey;
    values.SERVICE_ROLE_KEY = status.credentials.serviceRoleKey;
    values.PUBLISHABLE_KEY = status.credentials.publishableKey;
    values.SECRET_KEY = status.credentials.secretKey;
  }
  if (status.endpoints.api !== undefined) values.API_URL = status.endpoints.api.url;
  if (status.endpoints.studio !== undefined) values.STUDIO_URL = status.endpoints.studio.url;
  if (status.endpoints.mailUi !== undefined) values.INBUCKET_URL = status.endpoints.mailUi.url;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [names.get(key) ?? key, value]),
  );
};

/** Encodes values in the same dotenv shape as `status -o env`, sorted by key. */
export const encodeStackEnv = (values: Readonly<Record<string, string>>): string => {
  const lines = Object.keys(values)
    .sort()
    .map((name) => `${name}=${formatEnvValue(values[name] ?? "")}`);
  return `${lines.join("\n")}\n`;
};
