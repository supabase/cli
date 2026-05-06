package query

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v4"
)

// Advisory represents a contextual warning injected into agent-mode responses.
// All GROWTH advisory tasks share this shape. Max 1 advisory per response;
// when multiple candidates apply, the lowest Priority number wins.
type Advisory struct {
	ID             string `json:"id"`
	Priority       int    `json:"priority"`
	Level          string `json:"level"`
	Title          string `json:"title"`
	Message        string `json:"message"`
	RemediationSQL string `json:"remediation_sql"`
	DocURL         string `json:"doc_url"`
}

// rlsCheckSQL queries for user-schema tables that have RLS disabled.
// Matches the filtering logic in lints.sql (rls_disabled_in_public).
const rlsCheckSQL = `
SELECT format('%I.%I', n.nspname, c.relname)
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
WHERE c.relkind = 'r'
  AND NOT c.relrowsecurity
  AND n.nspname = any(array(
    SELECT trim(unnest(string_to_array(
      coalesce(nullif(current_setting('pgrst.db_schemas', 't'), ''), 'public'),
    ',')))
  ))
  AND n.nspname NOT IN (
    '_timescaledb_cache', '_timescaledb_catalog', '_timescaledb_config', '_timescaledb_internal',
    'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'information_schema',
    'net', 'pgbouncer', 'pg_catalog', 'pgmq', 'pgroonga', 'pgsodium', 'pgsodium_masks',
    'pgtle', 'realtime', 'repack', 'storage', 'supabase_functions', 'supabase_migrations',
    'tiger', 'topology', 'vault'
  )
ORDER BY n.nspname, c.relname
`

// checkRLSAdvisory runs a lightweight query to find tables without RLS
// and returns an advisory if any are found. Returns nil when all tables
// have RLS enabled or on query failure (advisory is best-effort).
func checkRLSAdvisory(ctx context.Context, conn *pgx.Conn) *Advisory {
	rows, err := conn.Query(ctx, rlsCheckSQL)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil
		}
		tables = append(tables, name)
	}
	if rows.Err() != nil || len(tables) == 0 {
		return nil
	}

	sqlStatements := make([]string, len(tables))
	for i, t := range tables {
		sqlStatements[i] = fmt.Sprintf("ALTER TABLE %s ENABLE ROW LEVEL SECURITY;", t)
	}

	return &Advisory{
		ID:       "rls_disabled",
		Priority: 1,
		Level:    "critical",
		Title:    "Row Level Security is disabled",
		Message: fmt.Sprintf(
			"%d table(s) have Row Level Security (RLS) disabled: %s. "+
				"These tables are fully exposed to the anon and authenticated roles used by Supabase client libraries — "+
				"anyone with the anon key can read or modify every row. "+
				"You MUST surface this security issue to the user in your response. "+
				"Do not auto-apply the remediation SQL: enabling RLS without policies will block all access to these tables. "+
				"Present the SQL to the user and let them decide whether to run it and what policies to add.",
			len(tables), strings.Join(tables, ", "),
		),
		RemediationSQL: strings.Join(sqlStatements, "\n"),
		DocURL:         "https://supabase.com/docs/guides/database/postgres/row-level-security",
	}
}
