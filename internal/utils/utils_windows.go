//go:build windows

package utils

import (
	"unicode"
)

// IsRootDirectory reports whether the string dir is a root directory.
func IsRootDirectory(dir string) bool {
	chars := []rune(dir)
	return len(chars) == 3 && unicode.IsUpper(chars[0]) && chars[1] == ':' && chars[2] == '\\'
}
