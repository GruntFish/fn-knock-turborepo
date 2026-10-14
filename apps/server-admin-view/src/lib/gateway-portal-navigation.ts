import type { GatewayPortalConfig } from "@/types";

// Keep these rules aligned with Go gateway portal_navigation.go: smart mode
// overrides the manual choice, and an unknown client always uses the gateway.
export const usesGatewayPortalLanNavigation = (
  portal: Partial<GatewayPortalConfig> | null | undefined,
  clientIsLan?: boolean | null,
): boolean =>
  portal?.smart_lan_detection === true
    ? clientIsLan === true
    : portal?.navigation_mode === "lan";

const isUsableIPv4Target = (octets: number[]): boolean =>
  octets[0] !== 127 &&
  !octets.every((octet) => octet === 0) &&
  !(octets[0] === 169 && octets[1] === 254) &&
  !(octets[0]! >= 224 && octets[0]! <= 239);

// A proxy target is opened by the visitor's browser, so loopback, local-only
// address scopes and non-HTTP targets must fall back to the gateway link.
export const resolveGatewayPortalTargetHref = (target: unknown): string => {
  if (typeof target !== "string") return "";
  const value = target.trim();
  if (/[\\\s\p{Cc}]/u.test(value)) return "";
  const authority = /^https?:\/\/([^/?#]+)/iu.exec(value)?.[1];
  if (!authority || authority.includes("@") || authority.includes("%"))
    return "";
  try {
    const url = new URL(value);
    if (url.port === "0") return "";
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (host === "localhost" || host.endsWith(".localhost")) return "";

    if (host.startsWith("[")) {
      // WHATWG URL has already validated and compressed this IPv6 literal.
      const address = host.slice(1, -1);
      const firstSegment = Number.parseInt(address.split(":")[0] || "0", 16);
      if (
        address === "::" ||
        address === "::1" ||
        (firstSegment & 0xffc0) === 0xfe80 ||
        (firstSegment & 0xff00) === 0xff00
      )
        return "";
      const mapped = /^::ffff:([a-f\d]+):([a-f\d]+)$/u.exec(address);
      if (mapped) {
        const high = Number.parseInt(mapped[1]!, 16);
        const low = Number.parseInt(mapped[2]!, 16);
        if (!isUsableIPv4Target([high >> 8, high & 255, low >> 8, low & 255]))
          return "";
      }
    } else if (/^\d+\.\d+\.\d+\.\d+$/u.test(host)) {
      const originalHost = authority
        .split(":")[0]!
        .toLowerCase()
        .replace(/\.$/u, "");
      // Reject shortened, hexadecimal and octal IPv4 spellings, like Go does.
      if (
        originalHost !== host ||
        !isUsableIPv4Target(host.split(".").map(Number))
      )
        return "";
    } else if (
      host.length > 253 ||
      !host.split(".").every((label) => /^[a-z\d_-]{1,63}$/u.test(label))
    )
      return "";
    return url.href;
  } catch {
    return "";
  }
};
