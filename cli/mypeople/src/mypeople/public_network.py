"""Shared public-address validation for direct requests and container egress."""

import ipaddress
import socket


class UnsafeURL(ValueError):
    pass


def public_address(host: str) -> str:
    addresses = list(dict.fromkeys(r[4][0] for r in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)))
    if not addresses:
        raise UnsafeURL("No public address")
    for value in addresses:
        address = ipaddress.ip_address(value)
        if not address.is_global or address.is_multicast:
            raise UnsafeURL("Non-public network address")
    return addresses[0]
