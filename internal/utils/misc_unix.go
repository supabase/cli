//go:build !windows

package utils

// isRootDirectory reports whether the string dir is a root directory.
func isRootDirectory(dir string) bool {
	return dir == "/"
}
