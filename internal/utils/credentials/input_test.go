package credentials

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReadMaskedInput(t *testing.T) {
	t.Run("reads until Enter", func(t *testing.T) {
		input := strings.NewReader("hello\r")
		result, err := readMaskedInput(input, io.Discard)
		require.NoError(t, err)
		assert.Equal(t, "hello", result)
	})

	t.Run("reads until newline", func(t *testing.T) {
		input := strings.NewReader("hello\n")
		result, err := readMaskedInput(input, io.Discard)
		require.NoError(t, err)
		assert.Equal(t, "hello", result)
	})

	t.Run("returns error on Ctrl+C", func(t *testing.T) {
		input := strings.NewReader("abc\x03")
		_, err := readMaskedInput(input, io.Discard)
		assert.ErrorContains(t, err, "interrupted")
	})

	t.Run("handles backspace", func(t *testing.T) {
		// Type "abc", backspace, then "d", then Enter
		input := strings.NewReader("abc\x7fd\r")
		result, err := readMaskedInput(input, io.Discard)
		require.NoError(t, err)
		assert.Equal(t, "abd", result)
	})

	t.Run("backspace on empty buffer is no-op", func(t *testing.T) {
		input := strings.NewReader("\x7f\x7fabc\r")
		result, err := readMaskedInput(input, io.Discard)
		require.NoError(t, err)
		assert.Equal(t, "abc", result)
	})

	t.Run("ignores non-printable characters", func(t *testing.T) {
		// Tab (0x09), escape (0x1b), and other control chars should be ignored
		input := strings.NewReader("a\x09b\x1bc\r")
		result, err := readMaskedInput(input, io.Discard)
		require.NoError(t, err)
		assert.Equal(t, "abc", result)
	})

	t.Run("accepts non-ASCII bytes", func(t *testing.T) {
		// UTF-8 encoded "é" is 0xc3 0xa9
		input := bytes.NewReader([]byte{'a', 0xc3, 0xa9, 'b', '\r'})
		result, err := readMaskedInput(input, io.Discard)
		require.NoError(t, err)
		assert.Equal(t, "a\xc3\xa9b", result)
	})

	t.Run("echoes asterisks for each character", func(t *testing.T) {
		input := strings.NewReader("abc\r")
		var echo bytes.Buffer
		_, err := readMaskedInput(input, &echo)
		require.NoError(t, err)
		assert.Equal(t, "***\r\n", echo.String())
	})

	t.Run("returns accumulated input on EOF", func(t *testing.T) {
		input := strings.NewReader("partial")
		result, err := readMaskedInput(input, io.Discard)
		require.NoError(t, err)
		assert.Equal(t, "partial", result)
	})
}

func TestPromptMaskedWithAsterisks(t *testing.T) {
	t.Run("returns error on non-TTY", func(t *testing.T) {
		r, w, err := os.Pipe()
		require.NoError(t, err)
		defer r.Close()
		defer w.Close()
		// MakeRaw fails on pipes (non-TTY)
		_, err = PromptMaskedWithAsterisks(r)
		assert.ErrorContains(t, err, "failed to set raw terminal")
	})
}

func TestPromptMasked(t *testing.T) {
	t.Run("reads from piped stdin", func(t *testing.T) {
		// Setup token
		r, w, err := os.Pipe()
		require.NoError(t, err)
		_, err = w.WriteString("token")
		require.NoError(t, err)
		require.NoError(t, w.Close())
		// Run test
		input := PromptMasked(r)
		// Check error
		assert.Equal(t, "token", input)
	})

	t.Run("empty string on closed pipe", func(t *testing.T) {
		// Setup empty stdin
		r, w, err := os.Pipe()
		require.NoError(t, err)
		require.NoError(t, w.Close())
		require.NoError(t, r.Close())
		// Run test
		input := PromptMasked(r)
		// Check error
		assert.Empty(t, input)
	})
}
