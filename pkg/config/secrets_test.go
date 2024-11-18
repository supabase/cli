package config

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDecryptBuildEnvs(t *testing.T) {
	t.Run("decrypts build envs", func(t *testing.T) {
		config := &secrets{
			BuildEnvs: map[string]string{
				"BUILD_VAR1": "encrypted1",
				"BUILD_VAR2": "encrypted2",
			},
		}

		buildEnvs, err := config.DecryptBuildEnvs(context.Background(), "test-key")
		assert.NoError(t, err)

		assert.Equal(t, map[string]string{
			"BUILD_VAR1": "encrypted1",
			"BUILD_VAR2": "encrypted2",
		}, buildEnvs)
	})

	t.Run("handles empty config", func(t *testing.T) {
		config := &secrets{}

		buildEnvs, err := config.DecryptBuildEnvs(context.Background(), "test-key")
		assert.NoError(t, err)
		assert.Empty(t, buildEnvs)
	})
}

func TestDecryptRuntimeEnvs(t *testing.T) {
	t.Run("decrypts runtime envs", func(t *testing.T) {
		config := &secrets{
			RuntimeEnvs: map[string]string{
				"RUNTIME_VAR1": "encrypted3",
				"RUNTIME_VAR2": "encrypted4",
			},
		}

		runtimeEnvs, err := config.DecryptRuntimeEnvs(context.Background(), "test-key")
		assert.NoError(t, err)

		assert.Equal(t, map[string]string{
			"RUNTIME_VAR1": "encrypted3",
			"RUNTIME_VAR2": "encrypted4",
		}, runtimeEnvs)
	})

	t.Run("handles empty config", func(t *testing.T) {
		config := &secrets{}

		runtimeEnvs, err := config.DecryptRuntimeEnvs(context.Background(), "test-key")
		assert.NoError(t, err)
		assert.Empty(t, runtimeEnvs)
	})
}

func TestSetEnvValues(t *testing.T) {
	t.Run("sets environment variables", func(t *testing.T) {
		// Clean up environment after test
		defer os.Unsetenv("TEST_VAR1")
		defer os.Unsetenv("TEST_VAR2")

		envs := map[string]string{
			"TEST_VAR1": "value1",
			"TEST_VAR2": "value2",
		}

		err := SetEnvValues(envs)
		assert.NoError(t, err)

		// Verify environment variables were set
		assert.Equal(t, "value1", os.Getenv("TEST_VAR1"))
		assert.Equal(t, "value2", os.Getenv("TEST_VAR2"))
	})

	t.Run("handles empty input", func(t *testing.T) {
		err := SetEnvValues(map[string]string{})
		assert.NoError(t, err)
	})
}
