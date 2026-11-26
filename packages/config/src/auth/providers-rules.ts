import type { CliConfigTableRuleIssue } from "../lib/table-rule-issue.ts";

export interface ExternalProviderInput {
  readonly enabled: boolean;
  readonly client_id: string;
  readonly secret?: string;
}

export const secretOptional = (id: string) => id === "apple" || id === "google";

function providerRequirements(id: string) {
  return [
    ["client_id", (value: ExternalProviderInput) => value.client_id !== ""],
    ...(secretOptional(id)
      ? []
      : [
          [
            "secret",
            (value: ExternalProviderInput) => value.secret !== undefined && value.secret !== "",
          ] as const,
        ]),
  ] as const;
}

/** The required-when-enabled issues of the `[auth.external.<id>]` table; paths are relative to it. */
export function cliConfigExternalProviderIssues(
  id: string,
  value: ExternalProviderInput,
  only?: "client_id" | "secret",
): ReadonlyArray<CliConfigTableRuleIssue> {
  return providerRequirements(id).flatMap(([key, isPresent]) =>
    (only !== undefined && key !== only) || !value.enabled || isPresent(value)
      ? []
      : [{ path: [key], message: `Missing required field in config: auth.external.${id}.${key}` }],
  );
}
