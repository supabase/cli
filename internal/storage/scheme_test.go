package storage

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseStorageURL(t *testing.T) {
	t.Run("parses valid url", func(t *testing.T) {
		path, err := ParseStorageURL("ss:///bucket/folder/name.png")
		assert.NoError(t, err)
		assert.Equal(t, path, "/bucket/folder/name.png")
	})

	t.Run("throws error on invalid host", func(t *testing.T) {
		path, err := ParseStorageURL("ss://bucket")
		assert.ErrorIs(t, err, ErrInvalidURL)
		assert.Empty(t, path)
	})

	t.Run("throws error on missing path", func(t *testing.T) {
		path, err := ParseStorageURL("ss:")
		assert.ErrorIs(t, err, ErrInvalidURL)
		assert.Empty(t, path)
	})

	t.Run("throws error on invalid scheme", func(t *testing.T) {
		path, err := ParseStorageURL(".")
		assert.ErrorIs(t, err, ErrInvalidURL)
		assert.Empty(t, path)
	})

	t.Run("throws error on invalid url", func(t *testing.T) {
		path, err := ParseStorageURL(":")
		assert.ErrorContains(t, err, "missing protocol scheme")
		assert.Empty(t, path)
	})
}

func TestSplitBucketPrefix(t *testing.T) {
	t.Run("splits empty path", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("")
		assert.Equal(t, bucket, "")
		assert.Equal(t, prefix, "")
	})

	t.Run("splits root path", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("/")
		assert.Equal(t, bucket, "")
		assert.Equal(t, prefix, "")
	})

	t.Run("splits no slash", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("bucket")
		assert.Equal(t, bucket, "bucket")
		assert.Equal(t, prefix, "")
	})

	t.Run("splits prefix slash", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("/bucket")
		assert.Equal(t, bucket, "bucket")
		assert.Equal(t, prefix, "")
	})

	t.Run("splits suffix slash", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("bucket/")
		assert.Equal(t, bucket, "bucket")
		assert.Equal(t, prefix, "")
	})

	t.Run("splits file path", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("/bucket/folder/name.png")
		assert.Equal(t, bucket, "bucket")
		assert.Equal(t, prefix, "folder/name.png")
	})

	t.Run("splits dir path", func(t *testing.T) {
		bucket, prefix := SplitBucketPrefix("/bucket/folder/")
		assert.Equal(t, bucket, "bucket")
		assert.Equal(t, prefix, "folder/")
	})
}
