public enum Loopback {
    /// True for addresses in 127.0.0.0/8 and ::1, including IPv4-mapped IPv6 loopback.
    /// Host names (including "localhost") return false: the filter only trusts addresses.
    public static func contains(address: String) -> Bool {
        IPAddress(address)?.isLoopback ?? false
    }
}
