package utils

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"
)

type Console struct {
	IsTTY  bool
	stdin  *bufio.Scanner
	logger io.Writer
}

func NewConsole() Console {
	return Console{
		IsTTY:  term.IsTerminal(int(os.Stdin.Fd())),
		stdin:  bufio.NewScanner(os.Stdin),
		logger: GetDebugLogger(),
	}
}

// PromptYesNo asks yes/no questions using the label.
func (c Console) PromptYesNo(label string, def bool) bool {
	choices := "Y/n"
	if !def {
		choices = "y/N"
	}
	labelWithChoice := fmt.Sprintf("%s [%s] ", label, choices)
	// Any error will be handled as default value
	if input := c.PromptText(labelWithChoice); len(input) > 0 {
		if answer := parseYesNo(input); answer != nil {
			return *answer
		}
	}
	return def
}

func parseYesNo(s string) *bool {
	s = strings.ToLower(s)
	if s == "y" || s == "yes" {
		return Ptr(true)
	}
	if s == "n" || s == "no" {
		return Ptr(false)
	}
	return nil
}

// PromptText asks for input using the label.
func (c Console) PromptText(label string) string {
	fmt.Fprint(os.Stderr, label)
	// Scan a single line from input or file
	if !c.stdin.Scan() {
		fmt.Fprintln(c.logger, io.EOF)
	}
	if err := c.stdin.Err(); err != nil {
		fmt.Fprintln(c.logger, err)
	}
	token := strings.TrimSpace(c.stdin.Text())
	// Echo input to stderr for non-interactive terminals
	if !c.IsTTY {
		fmt.Fprintln(os.Stderr, token)
	}
	return token
}
