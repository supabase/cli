const functionSlugPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const invalidFunctionSlugDetail =
  "Invalid Function name. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (^[A-Za-z][A-Za-z0-9_-]*$)";

export function validateFunctionSlugMessage(slug: string): string | undefined {
  return functionSlugPattern.test(slug) ? undefined : invalidFunctionSlugDetail;
}

// Registration order matches Go's `functionsDeployCmd`/`functionsDownloadCmd`
// `MarkFlagsMutuallyExclusive("use-api", "use-docker", "legacy-bundle")`
// (`cmd/functions.go:158,182`).
export const FUNCTIONS_BUNDLER_MUTEX_GROUP = ["use-api", "use-docker", "legacy-bundle"] as const;
