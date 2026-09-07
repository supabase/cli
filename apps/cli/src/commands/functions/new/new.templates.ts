export const LEGACY_FUNCTIONS_NEW_DENO_JSON = `{
  "imports": {
    "@supabase/functions-js": "jsr:@supabase/functions-js@^2",
    "@supabase/server": "npm:@supabase/server@^1"
  }
}
`;

export const LEGACY_FUNCTIONS_NEW_NPMRC = `# Configuration for private npm package dependencies
# For more information on using private registries with Edge Functions, see:
# https://supabase.com/docs/guides/functions/import-maps#importing-from-private-registries
`;

const INDEX_AUTH_MODE_NONE = `// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

console.log("Hello from Functions!");

// This endpoint uses auth 'none', no credentials required, every request is accepted.
// Use it for health checks, public APIs, or when you need to implement your own auth logic.
export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    const { name } = await req.json();

    return Response.json({
      message: \`Hello \${name}!\`,
    });
  }),
};

/* To invoke locally:

  1. Run \`supabase start\` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST '__URL__' \\
    --header 'Content-Type: application/json' \\
    --data '{"name":"Functions"}'

*/
`;

const INDEX_AUTH_MODE_APIKEY = `// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

console.log("Hello from Functions!");

// This endpoint uses 'publishable' | 'secret' access, apiKey is required.
// Use publishable for Client-facing, key-validated endpoints
// Use secret for Server-to-server, internal calls
export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, ctx) => {
    // Called by another service with a secret key
    // ctx.supabaseAdmin bypasses RLS — use for privileged operations
    /*
    if (ctx.authMode === "secret") {
      const { user_id } = await req.json();
      const { data } = await ctx.supabaseAdmin.auth.admin.getUserById(user_id);

      return Response.json({
        email: data?.user?.email,
      });
    }
    */

    const { name } = await req.json();

    return Response.json({
      message: \`Hello \${name}!\`,
    });
  }),
};

/* To invoke locally:

  1. Run \`supabase start\` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST '__URL__' \\
    --header 'apiKey: __PUBLISHABLE_KEY__' \\
    --data '{"name":"Functions"}'

*/
`;

const INDEX_AUTH_MODE_USER = `// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts"
import { withSupabase } from "@supabase/server"

console.log("Hello from Functions!")

// This endpoint uses 'user' access, credentials is required.
export default {
  fetch: withSupabase({ auth: "user" }, async (_req, ctx) => {
    const email = ctx.userClaims?.email;

    return Response.json({
      message: \`Hello \${email}!\`,
    })
  }),
}

/* To invoke locally:

  1. Run \`supabase start\` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST '__URL__' \\
    --header 'apiKey: __PUBLISHABLE_KEY__' \\
    --header 'Authorization: Bearer <UserToken>'
*/
`;

const FUNCTION_CONFIG_TEMPLATE = `
[functions.__SLUG__]
enabled = true
verify_jwt = __VERIFY_JWT__
import_map = "./functions/__SLUG__/deno.json"
# Uncomment to specify a custom file path to the entrypoint.
# Supported file extensions are: .ts, .js, .mjs, .jsx, .tsx
entrypoint = "./functions/__SLUG__/index.ts"
# Specifies static files to be bundled with the function. Supports glob patterns.
# For example, if you want to serve static HTML pages in your function:
# static_files = [ "./functions/__SLUG__/*.html" ]
`;

export type LegacyFunctionsNewAuthMode = "none" | "apikey" | "user";

export function renderLegacyFunctionsNewEntrypoint(
  authMode: LegacyFunctionsNewAuthMode,
  options: {
    readonly url: string;
    readonly publishableKey: string;
  },
): string {
  const template =
    authMode === "none"
      ? INDEX_AUTH_MODE_NONE
      : authMode === "user"
        ? INDEX_AUTH_MODE_USER
        : INDEX_AUTH_MODE_APIKEY;
  return template
    .replaceAll("__URL__", options.url)
    .replaceAll("__PUBLISHABLE_KEY__", options.publishableKey);
}

export function renderLegacyFunctionsNewConfig(slug: string, verifyJwt: boolean): string {
  return FUNCTION_CONFIG_TEMPLATE.replaceAll("__SLUG__", slug).replaceAll(
    "__VERIFY_JWT__",
    verifyJwt ? "true" : "false",
  );
}
