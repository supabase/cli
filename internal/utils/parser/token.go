package parser

import (
	"bufio"
	"io"
	"unicode/utf8"
)

// State transition table for tokenizer:
//
//   Ready -> Ready (default)
//   Ready -> Error (on invalid syntax)
//   Ready -> Done (on ;, emit token)
//   Ready -> Done (on EOF, emit token)
//
//   Ready -> Comment (on --)
//   Comment -> Comment (default)
//   Comment -> Ready (on \n)
//
//   Ready -> Block (on /*)
//   Block -> Block (on /*, +-depth)
//   Block -> Ready (on */, depth 0)
//
//   Ready -> Quote (on ')
//   Quote -> Quote (on '', default)
//   Quote -> Ready (on ')
//
//   Ready -> Dollar (on $tag$)
//   Dollar -> Dollar (default)
//   Dollar -> Ready (on $tag$)
//
//   Ready -> Escape (on \)
//   Escape -> Ready (on next)
//
type tokenizer struct {
	state State
	last  int
}

func (t *tokenizer) ScanToken(data []byte, atEOF bool) (advance int, token []byte, err error) {
	// If we requested more data, resume from last position.
	for i, width := t.last, 1; i < len(data); i += width {
		r, width := utf8.DecodeRune(data[i:])
		t.last = i + width
		t.state = t.state.Next(r, data[:t.last])
		// Emit token
		if t.state == nil {
			end := t.last
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
func Split(sql io.Reader) (stats []string) {
	t := tokenizer{state: &ReadyState{}}
	scanner := bufio.NewScanner(sql)
	scanner.Split(t.ScanToken)
	for scanner.Scan() {
		token := scanner.Text()
		stats = append(stats, token)
	}
	return stats
}
