/**
 * Stack integration fixtures are provided by @supabase/stack/testing.
 * The legacy daemon fixture was intentionally removed with the manager API.
 */
export async function makeRunningStackFixture(): Promise<never> {
  throw new Error("Use createTestStack from @supabase/stack/testing for stack scenarios.");
}

export async function makeStoppedStackFixture(): Promise<never> {
  throw new Error("Use createTestStack from @supabase/stack/testing for stack scenarios.");
}
