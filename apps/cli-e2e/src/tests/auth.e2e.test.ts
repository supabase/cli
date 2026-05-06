import { describe, it } from "vitest";

// TODO: Implement auth e2e tests once the TS Legacy Port exposes a way to opt out of
// keychain access (e.g. a SUPABASE_NO_KEYRING env var respected by the Go
// binary). Without it, login/logout spawn macOS Security dialogs ("A keychain
// cannot be found to store 'test'") that block the subprocess indefinitely,
// causing every test to time out.
//
// Required before implementing:
//   - The Go CLI must honour SUPABASE_NO_KEYRING (or equivalent) so that
//     keyring operations fall back to the filesystem inside the isolated
//     SUPABASE_HOME / workspace directory instead of touching the OS keychain.
//
// Planned test coverage (see CLI-1365 for full spec):
//
//   login
//     - testBehaviour: saves token and prints success with --token
//     - testBehaviour: saves token with --token and custom --name
//     - testBehaviour: includes debug output with --debug
//     - testBehaviour: exits non-zero on invalid token format
//     - testParity(["login", "--token", ACCESS_TOKEN])
//     - testParity(["login", "--token", "not_a_valid_token"])
//
//   logout
//     - testBehaviour: exits zero after login with --yes
//     - testBehaviour: exits zero gracefully when not logged in with --yes
//       (double-logout pattern to clear any stale keychain state between runs)
//     - testParity(["logout", "--yes"])

describe("auth", () => {
  it.todo("login and logout tests blocked on Go CLI keyring opt-out (see file comment)");
});
