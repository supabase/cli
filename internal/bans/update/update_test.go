package update

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPrivateSubnet(t *testing.T) {
	err := validateIps([]string{"12.3.4.5", "10.0.0.0", "1.2.3.1"})
	assert.Nil(t, err)
}

func TestIpv4(t *testing.T) {
	err := validateIps([]string{"12.3.4.5", "2001:db8:abcd:0012::0", "1.2.3.1"})
	assert.ErrorContains(t, err, "only IPv4 supported at the moment: 2001:db8:abcd:12::")
}
