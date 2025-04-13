
// index.ts
// import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// serve((_req) => {
//   return new Response("User existence check function is working!", {
//     headers: { "Content-Type": "text/plain" },
//   });
// });



// index.ts
// import { serve } from 'https://deno.land/std/http/server.ts'

// serve((_req) => {
//   return new Response("Hello from check-user-existence function!");
// })



// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { serve } from 'std/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SERVICE_ROLE_KEY')!;

const supabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
  },
});

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  try {
    const { email }: { email?: string } = await req.json();
    if (!email) {
      return new Response(JSON.stringify({ error: 'Email is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const { data, error } = await supabaseClient.auth.admin.getUserByEmail(email);
    const exists = data !== null;
    return new Response(JSON.stringify({ exists }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});