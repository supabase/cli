//go:build linux

package utils

import "github.com/docker/docker/api/types/container"

// Allows containers to resolve host network: https://stackoverflow.com/a/62431165
var extraHosts = []string{DinDHost + ":host-gateway"}

func isUserDefined(mode container.NetworkMode) bool {
	return mode.IsUserDefined()
}
