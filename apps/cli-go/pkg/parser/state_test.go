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
