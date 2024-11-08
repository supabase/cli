package cloudflare

import (
	"context"
	"net/http"

	"github.com/go-errors/errors"
	"github.com/google/go-querystring/query"
	"github.com/supabase/cli/pkg/fetcher"
)

type DNSType uint16

// Spec: https://www.iana.org/assignments/dns-parameters/dns-parameters.xhtml#dns-parameters-4
// Impl: https://github.com/miekg/dns/blob/master/types.go#L23
const (
	TypeNone       DNSType = 0
	TypeA          DNSType = 1 // IPv4
	TypeNS         DNSType = 2
	TypeMD         DNSType = 3
	TypeMF         DNSType = 4
	TypeCNAME      DNSType = 5
	TypeSOA        DNSType = 6
	TypeMB         DNSType = 7
	TypeMG         DNSType = 8
	TypeMR         DNSType = 9
	TypeNULL       DNSType = 10
	TypePTR        DNSType = 12
	TypeHINFO      DNSType = 13
	TypeMINFO      DNSType = 14
	TypeMX         DNSType = 15
	TypeTXT        DNSType = 16
	TypeRP         DNSType = 17
	TypeAFSDB      DNSType = 18
	TypeX25        DNSType = 19
	TypeISDN       DNSType = 20
	TypeRT         DNSType = 21
	TypeNSAPPTR    DNSType = 23
	TypeSIG        DNSType = 24
	TypeKEY        DNSType = 25
	TypePX         DNSType = 26
	TypeGPOS       DNSType = 27
	TypeAAAA       DNSType = 28 // IPv6
	TypeLOC        DNSType = 29
	TypeNXT        DNSType = 30
	TypeEID        DNSType = 31
	TypeNIMLOC     DNSType = 32
	TypeSRV        DNSType = 33
	TypeATMA       DNSType = 34
	TypeNAPTR      DNSType = 35
	TypeKX         DNSType = 36
	TypeCERT       DNSType = 37
	TypeDNAME      DNSType = 39
	TypeOPT        DNSType = 41 // EDNS
	TypeAPL        DNSType = 42
	TypeDS         DNSType = 43
	TypeSSHFP      DNSType = 44
	TypeIPSECKEY   DNSType = 45
	TypeRRSIG      DNSType = 46
	TypeNSEC       DNSType = 47
	TypeDNSKEY     DNSType = 48
	TypeDHCID      DNSType = 49
	TypeNSEC3      DNSType = 50
	TypeNSEC3PARAM DNSType = 51
	TypeTLSA       DNSType = 52
	TypeSMIMEA     DNSType = 53
	TypeHIP        DNSType = 55
	TypeNINFO      DNSType = 56
	TypeRKEY       DNSType = 57
	TypeTALINK     DNSType = 58
	TypeCDS        DNSType = 59
	TypeCDNSKEY    DNSType = 60
	TypeOPENPGPKEY DNSType = 61
	TypeCSYNC      DNSType = 62
	TypeZONEMD     DNSType = 63
	TypeSVCB       DNSType = 64
	TypeHTTPS      DNSType = 65
	TypeSPF        DNSType = 99
	TypeUINFO      DNSType = 100
	TypeUID        DNSType = 101
	TypeGID        DNSType = 102
	TypeUNSPEC     DNSType = 103
	TypeNID        DNSType = 104
	TypeL32        DNSType = 105
	TypeL64        DNSType = 106
	TypeLP         DNSType = 107
	TypeEUI48      DNSType = 108
	TypeEUI64      DNSType = 109
	TypeURI        DNSType = 256
	TypeCAA        DNSType = 257
	TypeAVC        DNSType = 258
	TypeAMTRELAY   DNSType = 260

	TypeTKEY DNSType = 249
	TypeTSIG DNSType = 250

	// valid Question.Qtype only
	TypeIXFR  DNSType = 251
	TypeAXFR  DNSType = 252
	TypeMAILB DNSType = 253
	TypeMAILA DNSType = 254
	TypeANY   DNSType = 255

	TypeTA       DNSType = 32768
	TypeDLV      DNSType = 32769
	TypeReserved DNSType = 65535
)

type DNSQuestion struct {
	Name string  `json:"name"`
	Type DNSType `json:"type"`
}

type DNSAnswer struct {
	Name string  `json:"name"`
	Type DNSType `json:"type"`
	Ttl  uint32  `json:"TTL"`
	Data string  `json:"data"`
}

// Ref: https://www.iana.org/assignments/dns-parameters/dns-parameters.xhtml#dns-parameters-6
type DNSResponse struct {
	Status     uint16
	TC         bool
	RD         bool
	RA         bool
	AD         bool
	CD         bool
	Question   []DNSQuestion `json:",omitempty"`
	Answer     []DNSAnswer   `json:",omitempty"`
	Authority  []DNSAnswer   `json:",omitempty"`
	Additional []DNSAnswer   `json:",omitempty"`
}

type DNSParams struct {
	Name string   `url:"name"`
	Type *DNSType `url:"type,omitempty"`
	Do   *bool    `url:"do,omitempty"`
	Cd   *bool    `url:"cd,omitempty"`
}

// Performs DNS lookup via HTTPS, in case firewall blocks native netgo resolver.
// Ref: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json
func (c *CloudflareAPI) DNSQuery(ctx context.Context, params DNSParams) (DNSResponse, error) {
	values, err := query.Values(params)
	if err != nil {
		return DNSResponse{}, errors.Errorf("failed to encode query params: %w", err)
	}
	resp, err := c.Send(ctx, http.MethodGet, "/dns-query?"+values.Encode(), nil)
	if err != nil {
		return DNSResponse{}, err
	}
	return fetcher.ParseJSON[DNSResponse](resp.Body)
}
