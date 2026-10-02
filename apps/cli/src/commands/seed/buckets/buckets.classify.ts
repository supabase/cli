/**
 * Vector-bucket error classifiers based on the Storage gateway's error message text, which
 * reproduces `Error status <d>: <body>`.
 */

/** True when the remote region has not enabled vector buckets yet. */
export function isVectorBucketsFeatureNotEnabled(message: string): boolean {
  return message.includes("FeatureNotEnabled");
}

/**
 * True when the local Storage service does not expose the vector routes: either it reports the
 * vector service is not configured, or `ListVectorBuckets` returns 404 (older local image without
 * vector support).
 */
export function isLocalVectorBucketsUnavailable(message: string): boolean {
  return (
    message.includes("Vector service not configured") ||
    (message.includes("Error status 404:") &&
      message.includes("Route POST:") &&
      message.includes("ListVectorBuckets"))
  );
}
