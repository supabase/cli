// Single source of truth for Vitest's `inject()` keys used by the replay/record
// harness. The global setup imports this module so the augmentation is always
// in the build and `inject("…")` is typed without `as` casts.
export {};

declare module "vitest" {
  export interface ProvidedContext {
    // Shared by replay and record.
    projectRef: string;
    storageBucket: string;
    // Replay/record (replay server + pg/docker mocks).
    replayServerUrl: string;
    orgId: string;
    pgMockPort: number;
    /** DOCKER_HOST value (tcp://host:port) pointing at the relay server.
     *  In record mode the relay forwards to the real Docker socket; in replay
     *  mode it serves recorded Docker API fixtures. */
    dockerHostUrl: string;
  }
}
