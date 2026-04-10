// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

console.log("Hello from Functions!");

// This endpoint uses 'always' access, no credentials required, every request is accepted.
// Use it for health checks, public APIs, or when you handle auth yourself inside the handler.
export default {
  fetch: withSupabase({ allow: "always" }, async (req, ctx) => {
    const { name } = await req.json();

    return Response.json({
      message: `Hello ${name}!`,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST '{{ .URL }}' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
