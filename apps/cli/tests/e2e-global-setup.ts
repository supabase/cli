import { prefetch } from "@supabase/stack";

export default async function globalSetup() {
  await prefetch();
}
