package pgtest

import (
	"context"
	"fmt"
	"net"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgmock"
	"github.com/jackc/pgproto3/v2"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/pkg/pgxv5"
	"google.golang.org/grpc/test/bufconn"
)

type MockConn struct {
	client *pgx.Conn

	// Duplex server listener backed by in-memory buffer
	server *bufconn.Listener

	// Mock server requests and responses
	script pgmock.Script

	// Status parameters emitted by postgres on first connect
	status map[string]string

	// Channel for reporting all server error
	errChan chan error
}

func (r *MockConn) getStartupMessage(config *pgx.ConnConfig) []pgmock.Step {
	var steps []pgmock.Step
	// Add auth message
	params := map[string]string{"user": config.User}
	if len(config.Database) > 0 {
		params["database"] = config.Database
	}
	steps = append(
		steps,
		pgmock.ExpectMessage(&pgproto3.StartupMessage{
			ProtocolVersion: pgproto3.ProtocolVersionNumber,
			Parameters:      params,
		}),
		pgmock.SendMessage(&pgproto3.AuthenticationOk{}),
	)
	// Add status message
	r.status["session_authorization"] = config.User
	for key, value := range r.status {
		steps = append(steps, pgmock.SendMessage(&pgproto3.ParameterStatus{Name: key, Value: value}))
	}
	// Add ready message
	steps = append(
		steps,
		pgmock.SendMessage(&pgproto3.BackendKeyData{ProcessID: 0, SecretKey: 0}),
		pgmock.SendMessage(&pgproto3.ReadyForQuery{TxStatus: 'I'}),
	)
	return steps
}

// Configures pgx to use the mock dialer.
//
// The mock dialer provides a full duplex net.Conn backed by an in-memory buffer.
// It is implemented by grcp/test/bufconn package.
func (r *MockConn) Intercept(config *pgx.ConnConfig) {
	// Override config for test
	config.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return r.server.DialContext(ctx)
	}
	config.LookupFunc = func(ctx context.Context, host string) (addrs []string, err error) {
		return []string{"127.0.0.1"}, nil
	}
	config.TLSConfig = nil
	// Add startup message
	r.script.Steps = append(r.getStartupMessage(config), r.script.Steps...)
}

// Adds a simple query or prepared statement to the mock connection.
func (r *MockConn) Query(sql string, args ...interface{}) *MockConn {
	var oids []uint32
	var params [][]byte
	for _, v := range args {
		if value, oid := r.encodeValueArg(v); oid > 0 {
			params = append(params, value)
			oids = append(oids, oid)
		}
	}
	r.script.Steps = append(r.script.Steps, ExpectQuery(sql, params, oids))
	return r
}

func (r *MockConn) encodeValueArg(v interface{}) (value []byte, oid uint32) {
	if v == nil {
		return nil, pgtype.TextArrayOID
	}
	dt, ok := ci.DataTypeForValue(v)
	if !ok {
		r.errChan <- fmt.Errorf("no suitable type for arg: %v", v)
		return nil, 0
	}
	if err := dt.Value.Set(v); err != nil {
		r.errChan <- fmt.Errorf("failed to set value: %w", err)
		return nil, 0
	}
	var err error
	switch dt.OID {
	case pgtype.TextOID:
		value, err = (dt.Value).(pgtype.TextEncoder).EncodeText(ci, []byte{})
	default:
		value, err = (dt.Value).(pgtype.BinaryEncoder).EncodeBinary(ci, []byte{})
	}
	if err != nil {
		r.errChan <- fmt.Errorf("failed to encode arg: %w", err)
		return nil, 0
	}
	return value, dt.OID
}

func getDataTypeSize(v interface{}) int16 {
	t := reflect.TypeOf(v)
	k := t.Kind()
	if k < reflect.Int || k > reflect.Complex128 {
		return -1
	}
	return int16(t.Size())
}

func (r *MockConn) lastQuery() *extendedQueryStep {
	return r.script.Steps[len(r.script.Steps)-1].(*extendedQueryStep)
}

// Adds a server reply using binary or text protocol format.
//
// TODO: support prepared statements when using binary protocol
func (r *MockConn) Reply(tag string, rows ...interface{}) *MockConn {
	q := r.lastQuery()
	// Add field description
	if len(rows) > 0 {
		var desc pgproto3.RowDescription
		if arr, ok := rows[0].([]interface{}); ok {
			for i, v := range arr {
				name := fmt.Sprintf("c_%02d", i)
				if fd := toFieldDescription(v); fd != nil {
					fd.Name = []byte(name)
					desc.Fields = append(desc.Fields, *fd)
				} else {
					r.errChan <- fmt.Errorf("failed to describe field: %s", name)
				}
			}
		} else if t := reflect.TypeOf(rows[0]); t.Kind() == reflect.Struct {
			s := reflect.ValueOf(rows[0])
			for i := 0; i < s.NumField(); i++ {
				name := pgxv5.GetColumnName(t.Field(i))
				if len(name) == 0 {
					continue
				}
				v := s.Field(i).Interface()
				if fd := toFieldDescription(v); fd != nil {
					fd.Name = []byte(name)
					desc.Fields = append(desc.Fields, *fd)
				} else {
					r.errChan <- fmt.Errorf("failed to describe field: %s", name)
				}
			}
		} else {
			r.errChan <- fmt.Errorf("reply type must be one of [array, struct], found: %s", t.Kind())
		}
		q.reply.Steps = append(q.reply.Steps, pgmock.SendMessage(&desc))
	} else {
		// No data is optional, but we add for completeness
		q.reply.Steps = append(q.reply.Steps, pgmock.SendMessage(&pgproto3.NoData{}))
	}
	// Add row data
	for _, data := range rows {
		var dr pgproto3.DataRow
		if arr, ok := data.([]interface{}); ok {
			for _, v := range arr {
				if value, oid := r.encodeValueArg(v); oid > 0 {
					dr.Values = append(dr.Values, value)
				}
			}
		} else if t := reflect.TypeOf(data); t.Kind() == reflect.Struct {
			s := reflect.ValueOf(rows[0])
			for i := 0; i < s.NumField(); i++ {
				if name := pgxv5.GetColumnName(t.Field(i)); len(name) == 0 {
					continue
				}
				v := s.Field(i).Interface()
				if value, oid := r.encodeValueArg(v); oid > 0 {
					dr.Values = append(dr.Values, value)
				}
			}
		} else {
			r.errChan <- fmt.Errorf("invalid reply value: %v", data)
		}
		q.reply.Steps = append(q.reply.Steps, pgmock.SendMessage(&dr))
	}
	// Add completion message
	var complete pgproto3.BackendMessage
	if tag == "" {
		complete = &pgproto3.EmptyQueryResponse{}
	} else {
		complete = &pgproto3.CommandComplete{CommandTag: []byte(tag)}
	}
	q.reply.Steps = append(q.reply.Steps, pgmock.SendMessage(complete))
	return r
}

func toFieldDescription(v interface{}) *pgproto3.FieldDescription {
	if dt, ok := ci.DataTypeForValue(v); ok {
		size := getDataTypeSize(v)
		format := ci.ParamFormatCodeForOID(dt.OID)
		return &pgproto3.FieldDescription{
			TableOID:             17131,
			TableAttributeNumber: 1,
			DataTypeOID:          dt.OID,
			DataTypeSize:         size,
			TypeModifier:         -1,
			Format:               format,
		}
	}
	return nil
}

// Simulates an error reply from the server.
//
// TODO: simulate a notice reply
func (r *MockConn) ReplyError(code, message string) *MockConn {
	q := r.lastQuery()
	q.reply.Steps = append(
		q.reply.Steps,
		pgmock.SendMessage(&pgproto3.ErrorResponse{
			Severity:            "ERROR",
			SeverityUnlocalized: "ERROR",
			Code:                code,
			Message:             message,
		}),
	)
	return r
}

func (r *MockConn) Close(t *testing.T) {
	if r.client != nil {
		if err := r.client.Close(context.Background()); err != nil {
			t.Errorf("failed to close client: %v", err)
		}
	}
	for err := range r.errChan {
		t.Errorf("pgmock error:\n%v", err)
	}
	if err := r.server.Close(); err != nil {
		t.Fatalf("failed to close server: %v", err)
	}
}

func (r *MockConn) MockClient(t *testing.T, opts ...func(*pgx.ConnConfig)) *pgx.Conn {
	if r.client != nil {
		return r.client
	}
	opts = append(opts, r.Intercept, func(cc *pgx.ConnConfig) {
		cc.ConnectTimeout = time.Second * 2
	})
	var err error
	if r.client, err = pgxv5.Connect(context.Background(), "", opts...); err != nil {
		t.Errorf("failed to connect: %v", err)
	}
	return r.client
}

func NewWithStatus(status map[string]string) *MockConn {
	const bufSize = 1024 * 1024
	mock := MockConn{
		server:  bufconn.Listen(bufSize),
		status:  status,
		errChan: make(chan error, 10),
	}
	// Start server in background
	const timeout = time.Millisecond * 450
	go func() {
		defer close(mock.errChan)
		// Block until we've opened a TCP connection
		conn, err := mock.server.Accept()
		if err != nil {
			mock.errChan <- err
			return
		}
		defer conn.Close()
		// Prevent server from hanging the test
		err = conn.SetDeadline(time.Now().Add(timeout))
		if err != nil {
			mock.errChan <- err
			return
		}
		// Always expect clients to terminate the request
		mock.script.Steps = append(mock.script.Steps, ExpectTerminate())
		err = mock.script.Run(pgproto3.NewBackend(pgproto3.NewChunkReader(conn), conn))
		if err != nil {
			mock.errChan <- err
			return
		}
	}()

	return &mock
}

func NewConn() *MockConn {
	status := map[string]string{
		"application_name":              "",
		"client_encoding":               "UTF8",
		"DateStyle":                     "ISO, MDY",
		"default_transaction_read_only": "off",
		"in_hot_standby":                "off",
		"integer_datetimes":             "on",
		"IntervalStyle":                 "postgres",
		"is_superuser":                  "on",
		"server_encoding":               "UTF8",
		"server_version":                "14.3 (Debian 14.3-1.pgdg110+1)",
		"standard_conforming_strings":   "on",
		"TimeZone":                      "UTC",
	}
	return NewWithStatus(status)
}
