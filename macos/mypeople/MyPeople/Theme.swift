import AppKit
import MyPeopleKit
import SwiftUI

extension Color {
    fileprivate static func hex(_ value: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }

    static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            hex(appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light)
        })
    }
}

/// Quiet teal-grey chrome, the same tokens as the Android app. Colour is spent on people.
enum Kin {
    static let primary = Color.adaptive(0x036B5C, 0x84D6C3)
    static let onPrimary = Color.adaptive(0xFFFFFF, 0x00382F)
    static let secondary = Color.adaptive(0x4A635D, 0xB1CCC4)
    static let secondaryContainer = Color.adaptive(0xCDE8E0, 0x334B46)
    static let onSecondaryContainer = Color.adaptive(0x334B46, 0xCDE8E0)
    static let tertiary = Color.adaptive(0x436278, 0xABCAE4)
    static let error = Color.adaptive(0xBA1A1A, 0xFFB4AB)
    static let errorContainer = Color.adaptive(0xFFDAD6, 0x93000A)
    static let onErrorContainer = Color.adaptive(0x93000A, 0xFFDAD6)
    static let surface = Color.adaptive(0xF5FBF7, 0x0E1513)
    static let surfaceLow = Color.adaptive(0xEFF5F2, 0x171D1B)
    static let surfaceContainer = Color.adaptive(0xE9EFEC, 0x1B211F)
    static let onSurfaceVariant = Color.adaptive(0x3F4946, 0xBEC9C5)
    static let outlineVariant = Color.adaptive(0xBEC9C5, 0x3F4946)

    private static let wght: Int = 0x77676874, opsz: Int = 0x6F70737A, wdth: Int = 0x77647468

    /// Bricolage Grotesque, for names and headlines only. It's a variable font whose default
    /// instance is its heaviest, so the weight and optical size are set explicitly.
    static func display(_ size: CGFloat, weight: CGFloat = 600) -> Font {
        guard let base = NSFont(name: "BricolageGrotesque-96ptExtraBold", size: size) else {
            return .system(size: size, weight: .semibold)
        }
        let variation: [Int: CGFloat] = [wght: weight, opsz: min(max(size, 12), 96), wdth: 100]
        let descriptor = base.fontDescriptor.addingAttributes([NSFontDescriptor.AttributeName(kCTFontVariationAttribute as String): variation])
        return Font(NSFont(descriptor: descriptor, size: size) ?? base)
    }
}

struct PersonPalette: Equatable {
    var accent: Color
    var onAccent: Color
    var container: Color
    var onContainer: Color
    var wash: Color

    private static func make(_ l: (UInt32, UInt32, UInt32, UInt32, UInt32), _ d: (UInt32, UInt32, UInt32, UInt32, UInt32)) -> PersonPalette {
        PersonPalette(accent: .adaptive(l.0, d.0), onAccent: .adaptive(l.1, d.1), container: .adaptive(l.2, d.2), onContainer: .adaptive(l.3, d.3), wash: .adaptive(l.4, d.4))
    }

    /// The same order as Android, so someone keeps their colours on both. Never reorder.
    private static let all: [PersonPalette] = [
        make((0x904B3B, 0xFFFFFF, 0xFFDAD2, 0x733426, 0xFFF0ED), (0xFFB4A3, 0x561F12, 0x733426, 0xFFDAD2, 0x231917)),
        make((0x7D570E, 0xFFFFFF, 0xFFDEAD, 0x604100, 0xFEF2E5), (0xF1BE6D, 0x432C00, 0x604100, 0xFFDEAD, 0x201B13)),
        make((0x48672F, 0xFFFFFF, 0xC8EEA7, 0x314E19, 0xF3F5EA), (0xADD28E, 0x1B3704, 0x314E19, 0xC8EEA7, 0x1A1D16)),
        make((0x30628C, 0xFFFFFF, 0xCFE5FF, 0x104A73, 0xF1F3F9), (0x9CCBFB, 0x003354, 0x104A73, 0xCFE5FF, 0x181C20)),
        make((0x765085, 0xFFFFFF, 0xF7D8FF, 0x5C386B, 0xFBF1F8), (0xE4B7F3, 0x442253, 0x5C386B, 0xF7D8FF, 0x1E1A1F)),
        make((0x8C4A5E, 0xFFFFFF, 0xFFD9E1, 0x703346, 0xFFF0F2), (0xFFB1C5, 0x551D30, 0x703346, 0xFFD9E1, 0x22191B)),
    ]

    static func of(_ seed: String) -> PersonPalette { all[paletteIndex(seed, count: all.count)] }
}
