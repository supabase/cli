package apitest

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
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

const letters = "abcdefghijklmnopqrstuvwxyz"

func RandomProjectRef() string {
	data := make([]byte, 20)
	_, err := rand.Read(data)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	for i := range data {
		n := int(data[i]) % len(letters)
		data[i] = letters[n]
	}
	return string(data)
}

func AssertRequestsDone(t *testing.T) {
	assert.False(t, gock.HasUnmatchedRequest())
	for _, r := range gock.GetUnmatchedRequests() {
		fmt.Fprintln(os.Stderr, "Unmatched:", r.Method, r.URL.Path)
	}
	assert.True(t, gock.IsDone())
	for _, p := range gock.Pending() {
		fmt.Fprintln(os.Stderr, "Pending:", p.Request().Method, p.Request().URLStruct.Path)
	}
}
