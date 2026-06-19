// Single source of truth for Vitest's `inject()` keys across all three modes
// (replay/record use the replay-server keys; live uses the staging-project keys).
// Both global setups import this module so the augmentation is always in the
// build and `inject("…")` is typed without `as` casts.
export {};

declare module "vitest" {
  export interface ProvidedContext {
    // Shared by every mode.
    projectRef: string;
    storageBucket: string;
    // Replay/record only (replay server + pg/docker mocks).
    replayServerUrl: string;
    orgId: string;
    pgMockPort: number;
    /** DOCKER_HOST value (tcp://host:port) pointing at the relay server.
     *  In record mode the relay forwards to the real Docker socket; in replay
     *  mode it serves recorded Docker API fixtures. */
    dockerHostUrl: string;
    // Live only (ADR-0013): real ephemeral project wiring.
    /** Legacy anon JWT for invoking deployed functions over HTTP. */
    anonKey: string;
    /** https://{ref}.{CLI_E2E_PROJECT_HOST}/functions/v1 */
    functionsUrl: string;
    /** IPv4 session-pooler Postgres URL for --db-url DB commands. */
    dbUrl: string;
    /** DB password of the ephemeral project (for `link` → persisted pooler config). */
    dbPassword: string;
  }
}
