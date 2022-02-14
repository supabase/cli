//go:build windows

package utils

import (
	"unicode"
)

// isRootDirectory reports whether the string dir is a root directory.
func isRootDirectory(dir string) bool {
	chars := []rune(dir)
	return len(chars) == 3 && unicode.IsUpper(chars[0]) && chars[1] == ':' && chars[2] == '\\'
}
