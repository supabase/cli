import { prefetch } from "@supabase/stack/bun";

export default async function globalSetup() {
  await prefetch();
}
