import { Effect } from "effect";
import type { StackCredentials } from "@supabase/stack/effect";
import { connectionEnv, type StackConnections } from "../stack-summary.ts";
import { StackCommandStatusError } from "./status.errors.ts";

const variableNames = [
  "API_URL",
  "REST_URL",
  "FUNCTIONS_URL",
  "DB_URL",
  "STUDIO_URL",
  "MCP_URL",
  "MAILPIT_URL",
  "INBUCKET_URL",
  "PUBLISHABLE_KEY",
  "SECRET_KEY",
  "ANON_KEY",
  "SERVICE_ROLE_KEY",
  "STORAGE_S3_URL",
  "S3_PROTOCOL_ACCESS_KEY_ID",
  "S3_PROTOCOL_ACCESS_KEY_SECRET",
  "S3_PROTOCOL_REGION",
] as const;

/** Names the stack backend used to export, since removed; still worth naming in errors. */
const removedVariableNames = new Set(["S3_PROTOCOL_URL"]);

export const stackEnvOverrides = (entries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const names = new Map(variableNames.map((name) => [String(name), String(name)]));
    const sources = new Set<string>();
    for (const entry of entries) {
      const [source, target, extra] = entry.split("=");
      if (
        source === undefined ||
        target === undefined ||
        extra !== undefined ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(target)
      )
        return yield* new StackCommandStatusError({
          reason: "flags",
          message: `--override-name entry "${entry}" must be EXPORTED_VARIABLE=VALID_ENV_NAME; for example API_URL=NEXT_PUBLIC_SUPABASE_URL.`,
        });
      if (!names.has(source))
        return yield* new StackCommandStatusError({
          reason: "flags",
          message: removedVariableNames.has(source)
            ? `--override-name entry "${entry}" refers to ${source}, which is not exported by the stack backend.`
            : `--override-name entry "${entry}" refers to ${source}, which is not an exported variable; valid variables are ${variableNames.join(", ")}.`,
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

/** The `status --env` variable map, with `--override-name` remapping applied. */
export const stackEnvValues = (
  connections: StackConnections,
  credentials:
    | Pick<StackCredentials, "publishableKey" | "secretKey" | "anonKey" | "serviceRoleKey">
    | undefined,
  names: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(connectionEnv(connections, credentials)).map(([key, value]) => [
      names.get(key) ?? key,
      value,
    ]),
  );

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
