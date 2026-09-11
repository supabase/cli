import type { EffectStackCredentials, StackStatus } from "@supabase/stack/effect";
import { Effect, Redacted } from "effect";
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
  status: StackStatus,
  credentials: EffectStackCredentials,
  names: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {
    DB_URL: Redacted.value(credentials.database.url),
    ...(credentials.api === undefined
      ? {}
      : {
          ANON_KEY: credentials.api.anonJwt,
          SERVICE_ROLE_KEY: Redacted.value(credentials.api.serviceRoleJwt),
          PUBLISHABLE_KEY: credentials.api.publishableKey,
          SECRET_KEY: Redacted.value(credentials.api.secretKey),
        }),
    ...(status.endpoints.api === undefined ? {} : { API_URL: status.endpoints.api.url }),
    ...(status.endpoints.studio === undefined ? {} : { STUDIO_URL: status.endpoints.studio.url }),
    ...(status.endpoints.mailUi === undefined ? {} : { INBUCKET_URL: status.endpoints.mailUi.url }),
    ...(credentials.storage === undefined
      ? {}
      : {
          S3_PROTOCOL_ACCESS_KEY_ID: credentials.storage.accessKeyId,
          S3_PROTOCOL_ACCESS_KEY_SECRET: Redacted.value(credentials.storage.secretAccessKey),
          S3_PROTOCOL_REGION: credentials.storage.region,
          S3_PROTOCOL_URL: credentials.storage.endpoint,
        }),
  };
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [names.get(key) ?? key, value]),
  );
};

/** Dotenv quoting preserves URLs and keys verbatim, including literal backslashes. */
export const encodeStackEnv = (values: Readonly<Record<string, string>>) =>
  Effect.forEach(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
    ([name, value]) => {
      const quote = ["'", "`"].find((candidate) => !value.includes(candidate));
      if (quote === undefined || value.includes("\r"))
        return Effect.fail(
          new StackCommandStatusError({
            reason: "runtime",
            message:
              "A credential cannot be represented losslessly as dotenv. Use --env --output-format json.",
          }),
        );
      return Effect.succeed(`${name}=${quote}${value}${quote}`);
    },
  ).pipe(Effect.map((lines) => `${lines.join("\n")}\n`));
