package utils

import (
	"github.com/yarlson/pin"
)

func NewSpinner(text string) *pin.Pin {
	s := pin.New(text)
	return s
}
