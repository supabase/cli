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
			Statement: Statement{
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
	conn.Query("CREATE EXTENSION IF NOT EXISTS plpgsql_check").
		Reply("CREATE EXTENSION").
		Query(checkSchemaScript, "public").
		Reply("SELECT 1", map[string]interface{}{
			"proname":                "f1",
			"plpgsql_check_function": string(data),
		})
	// Run test
	var out bytes.Buffer
	assert.NoError(t, Run(context.Background(), []string{"public"}, "warning", &out, fsys, conn.Intercept))
	// Validate output
	assert.NotEmpty(t, out)
}

func TestLintDatabase(t *testing.T) {
	t.Run("parses lint results", func(t *testing.T) {
		expected := []Result{{
			Function: "public.f1",
			Issues: []Issue{{
				Level:   AllowedLevels[1],
				Message: `record "r" has no field "c"`,
				Statement: Statement{
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
				Statement: Statement{
					LineNumber: "4",
					Text:       "FOR over SELECT rows",
				},
				Query: Query{
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
		conn.Query("CREATE EXTENSION IF NOT EXISTS plpgsql_check").
			Reply("CREATE EXTENSION").
			Query(checkSchemaScript, "public").
			Reply("SELECT 2", map[string]interface{}{
				"proname":                "f1",
				"plpgsql_check_function": string(r1),
			}, map[string]interface{}{
				"proname":                "f2",
				"plpgsql_check_function": string(r2),
			})
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

	t.Run("throws error on missing extension", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query("CREATE EXTENSION IF NOT EXISTS plpgsql_check").
			ReplyError(pgerrcode.UndefinedFile, `could not open extension control file "/usr/share/postgresql/14/extension/plpgsql_check.control": No such file or directory"`)
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
		conn.Query("CREATE EXTENSION IF NOT EXISTS plpgsql_check").
			Reply("CREATE EXTENSION").
			Query(checkSchemaScript, "public").
			Reply("SELECT 1", map[string]interface{}{
				"proname":                "f1",
				"plpgsql_check_function": "malformed",
			})
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
