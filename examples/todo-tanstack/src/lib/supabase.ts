import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env and fill in the values from `supabase status`.",
  );
}

export interface Todo {
  id: number;
  user_id: string;
  title: string;
  done: boolean;
  inserted_at: string;
}

export const supabase = createClient(url, publishableKey);
