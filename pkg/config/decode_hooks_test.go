package config

import (
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadEnvHook(t *testing.T) {
	tests := []struct {
		name          string
		input         string
		envVar        string
		envValue      string
		expected      string
		description   string
	}{
		{
			name:        "basic env var substitution",
			input:       "env(TEST_VAR)",
			envVar:      "TEST_VAR",
			envValue:    "test_value",
			expected:    "test_value",
			description: "should replace env(VAR) with environment variable value",
		},
		{
			name:        "env var with default - env var set",
			input:       "env(TEST_VAR, default_value)",
			envVar:      "TEST_VAR",
			envValue:    "env_value",
			expected:    "env_value",
			description: "should use environment variable value when available, ignoring default",
		},
		{
			name:        "env var with default - env var not set",
			input:       "env(MISSING_VAR, default_value)",
			envVar:      "",
			envValue:    "",
			expected:    "default_value",
			description: "should use default value when environment variable is not set",
		},
		{
			name:        "env var with default - env var empty",
			input:       "env(EMPTY_VAR, default_value)",
			envVar:      "EMPTY_VAR",
			envValue:    "",
			expected:    "default_value",
			description: "should use default value when environment variable is empty",
		},
		{
			name:        "env var with spaces in default",
			input:       "env(MISSING_VAR, my default value)",
			envVar:      "",
			envValue:    "",
			expected:    "my default value",
			description: "should handle default values with spaces",
		},
		{
			name:        "env var with extra spaces",
			input:       "env( TEST_VAR , default_value )",
			envVar:      "TEST_VAR",
			envValue:    "trimmed_value",
			expected:    "trimmed_value",
			description: "should handle extra spaces around variable name and default",
		},
		{
			name:        "env var with default containing commas",
			input:       "env(MISSING_VAR, value,with,commas)",
			envVar:      "",
			envValue:    "",
			expected:    "value,with,commas",
			description: "should handle default values containing commas",
		},
		{
			name:        "non-env string unchanged",
			input:       "regular_string",
			envVar:      "",
			envValue:    "",
			expected:    "regular_string",
			description: "should leave non-env strings unchanged",
		},
		{
			name:        "malformed env syntax unchanged",
			input:       "env(MISSING_VAR",
			envVar:      "",
			envValue:    "",
			expected:    "env(MISSING_VAR",
			description: "should leave malformed env syntax unchanged",
		},
		{
			name:        "env var without default - missing var",
			input:       "env(MISSING_VAR)",
			envVar:      "",
			envValue:    "",
			expected:    "env(MISSING_VAR)",
			description: "should leave original string when env var missing and no default",
		},
		{
			name:        "env var without default - empty var",
			input:       "env(EMPTY_VAR)",
			envVar:      "EMPTY_VAR",
			envValue:    "",
			expected:    "env(EMPTY_VAR)",
			description: "should leave original string when env var empty and no default",
		},
		{
			name:        "quoted default value",
			input:       `env(MISSING_VAR, "quoted default")`,
			envVar:      "",
			envValue:    "",
			expected:    `"quoted default"`,
			description: "should preserve quotes in default values",
		},
		{
			name:        "numeric default value",
			input:       "env(MISSING_VAR, 12345)",
			envVar:      "",
			envValue:    "",
			expected:    "12345",
			description: "should handle numeric default values as strings",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Setup environment variable if specified
			if tt.envVar != "" {
				if tt.envValue != "" {
					t.Setenv(tt.envVar, tt.envValue)
				} else {
					// Ensure the env var is not set
					os.Unsetenv(tt.envVar)
				}
			}

			// Call the hook function
			result, err := LoadEnvHook(reflect.String, reflect.String, tt.input)

			// Assertions
			require.NoError(t, err, "LoadEnvHook should not return an error")
			assert.Equal(t, tt.expected, result, tt.description)
		})
	}
}

func TestLoadEnvHook_NonStringInput(t *testing.T) {
	tests := []struct {
		name     string
		fromKind reflect.Kind
		toKind   reflect.Kind
		input    interface{}
		expected interface{}
	}{
		{
			name:     "integer input",
			fromKind: reflect.Int,
			toKind:   reflect.String,
			input:    42,
			expected: 42,
		},
		{
			name:     "boolean input",
			fromKind: reflect.Bool,
			toKind:   reflect.String,
			input:    true,
			expected: true,
		},
		{
			name:     "slice input",
			fromKind: reflect.Slice,
			toKind:   reflect.String,
			input:    []string{"test"},
			expected: []string{"test"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := LoadEnvHook(tt.fromKind, tt.toKind, tt.input)
			require.NoError(t, err)
			assert.Equal(t, tt.expected, result, "non-string inputs should be returned unchanged")
		})
	}
}

func TestLoadEnvHook_RegressionTest(t *testing.T) {
	// Test that existing functionality still works as expected
	t.Run("existing env() patterns continue to work", func(t *testing.T) {
		t.Setenv("EXISTING_VAR", "existing_value")

		result, err := LoadEnvHook(reflect.String, reflect.String, "env(EXISTING_VAR)")
		require.NoError(t, err)
		assert.Equal(t, "existing_value", result)
	})

	t.Run("missing env vars without defaults preserve original behavior", func(t *testing.T) {
		os.Unsetenv("NONEXISTENT_VAR")

		result, err := LoadEnvHook(reflect.String, reflect.String, "env(NONEXISTENT_VAR)")
		require.NoError(t, err)
		assert.Equal(t, "env(NONEXISTENT_VAR)", result)
	})
}

func TestEnvPattern_Regex(t *testing.T) {
	tests := []struct {
		input       string
		shouldMatch bool
		varName     string
		defaultVal  string
		description string
	}{
		{"env(VAR)", true, "VAR", "", "basic env var"},
		{"env(VAR, default)", true, "VAR", "default", "env var with default"},
		{"env( VAR , default )", true, "VAR", "default", "env var with spaces"},
		{"env(VAR,default)", true, "VAR", "default", "env var without spaces around comma"},
		{"env(VAR, default with spaces)", true, "VAR", "default with spaces", "default with spaces"},
		{"env(VAR, val,ue)", true, "VAR", "val,ue", "default with comma"},
		{"env()", false, "", "", "empty env"},
		{"env(VAR", false, "", "", "missing closing paren"},
		{"env VAR)", false, "", "", "missing opening paren"},
		{"notenv(VAR)", false, "", "", "wrong function name"},
		{"env(VAR, )", true, "VAR", "", "empty default"},
	}

	for _, tt := range tests {
		t.Run(tt.description, func(t *testing.T) {
			matches := envPattern.FindStringSubmatch(tt.input)

			if tt.shouldMatch {
				require.True(t, len(matches) > 1, "should match pattern: %s", tt.input)
				assert.Equal(t, tt.varName, strings.TrimSpace(matches[1]), "variable name should match")
				if len(matches) > 2 {
					assert.Equal(t, tt.defaultVal, strings.TrimSpace(matches[2]), "default value should match")
				}
			} else {
				assert.True(t, len(matches) <= 1, "should not match pattern: %s", tt.input)
			}
		})
	}
}
