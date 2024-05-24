package utils

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"golang.org/x/term"
)

type Console struct {
	IsTTY  bool
	stdin  *bufio.Scanner
	logger io.Writer
	token  chan string
}

func NewConsole() Console {
	c := Console{
		IsTTY:  term.IsTerminal(int(os.Stdin.Fd())),
		stdin:  bufio.NewScanner(os.Stdin),
		logger: GetDebugLogger(),
		token:  make(chan string),
	}
	go func() {
		// Scan a single line from input or file
		if !c.stdin.Scan() {
			fmt.Fprintln(c.logger, io.EOF)
		}
		if err := c.stdin.Err(); err != nil {
			fmt.Fprintln(c.logger, err)
		}
		c.token <- strings.TrimSpace(c.stdin.Text())
	}()
	return c
}

// PromptYesNo asks yes/no questions using the label.
func (c Console) PromptYesNo(ctx context.Context, label string, def bool) (bool, error) {
	choices := "Y/n"
	if !def {
		choices = "y/N"
	}
	labelWithChoice := fmt.Sprintf("%s [%s] ", label, choices)
	// Any error will be handled as default value
	input, err := c.PromptText(ctx, labelWithChoice)
	if len(input) > 0 {
		if answer := parseYesNo(input); answer != nil {
			return *answer, nil
		}
	}
	return def, err
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

// Prevent interactive terminals from hanging more than 10 minutes
const ttyTimeout = time.Minute * 10

// PromptText asks for input using the label.
func (c Console) PromptText(ctx context.Context, label string) (string, error) {
	fmt.Fprint(os.Stderr, label)
	// Wait a few ms for input
	timeout := time.Millisecond
	if c.IsTTY {
		timeout = ttyTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	// Read from stdin
	var input string
	select {
	case input = <-c.token:
	case <-ctx.Done():
	case <-timer.C:
	}
	// Echo to stderr for non-interactive terminals
	if !c.IsTTY {
		fmt.Fprintln(os.Stderr, input)
	}
	if err := ctx.Err(); err != nil {
		return "", errors.New(err)
	}
	return input, nil
}
