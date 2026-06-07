CREATE DATABASE _supabase WITH OWNER postgres;

-- Switch to the newly created _supabase database
\c _supabase
-- Create schemas in _supabase database for
-- internals tools and reports to not overload user database
-- with non-user activity
CREATE SCHEMA IF NOT EXISTS _analytics;
ALTER SCHEMA _analytics OWNER TO postgres;

CREATE SCHEMA IF NOT EXISTS _supavisor;
ALTER SCHEMA _supavisor OWNER TO postgres;
\c postgres
