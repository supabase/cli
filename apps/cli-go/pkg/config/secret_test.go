package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDecryptSecret(t *testing.T) {
	key := "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb"
	value := "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/"

	t.Run("decrypts secret value", func(t *testing.T) {
		// Run test
		plaintext, err := decrypt(key, value)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "value", plaintext)
	})

	t.Run("throws error on missing key", func(t *testing.T) {
		// Run test
		plaintext, err := decrypt("", value)
		// Check error
		assert.ErrorIs(t, err, errMissingKey)
		assert.Equal(t, value, plaintext)
	})

	t.Run("throws error on non-hex key", func(t *testing.T) {
		// Run test
		plaintext, err := decrypt("invalid", value)
		// Check error
		assert.ErrorContains(t, err, "failed to hex decode private key: cannot decode hex string")
		assert.Equal(t, value, plaintext)
	})

	t.Run("throws error on non-base64 value", func(t *testing.T) {
		// Run test
		plaintext, err := decrypt(key, "encrypted:invalid")
		// Check error
		assert.ErrorContains(t, err, "failed to base64 decode secret: illegal base64 data at input byte 4")
		assert.Equal(t, "encrypted:invalid", plaintext)
	})

	t.Run("throws error on empty ciphertext", func(t *testing.T) {
		// Run test
		plaintext, err := decrypt(key, "encrypted:")
		// Check error
		assert.ErrorContains(t, err, "failed to decrypt secret: invalid length of message")
		assert.Equal(t, "encrypted:", plaintext)
	})
}
