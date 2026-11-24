import Testing

@testable import TattleShared

struct LoopbackTests {
    @Test(arguments: ["127.0.0.1", "127.255.255.254", "::1", "::ffff:127.0.0.1"])
    func loopbackAddresses(address: String) {
        #expect(Loopback.contains(address: address))
    }

    @Test(arguments: ["128.0.0.1", "10.0.0.1", "::2", "fe80::1", "::ffff:8.8.8.8", "localhost", "", "not an address"])
    func otherAddresses(address: String) {
        #expect(!Loopback.contains(address: address))
    }
}
