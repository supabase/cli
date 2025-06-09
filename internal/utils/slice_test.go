package utils

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestSliceEqual(t *testing.T) {
	t.Run("different slices", func(t *testing.T) {
		assert.False(t, SliceEqual([]string{"a"}, []string{"b"}))
	})

	t.Run("different lengths", func(t *testing.T) {
		assert.False(t, SliceEqual([]string{"a"}, []string{"a", "b"}))
		assert.False(t, SliceEqual([]string{"a", "b"}, []string{"a"}))
	})

	t.Run("equal slices", func(t *testing.T) {
		assert.True(t, SliceEqual([]string{"a", "b"}, []string{"a", "b"}))
		assert.True(t, SliceEqual([]int{1, 2, 3}, []int{1, 2, 3}))
	})

	t.Run("empty slices", func(t *testing.T) {
		assert.True(t, SliceEqual([]string{}, []string{}))
	})
}

func TestSliceContains(t *testing.T) {
	t.Run("not contains element", func(t *testing.T) {
		assert.False(t, SliceContains([]string{"a"}, "b"))
	})

	t.Run("contains element", func(t *testing.T) {
		assert.True(t, SliceContains([]string{"a", "b", "c"}, "b"))
		assert.True(t, SliceContains([]int{1, 2, 3}, 2))
	})

	t.Run("empty slice", func(t *testing.T) {
		assert.False(t, SliceContains([]string{}, "a"))
	})
}

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
