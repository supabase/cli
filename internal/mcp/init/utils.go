package mcpinit

import (
	"fmt"
	"os"
	"runtime"
)

// appExists checks if a macOS application is installed
func appExists(appName string) bool {
	if runtime.GOOS == "darwin" {
		locations := []string{
			fmt.Sprintf("/Applications/%s.app", appName),
			fmt.Sprintf("%s/Applications/%s.app", os.Getenv("HOME"), appName),
		}
		for _, location := range locations {
			if _, err := os.Stat(location); err == nil {
				return true
			}
		}
	}
	return false
}
