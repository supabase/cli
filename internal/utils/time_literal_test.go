package utils

import (
	"testing"
)

func TestIsValidTimeSecondLiteral(t *testing.T) {
	tc := []struct {
		name     string
		input    string
		expected bool
	}{
		{
			name:     "valid time second literal",
			input:    "1s",
			expected: true,
		},
		{
			name:     "invalid time second literal",
			input:    "1m",
			expected: false,
		},
		{
			name:     "invalid time second literal",
			input:    "1",
			expected: false,
		},
		{
			name:     "invalid time second literal",
			input:    "s",
			expected: false,
		},
		{
			name:     "invalid time second literal",
			input:    "s1",
			expected: false,
		},
	}

	for _, tt := range tc {
		t.Run(tt.name, func(t *testing.T) {
			actual := IsValidTimeSecondLiteral(tt.input)
			if actual != tt.expected {
				t.Errorf("expected %v, got %v", tt.expected, actual)
			}
		})
	}
}
