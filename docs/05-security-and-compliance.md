# 05 — Defensive Security, SSRF & Authentication

## Security-First Engineering

zapost is architected with a security-first mindset, adhering to OWASP Top 10 standards to protect customer brand assets, user data, and server infrastructure.

---

## 1. Server-Side Request Forgery (SSRF) Defense & DNS Pinning

External image URLs (from Unsplash, Pexels, DuckDuckGo, or user links) must be proxied by the server to satisfy browser CORS requirements for canvas rasterization. If unprotected, an image proxy becomes a gateway for internal network scanning and cloud metadata theft.

zapost implements strict SSRF defenses in `src/lib/http/ssrf.ts`:

### Defense Mechanics:
1. **Scheme Restriction:** Rejects anything other than explicit `http:` and `https:` protocols.
2. **Private Network Filtering:** Rejects `localhost`, single-label hostnames, IPv6 loopback (`::1`), link-local addresses, and private IPv4 ranges (RFC 1918):
   * `10.0.0.0/8`
   * `172.16.0.0/12`
   * `192.168.0.0/16`
   * `127.0.0.0/8`
   * `169.254.0.0/16` (Cloud metadata service like AWS/GCP `169.254.169.254`)
3. **DNS Pinning:** Resolves both IPv4 (`A`) and IPv6 (`AAAA`) addresses before issuing the HTTP request. If **any** returned IP resolves to a private subnet, the request is immediately blocked, preventing DNS Rebinding attacks.

---

## 2. Content Security Policy (CSP) & HTTP Headers

Configured directly in `next.config.ts`, security headers are enforced globally across every response:

```typescript
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://accounts.google.com",
      "style-src 'self' 'unsafe-inline' https://accounts.google.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self'",
      "connect-src 'self' https://accounts.google.com blob: https:",
      "frame-src 'self' https://accounts.google.com",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  }
];
```

---

## 3. Authentication & Credential Hardening

The application offers both social login (Google OAuth 2.0 with Google One Tap / FedCM) and email/password credentials:

* **Password Hashing:** Hashes passwords with `bcryptjs` using a cost factor of **12 rounds**, resisting GPU-accelerated dictionary attacks.
* **Password Complexity:** Enforced at schema level with a minimum of 8 characters containing letters and numbers.
* **Brute-Force Lockout:** Tracks consecutive failed attempts in the database. 5 consecutive failed logins trigger a mandatory 15-minute lock (`lockedUntil`).
* **Timing-Attack Resistance:** Generic error responses prevent account enumeration. When a nonexistent email attempts login, a dummy password verification is performed to equalize execution time.
* **Cryptographic Token Hashing:** Password reset tokens are generated using cryptographically strong random bytes (`crypto.randomBytes(32)`). Only the SHA-256 hash is persisted in `PasswordResetToken`, with a 1-hour TTL and single-use invalidation.

---

## 4. Immutable Audit Logs

To satisfy enterprise compliance requirements and audit administrative actions, all privileged interventions generate immutable records in the `AuditLog` table:

```prisma
model AuditLog {
  id         String      @id @default(cuid())
  adminId    String?
  action     AuditAction // USER_BLOCKED, PLAN_UPDATED, CREDIT_ADDED, USER_IMPERSONATED, etc.
  targetType String
  targetId   String
  metadata   Json?
  createdAt  DateTime    @default(now())

  @@index([adminId])
  @@index([targetId])
  @@index([action])
  @@map("audit_logs")
}
```

Audit records cannot be modified or deleted via API endpoints, ensuring traceability across support sessions, user impersonations, and subscription overrides.
