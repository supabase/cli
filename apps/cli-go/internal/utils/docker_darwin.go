//go:build darwin

package utils

import "github.com/moby/moby/api/types/container"

var extraHosts []string

func isUserDefined(mode container.NetworkMode) bool {
	return mode.IsUserDefined()
}
