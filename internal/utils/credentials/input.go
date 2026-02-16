package credentials

import (
	"bytes"
	"fmt"
	"io"
	"os"

	"golang.org/x/term"
)

// PromptMaskedWithAsterisks reads input character by character, echoing '*' for
// each typed character. Handles backspace and Ctrl+C. Requires a TTY terminal.
func PromptMaskedWithAsterisks(stdin *os.File) (string, error) {
	fd := int(stdin.Fd())
	oldState, err := term.MakeRaw(fd)
	if err != nil {
		return "", fmt.Errorf("failed to set raw terminal: %w", err)
	}
	defer term.Restore(fd, oldState)
	return readMaskedInput(stdin, os.Stderr)
}

// readMaskedInput reads bytes one at a time from r, echoing '*' to echo for each
// printable character. Handles backspace, Ctrl+C, and Enter.
func readMaskedInput(r io.Reader, echo io.Writer) (string, error) {
	var buf []byte
	b := make([]byte, 1)
	for {
		if _, err := r.Read(b); err != nil {
			fmt.Fprint(echo, "\r\n")
			if err == io.EOF {
				return string(buf), nil
			}
			return "", fmt.Errorf("failed to read input: %w", err)
		}
		switch {
		case b[0] == 3: // Ctrl+C
			fmt.Fprint(echo, "\r\n")
			return "", fmt.Errorf("interrupted")
		case b[0] == 13 || b[0] == 10: // Enter
			fmt.Fprint(echo, "\r\n")
			return string(buf), nil
		case b[0] == 127 || b[0] == 8: // Backspace / Delete
			if len(buf) > 0 {
				buf = buf[:len(buf)-1]
				fmt.Fprint(echo, "\b \b")
			}
		case b[0] >= 32 && b[0] < 127: // Printable ASCII
			buf = append(buf, b[0])
			fmt.Fprint(echo, "*")
		}
	}
}

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
