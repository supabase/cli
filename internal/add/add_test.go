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
	"github.com/spf13/viper"
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
        {"name": "embedding-column", "type": "tables", "path": "./sql/add-embedding-column.sql"}
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

	sql, err := afero.ReadFile(fsys, "supabase/schemas/tables/embedding-column.sql")
	require.NoError(t, err)
	assert.Contains(t, string(sql), "alter table documents")

	fn, err := afero.ReadFile(fsys, "supabase/functions/generate-embedding/index.ts")
	require.NoError(t, err)
	assert.Contains(t, string(fn), "documents")

	config, err := afero.ReadFile(fsys, utils.ConfigPath)
	require.NoError(t, err)
	assert.Contains(t, string(config), `[functions.generate-embedding]`)
	assert.Contains(t, string(config), `OPENAI_API_KEY = "env(OPENAI_API_KEY)"`)
	assert.Contains(t, string(config), `EMBEDDING_FUNCTION_SECRET = "env(EMBEDDING_FUNCTION_SECRET)"`)
	assert.Contains(t, string(config), `./schemas/tables/*.sql`)

	functionEnv := readEnvMap(t, fsys, utils.FallbackEnvFilePath)
	assert.Equal(t, "test-key", functionEnv["OPENAI_API_KEY"])
	assert.NotContains(t, functionEnv, "EMBEDDING_FUNCTION_SECRET")
}

func TestAddRunWithEmbeddingsTemplateAndSchemaPlacement(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	config, err := afero.ReadFile(fsys, utils.ConfigPath)
	require.NoError(t, err)
	config = append(config, []byte(`
[db.migrations.schema_placement]
"extensions" = "./schemas/db/extensions.sql"
"tables" = "./schemas/db/tables"
"functions" = "./schemas/db/functions/{name}.sql"
"triggers" = "./schemas/db/triggers/{name}.sql"
`)...)
	require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, config, 0644))

	template := `{
  "name": "add-embeddings",
  "title": "Add Embeddings Support",
  "description": "Adds embeddings support.",
  "version": "4.3.5",
  "inputs": {
    "table_name": {"label": "Target table name", "type": "string", "required": true},
    "pk_column": {"label": "Primary key column", "type": "string", "default": "id"},
    "text_column": {"label": "Text column to embed", "type": "string", "required": true},
    "embedding_column": {"label": "Embedding column name", "type": "string", "default": "embedding"},
    "model": {"label": "Embedding model", "type": "select", "options": ["text-embedding-3-small", "text-embedding-3-large"], "default": "text-embedding-3-small"},
    "embedding_dims": {"label": "Override dimensions (optional)", "type": "number", "default": 1536},
    "openai_api_key": {"label": "OpenAI API key", "type": "password", "required": true},
    "embedding_function_secret": {"label": "Embedding function secret", "type": "password", "required": true}
  },
  "steps": [
    {
      "name": "configure_secrets",
      "components": [
        {"name": "openai-api-key", "type": "secret", "key": "OPENAI_API_KEY", "value": "{{context.openai_api_key}}"},
        {"name": "embedding-function-secret", "type": "secret", "key": "EMBEDDING_FUNCTION_SECRET", "value": "{{context.embedding_function_secret}}"},
        {"name": "embedding-function-secret-vault", "type": "vault", "key": "EMBEDDING_FUNCTION_SECRET", "value": "{{context.embedding_function_secret}}"}
      ]
    },
    {
      "name": "deploy_function",
      "components": [
        {
          "name": "generate-embedding",
          "type": "edge_function",
          "path": "./functions/generate-embedding",
          "output": {"embedding_function_url": "{{generate-embedding.url}}"}
        }
      ]
    },
    {
      "name": "provision_database",
      "components": [
        {"name": "extensions", "type": "extensions", "path": "./schemas/extensions.sql"},
        {"name": "embedding-column", "type": "tables", "path": "./schemas/add-embedding-column.sql"},
        {"name": "trigger-function", "type": "functions", "path": "./schemas/queue-generate-embedding.sql"},
        {"name": "trigger", "type": "triggers", "path": "./schemas/on-insert-update-embedding.sql"}
      ]
    }
  ]
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/add-embeddings.json", []byte(template), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/schemas/extensions.sql", []byte(`create extension if not exists vector;`), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/schemas/add-embedding-column.sql", []byte(`alter table {{context.table_name}} add column {{context.embedding_column}} vector({{context.embedding_dims}});`), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/schemas/queue-generate-embedding.sql", []byte(`-- {{context.embedding_function_url}}`), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/schemas/on-insert-update-embedding.sql", []byte(`create trigger trg after insert on {{context.table_name}} for each row execute function public.queue();`), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/functions/generate-embedding/index.ts", []byte(`export const model = "{{context.model}}"`), 0644))

	prevYes := viper.GetBool("YES")
	viper.Set("YES", true)
	t.Cleanup(func() {
		viper.Set("YES", prevYes)
	})

	require.NoError(t, Run(context.Background(), "templates/add-embeddings.json", []string{
		"table_name=documents",
		"text_column=content",
		"openai_api_key=test-key",
		"embedding_function_secret=test-secret",
	}, fsys))

	extensionsPath := filepath.Join(utils.SupabaseDirPath, "schemas", "db", "extensions.sql")
	extensions, err := afero.ReadFile(fsys, extensionsPath)
	require.NoError(t, err)
	assert.Contains(t, string(extensions), "create extension")

	tablePath := filepath.Join(utils.SupabaseDirPath, "schemas", "db", "tables", "embedding-column.sql")
	tableSql, err := afero.ReadFile(fsys, tablePath)
	require.NoError(t, err)
	assert.Contains(t, string(tableSql), "documents")
	assert.Contains(t, string(tableSql), "embedding vector(1536)")

	functionPath := filepath.Join(utils.SupabaseDirPath, "schemas", "db", "functions", "trigger-function.sql")
	functionSql, err := afero.ReadFile(fsys, functionPath)
	require.NoError(t, err)
	assert.Contains(t, string(functionSql), "/functions/v1/generate-embedding")

	triggerPath := filepath.Join(utils.SupabaseDirPath, "schemas", "db", "triggers", "trigger.sql")
	triggerSql, err := afero.ReadFile(fsys, triggerPath)
	require.NoError(t, err)
	assert.Contains(t, string(triggerSql), "create trigger")

	functionEntry, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "generate-embedding", "index.ts"))
	require.NoError(t, err)
	assert.Contains(t, string(functionEntry), "text-embedding-3-small")

	config, err = afero.ReadFile(fsys, utils.ConfigPath)
	require.NoError(t, err)
	assert.Contains(t, string(config), `[functions.generate-embedding]`)
	assert.Contains(t, string(config), `OPENAI_API_KEY = "env(OPENAI_API_KEY)"`)
	assert.Contains(t, string(config), `EMBEDDING_FUNCTION_SECRET = "env(EMBEDDING_FUNCTION_SECRET)"`)
	assert.Contains(t, string(config), `./schemas/tables/*.sql`)
	assert.Contains(t, string(config), `"tables" = "./schemas/db/tables"`)
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

func TestAddRunFallsBackForUnsupportedComponentType(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	template := `{
  "name": "unsupported-type-fallback",
  "steps": [
    {
      "name": "provision_database",
      "components": [
        {"name": "stripe-schema", "type": "schema", "path": "./schemas/stripe-schema.sql"}
      ]
    }
  ]
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/fallback.json", []byte(template), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/schemas/stripe-schema.sql", []byte(`create schema if not exists stripe;`), 0644))

	require.NoError(t, Run(context.Background(), "templates/fallback.json", nil, fsys))

	outPath := filepath.Join(utils.SchemasDir, "stripe-schema.sql")
	sql, err := afero.ReadFile(fsys, outPath)
	require.NoError(t, err)
	assert.Contains(t, string(sql), "create schema if not exists stripe")
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

func TestAddRunAppendsAndDedupesSqlTablePatch(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, utils.WriteConfig(fsys, false))
	cfg, err := afero.ReadFile(fsys, utils.ConfigPath)
	require.NoError(t, err)
	cfg = append(cfg, []byte(`
[db.migrations.schema_placement]
"tables" = "./schemas/tables/{name}.sql"
`)...)
	require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, cfg, 0644))

	require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.SchemasDir, "tables", "tasks.sql"), []byte(`
create table public.tasks (
  id bigint generated by default as identity primary key,
  title text not null
);
`), 0644))

	template := `{
  "name": "table-merge",
  "inputs": {
    "table_name": {"type": "string", "required": true},
    "embedding_column": {"type": "string", "default": "embedding"},
    "embedding_dims": {"type": "number", "default": 1536}
  },
  "steps": [
    {
      "name": "provision_database",
      "components": [
        {
          "name": "{{context.table_name}}",
          "type": "tables",
          "path": "./sql/add-embedding-column.sql"
        }
      ]
    }
  ]
}`
	require.NoError(t, afero.WriteFile(fsys, "templates/table-merge.json", []byte(template), 0644))
	require.NoError(t, afero.WriteFile(fsys, "templates/sql/add-embedding-column.sql", []byte(`
alter table {{context.table_name}}
  add column if not exists {{context.embedding_column}} vector({{context.embedding_dims}});

create index if not exists idx_{{context.table_name}}_{{context.embedding_column}}
  on {{context.table_name}}
  using hnsw ({{context.embedding_column}} vector_cosine_ops);
`), 0644))

	require.NoError(t, Run(context.Background(), "templates/table-merge.json", []string{
		"table_name=tasks",
	}, fsys))
	require.NoError(t, Run(context.Background(), "templates/table-merge.json", []string{
		"table_name=tasks",
	}, fsys))

	tableSQL, err := afero.ReadFile(fsys, filepath.Join(utils.SchemasDir, "tables", "tasks.sql"))
	require.NoError(t, err)
	sqlText := strings.ToLower(string(tableSQL))
	assert.Contains(t, sqlText, `create table`)
	assert.Contains(t, sqlText, `vector(1536)`)
	assert.Contains(t, sqlText, `create index if not exists idx_tasks_embedding`)
	assert.NotContains(t, sqlText, "alter table tasks")
	assert.Equal(t, 1, strings.Count(sqlText, "idx_tasks_embedding"))

	_, err = fsys.Stat(filepath.Join(utils.SchemasDir, "tables", "add-embedding-column.sql"))
	assert.Error(t, err)
}

func TestMergeSQLFileMergesBasicAlterTableVariants(t *testing.T) {
	fsys := afero.NewMemMapFs()
	path := filepath.Join(utils.SchemasDir, "tables", "events.sql")
	require.NoError(t, utils.MkdirIfNotExistFS(fsys, filepath.Dir(path)))
	require.NoError(t, afero.WriteFile(fsys, path, []byte(`
create table public.events (
  id bigint not null,
  payload text
);
`), 0644))

	firstPatch := `
alter table public.events alter column id add generated by default as identity (
  start with 1
  increment by 1
);
alter table public.events alter column payload set default 'x'::text;
alter table public.events alter column payload set not null;
alter table public.events add constraint events_payload_key unique (payload);
`
	changed, err := mergeSQLFile(path, firstPatch, fsys)
	require.NoError(t, err)
	assert.True(t, changed)

	changed, err = mergeSQLFile(path, firstPatch, fsys)
	require.NoError(t, err)
	assert.False(t, changed)

	secondPatch := `
alter table public.events alter column payload drop default;
alter table public.events alter column payload drop not null;
alter table public.events drop constraint events_payload_key;
alter table public.events alter column payload type varchar(255);
`
	changed, err = mergeSQLFile(path, secondPatch, fsys)
	require.NoError(t, err)
	assert.True(t, changed)

	sql, err := afero.ReadFile(fsys, path)
	require.NoError(t, err)
	sqlText := strings.ToLower(string(sql))
	assert.Contains(t, sqlText, "generated by default as identity")
	assert.Contains(t, sqlText, "varchar(255)")
	assert.NotContains(t, sqlText, "events_payload_key")
	assert.NotContains(t, sqlText, "default 'x'::text")
	assert.NotContains(t, sqlText, "alter table public.events")
}

func TestMergeSQLFileFallsBackForUnsupportedAlterTable(t *testing.T) {
	fsys := afero.NewMemMapFs()
	path := filepath.Join(utils.SchemasDir, "tables", "flags.sql")
	require.NoError(t, utils.MkdirIfNotExistFS(fsys, filepath.Dir(path)))
	require.NoError(t, afero.WriteFile(fsys, path, []byte(`
create table public.flags (
  id bigint primary key
);
`), 0644))

	changed, err := mergeSQLFile(path, `alter table public.flags enable row level security;`, fsys)
	require.NoError(t, err)
	assert.True(t, changed)

	sql, err := afero.ReadFile(fsys, path)
	require.NoError(t, err)
	sqlText := strings.ToLower(string(sql))
	assert.Contains(t, sqlText, "create table public.flags")
	assert.Contains(t, sqlText, "alter table public.flags enable row level security")
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
    "message": "Call: {{env.SUPABASE_URL}}/functions/v1/stripe-setup\\nrun_backfill={{inputs.run_backfill}}"
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
