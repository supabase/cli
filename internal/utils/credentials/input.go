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
	defer func() { _ = term.Restore(fd, oldState) }()
	return readMaskedInput(stdin, os.Stderr)
}

// readMaskedInput reads bytes one at a time from r, echoing '*' to echo for each
// printable character. Handles backspace, Ctrl+C, and Enter.
func readMaskedInput(r io.Reader, echo io.Writer) (string, error) {
	var buf []byte
	var b [1]byte
	for {
		if _, err := io.ReadFull(r, b[:]); err != nil {
			fmt.Fprint(echo, "\r\n")
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return string(buf), nil
			}
			return "", fmt.Errorf("failed to read input: %w", err)
		}
		ch := b[0]
		switch {
		case ch == 3: // Ctrl+C
			fmt.Fprint(echo, "\r\n")
			return "", fmt.Errorf("interrupted")
		case ch == 13 || ch == 10: // Enter
			fmt.Fprint(echo, "\r\n")
			return string(buf), nil
		case ch == 127 || ch == 8: // Backspace / Delete
			if len(buf) > 0 {
				buf = buf[:len(buf)-1]
				fmt.Fprint(echo, "\b \b")
			}
		case ch >= 32 && ch < 127: // Printable ASCII
			buf = append(buf, ch)
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
