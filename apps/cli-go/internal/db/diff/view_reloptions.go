package diff

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgxv5"
)

const SELECT_VIEW_RELOPTIONS = `SELECT n.nspname AS nspname,
       c.relname AS relname,
       c.relkind::text AS relkind,
       COALESCE(c.reloptions, ARRAY[]::text[]) AS reloptions
  FROM pg_class c
  JOIN pg_namespace n ON c.relnamespace = n.oid
 WHERE c.relkind IN ('v','m')
 ORDER BY n.nspname, c.relname`

type viewReloptionKey struct {
	schema  string
	name    string
	relkind string
}

type viewReloptionRow struct {
	Nspname    string   `db:"nspname"`
	Relname    string   `db:"relname"`
	Relkind    string   `db:"relkind"`
	Reloptions []string `db:"reloptions"`
}

func appendViewReloptionDiff(ctx context.Context, sql string, source, target pgconn.Config, schema []string, options ...func(*pgx.ConnConfig)) string {
	sourceConn, err := utils.ConnectByConfig(ctx, source, options...)
	if err != nil {
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "could not connect to source database to diff view reloptions:", err)
		return sql
	}
	defer sourceConn.Close(context.Background())
	targetConn, err := utils.ConnectByConfig(ctx, target, options...)
	if err != nil {
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "could not connect to target database to diff view reloptions:", err)
		return sql
	}
	defer targetConn.Close(context.Background())
	sourceReloptions, err := selectViewReloptions(ctx, sourceConn)
	if err != nil {
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "could not read source view reloptions:", err)
		return sql
	}
	targetReloptions, err := selectViewReloptions(ctx, targetConn)
	if err != nil {
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "could not read target view reloptions:", err)
		return sql
	}
	return appendDiffSQL(sql, buildViewReloptionDiff(sourceReloptions, targetReloptions, schema))
}

func selectViewReloptions(ctx context.Context, conn *pgx.Conn) (map[viewReloptionKey][]string, error) {
	rows, err := conn.Query(ctx, SELECT_VIEW_RELOPTIONS)
	if err != nil {
		return nil, err
	}
	collected, err := pgxv5.CollectRows[viewReloptionRow](rows)
	if err != nil {
		return nil, err
	}
	out := make(map[viewReloptionKey][]string, len(collected))
	for _, r := range collected {
		out[viewReloptionKey{schema: r.Nspname, name: r.Relname, relkind: r.Relkind}] = r.Reloptions
	}
	return out, nil
}

func buildViewReloptionDiff(source, target map[viewReloptionKey][]string, schema []string) string {
	if len(source) == 0 || len(target) == 0 {
		return ""
	}
	includeSchema := schemaFilter(schema)
	keys := make([]viewReloptionKey, 0, len(target))
	for key := range target {
		if !includeSchema(key.schema) {
			continue
		}
		if _, ok := source[key]; ok {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].schema != keys[j].schema {
			return keys[i].schema < keys[j].schema
		}
		if keys[i].name != keys[j].name {
			return keys[i].name < keys[j].name
		}
		return keys[i].relkind < keys[j].relkind
	})
	var statements []string
	for _, key := range keys {
		statements = append(statements, buildAlterViewReloptions(key, source[key], target[key])...)
	}
	return strings.Join(statements, "")
}

func schemaFilter(schema []string) func(string) bool {
	if len(schema) > 0 {
		included := make(map[string]bool, len(schema))
		for _, name := range schema {
			included[name] = true
		}
		return func(name string) bool {
			return included[name]
		}
	}
	excluded := make(map[string]bool, len(managedSchemas)+2)
	for _, name := range managedSchemas {
		excluded[name] = true
	}
	excluded["information_schema"] = true
	excluded["pg_catalog"] = true
	return func(name string) bool {
		return !excluded[name] && !strings.HasPrefix(name, "pg_")
	}
}

func buildAlterViewReloptions(key viewReloptionKey, source, target []string) []string {
	sourceOpts := reloptionsByName(source)
	targetOpts := reloptionsByName(target)
	var setNames []string
	for name, targetOpt := range targetOpts {
		if sourceOpt, ok := sourceOpts[name]; !ok || sourceOpt.raw != targetOpt.raw {
			setNames = append(setNames, name)
		}
	}
	var resetNames []string
	for name := range sourceOpts {
		if _, ok := targetOpts[name]; !ok {
			resetNames = append(resetNames, name)
		}
	}
	sort.Strings(setNames)
	sort.Strings(resetNames)
	alterPrefix := "ALTER VIEW "
	if key.relkind == "m" {
		alterPrefix = "ALTER MATERIALIZED VIEW "
	}
	viewName := quoteIdentifier(key.schema) + "." + quoteIdentifier(key.name)
	var statements []string
	if len(setNames) > 0 {
		opts := make([]string, len(setNames))
		for i, name := range setNames {
			opts[i] = targetOpts[name].raw
		}
		statements = append(statements, fmt.Sprintf("%s%s SET (%s);\n", alterPrefix, viewName, strings.Join(opts, ", ")))
	}
	if len(resetNames) > 0 {
		statements = append(statements, fmt.Sprintf("%s%s RESET (%s);\n", alterPrefix, viewName, strings.Join(resetNames, ", ")))
	}
	return statements
}

type reloption struct {
	raw string
}

func reloptionsByName(options []string) map[string]reloption {
	out := make(map[string]reloption, len(options))
	for _, raw := range options {
		name, _, _ := strings.Cut(raw, "=")
		if name == "" {
			continue
		}
		out[name] = reloption{raw: raw}
	}
	return out
}

func appendDiffSQL(sql, extra string) string {
	if extra == "" {
		return sql
	}
	if strings.TrimSpace(sql) == "" {
		return extra
	}
	if strings.HasSuffix(sql, "\n") {
		return sql + extra
	}
	return sql + "\n" + extra
}

func quoteIdentifier(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}
