package utils

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-errors/errors"
	"github.com/spf13/viper"
	"github.com/supabase/cli/pkg/cast"
	"golang.org/x/term"
)

type Console struct {
	IsTTY bool
	stdin *bufio.Scanner
	token chan string
	mu    sync.Mutex
}

func NewConsole() *Console {
	return &Console{
		IsTTY: term.IsTerminal(int(os.Stdin.Fd())),
		stdin: bufio.NewScanner(os.Stdin),
		token: make(chan string),
		mu:    sync.Mutex{},
	}
}

// Prevent interactive terminals from hanging more than 10 minutes
const ttyTimeout = time.Minute * 10

func (c *Console) ReadLine(ctx context.Context) string {
	// Wait a few ms for input
	timeout := time.Millisecond
	if c.IsTTY {
		timeout = ttyTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	// Read from stdin in background
	go func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		// Scan one line from input or file
		if c.stdin.Scan() {
			c.token <- strings.TrimSpace(c.stdin.Text())
		}
	}()
	var input string
	select {
	case input = <-c.token:
	case <-ctx.Done():
	case <-timer.C:
	}
	return input
}

// PromptYesNo asks yes/no questions using the label.
func (c *Console) PromptYesNo(ctx context.Context, label string, def bool) (bool, error) {
	choices := "Y/n"
	if !def {
		choices = "y/N"
	}
	labelWithChoice := fmt.Sprintf("%s [%s] ", label, choices)
	if viper.GetBool("YES") {
		fmt.Fprintln(os.Stderr, labelWithChoice+"y")
		return true, nil
	}
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
		return cast.Ptr(true)
	}
	if s == "n" || s == "no" {
		return cast.Ptr(false)
	}
	return nil
}

// PromptText asks for input using the label.
func (c *Console) PromptText(ctx context.Context, label string) (string, error) {
	fmt.Fprint(os.Stderr, label)
	input := c.ReadLine(ctx)
	// Echo to stderr for non-interactive terminals
	if !c.IsTTY {
		fmt.Fprintln(os.Stderr, input)
	}
	if err := ctx.Err(); err != nil {
		return "", errors.New(err)
	}
	return input, nil
}
