/**
 * Oxlint plugin that keeps Management API calls on the typed `@supabase/api` client.
 *
 * `no-raw-management-api-url` flags string and template literals that start a `/v1/`, `/v2/` or
 * `/platform/` path because such requests skip the `api.operation` span that per-command route
 * detection reads.
 */

const MESSAGE =
  "Build Management API requests with the typed `@supabase/api` client (`api.v1.*`, `execute`/`executeRaw`) so the call emits the `api.operation` span; do not assemble `/v1/`, `/v2/` or `/platform/` URLs by hand.";

// OTLP exporters use `/v1/traces`, `/v1/metrics` and `/v1/logs`, which are not Management API
// routes.
const OTLP_SIGNAL = "(?!v1/(?:traces|metrics|logs)(?:/|$))";

// A path that begins at its first segment with a Management API prefix, optionally behind an
// absolute origin. Service-scoped prefixes such as `/auth/v1/` and `/storage/v1/` start with a
// different segment and never match.
const LEADING_PATH = new RegExp(`^(?:https?://[^/]*)?/${OTLP_SIGNAL}(?:v[12]|platform)(?:/|$)`);

// The same path continuing a string whose base was interpolated or concatenated before it.
const CONTINUED_PATH = new RegExp(`^/${OTLP_SIGNAL}(?:v[12]|platform)(?:/|$)`);

function quasiText(quasi) {
  return quasi.value.cooked ?? quasi.value.raw;
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-built Management API URLs outside the typed `@supabase/api` client.",
    },
  },
  create(context) {
    const report = (node) => context.report({ node, message: MESSAGE });

    return {
      Literal(node) {
        if (typeof node.value === "string" && LEADING_PATH.test(node.value)) {
          report(node);
        }
      },
      TemplateLiteral(node) {
        const matches = node.quasis.some((quasi, index) => {
          const text = quasiText(quasi);
          return index === 0 ? LEADING_PATH.test(text) : CONTINUED_PATH.test(text);
        });
        if (matches) {
          report(node);
        }
      },
    };
  },
};

export default {
  meta: { name: "supabase" },
  rules: { "no-raw-management-api-url": rule },
};
