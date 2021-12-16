//go:build !windows

package utils

// IsRootDirectory reports whether the string dir is a root directory.
func IsRootDirectory(dir string) bool {
	return dir == "/"
}
