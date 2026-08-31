// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native BEAM releases require cryptographically random stack identity.
import { randomBytes } from "node:crypto";

/**
 * Native BEAM services pass this value through PostgreSQL channel identifiers as
 * well as Erlang distribution cookies. Keep the random portion large enough to
 * prevent collisions while staying within PostgreSQL's 63-byte identifier cap.
 */
const BEAM_COOKIE_RANDOM_BYTES = 23;
const BEAM_COOKIE_PREFIX = "supabase_";
const BEAM_COOKIE_SUFFIX = "_cookie";

/** @internal Generate the per-stack cookie shared by native BEAM services. */
export const generateBeamReleaseCookie = (): string =>
  `${BEAM_COOKIE_PREFIX}${randomBytes(BEAM_COOKIE_RANDOM_BYTES).toString("hex")}${BEAM_COOKIE_SUFFIX}`;
