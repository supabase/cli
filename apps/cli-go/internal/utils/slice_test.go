package utils

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestRemoveDuplicates(t *testing.T) {
	t.Run("string slice", func(t *testing.T) {
		input := []string{"a", "b", "a", "c", "b", "d"}
		expected := []string{"a", "b", "c", "d"}
		assert.Equal(t, expected, RemoveDuplicates(input))
	})

	t.Run("int slice", func(t *testing.T) {
		input := []int{1, 2, 2, 3, 1, 4, 3, 5}
		expected := []int{1, 2, 3, 4, 5}
		assert.Equal(t, expected, RemoveDuplicates(input))
	})

	t.Run("empty slice", func(t *testing.T) {
		assert.Empty(t, RemoveDuplicates([]string{}))
	})

	t.Run("no duplicates", func(t *testing.T) {
		input := []int{1, 2, 3, 4, 5}
		assert.Equal(t, input, RemoveDuplicates(input))
	})
}
