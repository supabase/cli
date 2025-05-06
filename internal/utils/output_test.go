package utils

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEncodeOutput(t *testing.T) {
	t.Run("encodes env format", func(t *testing.T) {
		input := map[string]string{
			"DATABASE_URL": "postgres://user:pass@host:5432/db",
			"API_KEY":      "secret-key",
		}
		var buf bytes.Buffer
		err := EncodeOutput(OutputEnv, &buf, input)
		assert.NoError(t, err)
		expected := "API_KEY=\"secret-key\"\nDATABASE_URL=\"postgres://user:pass@host:5432/db\"\n"
		assert.Equal(t, expected, buf.String())
	})

	t.Run("fails env format with invalid type", func(t *testing.T) {
		input := map[string]int{"FOO": 123}
		var buf bytes.Buffer
		err := EncodeOutput(OutputEnv, &buf, input)
		assert.ErrorContains(t, err, "value is not a map[string]string")
	})

	t.Run("encodes json format", func(t *testing.T) {
		input := map[string]interface{}{
			"name": "test",
			"config": map[string]interface{}{
				"port":    5432,
				"enabled": true,
			},
		}
		var buf bytes.Buffer
		err := EncodeOutput(OutputJson, &buf, input)
		assert.NoError(t, err)
		expected := `{
  "config": {
    "enabled": true,
    "port": 5432
  },
  "name": "test"
}
`
		assert.Equal(t, expected, buf.String())
	})

	t.Run("encodes yaml format", func(t *testing.T) {
		input := map[string]interface{}{
			"name": "test",
			"config": map[string]interface{}{
				"port":    5432,
				"enabled": true,
			},
		}
		var buf bytes.Buffer
		err := EncodeOutput(OutputYaml, &buf, input)
		assert.NoError(t, err)
		expected := `config:
    enabled: true
    port: 5432
name: test
`
		assert.Equal(t, expected, buf.String())
	})

	t.Run("encodes toml format", func(t *testing.T) {
		input := map[string]interface{}{
			"name": "test",
			"config": map[string]interface{}{
				"port":    5432,
				"enabled": true,
			},
		}
		var buf bytes.Buffer
		err := EncodeOutput(OutputToml, &buf, input)
		assert.NoError(t, err)
		expected := `name = "test"

[config]
  enabled = true
  port = 5432
`
		assert.Equal(t, expected, buf.String())
	})

	t.Run("fails with unsupported format", func(t *testing.T) {
		var buf bytes.Buffer
		err := EncodeOutput("invalid", &buf, nil)
		assert.ErrorContains(t, err, `Unsupported output encoding "invalid"`)
	})

	t.Run("handles complex nested structures", func(t *testing.T) {
		input := map[string]interface{}{
			"database": map[string]interface{}{
				"connections": []map[string]interface{}{
					{
						"host": "localhost",
						"port": 5432,
					},
					{
						"host": "remote",
						"port": 6543,
					},
				},
				"settings": map[string]interface{}{
					"max_connections": 100,
					"ssl_enabled":     true,
				},
			},
		}
		var buf bytes.Buffer
		err := EncodeOutput(OutputJson, &buf, input)
		require.NoError(t, err)
		expected := `{
  "database": {
    "connections": [
      {
        "host": "localhost",
        "port": 5432
      },
      {
        "host": "remote",
        "port": 6543
      }
    ],
    "settings": {
      "max_connections": 100,
      "ssl_enabled": true
    }
  }
}
`
		assert.Equal(t, expected, buf.String())
	})
}
