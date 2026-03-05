package add

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func TestRenderValue(t *testing.T) {
	out, err := renderValue(
		`{{context.table_name}} -> {{fn.url}}`,
		map[string]string{"table_name": "messages"},
		map[string]string{"fn.url": "http://localhost:54321/functions/v1/fn"},
	)
	require.NoError(t, err)
	assert.Equal(t, "messages -> http://localhost:54321/functions/v1/fn", out)
}

func TestRenderValueInputsAndEnv(t *testing.T) {
	t.Setenv("SUPABASE_URL", "http://localhost:54321")
	out, err := renderValue(
		`{{inputs.table_name}} -> {{env.SUPABASE_URL}}`,
		map[string]string{"table_name": "messages"},
		nil,
	)
	require.NoError(t, err)
	assert.Equal(t, "messages -> http://localhost:54321", out)
}

func TestRenderValueMissingEnvLeavesPlaceholder(t *testing.T) {
	out, err := renderValue(
		`{{env.SUPABASE_URL}}`,
		nil,
		nil,
	)
	require.NoError(t, err)
	assert.Equal(t, `{{env.SUPABASE_URL}}`, out)
}

func TestAddRunWithLocalTemplate(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	// Override timestamp to produce deterministic filenames.
	origTimestamp := migrationTimestamp
	seq := 0
	migrationTimestamp = func(_ int) string {
		seq++
		return "20260305120000"
	}
	t.Cleanup(func() { migrationTimestamp = origTimestamp })

	template := `{
  "name": "add-embeddings",
  "inputs": {
    "table_name": {"label": "Table", "type": "string", "required": true},
    "openai_api_key": {"label": "OpenAI", "type": "password", "required": true},
    "embedding_function_secret": {"label": "Secret", "type": "password", "required": true}
  },
  "steps": [
    {
      "name": "provision_database",
      "components": [
        {"name": "add-embedding-column", "type": "migration", "path": "./sql/add-embedding-column.sql"}
      ]
    },
    {
      "name": "deploy_function",
      "components": [
        {"name": "generate-embedding", "type": "edge_function", "path": "./functions/generate-embedding"}
      ]
    },
    {
      "name": "configure_secrets",
      "components": [
        {"name": "openai-api-key", "type": "secret", "key": "OPENAI_API_KEY", "value": "{{context.openai_api_key}}"},
        {"name": "embedding-function-secret-vault", "type": "vault", "key": "EMBEDDING_FUNCTION_SECRET", "value": "{{context.embedding_function_secret}}"}
      ]
    }
  ]
}`

	require.NoError(t, afero.WriteFile(fsys, "templates/add-embeddings.json", []byte(template), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/sql/add-embedding-column.sql", []byte(`alter table {{context.table_name}} add column embedding vector(1536);`), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/functions/generate-embedding/index.ts", []byte(`export default "{{context.table_name}}";`), 0644))
	require.NoError(t, Run(context.Background(), "templates/add-embeddings.json", []string{
		"table_name=documents",
		"openai_api_key=test-key",
		"embedding_function_secret=test-secret",
	}, fsys))

	// Migration file should be in migrations dir with timestamp prefix.
	migrationPath := filepath.Join(utils.MigrationsDir, "20260305120000_add-embedding-column.sql")
	sql, err := afero.ReadFile(fsys, migrationPath)
	require.NoError(t, err)
	assert.Contains(t, string(sql), "alter table documents")

	fn, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "generate-embedding", "index.ts"))
	require.NoError(t, err)
	assert.Contains(t, string(fn), "documents")

	config, err := afero.ReadFile(fsys, utils.ConfigPath)
	require.NoError(t, err)
	assert.Contains(t, string(config), `[functions.generate-embedding]`)
	assert.Contains(t, string(config), `OPENAI_API_KEY = "env(OPENAI_API_KEY)"`)
	assert.Contains(t, string(config), `EMBEDDING_FUNCTION_SECRET = "env(EMBEDDING_FUNCTION_SECRET)"`)

	functionEnv := readEnvMap(t, fsys, utils.FallbackEnvFilePath)
	assert.Equal(t, "test-key", functionEnv["OPENAI_API_KEY"])
	assert.NotContains(t, functionEnv, "EMBEDDING_FUNCTION_SECRET")
}

func TestAddRunWithMultipleMigrations(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	origTimestamp := migrationTimestamp
	migrationTimestamp = func(seq int) string {
		return strings.Replace("20260305120000", "0000", strings.Repeat("0", 4-len(string(rune('0'+seq))))+string(rune('0'+seq)), 1)
	}
	t.Cleanup(func() { migrationTimestamp = origTimestamp })

	template := `{
  "name": "multi-migration",
  "steps": [
    {
      "name": "provision_database",
      "components": [
        {"name": "enable-extensions", "type": "migration", "path": "./sql/extensions.sql"},
        {"name": "create-tables", "type": "migration", "path": "./sql/tables.sql"}
      ]
    }
  ]
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/multi.json", []byte(template), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/sql/extensions.sql", []byte(`create extension if not exists vector;`), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/sql/tables.sql", []byte(`create table public.items (id bigint primary key);`), 0644))

	require.NoError(t, Run(context.Background(), "templates/multi.json", nil, fsys))

	// Both migration files should exist.
	entries, err := afero.ReadDir(fsys, utils.MigrationsDir)
	require.NoError(t, err)
	assert.Len(t, entries, 2)

	// Files should have different timestamps due to sequence counter.
	names := []string{entries[0].Name(), entries[1].Name()}
	assert.Contains(t, names[0], "enable-extensions")
	assert.Contains(t, names[1], "create-tables")
}

func TestAddRunWithEdgeFunctionPathArray(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	template := `{
  "name": "path-array",
  "inputs": {
    "model": {"label": "Model", "type": "string", "default": "text-embedding-3-small"}
  },
  "steps": [
    {
      "name": "deploy_function",
      "components": [
        {
          "name": "generate-embedding",
          "type": "edge_function",
          "path": [
            "./functions/generate-embedding/index.ts",
            "./functions/generate-embedding/lib/helper.ts"
          ]
        }
      ]
    }
  ]
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/path-array.json", []byte(template), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/functions/generate-embedding/index.ts", []byte(`import { helper } from "./lib/helper.ts"; export const model = "{{context.model}}"`), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/functions/generate-embedding/lib/helper.ts", []byte(`export const helper = "{{context.model}}"`), 0644))

	require.NoError(t, Run(context.Background(), "templates/path-array.json", nil, fsys))

	index, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "generate-embedding", "index.ts"))
	require.NoError(t, err)
	assert.Contains(t, string(index), "text-embedding-3-small")

	helper, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "generate-embedding", "lib", "helper.ts"))
	require.NoError(t, err)
	assert.Contains(t, string(helper), "text-embedding-3-small")
}

func TestAddRunWithEdgeFunctionPathArraySharedSibling(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	template := `{
  "name": "path-array-shared-sibling",
  "steps": [
    {
      "name": "deploy_function",
      "components": [
        {
          "name": "stripe-webhook",
          "type": "edge_function",
          "path": [
            "./functions/stripe-webhook/index.ts",
            "./functions/_shared/db.ts"
          ]
        }
      ]
    }
  ]
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/path-array-shared-sibling.json", []byte(template), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/functions/stripe-webhook/index.ts", []byte(`import { db } from "../_shared/db.ts"; export const handler = () => db;`), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/functions/_shared/db.ts", []byte(`export const db = "ok"`), 0644))

	require.NoError(t, Run(context.Background(), "templates/path-array-shared-sibling.json", nil, fsys))

	index, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "stripe-webhook", "index.ts"))
	require.NoError(t, err)
	assert.Contains(t, string(index), "../_shared/db.ts")

	shared, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "_shared", "db.ts"))
	require.NoError(t, err)
	assert.Contains(t, string(shared), `export const db = "ok"`)

	_, err = fsys.Stat(filepath.Join(utils.FunctionsDir, "stripe-webhook", "_shared", "db.ts"))
	assert.Error(t, err)
	assert.True(t, os.IsNotExist(err))
}

func TestAddRunUnsupportedComponentTypeReturnsError(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	template := `{
  "name": "bad-type",
  "steps": [
    {
      "name": "provision_database",
      "components": [
        {"name": "stripe-schema", "type": "schema", "path": "./schemas/stripe-schema.sql"}
      ]
    }
  ]
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/bad.json", []byte(template), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/schemas/stripe-schema.sql", []byte(`create schema if not exists stripe;`), 0644))

	err := Run(context.Background(), "templates/bad.json", nil, fsys)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported component type: schema")
}

func TestAddRunSecretAppendsToExistingFunctionsEnv(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))
	require.NoError(t, utils.WriteFile(utils.FallbackEnvFilePath, []byte("EXISTING=1\n"), fsys))

	template := `{
  "name": "secret-env-append",
  "inputs": {
    "secret_value": {"type": "string", "required": true}
  },
  "steps": [
    {
      "name": "configure_secrets",
      "components": [
        {"name": "openai-api-key", "type": "secret", "key": "OPENAI_API_KEY", "value": "{{inputs.secret_value}}"}
      ]
    }
  ]
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/secret-env-append.json", []byte(template), 0644))

	require.NoError(t, Run(context.Background(), "templates/secret-env-append.json", []string{
		"secret_value=appended-value",
	}, fsys))

	functionEnv := readEnvMap(t, fsys, utils.FallbackEnvFilePath)
	assert.Equal(t, "1", functionEnv["EXISTING"])
	assert.Equal(t, "appended-value", functionEnv["OPENAI_API_KEY"])
}

func TestAddRunShowsPostInstallMessage(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	template := `{
  "name": "post-install-template",
  "inputs": {
    "webhook_events": {"type": "string", "required": true},
    "run_backfill": {"type": "string", "required": true}
  },
  "steps": [],
  "postInstall": {
    "title": "Complete setup for {{inputs.webhook_events}}",
    "message": "Call: {{env.SUPABASE_URL}}/functions/v1/stripe-setup\nrun_backfill={{inputs.run_backfill}}"
  }
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/post-install-template.json", []byte(template), 0644))

	t.Setenv("SUPABASE_URL", "http://localhost:54321")
	stdout := captureStdout(t, func() error {
		return Run(context.Background(), "templates/post-install-template.json", []string{
			"webhook_events=[\"invoice.paid\"]",
			"run_backfill=true",
		}, fsys)
	})

	finishedIdx := strings.Index(stdout, "Finished ")
	postInstallIdx := strings.Index(stdout, "Complete setup for [\"invoice.paid\"]")
	require.NotEqual(t, -1, finishedIdx)
	require.NotEqual(t, -1, postInstallIdx)
	assert.Greater(t, postInstallIdx, finishedIdx)
	assert.Contains(t, stdout, "Call: http://localhost:54321/functions/v1/stripe-setup")
	assert.Contains(t, stdout, "run_backfill=true")
}

func captureStdout(t *testing.T, run func() error) string {
	t.Helper()
	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	require.NoError(t, err)
	os.Stdout = w
	t.Cleanup(func() {
		os.Stdout = oldStdout
	})

	runErr := run()
	require.NoError(t, runErr)
	require.NoError(t, w.Close())

	var out bytes.Buffer
	_, err = io.Copy(&out, r)
	require.NoError(t, err)
	require.NoError(t, r.Close())
	return out.String()
}

func readEnvMap(t *testing.T, fsys afero.Fs, path string) map[string]string {
	t.Helper()
	f, err := fsys.Open(path)
	require.NoError(t, err)
	defer f.Close()
	envMap, err := godotenv.Parse(f)
	require.NoError(t, err)
	return envMap
}
