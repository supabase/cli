/**
 * Boilerplate written by `supabase test new` for the `pgtap` template.
 * Byte-for-byte copy of Go's embedded `apps/cli-go/internal/test/new/templates/pgtap.sql`
 * (109 bytes, trailing newline included).
 */
export const LEGACY_PGTAP_TEMPLATE = `BEGIN;
SELECT plan(1);

-- Examples: https://pgtap.org/documentation.html

SELECT * FROM finish();
ROLLBACK;
`;
