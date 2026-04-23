package vault

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/config"
)

func TestWithEdgeFunctionSecrets(t *testing.T) {
	t.Run("adds local defaults when projectRef is empty", func(t *testing.T) {
		secrets := map[string]config.Secret{}
		serviceRoleKey := "test-service-role-key"

		result := WithEdgeFunctionSecrets(secrets, "", serviceRoleKey)

		assert.Len(t, result, 2)
		assert.Equal(t, "http://kong:8000/functions/v1", result[SecretFunctionsUrl].Value)
		assert.Equal(t, serviceRoleKey, result[SecretServiceRoleKey].Value)
	})

	t.Run("adds production URL when projectRef is provided", func(t *testing.T) {
		secrets := map[string]config.Secret{}
		serviceRoleKey := "test-service-role-key"
		projectRef := "abcdefghijklmnop"

		result := WithEdgeFunctionSecrets(secrets, projectRef, serviceRoleKey)

		assert.Len(t, result, 1)
		assert.Equal(t, "https://abcdefghijklmnop.supabase.co/functions/v1", result[SecretFunctionsUrl].Value)
		assert.NotContains(t, result, SecretServiceRoleKey)
	})

	t.Run("preserves user-defined secrets", func(t *testing.T) {
		userUrl := "https://custom.example.com/functions/v1"
		userKey := "custom-service-key"
		secrets := map[string]config.Secret{
			SecretFunctionsUrl:   {Value: userUrl, SHA256: "custom-hash"},
			SecretServiceRoleKey: {Value: userKey, SHA256: "custom-hash"},
		}

		result := WithEdgeFunctionSecrets(secrets, "some-project", "ignored-key")

		assert.Len(t, result, 2)
		assert.Equal(t, userUrl, result[SecretFunctionsUrl].Value)
		assert.Equal(t, "custom-hash", result[SecretFunctionsUrl].SHA256)
		assert.Equal(t, userKey, result[SecretServiceRoleKey].Value)
		assert.Equal(t, "custom-hash", result[SecretServiceRoleKey].SHA256)
	})

	t.Run("skips service role key when empty", func(t *testing.T) {
		secrets := map[string]config.Secret{}

		result := WithEdgeFunctionSecrets(secrets, "", "")

		assert.Len(t, result, 1)
		assert.Contains(t, result, SecretFunctionsUrl)
		assert.NotContains(t, result, SecretServiceRoleKey)
	})

	t.Run("preserves existing secrets in input", func(t *testing.T) {
		existingSecret := config.Secret{Value: "existing-value", SHA256: "existing-hash"}
		secrets := map[string]config.Secret{
			"custom_secret": existingSecret,
		}

		result := WithEdgeFunctionSecrets(secrets, "", "service-key")

		assert.Len(t, result, 3)
		assert.Equal(t, existingSecret, result["custom_secret"])
		assert.Contains(t, result, SecretFunctionsUrl)
		assert.Contains(t, result, SecretServiceRoleKey)
	})

	t.Run("does not modify original map", func(t *testing.T) {
		secrets := map[string]config.Secret{
			"existing": {Value: "value", SHA256: "hash"},
		}

		result := WithEdgeFunctionSecrets(secrets, "", "service-key")

		assert.Len(t, secrets, 1)
		assert.Len(t, result, 3)
	})

	t.Run("handles nil input map", func(t *testing.T) {
		result := WithEdgeFunctionSecrets(nil, "", "service-key")

		assert.Len(t, result, 2)
		assert.Contains(t, result, SecretFunctionsUrl)
		assert.Contains(t, result, SecretServiceRoleKey)
	})

	t.Run("partial override - only URL defined by user for remote", func(t *testing.T) {
		secrets := map[string]config.Secret{
			SecretFunctionsUrl: {Value: "https://custom.example.com/functions/v1", SHA256: "custom"},
		}
		result := WithEdgeFunctionSecrets(secrets, "project-ref", "auto-service-key")
		assert.Len(t, result, 1)
		assert.Equal(t, "https://custom.example.com/functions/v1", result[SecretFunctionsUrl].Value)
		assert.NotContains(t, result, SecretServiceRoleKey)
	})

	t.Run("partial override - only URL defined by user for local", func(t *testing.T) {
		secrets := map[string]config.Secret{
			SecretFunctionsUrl: {Value: "http://custom:8000/functions/v1", SHA256: "custom"},
		}
		result := WithEdgeFunctionSecrets(secrets, "", "auto-service-key")
		assert.Len(t, result, 2)
		assert.Equal(t, "http://custom:8000/functions/v1", result[SecretFunctionsUrl].Value)
		assert.Equal(t, "auto-service-key", result[SecretServiceRoleKey].Value)
	})

	t.Run("partial override - only service key defined by user", func(t *testing.T) {
		secrets := map[string]config.Secret{
			SecretServiceRoleKey: {Value: "user-defined-key", SHA256: "custom"},
		}
		result := WithEdgeFunctionSecrets(secrets, "my-project", "ignored-key")
		assert.Len(t, result, 2)
		assert.Equal(t, "https://my-project.supabase.co/functions/v1", result[SecretFunctionsUrl].Value)
		assert.Equal(t, "user-defined-key", result[SecretServiceRoleKey].Value)
	})
}
