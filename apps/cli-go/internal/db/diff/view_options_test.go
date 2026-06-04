package diff

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPatchViewReloptions(t *testing.T) {
	t.Run("inserts WITH clause for create or replace view", func(t *testing.T) {
		in := `create or replace view "public"."user_details" as SELECT id FROM users;`
		out := PatchViewReloptions(in, map[viewKey][]string{
			{schema: "public", name: "user_details"}: {"security_invoker=true"},
		})
		assert.Equal(t,
			`create or replace view "public"."user_details" with (security_invoker=true) as SELECT id FROM users;`,
			out,
		)
	})

	t.Run("preserves multiple reloptions in order", func(t *testing.T) {
		in := `create or replace view "public"."v" as select 1;`
		out := PatchViewReloptions(in, map[viewKey][]string{
			{schema: "public", name: "v"}: {"security_invoker=true", "check_option=local"},
		})
		assert.Equal(t,
			`create or replace view "public"."v" with (security_invoker=true, check_option=local) as select 1;`,
			out,
		)
	})

	t.Run("handles materialized view", func(t *testing.T) {
		in := `CREATE MATERIALIZED VIEW "public"."mv" AS SELECT 1;`
		out := PatchViewReloptions(in, map[viewKey][]string{
			{schema: "public", name: "mv"}: {"fillfactor=70"},
		})
		assert.Equal(t,
			`CREATE MATERIALIZED VIEW "public"."mv" with (fillfactor=70) AS SELECT 1;`,
			out,
		)
	})

	t.Run("patches multiple views in one diff", func(t *testing.T) {
		in := `create or replace view "public"."a" as select 1;
create or replace view "public"."b" as select 2;
create or replace view "public"."c" as select 3;`
		out := PatchViewReloptions(in, map[viewKey][]string{
			{schema: "public", name: "a"}: {"security_invoker=true"},
			{schema: "public", name: "c"}: {"security_invoker=true"},
		})
		assert.Equal(t,
			`create or replace view "public"."a" with (security_invoker=true) as select 1;
create or replace view "public"."b" as select 2;
create or replace view "public"."c" with (security_invoker=true) as select 3;`,
			out,
		)
	})

	t.Run("leaves diff unchanged when no matching view is present", func(t *testing.T) {
		in := `alter table "public"."users" add column "email" text;`
		out := PatchViewReloptions(in, map[viewKey][]string{
			{schema: "public", name: "user_details"}: {"security_invoker=true"},
		})
		assert.Equal(t, in, out)
	})

	t.Run("leaves view unchanged when reloptions map has no entry", func(t *testing.T) {
		in := `create or replace view "public"."v" as select 1;`
		out := PatchViewReloptions(in, map[viewKey][]string{
			{schema: "other", name: "v"}: {"security_invoker=true"},
		})
		assert.Equal(t, in, out)
	})

	t.Run("returns input unchanged when reloptions map is empty", func(t *testing.T) {
		in := `create or replace view "public"."v" as select 1;`
		assert.Equal(t, in, PatchViewReloptions(in, nil))
		assert.Equal(t, in, PatchViewReloptions(in, map[viewKey][]string{}))
	})

	t.Run("matches schemas with uppercase keywords", func(t *testing.T) {
		in := `CREATE OR REPLACE VIEW "public"."v" AS SELECT 1;`
		out := PatchViewReloptions(in, map[viewKey][]string{
			{schema: "public", name: "v"}: {"security_invoker=true"},
		})
		assert.Equal(t,
			`CREATE OR REPLACE VIEW "public"."v" with (security_invoker=true) AS SELECT 1;`,
			out,
		)
	})

	t.Run("matches view name containing the word as", func(t *testing.T) {
		in := `create or replace view "public"."alias" as select 1;`
		out := PatchViewReloptions(in, map[viewKey][]string{
			{schema: "public", name: "alias"}: {"security_invoker=true"},
		})
		assert.Equal(t,
			`create or replace view "public"."alias" with (security_invoker=true) as select 1;`,
			out,
		)
	})
}
