//go:build linux

package utils

import (
	"os"
	"runtime"

	"github.com/docker/docker/api/types/container"
)

// Allows containers to resolve host network: https://stackoverflow.com/a/62431165
var extraHosts = []string{DinDHost + ":host-gateway"}

func isUserDefined(mode container.NetworkMode) bool {
	return mode.IsUserDefined()
}

func isSELinuxEnabled() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	_, err := os.Stat("/sys/fs/selinux")
	return err == nil
}

func getVolumeBindMode(mode string) string {
	if isSELinuxEnabled() {
		return mode + ",z"
	}
	return mode
}
