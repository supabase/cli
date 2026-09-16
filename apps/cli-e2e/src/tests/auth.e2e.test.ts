import { describe, it } from "vitest";

// TODO(CLI-1365): implement auth e2e tests once the CLI can opt out of keychain
// access (e.g. SUPABASE_NO_KEYRING) — without it, login/logout spawn a macOS
// keychain dialog that blocks the subprocess indefinitely.

describe("auth", () => {
  it.todo("login and logout tests blocked on Go CLI keyring opt-out (see file comment)");
});
