package mail

import (
	"bytes"
	"io"

	"github.com/emersion/go-smtp"
)

// smtpBackend implements the smtp.Backend interface.
type smtpBackend struct {
	storage *Storage
}

// NewSession implements smtp.Backend.
func (b *smtpBackend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	return &smtpSession{storage: b.storage}, nil
}

// smtpSession implements the smtp.Session interface.
type smtpSession struct {
	storage *Storage
	from    string
	to      []string
}

// AuthPlain implements smtp.Session.
// We accept any authentication for local testing.
func (s *smtpSession) AuthPlain(username, password string) error {
	return nil
}

// Mail implements smtp.Session.
func (s *smtpSession) Mail(from string, opts *smtp.MailOptions) error {
	s.from = from
	return nil
}

// Rcpt implements smtp.Session.
func (s *smtpSession) Rcpt(to string, opts *smtp.RcptOptions) error {
	s.to = append(s.to, to)
	return nil
}

// Data implements smtp.Session.
func (s *smtpSession) Data(r io.Reader) error {
	// Read all the email data
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, r); err != nil {
		return err
	}

	// Store the email for each recipient
	return s.storage.Store(s.from, s.to, buf.Bytes())
}

// Reset implements smtp.Session.
func (s *smtpSession) Reset() {
	s.from = ""
	s.to = nil
}

// Logout implements smtp.Session.
func (s *smtpSession) Logout() error {
	return nil
}
