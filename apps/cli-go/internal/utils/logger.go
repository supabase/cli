package utils

import (
	"io"
	"os"

	"github.com/spf13/viper"
)

func GetDebugLogger() io.Writer {
	if viper.GetBool("DEBUG") {
		return os.Stderr
	}
	return io.Discard
}
