package utils

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/spf13/viper"
)

func GetDebugLogger() io.Writer {
	if viper.GetBool("DEBUG") {
		return os.Stderr
	}
	return io.Discard
}

// DebugLogger provides namespaced debug logging similar to the Node.js debug package.
// Enable via DEBUG environment variable with patterns:
//   - DEBUG=supabase:dev:timing     - only timing logs
//   - DEBUG=supabase:dev:*          - all dev logs
//   - DEBUG=supabase:*              - all supabase logs
//   - DEBUG=*                       - all debug logs
type DebugLogger struct {
	namespace string
	enabled   bool
}

var (
	debugPatterns     []string
	debugPatternsOnce sync.Once
)

// loadDebugPatterns parses the DEBUG environment variable once
func loadDebugPatterns() {
	debugPatternsOnce.Do(func() {
		debug := os.Getenv("DEBUG")
		if debug == "" {
			return
		}
		for _, pattern := range strings.Split(debug, ",") {
			pattern = strings.TrimSpace(pattern)
			if pattern != "" {
				debugPatterns = append(debugPatterns, pattern)
			}
		}
	})
}

// NewDebugLogger creates a namespaced debug logger.
// The namespace should use colon-separated segments, e.g., "supabase:dev:timing"
func NewDebugLogger(namespace string) *DebugLogger {
	loadDebugPatterns()
	return &DebugLogger{
		namespace: namespace,
		enabled:   isDebugEnabled(namespace),
	}
}

// isDebugEnabled checks if a namespace matches any DEBUG pattern
func isDebugEnabled(namespace string) bool {
	for _, pattern := range debugPatterns {
		if matchDebugPattern(pattern, namespace) {
			return true
		}
	}
	return false
}

// matchDebugPattern checks if a namespace matches a debug pattern
// Supports * as wildcard at the end of a pattern
func matchDebugPattern(pattern, namespace string) bool {
	// Exact match
	if pattern == namespace {
		return true
	}
	// Wildcard match: "supabase:*" matches "supabase:dev:timing"
	if strings.HasSuffix(pattern, "*") {
		prefix := strings.TrimSuffix(pattern, "*")
		return strings.HasPrefix(namespace, prefix)
	}
	return false
}

// Printf prints a formatted debug message if the namespace is enabled
func (d *DebugLogger) Printf(format string, args ...interface{}) {
	if d.enabled {
		fmt.Fprintf(os.Stderr, "[%s] %s\n", d.namespace, fmt.Sprintf(format, args...))
	}
}

// Println prints a debug message if the namespace is enabled
func (d *DebugLogger) Println(args ...interface{}) {
	if d.enabled {
		fmt.Fprintf(os.Stderr, "[%s] %s\n", d.namespace, fmt.Sprint(args...))
	}
}

// Writer returns an io.Writer that writes to stderr if enabled, otherwise discards
func (d *DebugLogger) Writer() io.Writer {
	if d.enabled {
		return &debugWriter{namespace: d.namespace}
	}
	return io.Discard
}

// Enabled returns whether this logger is enabled
func (d *DebugLogger) Enabled() bool {
	return d.enabled
}

// debugWriter wraps writes with namespace prefix
type debugWriter struct {
	namespace string
}

func (w *debugWriter) Write(p []byte) (n int, err error) {
	msg := strings.TrimSpace(string(p))
	if msg != "" {
		fmt.Fprintf(os.Stderr, "[%s] %s\n", w.namespace, msg)
	}
	return len(p), nil
}
