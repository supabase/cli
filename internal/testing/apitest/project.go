package apitest

import (
	"math/rand"
)

const (
	letters = "abcdefghijklmnopqrstuvwxyz"
)

func RandomProjectRef() string {
	data := make([]byte, 20)
	for i := range data {
		data[i] = letters[rand.Intn(len(letters))]
	}
	return string(data)
}
