import {
  GenTypesGenerationError,
  GenTypesToolFailedError,
  GenTypesToolNotInstalledError,
} from "./types.generator.service.ts";

/**
 * Whether a direct-generation failure came before introspection ran. The generator's own errors
 * mean the database answered: the Management API would hit the same schema, so they never fall
 * back. Everything else that reaches the fallback (config and search-path resolution, libpq
 * environment, login role, connection resolution, pooler, dial, TLS, authentication) never got
 * that far.
 */
export const failedBeforeIntrospection = (error: unknown): boolean =>
  !(
    error instanceof GenTypesGenerationError ||
    error instanceof GenTypesToolFailedError ||
    error instanceof GenTypesToolNotInstalledError
  );

const firstLine = (message: string) => message.split("\n", 1)[0]?.trim() ?? "";

export const apiFallbackWarning = (error: {
  readonly message: string;
  readonly suggestion?: string;
}) =>
  [
    `Warning: Could not generate types from the project database (${firstLine(error.message)}), ` +
      "so these types come from the Management API: they do not apply [api].extra_search_path " +
      "or the CLI's generator.",
    ...(error.suggestion === undefined || error.suggestion.trim().length === 0
      ? []
      : [error.suggestion.trim()]),
    "This fallback is removed in the next major version.",
  ].join("\n");
