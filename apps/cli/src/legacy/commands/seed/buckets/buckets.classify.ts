/**
 * Vector-bucket error classifiers — ports of `isVectorBucketsFeatureNotEnabled`
 * and `isLocalVectorBucketsUnavailable` (`apps/cli-go/internal/seed/buckets/buckets.go:71-84`).
 *
 * Both inspect the error message string. The Storage gateway client raises
 * status errors whose message reproduces Go's `Error status <d>: <body>`, so the
 * same substring checks apply.
 */

/** Remote region has not enabled vector buckets yet (`buckets.go:71-73`). */
export function legacyIsVectorBucketsFeatureNotEnabled(message: string): boolean {
  return message.includes("FeatureNotEnabled");
}

/**
 * The local Storage service does not expose the vector routes (`buckets.go:75-84`):
 * either it reports the vector service is not configured, or the `ListVectorBuckets`
 * route returns 404 (older local image without vector support).
 */
export function legacyIsLocalVectorBucketsUnavailable(message: string): boolean {
  return (
    message.includes("Vector service not configured") ||
    (message.includes("Error status 404:") &&
      message.includes("Route POST:") &&
      message.includes("ListVectorBuckets"))
  );
}
