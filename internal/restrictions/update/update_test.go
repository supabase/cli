package update

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPrivateSubnet(t *testing.T) {
	err := validateCidrs([]string{"12.3.4.5/32", "10.0.0.0/8", "1.2.3.1/24"}, false)
	assert.ErrorContains(t, err, "private IP provided: 10.0.0.0/8")
	err = validateCidrs([]string{"10.0.0.0/8"}, true)
	assert.Nil(t, err, "should bypass private subnet checks")
}

func TestIpv4(t *testing.T) {
	err := validateCidrs([]string{"12.3.4.5/32", "2001:db8:abcd:0012::0/64", "1.2.3.1/24"}, false)
	assert.ErrorContains(t, err, "only IPv4 supported at the moment: 2001:db8:abcd:0012::0/64")
	err = validateCidrs([]string{"12.3.4.5/32", "2001:db8:abcd:0012::0/64", "1.2.3.1/24"}, true)
	assert.ErrorContains(t, err, "only IPv4 supported at the moment: 2001:db8:abcd:0012::0/64")
}

func TestInvalidSubnets(t *testing.T) {
	err := validateCidrs([]string{"12.3.4.5", "10.0.0.0/8", "1.2.3.1/24"}, false)
	assert.ErrorContains(t, err, "failed to parse IP: 12.3.4.5")
	err = validateCidrs([]string{"100/36"}, true)
	assert.ErrorContains(t, err, "failed to parse IP: 100/36")
}
