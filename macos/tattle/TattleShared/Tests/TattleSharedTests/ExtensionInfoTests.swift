import Foundation
import Testing

@testable import TattleShared

struct ExtensionInfoTests {
    @Test func readsIdentifiersFromInfoDictionary() throws {
        let info = try ExtensionInfo(infoDictionary: [
            "CFBundleIdentifier": "com.example.Tattle.FilterExtension",
            "NetworkExtension": ["NEMachServiceName": "group.com.example.Tattle.xpc"],
        ])
        #expect(info.bundleIdentifier == "com.example.Tattle.FilterExtension")
        #expect(info.machServiceName == "group.com.example.Tattle.xpc")
    }

    @Test func rejectsMissingBundleIdentifier() {
        #expect(throws: ExtensionInfo.ParseError.missingBundleIdentifier) {
            try ExtensionInfo(infoDictionary: ["NetworkExtension": ["NEMachServiceName": "x"]])
        }
    }

    @Test func rejectsMissingOrEmptyMachServiceName() {
        #expect(throws: ExtensionInfo.ParseError.missingMachServiceName) {
            try ExtensionInfo(infoDictionary: ["CFBundleIdentifier": "a"])
        }
        #expect(throws: ExtensionInfo.ParseError.missingMachServiceName) {
            try ExtensionInfo(infoDictionary: ["CFBundleIdentifier": "a", "NetworkExtension": ["NEMachServiceName": ""]])
        }
    }

    @Test func findsExtensionEmbeddedInAppBundle() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appending(path: "Tattle.app")
        let contents = app.appending(path: "Contents/Library/SystemExtensions/x.systemextension/Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "CFBundleIdentifier": "x",
            "CFBundlePackageType": "SYSX",
            "NetworkExtension": ["NEMachServiceName": "group.x.xpc"],
        ]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: contents.appending(path: "Info.plist"))

        let bundle = try #require(Bundle(url: app))
        #expect(ExtensionInfo.embedded(in: bundle) == ExtensionInfo(bundleIdentifier: "x", machServiceName: "group.x.xpc"))
    }

    @Test func returnsNilWithoutEmbeddedExtension() throws {
        let app = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).app")
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: app) }
        let bundle = try #require(Bundle(url: app))
        #expect(ExtensionInfo.embedded(in: bundle) == nil)
    }
}
