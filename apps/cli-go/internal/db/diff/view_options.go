package diff

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgxv5"
)

// viewDefinitionPattern matches a CREATE [OR REPLACE] [MATERIALIZED] VIEW
// "schema"."name" AS prefix. Capture groups: 1 = schema, 2 = view name, 3 =
// the trailing "AS" token, whose start offset is used to splice a WITH (...)
// clause in front of it without touching the rest of the statement.
var viewDefinitionPattern = regexp.MustCompile(`(?i)create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?"([^"]+)"\."([^"]+)"\s+(as\b)`)

// SELECT_VIEW_RELOPTIONS reads reloptions for every view and materialized view
// in the target database. djrobstep/migra, pg-schema-diff and @pgkit/migra
// emit CREATE VIEW statements without the WITH (...) clause, so the CLI
// reattaches it from this query after the diff is produced.
//
// See https://github.com/supabase/cli/issues/3973.
const SELECT_VIEW_RELOPTIONS = `SELECT n.nspname AS nspname,
       c.relname AS relname,
       c.reloptions AS reloptions
  FROM pg_class c
  JOIN pg_namespace n ON c.relnamespace = n.oid
 WHERE c.relkind IN ('v','m')
   AND c.reloptions IS NOT NULL
   AND array_length(c.reloptions, 1) > 0`

type viewKey struct {
	schema string
	name   string
}

type viewReloptionsRow struct {
	Nspname    string   `db:"nspname"`
	Relname    string   `db:"relname"`
	Reloptions []string `db:"reloptions"`
}

// PatchViewReloptions rewrites CREATE [OR REPLACE] [MATERIALIZED] VIEW
// statements in sql to include a WITH (...) clause for any view present in
// reloptions. Statements that do not match an entry in reloptions are left
// untouched, so the function is safe to call unconditionally on every diff.
func PatchViewReloptions(sql string, reloptions map[viewKey][]string) string {
	if sql == "" || len(reloptions) == 0 {
		return sql
	}
	return viewDefinitionPattern.ReplaceAllStringFunc(sql, func(match string) string {
		indexes := viewDefinitionPattern.FindStringSubmatchIndex(match)
		if len(indexes) < 8 {
			return match
		}
		key := viewKey{
			schema: match[indexes[2]:indexes[3]],
			name:   match[indexes[4]:indexes[5]],
		}
		opts, ok := reloptions[key]
		if !ok || len(opts) == 0 {
			return match
		}
		asStart := indexes[6]
		return match[:asStart] + "with (" + strings.Join(opts, ", ") + ") " + match[asStart:]
	})
}

// SelectViewReloptions queries conn for every view and materialized view with
// non-empty reloptions, keyed by (schema, name).
func SelectViewReloptions(ctx context.Context, conn *pgx.Conn) (map[viewKey][]string, error) {
	rows, err := conn.Query(ctx, SELECT_VIEW_RELOPTIONS)
	if err != nil {
		return nil, err
	}
	collected, err := pgxv5.CollectRows[viewReloptionsRow](rows)
	if err != nil {
		return nil, err
	}
	out := make(map[viewKey][]string, len(collected))
	for _, r := range collected {
		out[viewKey{schema: r.Nspname, name: r.Relname}] = r.Reloptions
	}
	return out, nil
}

// applyViewReloptionsFromTarget restores WITH (...) clauses on view
// definitions by querying target for the live reloptions and patching sql in
// place. Any failure to connect or query is treated as a soft error so the
// diff is preserved as-is; the caller is responsible for showing the original
// output to the user. A short warning is logged to stderr to make the
// degradation visible.
func applyViewReloptionsFromTarget(ctx context.Context, sql string, target pgconn.Config, options ...func(*pgx.ConnConfig)) string {
	if !viewDefinitionPattern.MatchString(sql) {
		return sql
	}
	conn, err := utils.ConnectByConfig(ctx, target, options...)
	if err != nil {
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "could not connect to target database to restore view reloptions:", err)
		return sql
	}
	defer conn.Close(context.Background())
	reloptions, err := SelectViewReloptions(ctx, conn)
	if err != nil {
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "could not read view reloptions from target database:", err)
		return sql
	}
	if len(reloptions) == 0 {
		return sql
	}
	return PatchViewReloptions(sql, reloptions)
}
