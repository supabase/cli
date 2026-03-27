package utils

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDecodeHealthcheck(t *testing.T) {
	testCmd := []string{"CMD", "pg_isready", "-U", "postgres"}
	payload, err := json.Marshal(testCmd)
	require.NoError(t, err)

	t.Run("decodes padded base64", func(t *testing.T) {
		encoded := base64.StdEncoding.EncodeToString(payload)

		decoded, err := decodeHealthcheck(encoded)

		require.NoError(t, err)
		assert.Equal(t, testCmd, decoded)
	})

	t.Run("decodes unpadded base64", func(t *testing.T) {
		encoded := strings.TrimRight(base64.StdEncoding.EncodeToString(payload), "=")

		decoded, err := decodeHealthcheck(encoded)

		require.NoError(t, err)
		assert.Equal(t, testCmd, decoded)
	})
}

func TestEncodeHealthcheck(t *testing.T) {
	encoded := encodeHealthcheck(&container.HealthConfig{
		Test: []string{"CMD", "curl", "-sSfL", "http://127.0.0.1:4000/health"},
	})

	assert.NotEmpty(t, encoded)
	assert.NotContains(t, encoded, "=")

	decoded, err := decodeHealthcheck(encoded)
	require.NoError(t, err)
	assert.Equal(t, []string{"CMD", "curl", "-sSfL", "http://127.0.0.1:4000/health"}, decoded)
}
