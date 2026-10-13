/**
 * Oxlint plugin that keeps Management API calls on the typed `@supabase/api` client.
 *
 * `no-raw-management-api-url` flags hand-built `/v1/`, `/v2/` and `/platform/` URLs because such
 * requests skip the `api.operation` span that per-command route detection reads.
 */

const MESSAGE =
  "Build Management API requests with the typed `@supabase/api` client (`api.v1.*`, `execute`/`executeRaw`) so the call emits the `api.operation` span; do not assemble `/v1/`, `/v2/` or `/platform/` URLs by hand.";

// A path that begins at its first segment with a Management API prefix, optionally behind an
// absolute origin. Service-scoped prefixes such as `/auth/v1/` and `/storage/v1/` start with a
// different segment and never match.
const LEADING_PATH = /^(?:https?:\/\/[^/]*)?\/(?:v[12]|platform)(?:\/|$)/;

// The same path continuing a string whose base was interpolated or concatenated before it.
const CONTINUED_PATH = /^\/(?:v[12]|platform)(?:\/|$)/;

const isStringLiteral = (node) => node.type === "Literal" && typeof node.value === "string";

function quasiText(quasi) {
  return quasi.value.cooked ?? quasi.value.raw;
}

function isHttpClientRequestCallee(callee) {
  if (callee.type === "CallExpression") {
    return isHttpClientRequestCallee(callee.callee);
  }
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "HttpClientRequest"
  );
}

function isRequestTarget(node) {
  const parent = node.parent;
  if (parent.type === "NewExpression") {
    return (
      parent.arguments[0] === node &&
      parent.callee.type === "Identifier" &&
      parent.callee.name === "URL"
    );
  }
  if (parent.type !== "CallExpression" || parent.arguments[0] !== node) {
    return false;
  }
  if (parent.callee.type === "Identifier" && parent.callee.name === "fetch") {
    return true;
  }
  return isHttpClientRequestCallee(parent.callee);
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
        if (isStringLiteral(node) && LEADING_PATH.test(node.value) && isRequestTarget(node)) {
          report(node);
        }
      },
      TemplateLiteral(node) {
        const { quasis } = node;
        if (quasis.length === 1) {
          if (LEADING_PATH.test(quasiText(quasis[0])) && isRequestTarget(node)) {
            report(node);
          }
          return;
        }
        const matches = quasis.some((quasi, index) => {
          const text = quasiText(quasi);
          return index === 0 ? LEADING_PATH.test(text) : CONTINUED_PATH.test(text);
        });
        if (matches) {
          report(node);
        }
      },
      BinaryExpression(node) {
        if (node.operator !== "+") {
          return;
        }
        const { left, right } = node;
        const joinsDynamicValue = !isStringLiteral(left) || !isStringLiteral(right);
        if (!joinsDynamicValue) {
          return;
        }
        const leftMatches = isStringLiteral(left) && LEADING_PATH.test(left.value);
        const rightMatches = isStringLiteral(right) && CONTINUED_PATH.test(right.value);
        if (leftMatches || rightMatches) {
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
