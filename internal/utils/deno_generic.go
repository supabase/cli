//go:build !darwin

package utils

import (
	"errors"
	"runtime"
)

func getDenoAssetFileName() (string, error) {
	if runtime.GOOS == "linux" && runtime.GOARCH == "amd64" {
		return "deno-x86_64-unknown-linux-gnu.zip", nil
	} else if runtime.GOOS == "linux" && runtime.GOARCH == "arm64" {
		// TODO: version pin to official release once available https://github.com/denoland/deno/issues/1846
		return "deno-linux-arm64.zip", nil
	} else if runtime.GOOS == "windows" && runtime.GOARCH == "amd64" {
		return "deno-x86_64-pc-windows-msvc.zip", nil
	} else {
		return "", errors.New("Platform " + runtime.GOOS + "/" + runtime.GOARCH + " is currently unsupported for Functions.")
	}
}
