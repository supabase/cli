package lint

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/client"
	"github.com/jackc/pgerrcode"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

func TestLintCommand(t *testing.T) {
	const version = "1.41"

	// Setup in-memory fs
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))
	// Setup mock docker
	require.NoError(t, client.WithHTTPClient(http.DefaultClient)(utils.Docker))
	defer gock.OffAll()
	gock.New("http:///var/run/docker.sock").
		Head("/_ping").
		Reply(http.StatusOK).
		SetHeader("API-Version", version).
		SetHeader("OSType", "linux")
	gock.New("http:///var/run/docker.sock").
		Get("/v" + version + "/containers").
		Reply(200).
		JSON(types.ContainerJSON{})
	// Setup db response
	expected := Result{
		Function: "22751",
		Issues: []Issue{{
			Level:   AllowedLevels[1],
			Message: `record "r" has no field "c"`,
			Statement: &Statement{
				LineNumber: "6",
				Text:       "RAISE",
			},
			Context:  `SQL expression "r.c"`,
			SQLState: pgerrcode.UndefinedColumn,
		}},
	}
	data, err := json.Marshal(expected)
	require.NoError(t, err)
	// Setup mock postgres
	conn := pgtest.NewConn()
	defer conn.Close(t)
	conn.Query("begin").Reply("BEGIN").
		Query(ENABLE_PGSQL_CHECK).
		Reply("CREATE EXTENSION").
		Query(checkSchemaScript, "public").
		Reply("SELECT 1", []interface{}{"f1", string(data)}).
		Query("rollback").Reply("ROLLBACK")
	// Run test
	assert.NoError(t, Run(context.Background(), []string{"public"}, "warning", fsys, conn.Intercept))
	// Validate api
	assert.Empty(t, apitest.ListUnmatchedRequests())
}

func TestLintDatabase(t *testing.T) {
	t.Run("parses lint results", func(t *testing.T) {
		expected := []Result{{
			Function: "public.f1",
			Issues: []Issue{{
				Level:   AllowedLevels[1],
				Message: `record "r" has no field "c"`,
				Statement: &Statement{
					LineNumber: "6",
					Text:       "RAISE",
				},
				Context:  `SQL expression "r.c"`,
				SQLState: pgerrcode.UndefinedColumn,
			}, {
				Level:    "warning extra",
				Message:  `never read variable "entity"`,
				SQLState: pgerrcode.SuccessfulCompletion,
			}},
		}, {
			Function: "public.f2",
			Issues: []Issue{{
				Level:   AllowedLevels[1],
				Message: `relation "t2" does not exist`,
				Statement: &Statement{
					LineNumber: "4",
					Text:       "FOR over SELECT rows",
				},
				Query: &Query{
					Position: "15",
					Text:     "SELECT * FROM t2",
				},
				SQLState: pgerrcode.UndefinedTable,
			}},
		}}
		r1, err := json.Marshal(expected[0])
		require.NoError(t, err)
		r2, err := json.Marshal(expected[1])
		require.NoError(t, err)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("begin").Reply("BEGIN").
			Query(ENABLE_PGSQL_CHECK).
			Reply("CREATE EXTENSION").
			Query(checkSchemaScript, "public").
			Reply("SELECT 2",
				[]interface{}{"f1", string(r1)},
				[]interface{}{"f2", string(r2)},
			).
			Query("rollback").Reply("ROLLBACK")
		// Connect to mock
		ctx := context.Background()
		mock, err := ConnectLocalPostgres(ctx, "localhost", 5432, "postgres", conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		result, err := LintDatabase(ctx, mock, []string{"public"})
		assert.NoError(t, err)
		// Validate result
		assert.ElementsMatch(t, expected, result)
	})

	t.Run("supports multiple schema", func(t *testing.T) {
		expected := []Result{{
			Function: "public.where_clause",
			Issues: []Issue{{
				Level:   AllowedLevels[0],
				Message: "target type is different type than source type",
				Statement: &Statement{
					LineNumber: "32",
					Text:       "statement block",
				},
				Hint:     "The input expression type does not have an assignment cast to the target type.",
				Detail:   `cast "text" value to "text[]" type`,
				Context:  `during statement block local variable "clause_arr" initialization on line 3`,
				SQLState: pgerrcode.DatatypeMismatch,
			}},
		}, {
			Function: "private.f2",
			Issues:   []Issue{},
		}}
		r1, err := json.Marshal(expected[0])
		require.NoError(t, err)
		r2, err := json.Marshal(expected[1])
		require.NoError(t, err)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("begin").Reply("BEGIN").
			Query(ENABLE_PGSQL_CHECK).
			Reply("CREATE EXTENSION").
			Query(checkSchemaScript, "public").
			Reply("SELECT 1", []interface{}{"where_clause", string(r1)}).
			Query(checkSchemaScript, "private").
			Reply("SELECT 1", []interface{}{"f2", string(r2)}).
			Query("rollback").Reply("ROLLBACK")
		// Connect to mock
		ctx := context.Background()
		mock, err := ConnectLocalPostgres(ctx, "localhost", 5432, "postgres", conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		result, err := LintDatabase(ctx, mock, []string{"public", "private"})
		assert.NoError(t, err)
		// Validate result
		assert.ElementsMatch(t, expected, result)
	})

	t.Run("throws error on missing extension", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("begin").Reply("BEGIN").
			Query(ENABLE_PGSQL_CHECK).
			ReplyError(pgerrcode.UndefinedFile, `could not open extension control file "/usr/share/postgresql/14/extension/plpgsql_check.control": No such file or directory"`).
			Query("rollback").Reply("ROLLBACK")
		// Connect to mock
		ctx := context.Background()
		mock, err := ConnectLocalPostgres(ctx, "localhost", 5432, "postgres", conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		_, err = LintDatabase(ctx, mock, []string{"public"})
		assert.Error(t, err)
	})

	t.Run("throws error on malformed json", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("begin").Reply("BEGIN").
			Query(ENABLE_PGSQL_CHECK).
			Reply("CREATE EXTENSION").
			Query(checkSchemaScript, "public").
			Reply("SELECT 1", []interface{}{"f1", "malformed"}).
			Query("rollback").Reply("ROLLBACK")
		// Connect to mock
		ctx := context.Background()
		mock, err := ConnectLocalPostgres(ctx, "localhost", 5432, "postgres", conn.Intercept)
		require.NoError(t, err)
		defer mock.Close(ctx)
		// Run test
		_, err = LintDatabase(ctx, mock, []string{"public"})
		assert.Error(t, err)
	})
}

func TestConnectLocal(t *testing.T) {
	t.Run("connects with debug log", func(t *testing.T) {
		viper.Set("DEBUG", true)
		_, err := ConnectLocalPostgres(context.Background(), "localhost", 5432, "postgres")
		assert.Error(t, err)
	})

	t.Run("throws error on invalid port", func(t *testing.T) {
		_, err := ConnectLocalPostgres(context.Background(), "localhost", 0, "postgres")
		assert.Error(t, err)
	})
}

func TestPrintResult(t *testing.T) {
	result := []Result{{
		Function: "public.f1",
		Issues: []Issue{{
			Level:   "warning",
			Message: "test 1a",
		}, {
			Level:   "error",
			Message: "test 1b",
		}},
	}, {
		Function: "private.f2",
		Issues: []Issue{{
			Level:   "warning extra",
			Message: "test 2",
		}},
	}}

	t.Run("filters warning level", func(t *testing.T) {
		// Run test
		var out bytes.Buffer
		assert.NoError(t, printResultJSON(result, toEnum("warning"), &out))
		// Validate output
		var actual []Result
		assert.NoError(t, json.Unmarshal(out.Bytes(), &actual))
		assert.ElementsMatch(t, result, actual)
	})

	t.Run("filters error level", func(t *testing.T) {
		// Run test
		var out bytes.Buffer
		assert.NoError(t, printResultJSON(result, toEnum("error"), &out))
		// Validate output
		var actual []Result
		assert.NoError(t, json.Unmarshal(out.Bytes(), &actual))
		assert.ElementsMatch(t, []Result{{
			Function: result[0].Function,
			Issues:   []Issue{result[0].Issues[1]},
		}}, actual)
	})
}
