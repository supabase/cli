package credentials

import (
	"bytes"
	"fmt"
	"io"
	"os"

	"golang.org/x/term"
)

func PromptMasked(stdin *os.File) string {
	// Start a new line after reading input
	defer fmt.Println()
	// Copy if stdin is piped: https://stackoverflow.com/a/26567513
	if !term.IsTerminal(int(stdin.Fd())) {
		var buf bytes.Buffer
		if _, err := io.Copy(&buf, stdin); err != nil {
			return ""
		}
		return buf.String()
	}
	// Read with masked tokens
	bytepw, err := term.ReadPassword(int(stdin.Fd()))
	if err != nil {
		fmt.Fprintln(os.Stderr, "Failed to read password:", err)
		return ""
	}
	return string(bytepw)
}
