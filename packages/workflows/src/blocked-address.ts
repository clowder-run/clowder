import { isIP } from "node:net";

// Private networks (RFC1918, IPv6 ULA) are allowed: Git servers and notification targets often live
// on the LAN. Loopback, link-local, cloud metadata, transition and special-use ranges never are.
export function isBlockedAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a = 0, b = 0, c = 0] = address.split(".").map(Number);

        return (
            address === "168.63.129.16" || // Azure platform/metadata services.
            a === 0 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113)
        );
    }

    if (isIP(address) !== 6) return true;
    const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);

    if (normalized === "fd00:ec2::254" || normalized === "fd20:ce::254") return true;

    if ((first & 0xfe00) === 0xfc00) return false;

    // Only global unicast; exclude mapped IPv4, NAT64, Teredo, 6to4 and documentation ranges.
    if (first < 0x2000 || first > 0x3fff || first === 0x2002 || first === 0x3fff) return true;
    const second = Number.parseInt(normalized.split(":")[1] || "0", 16);

    return first === 0x2001 && (second < 0x200 || second === 0xdb8);
}
