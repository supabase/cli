// // Follow this setup guide to integrate the Deno language server with your editor:
// // https://deno.land/manual/getting_started/setup_your_environment
// // This enables autocomplete, go to definition, etc.

// // Setup type definitions for built-in Supabase Runtime APIs

// import "jsr:@supabase/functions-js/edge-runtime.d.ts"

// // console.log("Hello from Functions!")

// // Deno.serve(async (req) => {
// //   const { name } = await req.json()
// //   const data = {
// //     message: `Hello ${name}!`,
// //   }

// //   return new Response(
// //     JSON.stringify(data),
// //     { headers: { "Content-Type": "application/json" } },
// //   )
// // })

// /* To invoke locally:

//   1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
//   2. Make an HTTP request:

//   curl -i --location --request POST '{{ .URL }}' \
//     --header 'Authorization: Bearer {{ .Token }}' \
//     --header 'Content-Type: application/json' \
//     --data '{"name":"Functions"}'

// */





import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

// HTTP handler
Deno.serve(async (req) => {
  // 1. Reject non-POST requests
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    // 2. Parse and validate email
    const { email } = await req.json();
    if (!email || typeof email !== "string") {
      return new Response(
        JSON.stringify({ error: "Valid email required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Check user existence
    const { data, error } = await supabase.auth.admin.getUserByEmail(email);
    if (error) throw error;

    // 4. Return boolean response
    return new Response(
      JSON.stringify({ exists: !!data.user }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    // 5. Handle errors gracefully
    console.error(`Error checking email: ${err.message}`);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});