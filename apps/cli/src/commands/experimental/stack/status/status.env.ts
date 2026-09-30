import { Effect } from "effect";
import type { StackCredentials } from "@supabase/stack/effect";
import type { StackConnections } from "../stack-summary.ts";
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
  "MCP_URL",
  "S3_PROTOCOL_ACCESS_KEY_ID",
  "S3_PROTOCOL_ACCESS_KEY_SECRET",
  "S3_PROTOCOL_REGION",
  "STORAGE_S3_URL",
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
    readonly urls: Pick<StackConnections, "api" | "studio" | "mailpit" | "mcp" | "s3">;
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
  if (status.urls.api !== undefined) values.API_URL = status.urls.api;
  if (status.urls.studio !== undefined) values.STUDIO_URL = status.urls.studio;
  if (status.urls.mcp !== undefined) values.MCP_URL = status.urls.mcp;
  if (status.urls.mailpit !== undefined) values.INBUCKET_URL = status.urls.mailpit;
  if (status.urls.s3 !== undefined) {
    values.STORAGE_S3_URL = status.urls.s3.url;
    values.S3_PROTOCOL_ACCESS_KEY_ID = status.urls.s3.accessKeyId;
    values.S3_PROTOCOL_ACCESS_KEY_SECRET = status.urls.s3.secretAccessKey;
    values.S3_PROTOCOL_REGION = status.urls.s3.region;
  }
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [names.get(key) ?? key, value]),
  );
};

const dotenvQuote = (value: string): string | undefined => {
  if (!value.includes("'")) return "'";
  if (!/["\\$`!]/u.test(value)) return '"';
  return undefined;
};

/**
 * Quotes so that both dotenv parsers and a shell that sources the file read every
 * value literally: double quotes are used only without `"`, `\`, `$`, backtick, or
 * `!`, and backticks are never a delimiter.
 */
export const encodeStackEnv = (values: Readonly<Record<string, string>>) =>
  Effect.forEach(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
    ([name, value]) => {
      const quote = dotenvQuote(value);
      if (quote === undefined || value.includes("\r"))
        return Effect.fail(
          new StackCommandStatusError({
            reason: "output",
            message:
              "A credential cannot be written safely as dotenv. Use --env --output-format json.",
          }),
        );
      return Effect.succeed(`${name}=${quote}${value}${quote}`);
    },
  ).pipe(Effect.map((lines) => `${lines.join("\n")}\n`));
