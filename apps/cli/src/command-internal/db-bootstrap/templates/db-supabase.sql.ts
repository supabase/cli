/**
 * Embedded byte-for-byte into the Postgres container's entrypoint heredoc, for both the PG >= 15
 * and PG <= 14 branches.
 */
export const START_DB_SUPABASE_SQL = `CREATE DATABASE _supabase WITH OWNER postgres;

-- Switch to the newly created _supabase database
\\c _supabase
-- Create schemas in _supabase database for
-- internals tools and reports to not overload user database
-- with non-user activity
CREATE SCHEMA IF NOT EXISTS _analytics;
ALTER SCHEMA _analytics OWNER TO postgres;

CREATE SCHEMA IF NOT EXISTS _supavisor;
ALTER SCHEMA _supavisor OWNER TO postgres;
\\c postgres
`;
