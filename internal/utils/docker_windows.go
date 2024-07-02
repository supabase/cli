//go:build windows

package utils

import (
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
)

var extraHosts []string

func isUserDefined(mode container.NetworkMode) bool {
	// Host network requires explicit check on windows: https://github.com/supabase/cli/pull/952
	return mode.IsUserDefined() && mode.UserDefined() != network.NetworkHost
}
