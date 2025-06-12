package utils

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"

	"github.com/spf13/viper"
)

var logger *slog.Logger

func init() {
	// Custom handler for simple colored output
	handler := &simpleHandler{output: os.Stderr}
	logger = slog.New(handler)
}

// simpleHandler implements slog.Handler with simple colored output
type simpleHandler struct {
	output io.Writer
}

func (h *simpleHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return true
}

func (h *simpleHandler) Handle(ctx context.Context, record slog.Record) error {
	var prefix string
	var colorFunc func(string) string

	switch record.Level {
	case slog.LevelDebug:
		prefix = "DEBUG:"
		colorFunc = Aqua
	case slog.LevelInfo:
		prefix = "INFO:"
		colorFunc = Blue
	case slog.LevelWarn:
		prefix = "WARNING:"
		colorFunc = Yellow
	case slog.LevelError:
		prefix = "ERROR:"
		colorFunc = Red
	default:
		prefix = "LOG:"
		colorFunc = func(s string) string { return s }
	}

	fmt.Fprintf(h.output, "%s %s\n", colorFunc(prefix), record.Message)
	return nil
}

func (h *simpleHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return h
}

func (h *simpleHandler) WithGroup(name string) slog.Handler {
	return h
}

// GetVerbosity returns the current verbosity level (0 = minimal, 1 = normal info, 2+ = more verbose)
func GetVerbosity() int {
	return viper.GetInt("VERBOSITY")
}

func GetDebugLogger() io.Writer {
	if viper.GetBool("DEBUG") {
		return os.Stderr
	}
	return io.Discard
}

// Log logs a plain message with no formatting, colors, or prefixes over stdout
func Log(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	fmt.Fprintf(os.Stdout, "%s", message)
}

// Info logs an info message if the current SUPABASE_VERBOSITY level is >= the required level
func Info(level int, format string, args ...interface{}) {
	if GetVerbosity() >= level {
		logger.Info(fmt.Sprintf(format, args...))
	}
}

// Debug logs a debug message when SUPABASE_DEBUG=true
func Debug(format string, args ...interface{}) {
	if viper.GetBool("DEBUG") {
		logger.Debug(fmt.Sprintf(format, args...))
	}
}

// Warning logs a warning message
func Warning(format string, args ...interface{}) {
	logger.Warn(fmt.Sprintf(format, args...))
}

// Error logs an error message
func Error(format string, args ...interface{}) {
	logger.Error(fmt.Sprintf(format, args...))
}

func GetLogger() *slog.Logger {
	return logger
}
