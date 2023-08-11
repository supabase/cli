package utils

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestSliceEqual(t *testing.T) {
	assert.False(t, SliceEqual([]string{"a"}, []string{"b"}))
}

func TestSliceContains(t *testing.T) {
	assert.False(t, SliceContains([]string{"a"}, "b"))
}
