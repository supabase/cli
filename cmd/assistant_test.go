package cmd

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDNAAssistant(t *testing.T) {
	// Skip if DNA_API_KEY is not set to avoid running API tests in CI
	if os.Getenv("DNA_API_KEY") == "" {
		t.Skip("DNA_API_KEY not set")
	}

	t.Run("doctor command", func(t *testing.T) {
		err := runEnvironmentChecks()
		assert.NoError(t, err, "doctor command should pass when environment is properly set up")
	})
}

// TestDNAAssistantNoAuth tests behavior when auth is not configured
func TestDNAAssistantNoAuth(t *testing.T) {
	// Temporarily clear DNA_API_KEY
	originalKey := os.Getenv("DNA_API_KEY")
	os.Setenv("DNA_API_KEY", "")
	defer os.Setenv("DNA_API_KEY", originalKey)

	t.Run("doctor command without auth", func(t *testing.T) {
		err := runEnvironmentChecks()
		assert.Error(t, err, "doctor command should fail when DNA_API_KEY is not set")
	})
}
