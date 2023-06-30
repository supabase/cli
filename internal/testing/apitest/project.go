package apitest

import (
	"crypto/rand"
	"fmt"
	"os"
)

const (
	letters = "abcdefghijklmnopqrstuvwxyz"
)

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
