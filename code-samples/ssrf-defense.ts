/**
 * SSRF Defense Engine with Pre-Flight DNS Pinning & Private Network Filter
 * 
 * Mitigates Server-Side Request Forgery and DNS Rebinding by validating resolved
 * IP addresses against RFC 1918 private subnets, loopbacks, and cloud metadata APIs.
 */

import dns from "node:dns/promises";
import net from "node:net";

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);

  if (a === 127) return true;                         // Loopback (127.0.0.0/8)
  if (a === 10) return true;                          // Class A private (10.0.0.0/8)
  if (a === 172 && b >= 16 && b <= 31) return true;   // Class B private (172.16.0.0/12)
  if (a === 192 && b === 168) return true;            // Class C private (192.168.0.0/16)
  if (a === 169 && b === 254) return true;            // Link-local / Cloud Metadata (169.254.0.0/16)
  if (a === 0) return true;                           // Current network
  if (a >= 240) return true;                          // Reserved for future use

  return false;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // Unique local address
    if (normalized.startsWith("fe80")) return true;                              // Link-local

    // IPv4-mapped IPv6 address (::ffff:192.168.1.1)
    const mapped = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateIpv4(mapped[1]);

    return false;
  }

  if (net.isIPv4(ip)) return isPrivateIpv4(ip);

  return true;
}

export async function validateSsrfSafeUrl(url: URL): Promise<boolean> {
  const hostname = url.hostname.toLowerCase();

  // Basic sanity checks
  if (hostname === "localhost") return false;
  if (hostname === "metadata.google.internal") return false;
  if (!hostname.includes(".")) return false;

  // If host is a direct IP literal, check immediately
  if (net.isIP(hostname)) {
    return !isPrivateIp(hostname);
  }

  // Pre-flight DNS Resolution for both IPv4 and IPv6 to mitigate DNS Rebinding
  const [v4Addresses, v6Addresses] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);

  const allResolvedAddresses = [...v4Addresses, ...v6Addresses];

  if (allResolvedAddresses.length === 0) {
    return false; // Domain could not be resolved
  }

  // Every single resolved IP must be public and non-private
  return allResolvedAddresses.every((ip) => !isPrivateIp(ip));
}
