// HeadSwift.Swift - HP64.js Swift frontend bridge
// Compiled to WASM via Swiftinbrowser; exposes a fast pre-parse pass
// that runs ahead of the JS tokenizer to strip TS-only regions.

import Foundation

@_cdecl("hp64_head_swift_version")
public func version() -> UnsafePointer<CChar> {
    return strdup("HP64.js Swift head 1.0")
}

/// Scans source and returns a byte mask: 1 = keep, 0 = TypeScript-only
/// region to drop (interface/type/enum/declare blocks). Runs in WASM
/// memory so the JS side can slice without re-scanning.
@_cdecl("hp64_mask_ts_regions")
public func maskTSRegions(_ src: UnsafePointer<CChar>, _ len: Int32) -> UnsafeMutablePointer<UInt8> {
    let n = Int(len)
    let mask = UnsafeMutablePointer<UInt8>.allocate(capacity: n)
    mask.initialize(repeating: 1, count: n)
    var i = 0
    while i < n {
        if matchesKeyword(src, n, i, "interface") || matchesKeyword(src, n, i, "declare") {
            // blank until matching closing brace at depth 0
            var depth = 0, j = i, seen = false
            while j < n {
                let c = src[j]
                if c == UInt8(ascii: "{") { depth += 1; seen = true }
                else if c == UInt8(ascii: "}") {
                    depth -= 1
                    if seen && depth == 0 { break }
                }
                j += 1
            }
            for k in i...min(j, n - 1) { mask[k] = 0 }
            i = j + 1
            continue
        }
        i += 1
    }
    return mask
}

@inline(__always)
private func matchesKeyword(_ src: UnsafePointer<CChar>, _ n: Int, _ at: Int, _ kw: String) -> Bool {
    let bytes = Array(kw.utf8)
    guard at + bytes.count <= n else { return false }
    for (k, b) in bytes.enumerated() where UInt8(src[at + k]) != b { return false }
    let before = at == 0 ? UInt8(ascii: " ") : UInt8(src[at - 1])
    let afterIdx = at + bytes.count
    let after = afterIdx >= n ? UInt8(ascii: " ") : UInt8(src[afterIdx])
    return !isIdent(before) && !isIdent(after)
}

@inline(__always)
private func isIdent(_ c: UInt8) -> Bool {
    return (c >= UInt8(ascii: "a") && c <= UInt8(ascii: "z")) ||
           (c >= UInt8(ascii: "A") && c <= UInt8(ascii: "Z")) ||
           (c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9")) ||
           c == UInt8(ascii: "_") || c == UInt8(ascii: "$")
}
