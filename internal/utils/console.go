package utils

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"golang.org/x/term"
)

type Console struct {
	isTTY  bool
	stdin  *bufio.Scanner
	stdout io.Writer
	stderr io.Writer
}

func NewConsole() Console {
	return Console{
		isTTY:  term.IsTerminal(int(os.Stdin.Fd())),
		stdin:  bufio.NewScanner(os.Stdin),
		stdout: os.Stdout,
		stderr: GetDebugLogger(),
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
	if s, err := c.PromptText(labelWithChoice); err != nil {
		fmt.Fprintln(c.stdout)
		if !errors.Is(err, io.EOF) {
			fmt.Fprintln(c.stderr, err)
		}
	} else if answer := parseYesNo(s); answer != nil {
		return *answer
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
func (c Console) PromptText(label string) (string, error) {
	fmt.Fprint(os.Stderr, label)
	// Scan a single line from input or file
	if !c.stdin.Scan() {
		return "", errors.New(io.EOF)
	}
	if err := c.stdin.Err(); err != nil {
		return "", errors.Errorf("failed to scan stdin: %w", err)
	}
	token := strings.TrimSpace(c.stdin.Text())
	// Echo input from non-interactive terminal
	if !c.isTTY {
		fmt.Fprintln(c.stdout, token)
	}
	return token, nil
}
