package apitest

import (
	"crypto/rand"
	"encoding/hex"
	"testing"

	"github.com/stretchr/testify/require"
)

func RandomAccessToken(t *testing.T) []byte {
	data := make([]byte, 20)
	_, err := rand.Read(data)
	require.NoError(t, err)
	token := make([]byte, 44)
	copy(token, "sbp_")
	hex.Encode(token[4:], data)
	return token
}
