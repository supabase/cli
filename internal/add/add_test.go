package add

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/fstest"
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
	}, false, fsys))

	// Migration file should be in migrations dir using the migration name.
	migrationPath := filepath.Join(utils.MigrationsDir, "add-embedding-column.sql")
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

func TestAddRunWithRemoteTemplateSlug(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/templates/automatic-embeddings":
			_, _ = w.Write([]byte(`{
  "name": "automatic-embeddings",
  "inputs": {
    "table_name": {"label": "Table", "type": "string", "required": true}
  },
  "steps": [
    {
      "name": "provision_database",
      "components": [
        {"name": "add-embedding-column", "type": "migration", "path": "` + server.URL + `/assets/automatic-embeddings/sql/add-embedding-column.sql"}
      ]
    },
    {
      "name": "deploy_function",
      "components": [
        {
          "name": "generate-embedding",
          "type": "edge_function",
          "path": [
            "` + server.URL + `/assets/automatic-embeddings/functions/generate-embedding/index.ts",
            "` + server.URL + `/assets/automatic-embeddings/functions/generate-embedding/lib/helper.ts"
          ]
        }
      ]
    }
  ]
}`))
		case "/assets/automatic-embeddings/sql/add-embedding-column.sql":
			_, _ = w.Write([]byte(`alter table {{context.table_name}} add column embedding vector(1536);`))
		case "/assets/automatic-embeddings/functions/generate-embedding/index.ts":
			_, _ = w.Write([]byte(`import { helper } from "./lib/helper.ts"; export default helper("{{context.table_name}}");`))
		case "/assets/automatic-embeddings/functions/generate-embedding/lib/helper.ts":
			_, _ = w.Write([]byte(`export const helper = (value: string) => value;`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	t.Setenv(templatesAPIURLEnv, server.URL+"/templates")
	require.NoError(t, Run(context.Background(), "automatic-embeddings", []string{
		"table_name=documents",
	}, false, fsys))

	migrationPath := filepath.Join(utils.MigrationsDir, "add-embedding-column.sql")
	sql, err := afero.ReadFile(fsys, migrationPath)
	require.NoError(t, err)
	assert.Contains(t, string(sql), "alter table documents")

	index, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "generate-embedding", "index.ts"))
	require.NoError(t, err)
	assert.Contains(t, string(index), `helper("documents")`)

	helper, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "generate-embedding", "lib", "helper.ts"))
	require.NoError(t, err)
	assert.Contains(t, string(helper), "export const helper")
}

func TestAddRunWithRemoteTemplateSlugRejectsRelativeComponentPaths(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/templates/automatic-embeddings":
			_, _ = w.Write([]byte(`{
  "name": "automatic-embeddings",
  "steps": [
    {
      "name": "provision_database",
      "components": [
        {"name": "add-embedding-column", "type": "migration", "path": "./sql/add-embedding-column.sql"}
      ]
    }
  ]
}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	t.Setenv(templatesAPIURLEnv, server.URL+"/templates")
	err := Run(context.Background(), "automatic-embeddings", nil, false, fsys)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "remote template component path must be an absolute URL")
}

func TestAddRunWithTemplateSlugMissingAPIURL(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))
	t.Setenv(templatesAPIURLEnv, "")

	err := Run(context.Background(), "automatic-embeddings", nil, false, fsys)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "missing "+templatesAPIURLEnv+" environment variable")
}

func TestAddRunRejectsRemoteTemplateURL(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	err := Run(context.Background(), "https://example.com/templates/automatic-embeddings.json", nil, false, fsys)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "remote template URLs are unsupported")
}

func TestAddRunWithMultipleMigrations(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

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

	require.NoError(t, Run(context.Background(), "templates/multi.json", nil, false, fsys))

	// Both migration files should exist.
	entries, err := afero.ReadDir(fsys, utils.MigrationsDir)
	require.NoError(t, err)
	assert.Len(t, entries, 2)

	// Files should use migration component names.
	names := []string{entries[0].Name(), entries[1].Name()}
	assert.ElementsMatch(t, []string{"enable-extensions.sql", "create-tables.sql"}, names)
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

	require.NoError(t, Run(context.Background(), "templates/path-array.json", nil, false, fsys))

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

	require.NoError(t, Run(context.Background(), "templates/path-array-shared-sibling.json", nil, false, fsys))

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

	err := Run(context.Background(), "templates/bad.json", nil, false, fsys)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported component type: schema")
}

func TestAddRunInvalidTemplateFormatReturnsError(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	template := `{
  "name": "bad-template",
  "stepz": []
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/bad-format.json", []byte(template), 0644))

	err := Run(context.Background(), "templates/bad-format.json", nil, false, fsys)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "template manifest has invalid JSON format")
	assert.Contains(t, err.Error(), "unknown field \"stepz\"")
}

func TestAddRunEdgeFunctionOverwriteRequiresConfirmation(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	template := `{
  "name": "overwrite-fn",
  "steps": [
    {
      "name": "deploy_function",
      "components": [
        {
          "name": "my-fn",
          "type": "edge_function",
          "path": "./functions/my-fn/index.ts"
        }
      ]
    }
  ]
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/overwrite-fn.json", []byte(template), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/functions/my-fn/index.ts", []byte(`export const value = "new";`), 0644))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.FunctionsDir, "my-fn", "index.ts"), []byte(`export const value = "old";`), 0644))

	t.Run("aborts when overwrite is declined", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "n\n"))
		err := Run(context.Background(), "templates/overwrite-fn.json", nil, false, fsys)
		require.Error(t, err)
		assert.Contains(t, err.Error(), context.Canceled.Error())

		index, readErr := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "my-fn", "index.ts"))
		require.NoError(t, readErr)
		assert.Contains(t, string(index), `"old"`)
	})

	t.Run("overwrites when confirmed", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y\n"))
		err := Run(context.Background(), "templates/overwrite-fn.json", nil, false, fsys)
		require.NoError(t, err)

		index, readErr := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "my-fn", "index.ts"))
		require.NoError(t, readErr)
		assert.Contains(t, string(index), `"new"`)
	})
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
	}, false, fsys))

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
		}, false, fsys)
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
