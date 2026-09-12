package parser

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func checkSplit(t *testing.T, sql []string) {
	input := strings.Join(sql, "")
	output, err := Split(strings.NewReader(input))
	require.NoError(t, err)
	assert.ElementsMatch(t, sql, output)
}

func TestLineComment(t *testing.T) {
	t.Run("after separator", func(t *testing.T) {
		sql := []string{"END;", "-- comment"}
		checkSplit(t, sql)
	})

	t.Run("before separator", func(t *testing.T) {
		sql := []string{"SELECT --; 1"}
		checkSplit(t, sql)
	})

	t.Run("not started", func(t *testing.T) {
		sql := []string{"- ;", "END"}
		checkSplit(t, sql)
	})

	t.Run("between lines", func(t *testing.T) {
		sql := []string{"-- /* \n;", " */ END"}
		checkSplit(t, sql)
	})
}

func TestBlockComment(t *testing.T) {
	t.Run("contains separator", func(t *testing.T) {
		sql := []string{"SELECT /* ; */ 1;"}
		checkSplit(t, sql)
	})

	t.Run("nested block", func(t *testing.T) {
		sql := []string{"SELECT /*; /*;*/ ;*/ 1"}
		checkSplit(t, sql)
	})

	t.Run("not started", func(t *testing.T) {
		sql := []string{"/ * ;", " */ END"}
		checkSplit(t, sql)
	})
}

func TestSeparator(t *testing.T) {
	t.Run("no spaces", func(t *testing.T) {
		sql := []string{";", "END;", ";"}
		checkSplit(t, sql)
	})

	t.Run("between spaces", func(t *testing.T) {
		sql := []string{"BEGIN   ;", "  END"}
		checkSplit(t, sql)
	})

	t.Run("backslash escaped", func(t *testing.T) {
		sql := []string{"\\;;", "\\;"}
		checkSplit(t, sql)
	})
}

func TestDollarQuote(t *testing.T) {
	t.Run("named tag", func(t *testing.T) {
		sql := []string{"$tag$ any ; string$tag$"}
		checkSplit(t, sql)
	})

	t.Run("non-ASCII named tag", func(t *testing.T) {
		for _, tag := range []string{"a²", "a😀", "á"} {
			t.Run(tag, func(t *testing.T) {
				checkSplit(t, []string{"$" + tag + "$ any ; END; string$" + tag + "$;", " SELECT 2;"})
			})
		}
	})

	t.Run("anonymous tag", func(t *testing.T) {
		sql := []string{"$$\"Dane's horse\"$$"}
		checkSplit(t, sql)
	})

	t.Run("not started", func(t *testing.T) {
		sql := []string{"SELECT \"$\";", " $$"}
		checkSplit(t, sql)
	})
}

func TestSingleQuote(t *testing.T) {
	t.Run("escapes separator", func(t *testing.T) {
		sql := []string{"SELECT ';' 1"}
		checkSplit(t, sql)
	})

	t.Run("preserves single quote", func(t *testing.T) {
		sql := []string{"SELECT ';'';' 1"}
		checkSplit(t, sql)
	})

	t.Run("literal backslash", func(t *testing.T) {
		sql := []string{"SELECT '\\';", " 1'"}
		checkSplit(t, sql)
	})
}

func TestDoubleQuote(t *testing.T) {
	t.Run("escapes separator", func(t *testing.T) {
		sql := []string{`CREATE POLICY "cats;dogs" on cats_dogs;`, " END"}
		checkSplit(t, sql)
	})

	t.Run("preserves single quote", func(t *testing.T) {
		sql := []string{`CREATE POLICY "cat's and dog's" on cats_dogs;`, " END"}
		checkSplit(t, sql)
	})

	t.Run("preserves double quote", func(t *testing.T) {
		sql := []string{`CREATE POLICY "pet""name" on pets;`, " END"}
		checkSplit(t, sql)
	})
}

func TestParentheses(t *testing.T) {
	t.Run("preserves parentheses", func(t *testing.T) {
		sql := []string{
			`CREATE RULE notify_me AS ON UPDATE TO mytable DO (NOTIFY mytable; SELECT "1");`,
			`SELECT 1`,
		}
		checkSplit(t, sql)
	})

	t.Run("ignores literals", func(t *testing.T) {
		sql := []string{`CREATE RULE notify_me AS ON UPDATE TO mytable DO (-- )
SELECT ')';
-- )
)
`}
		checkSplit(t, sql)
	})
}

func TestBeginAtomic(t *testing.T) {
	t.Run("inline body", func(t *testing.T) {
		sql := []string{`CREATE FUNCTION add(a integer, b integer) RETURNS integer
LANGUAGE SQL
IMMUTABLE STRICT PARALLEL SAFE
RETURNS NULL ON NULL INPUT
BEGIN ATOMIC
	SELECT 'add';
	SELECT a + b;
END;`}
		checkSplit(t, sql)
	})

	t.Run("case insenstive", func(t *testing.T) {
		sql := []string{"begin atomic; select 'end'; end"}
		checkSplit(t, sql)
	})

	t.Run("ignores literals", func(t *testing.T) {
		sql := []string{`CREATE FUNCTION test() BEGIN
ATOMIC-- END;
-- END;
END
;`}
		checkSplit(t, sql)
	})

	t.Run("ignores atomic in identifiers", func(t *testing.T) {
		names := []string{
			"fn_atomic",
			"atomic_fn",
			"my_atomic_thing",
			"xatomicx",
			"fn_ATomiC",
		}
		for _, name := range names {
			t.Run(name, func(t *testing.T) {
				sql := []string{
					`CREATE OR REPLACE FUNCTION ` + name + `()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  NULL;
END;
$$;`,
					`
SELECT 1;`,
				}
				checkSplit(t, sql)
			})
		}
	})

	t.Run("ignores end inside identifiers", func(t *testing.T) {
		for _, name := range []string{"pending", "pending_change", "append", "legend", "𐐀end", "😀end", "́end", "²end", "pending$$foo$"} {
			t.Run(name, func(t *testing.T) {
				body := `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1 AS ` + name + `; END;`
				checkSplit(t, []string{body, ` SELECT 2;`})
			})
		}
	})

	t.Run("ignores identifiers starting with end", func(t *testing.T) {
		for _, name := range []string{"endpoint", "end_date", "ended_at", "end𐐀", "end😀", "end́", "end²", "end$$foo$"} {
			t.Run(name, func(t *testing.T) {
				body := `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT ` + name + `; SELECT 1; END;`
				checkSplit(t, []string{body, ` SELECT 2;`})
			})
		}
	})

	t.Run("ignores end inside inner statements", func(t *testing.T) {
		for _, expr := range []string{
			"CASE WHEN true THEN 1 ELSE 0 END",
			"case when true then 1 end",
			"CASE WHEN true THEN 1 END AS ended",
			"CASE WHEN CASE WHEN true THEN true END THEN 1 END",
			"(CASE WHEN (true) THEN 1 END)",
			"coalesce(CASE WHEN length('a') > 0 THEN 1 END, 0)",
			"CASE(1)WHEN 1 THEN 1 END",
			"1 AS case",
			"1 case",
			"1 AS end",
			"1 end",
			"'end'",
		} {
			t.Run(expr, func(t *testing.T) {
				body := `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT ` + expr + `; SELECT 1; END;`
				checkSplit(t, []string{body, ` SELECT 2;`})
			})
		}
	})

	t.Run("closes at end preceded only by comments", func(t *testing.T) {
		for _, comment := range []string{"-- note END\n", "/* note; */ ", "\n/* a /* b; */ */ -- c\n"} {
			t.Run(comment, func(t *testing.T) {
				body := `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; ` + comment + `END;`
				checkSplit(t, []string{body, ` SELECT 2;`})
			})
		}
	})

	t.Run("ignores non-ASCII begin atomic lookalikes", func(t *testing.T) {
		// atomıc (dotless ı) case-folds to ATOMIC in some Unicode mappings but is a plain
		// identifier in SQL.
		checkSplit(t, []string{"BEGIN atomıc;", " SELECT 'end';", " SELECT 2;"})
	})

	t.Run("does not treat schema-qualified atomic function names as begin atomic", func(t *testing.T) {
		sql := []string{`CREATE OR REPLACE FUNCTION public.atomic_example()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN 1;
END;
$$;`,
			`
GRANT EXECUTE ON FUNCTION public.atomic_example() TO authenticated;`,
		}
		checkSplit(t, sql)
	})
}
