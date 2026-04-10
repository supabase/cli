// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts"
import { withSupabase } from '@supabase/server'

console.log("Hello from Functions!")

// This endpoint uses 'user' access, credentials is required.
export default {
  fetch: withSupabase({ allow: 'user' }, async (_req, ctx) => {
    const email = ctx.userClaims?.email;

    return Response.json({
      message: `Hello ${email}!`,
    })
  }),
}

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST '{{ .URL }}' \
    --header 'apiKey: {{ .PublishableKey }}'
    --header 'Authorization: Bearer <UserToken>'
*/
