package parser

import (
	"bufio"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/go-errors/errors"
	"github.com/spf13/viper"
)

// Equal to `startBufSize` from `bufio/scan.go`
const startBufSize = 4096

// MaxScannerCapacity defaults to 64 * 1024 which is not enough for certain lines
// containing e.g. geographical data. 256K ought to be enough for anybody...
var MaxScannerCapacity = 256 * 1024

// State transition table for tokenizer:
//
//	Ready -> Ready (default)
//	Ready -> Error (on invalid syntax)
//	Ready -> Done (on ;, emit token)
//	Ready -> Done (on EOF, emit token)
//
//	Ready -> Comment (on --)
//	Comment -> Comment (default)
//	Comment -> Ready (on \n)
//
//	Ready -> Block (on /*)
//	Block -> Block (on /*, +-depth)
//	Block -> Ready (on */, depth 0)
//
//	Ready -> Quote (on ')
//	Quote -> Quote (on '', default)
//	Quote -> Ready (on ')
//
//	Ready -> Dollar (on $tag$)
//	Dollar -> Dollar (default)
//	Dollar -> Ready (on $tag$)
//
//	Ready -> Escape (on \)
//	Escape -> Ready (on next)
type tokenizer struct {
	state State
	last  int
}

func (t *tokenizer) ScanToken(data []byte, atEOF bool) (advance int, token []byte, err error) {
	// If we requested more data, resume from last position.
	for width := 1; t.last < len(data); t.last += width {
		r, width := utf8.DecodeRune(data[t.last:])
		end := t.last + width
		t.state = t.state.Next(r, data[:end])
		// Emit token
		if t.state == nil {
			t.last = 0
			t.state = &ReadyState{}
			return end, data[:end], nil
		}
	}
	if !atEOF || len(data) == 0 {
		// Request more data or end the stream
		return 0, nil, nil
	}
	// We're at EOF. If we have a final, non-terminated token, return it.
	return len(data), data, nil
}

// Use bufio.Scanner to split a PostgreSQL string into multiple statements.
//
// The core problem is to figure out whether the current ; separator is inside
// an escaped string literal. PostgreSQL has multiple ways of opening a string
// literal, $$, ', --, /*, etc. We use a FSM to guarantee these states are
// entered exclusively. If not in one of the above escape states, the next ;
// token can be parsed as statement separator.
//
// Each statement is split as it is, without removing comments or white spaces.
func Split(sql io.Reader, transform ...func(string) string) (stats []string, err error) {
	t := tokenizer{state: &ReadyState{}}
	scanner := bufio.NewScanner(sql)

	// Increase scanner capacity to support very long lines containing e.g. geodata
	buf := make([]byte, startBufSize)
	maxbuf := int(viper.GetSizeInBytes("SCANNER_BUFFER_SIZE"))
	if maxbuf == 0 {
		maxbuf = MaxScannerCapacity
	}
	scanner.Buffer(buf, maxbuf)
	scanner.Split(t.ScanToken)

	var token string
	for scanner.Scan() {
		token = scanner.Text()
		trim := token
		for _, apply := range transform {
			trim = apply(trim)
		}
		if len(trim) > 0 {
			stats = append(stats, trim)
		}
	}
	err = scanner.Err()
	if err != nil {
		err = errors.Errorf("%w\nAfter statement %d: %s", err, len(stats), token)
	}
	if errors.Is(err, bufio.ErrTooLong) {
		err = errors.Errorf("%w\nTry setting SUPABASE_SCANNER_BUFFER_SIZE=5MB (current size is %dKB)", err, maxbuf>>10)
	}
	return stats, err
}

func SplitAndTrim(sql io.Reader) (stats []string, err error) {
	return Split(sql, func(token string) string {
		return strings.TrimRight(token, ";")
	}, strings.TrimSpace)
}
