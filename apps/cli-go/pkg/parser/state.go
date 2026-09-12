package parser

import (
	"bytes"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	// Omit BEGIN to allow arbitrary whitespaces between BEGIN and ATOMIC keywords.
	// This can fail if ATOMIC is used as column name because it is not a reserved
	// keyword: https://www.postgresql.org/docs/current/sql-keywords-appendix.html
	BEGIN_ATOMIC = "ATOMIC"
	END_ATOMIC   = "END"
)

type State interface {
	// Return nil to emit token
	Next(r rune, data []byte) State
}

// Initial state: ready to parse next token
type ReadyState struct{}

func (s *ReadyState) Next(r rune, data []byte) State {
	switch r {
	case '$':
		// $ continues an identifier (pending$$foo$ is one name, not a dollar quote). Only the
		// preceding rune is checked, so a digit counts too (1$$), unlike PostgreSQL's
		// number-then-dollar-quote lexing; valid SQL never juxtaposes the two.
		offset := len(data) - utf8.RuneLen(r)
		if hasIdentifierRuneBefore(data, offset) {
			return s
		}
		return &TagState{offset: offset}
	case '\'':
		fallthrough
	case '"':
		return &QuoteState{delimiter: r}
	case '-':
		return &CommentState{}
	case '/':
		return &BlockState{}
	case '\\':
		return &EscapeState{}
	case ';':
		// Emit token
		return nil
	case '(':
		return &AtomicState{prev: s, delimiter: []byte{')'}, statementStart: len(data)}
	case 'c':
		fallthrough
	case 'C':
		if isBeginAtomic(data) {
			return &AtomicState{prev: s, delimiter: []byte(END_ATOMIC), statementStart: len(data)}
		}
	}
	return s
}

func isBeginAtomic(data []byte) bool {
	if !endsWithKeyword(data, BEGIN_ATOMIC) {
		return false
	}
	prefix := bytes.TrimRightFunc(data[:len(data)-len(BEGIN_ATOMIC)], unicode.IsSpace)
	return endsWithKeyword(prefix, "BEGIN")
}

// PostgreSQL's lexer treats every byte at or above 0x80 as an identifier/dollar-tag
// character (ident_cont/dolq_cont are [A-Za-z\200-\377_0-9$] in scan.l), whatever its
// Unicode category.
func isIdentifierRune(r rune) bool {
	return r >= utf8.RuneSelf || unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '$'
}

func hasIdentifierRuneBefore(data []byte, offset int) bool {
	if offset <= 0 {
		return false
	}
	r, _ := utf8.DecodeLastRune(data[:offset])
	return isIdentifierRune(r)
}

// Whether data ends with keyword (an uppercase ASCII word) at an identifier boundary.
// EqualFold over a window sized in bytes is ASCII-effective here: any non-ASCII rune in the
// window misaligns it, matching PostgreSQL's keyword matching.
func endsWithKeyword(data []byte, keyword string) bool {
	offset := len(data) - len(keyword)
	if offset < 0 || !strings.EqualFold(string(data[offset:]), keyword) {
		return false
	}
	return !hasIdentifierRuneBefore(data, offset)
}

// The whitespace class of PostgreSQL's lexer (space in scan.l).
func isSqlWhitespace(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r', '\f', '\v':
		return true
	}
	return false
}

// Whether text contains only whitespace and complete line/block comments — i.e. no
// statement content. Callers only pass prefixes the FSM scanned at body level, so a comment
// in text is practically always terminated; an unterminated one counts as comment text.
func isCommentsAndWhitespace(text []byte) bool {
	for i := 0; i < len(text); {
		switch {
		case isSqlWhitespace(text[i]):
			i++
		case bytes.HasPrefix(text[i:], []byte("--")):
			newline := bytes.IndexByte(text[i+2:], '\n')
			if newline == -1 {
				return true
			}
			i += 2 + newline + 1
		case bytes.HasPrefix(text[i:], []byte("/*")):
			depth := 1
			i += 2
			for i < len(text) && depth > 0 {
				switch {
				case bytes.HasPrefix(text[i:], []byte("/*")):
					depth++
					i += 2
				case bytes.HasPrefix(text[i:], []byte("*/")):
					depth--
					i += 2
				default:
					i++
				}
			}
			if depth > 0 {
				return true
			}
		default:
			return false
		}
	}
	return true
}

// Opened a line comment
type CommentState struct{}

func (s *CommentState) Next(r rune, data []byte) State {
	if r == '-' {
		// No characters are escaped in comments, which is the same as dollar
		return &DollarState{delimiter: []byte{'\n'}}
	}
	// Break out of comment state
	state := &ReadyState{}
	return state.Next(r, data)
}

// Opened a block comment
type BlockState struct {
	depth int
}

func (s *BlockState) Next(r rune, data []byte) State {
	const open = "/*"
	const close = "*/"
	window := data[len(data)-2:]
	if bytes.Equal(window, []byte(open)) {
		s.depth += 1
		return s
	}
	if s.depth == 0 {
		// Break out of block state
		state := &ReadyState{}
		return state.Next(r, data)
	}
	if bytes.Equal(window, []byte(close)) {
		s.depth -= 1
		if s.depth == 0 {
			return &ReadyState{}
		}
	}
	return s
}

// Opened a single quote ' or double quote "
type QuoteState struct {
	delimiter rune
	escape    bool
}

func (s *QuoteState) Next(r rune, data []byte) State {
	if s.escape {
		// Preserve escaped quote ''
		if r == s.delimiter {
			s.escape = false
			return s
		}
		// Break out of quote state
		state := &ReadyState{}
		return state.Next(r, data)
	}
	if r == s.delimiter {
		s.escape = true
	}
	return s
}

// Opened a dollar quote, no characters are ever esacped.
type DollarState struct {
	delimiter []byte
}

func (s *DollarState) Next(r rune, data []byte) State {
	window := data[len(data)-len(s.delimiter):]
	if bytes.Equal(window, s.delimiter) {
		// Break out of dollar state
		return &ReadyState{}
	}
	return s
}

// Opened a tag, ie. $tag$
type TagState struct {
	offset int
}

func (s *TagState) Next(r rune, data []byte) State {
	if r == '$' {
		// Make a copy since the data slice may be overwritten
		tag := data[s.offset:]
		dollar := DollarState{
			delimiter: make([]byte, len(tag)),
		}
		copy(dollar.delimiter, tag)
		return &dollar
	}
	// Valid tag: https://www.postgresql.org/docs/current/sql-syntax-lexical.html
	if isIdentifierRune(r) {
		return s
	}
	// Break out of tag state
	state := &ReadyState{}
	return state.Next(r, data)
}

// Opened a \ escape
type EscapeState struct{}

func (s *EscapeState) Next(r rune, data []byte) State {
	return &ReadyState{}
}

// Opened BEGIN ATOMIC function body
type AtomicState struct {
	prev      State
	delimiter []byte
	// END just matched at the end of data; confirmed once a non-identifier rune follows.
	pendingEnd bool
	// Offset where the current inner statement starts (after ATOMIC or a body-level ';').
	statementStart int
	// Memo: the current inner statement already has content, so no END in it can close.
	statementHasContent bool
}

func (s *AtomicState) Next(r rune, data []byte) State {
	pendingEnd := s.pendingEnd
	s.pendingEnd = false
	if pendingEnd && !isIdentifierRune(r) {
		return (&ReadyState{}).Next(r, data)
	}
	// If we are in a quoted state, the current delimiter doesn't count.
	curr := s.prev.Next(r, data)
	if curr == nil {
		// A body-level ';': the next inner statement starts after it.
		s.statementStart = len(data)
		s.statementHasContent = false
		return s
	}
	s.prev = curr
	if _, ok := s.prev.(*ReadyState); !ok {
		return s
	}
	if string(s.delimiter) != END_ATOMIC {
		if bytes.HasSuffix(data, s.delimiter) {
			return &ReadyState{}
		}
		return s
	}
	// PostgreSQL's grammar requires every inner statement to end with ';', so the body's
	// closing END is always the first token of a statement. An END after other statement
	// content is expression text (a CASE arm, a column label) and must not close the body.
	// Known limitation: BlockState closes a /*/ comment early (PostgreSQL lexes /*/ as a
	// comment opener), so a ';' inside such a comment can shift the statement start.
	if !s.statementHasContent && endsWithKeyword(data, END_ATOMIC) {
		if isCommentsAndWhitespace(data[s.statementStart : len(data)-len(END_ATOMIC)]) {
			s.pendingEnd = true
		} else {
			s.statementHasContent = true
		}
	}
	return s
}
