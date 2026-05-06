import { Tracer } from "effect";

/**
 * Tracing - Canonical tracing boundary for the CLI.
 *
 * The service reuses Effect's `Tracer` contract; the CLI-specific policy lives
 * in `tracing.layer.ts`, where consent, identity, and export wiring are applied.
 */
export const Tracing = Tracer.Tracer;
