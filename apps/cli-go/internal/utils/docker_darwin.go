//go:build darwin

package utils

import "github.com/docker/docker/api/types/container"

var extraHosts []string

func isUserDefined(mode container.NetworkMode) bool {
	return mode.IsUserDefined()
}
