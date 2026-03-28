package query

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/pgtest"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestRunSelectTable(t *testing.T) {
	utils.Config.Hostname = "127.0.0.1"
	utils.Config.Db.Port = 5432

	conn := pgtest.NewConn()
	defer conn.Close(t)
	conn.Query("SELECT 1 as num, 'hello' as greeting").
		Reply("SELECT 1", []any{int64(1), "hello"})

	var buf bytes.Buffer
	err := RunLocal(context.Background(), "SELECT 1 as num, 'hello' as greeting", dbConfig, "table", false, &buf, conn.Intercept)
	assert.NoError(t, err)
	output := buf.String()
	assert.Contains(t, output, "c_00")
	assert.Contains(t, output, "c_01")
	assert.Contains(t, output, "1")
	assert.Contains(t, output, "hello")
}

func TestRunSelectJSON(t *testing.T) {
	utils.Config.Hostname = "127.0.0.1"
	utils.Config.Db.Port = 5432

	conn := pgtest.NewConn()
	defer conn.Close(t)
	conn.Query("SELECT 42 as id, 'test' as name").
		Reply("SELECT 1", []any{int64(42), "test"})

	var buf bytes.Buffer
	err := RunLocal(context.Background(), "SELECT 42 as id, 'test' as name", dbConfig, "json", true, &buf, conn.Intercept)
	assert.NoError(t, err)

	var envelope map[string]interface{}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &envelope))
	assert.Contains(t, envelope["warning"], "untrusted data")
	assert.NotEmpty(t, envelope["boundary"])
	rows, ok := envelope["rows"].([]interface{})
	require.True(t, ok)
	assert.Len(t, rows, 1)
	row := rows[0].(map[string]interface{})
	// pgtest mock generates column names as c_00, c_01
	assert.Equal(t, float64(42), row["c_00"])
	assert.Equal(t, "test", row["c_01"])
}

func TestRunSelectJSONNoEnvelope(t *testing.T) {
	utils.Config.Hostname = "127.0.0.1"
	utils.Config.Db.Port = 5432

	conn := pgtest.NewConn()
	defer conn.Close(t)
	conn.Query("SELECT 42 as id, 'test' as name").
		Reply("SELECT 1", []any{int64(42), "test"})

	var buf bytes.Buffer
	err := RunLocal(context.Background(), "SELECT 42 as id, 'test' as name", dbConfig, "json", false, &buf, conn.Intercept)
	assert.NoError(t, err)

	// Non-agent mode: plain JSON array, no envelope
	var rows []map[string]interface{}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rows))
	assert.Len(t, rows, 1)
	// pgtest mock generates column names as c_00, c_01
	assert.Equal(t, float64(42), rows[0]["c_00"])
	assert.Equal(t, "test", rows[0]["c_01"])
}

func TestRunSelectCSV(t *testing.T) {
	utils.Config.Hostname = "127.0.0.1"
	utils.Config.Db.Port = 5432

	conn := pgtest.NewConn()
	defer conn.Close(t)
	conn.Query("SELECT 1 as a, 2 as b").
		Reply("SELECT 1", []any{int64(1), int64(2)})

	var buf bytes.Buffer
	err := RunLocal(context.Background(), "SELECT 1 as a, 2 as b", dbConfig, "csv", false, &buf, conn.Intercept)
	assert.NoError(t, err)
	output := buf.String()
	assert.Contains(t, output, "c_00,c_01")
	assert.Contains(t, output, "1,2")
}

func TestRunDDL(t *testing.T) {
	utils.Config.Hostname = "127.0.0.1"
	utils.Config.Db.Port = 5432

	conn := pgtest.NewConn()
	defer conn.Close(t)
	conn.Query("CREATE TABLE test (id int)").
		Reply("CREATE TABLE")

	var buf bytes.Buffer
	err := RunLocal(context.Background(), "CREATE TABLE test (id int)", dbConfig, "table", false, &buf, conn.Intercept)
	assert.NoError(t, err)
	assert.Contains(t, buf.String(), "CREATE TABLE")
}

func TestRunDMLInsert(t *testing.T) {
	utils.Config.Hostname = "127.0.0.1"
	utils.Config.Db.Port = 5432

	conn := pgtest.NewConn()
	defer conn.Close(t)
	conn.Query("INSERT INTO test VALUES (1)").
		Reply("INSERT 0 1")

	var buf bytes.Buffer
	err := RunLocal(context.Background(), "INSERT INTO test VALUES (1)", dbConfig, "table", false, &buf, conn.Intercept)
	assert.NoError(t, err)
	assert.Contains(t, buf.String(), "INSERT 0 1")
}

func TestRunQueryError(t *testing.T) {
	utils.Config.Hostname = "127.0.0.1"
	utils.Config.Db.Port = 5432

	conn := pgtest.NewConn()
	defer conn.Close(t)
	conn.Query("SELECT bad").
		ReplyError("42703", "column \"bad\" does not exist")

	var buf bytes.Buffer
	err := RunLocal(context.Background(), "SELECT bad", dbConfig, "table", false, &buf, conn.Intercept)
	assert.Error(t, err)
}

func TestResolveSQLFromArgs(t *testing.T) {
	sql, err := ResolveSQL([]string{"SELECT 1"}, "", os.Stdin)
	assert.NoError(t, err)
	assert.Equal(t, "SELECT 1", sql)
}

func TestResolveSQLFromFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.sql")
	require.NoError(t, os.WriteFile(path, []byte("SELECT 42"), 0600))

	sql, err := ResolveSQL(nil, path, os.Stdin)
	assert.NoError(t, err)
	assert.Equal(t, "SELECT 42", sql)
}

func TestResolveSQLFileTakesPrecedence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.sql")
	require.NoError(t, os.WriteFile(path, []byte("SELECT from_file"), 0600))

	sql, err := ResolveSQL([]string{"SELECT from_arg"}, path, os.Stdin)
	assert.NoError(t, err)
	assert.Equal(t, "SELECT from_file", sql)
}

func TestResolveSQLFromStdin(t *testing.T) {
	r, w, err := os.Pipe()
	require.NoError(t, err)
	_, err = w.WriteString("SELECT from_pipe")
	require.NoError(t, err)
	w.Close()

	sql, err := ResolveSQL(nil, "", r)
	assert.NoError(t, err)
	assert.Equal(t, "SELECT from_pipe", sql)
}

func TestResolveSQLNoInput(t *testing.T) {
	_, err := ResolveSQL(nil, "", os.Stdin)
	assert.Error(t, err)
}

func TestResolveSQLFileNotFound(t *testing.T) {
	_, err := ResolveSQL(nil, "/nonexistent/path.sql", os.Stdin)
	assert.Error(t, err)
}

func TestRunLinkedSelectJSON(t *testing.T) {
	projectRef := apitest.RandomProjectRef()
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	responseBody := `[{"id": 1, "name": "test"}]`
	defer gock.OffAll()
	gock.New(utils.DefaultApiHost).
		Post("/v1/projects/" + projectRef + "/database/query").
		Reply(http.StatusCreated).
		BodyString(responseBody)

	var buf bytes.Buffer
	err := RunLinked(context.Background(), "SELECT 1 as id, 'test' as name", projectRef, "json", true, &buf)
	assert.NoError(t, err)

	var envelope map[string]interface{}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &envelope))
	assert.Contains(t, envelope["warning"], "untrusted data")
	assert.NotEmpty(t, envelope["boundary"])
	rows, ok := envelope["rows"].([]interface{})
	require.True(t, ok)
	assert.Len(t, rows, 1)
	row := rows[0].(map[string]interface{})
	assert.Equal(t, float64(1), row["id"])
	assert.Equal(t, "test", row["name"])
	assert.Empty(t, apitest.ListUnmatchedRequests())
}

func TestRunLinkedSelectTable(t *testing.T) {
	projectRef := apitest.RandomProjectRef()
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	responseBody := `[{"id": 1, "name": "test"}]`
	defer gock.OffAll()
	gock.New(utils.DefaultApiHost).
		Post("/v1/projects/" + projectRef + "/database/query").
		Reply(http.StatusCreated).
		BodyString(responseBody)

	var buf bytes.Buffer
	err := RunLinked(context.Background(), "SELECT 1 as id, 'test' as name", projectRef, "table", false, &buf)
	assert.NoError(t, err)
	output := buf.String()
	assert.Contains(t, output, "id")
	assert.Contains(t, output, "name")
	assert.Contains(t, output, "1")
	assert.Contains(t, output, "test")
	assert.Empty(t, apitest.ListUnmatchedRequests())
}

func TestRunLinkedSelectCSV(t *testing.T) {
	projectRef := apitest.RandomProjectRef()
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	responseBody := `[{"a": 1, "b": 2}]`
	defer gock.OffAll()
	gock.New(utils.DefaultApiHost).
		Post("/v1/projects/" + projectRef + "/database/query").
		Reply(http.StatusCreated).
		BodyString(responseBody)

	var buf bytes.Buffer
	err := RunLinked(context.Background(), "SELECT 1 as a, 2 as b", projectRef, "csv", false, &buf)
	assert.NoError(t, err)
	output := buf.String()
	assert.Contains(t, output, "a,b")
	assert.Contains(t, output, "1,2")
	assert.Empty(t, apitest.ListUnmatchedRequests())
}

func TestFormatOutputNilColsJSON(t *testing.T) {
	var buf bytes.Buffer
	err := formatOutput(&buf, "json", true, nil, nil)
	assert.NoError(t, err)
	var envelope map[string]interface{}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &envelope))
	rows, ok := envelope["rows"].([]interface{})
	require.True(t, ok)
	assert.Len(t, rows, 0)
}

func TestFormatOutputNilColsTable(t *testing.T) {
	var buf bytes.Buffer
	err := formatOutput(&buf, "table", false, nil, nil)
	assert.NoError(t, err)
}

func TestFormatOutputNilColsCSV(t *testing.T) {
	var buf bytes.Buffer
	err := formatOutput(&buf, "csv", false, nil, nil)
	assert.NoError(t, err)
}

func TestRunLinkedEmptyResult(t *testing.T) {
	projectRef := apitest.RandomProjectRef()
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	defer gock.OffAll()
	gock.New(utils.DefaultApiHost).
		Post("/v1/projects/" + projectRef + "/database/query").
		Reply(http.StatusCreated).
		BodyString("[]")

	var buf bytes.Buffer
	err := RunLinked(context.Background(), "SELECT 1 WHERE false", projectRef, "json", true, &buf)
	assert.NoError(t, err)
	// Empty result still returns envelope with empty rows
	var envelope map[string]interface{}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &envelope))
	assert.Contains(t, envelope["warning"], "untrusted data")
	rows, ok := envelope["rows"].([]interface{})
	require.True(t, ok)
	assert.Len(t, rows, 0)
	assert.Empty(t, apitest.ListUnmatchedRequests())
}

func TestRunLinkedAPIError(t *testing.T) {
	projectRef := apitest.RandomProjectRef()
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	defer gock.OffAll()
	gock.New(utils.DefaultApiHost).
		Post("/v1/projects/" + projectRef + "/database/query").
		Reply(http.StatusBadRequest).
		BodyString(`{"message": "syntax error"}`)

	var buf bytes.Buffer
	err := RunLinked(context.Background(), "INVALID SQL", projectRef, "table", false, &buf)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "400")
	assert.Empty(t, apitest.ListUnmatchedRequests())
}
