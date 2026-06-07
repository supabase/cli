package diff

import (
	"context"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/pgtest"
)

func TestBuildViewReloptionDiff(t *testing.T) {
	t.Run("emits ALTER VIEW for reloption-only changes", func(t *testing.T) {
		key := viewReloptionKey{schema: "public", name: "user_details", relkind: "v"}
		out := buildViewReloptionDiff(
			map[viewReloptionKey][]string{
				key: {"security_invoker=true"},
			},
			map[viewReloptionKey][]string{
				key: {"security_invoker=false"},
			},
			[]string{"public"},
		)
		assert.Equal(t, `ALTER VIEW "public"."user_details" SET (security_invoker=false);
`, out)
	})

	t.Run("emits RESET for reloptions removed from existing views", func(t *testing.T) {
		key := viewReloptionKey{schema: "public", name: "user_details", relkind: "v"}
		out := buildViewReloptionDiff(
			map[viewReloptionKey][]string{
				key: {"security_invoker=true", "check_option=local"},
			},
			map[viewReloptionKey][]string{
				key: {"check_option=local"},
			},
			[]string{"public"},
		)
		assert.Equal(t, `ALTER VIEW "public"."user_details" RESET (security_invoker);
`, out)
	})

	t.Run("emits SET and RESET in stable order", func(t *testing.T) {
		key := viewReloptionKey{schema: "public", name: "user_details", relkind: "v"}
		out := buildViewReloptionDiff(
			map[viewReloptionKey][]string{
				key: {"security_invoker=true", "check_option=local"},
			},
			map[viewReloptionKey][]string{
				key: {"security_barrier=true", "security_invoker=false"},
			},
			[]string{"public"},
		)
		assert.Equal(t, `ALTER VIEW "public"."user_details" SET (security_barrier=true, security_invoker=false);
ALTER VIEW "public"."user_details" RESET (check_option);
`, out)
	})

	t.Run("emits ALTER MATERIALIZED VIEW for materialized views", func(t *testing.T) {
		key := viewReloptionKey{schema: "public", name: "cached_details", relkind: "m"}
		out := buildViewReloptionDiff(
			map[viewReloptionKey][]string{
				key: {"autovacuum_enabled=true"},
			},
			map[viewReloptionKey][]string{
				key: {"autovacuum_enabled=false"},
			},
			[]string{"public"},
		)
		assert.Equal(t, `ALTER MATERIALIZED VIEW "public"."cached_details" SET (autovacuum_enabled=false);
`, out)
	})

	t.Run("skips target-only views because CREATE VIEW diff owns them", func(t *testing.T) {
		key := viewReloptionKey{schema: "public", name: "new_view", relkind: "v"}
		out := buildViewReloptionDiff(
			map[viewReloptionKey][]string{},
			map[viewReloptionKey][]string{
				key: {"security_invoker=true"},
			},
			[]string{"public"},
		)
		assert.Empty(t, out)
	})

	t.Run("respects requested schema filter", func(t *testing.T) {
		key := viewReloptionKey{schema: "private", name: "user_details", relkind: "v"}
		out := buildViewReloptionDiff(
			map[viewReloptionKey][]string{
				key: {"security_invoker=true"},
			},
			map[viewReloptionKey][]string{
				key: {"security_invoker=false"},
			},
			[]string{"public"},
		)
		assert.Empty(t, out)
	})
}

func TestAppendDiffSQL(t *testing.T) {
	assert.Equal(t, "ALTER VIEW v SET (security_invoker=true);\n", appendDiffSQL("", "ALTER VIEW v SET (security_invoker=true);\n"))
	assert.Equal(t, "CREATE TABLE t();\nALTER VIEW v SET (security_invoker=true);\n", appendDiffSQL("CREATE TABLE t();", "ALTER VIEW v SET (security_invoker=true);\n"))
	assert.Equal(t, "CREATE TABLE t();\nALTER VIEW v SET (security_invoker=true);\n", appendDiffSQL("CREATE TABLE t();\n", "ALTER VIEW v SET (security_invoker=true);\n"))
}

func TestAppendViewReloptionDiff(t *testing.T) {
	sourceConn := pgtest.NewConn()
	defer sourceConn.Close(t)
	targetConn := pgtest.NewConn()
	defer targetConn.Close(t)
	sourceConn.Query(SELECT_VIEW_RELOPTIONS).
		Reply("SELECT 1", viewReloptionRow{
			Nspname:    "public",
			Relname:    "user_details",
			Relkind:    "v",
			Reloptions: []string{"security_invoker=true"},
		})
	targetConn.Query(SELECT_VIEW_RELOPTIONS).
		Reply("SELECT 1", viewReloptionRow{
			Nspname:    "public",
			Relname:    "user_details",
			Relkind:    "v",
			Reloptions: []string{"security_invoker=false"},
		})
	source := pgconn.Config{Host: "source.example", Port: 5432, User: "postgres", Database: "postgres"}
	target := pgconn.Config{Host: "target.example", Port: 5432, User: "postgres", Database: "postgres"}
	out := appendViewReloptionDiff(context.Background(), "", source, target, []string{"public"}, func(cc *pgx.ConnConfig) {
		if cc.Host == source.Host {
			sourceConn.Intercept(cc)
		} else {
			targetConn.Intercept(cc)
		}
	})
	assert.Equal(t, `ALTER VIEW "public"."user_details" SET (security_invoker=false);
`, out)
}
