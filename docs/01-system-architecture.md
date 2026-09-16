# 01 — System Architecture & Multi-Tenancy

## Architectural Paradigm

zapost is architected as a **modular monolith** optimized for deployment as a set of coordinated container services. It leverages **Next.js 16 App Router** with React Server Components (RSC) for presentation and API route handlers for RESTful operations, paired with a dedicated worker process executing asynchronously via **BullMQ and Redis**.

```
                           ┌─────────────────────────────────┐
                           │          Nginx Ingress          │
                           └────────────────┬────────────────┘
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    ▼                                               ▼
     ┌─────────────────────────────┐                 ┌─────────────────────────────┐
     │      Next.js App Server     │                 │   Dedicated Worker Process  │
     │   (Port 3000 / Standalone)  │                 │    (Node 22 + tsx runtime)  │
     └──────────────┬──────────────┘                 └──────────────┬──────────────┘
                    │                                               │
                    │         ┌───────────────────────────┐         │
                    ├────────►│     PostgreSQL 16 DB      │◄────────┤
                    │         └───────────────────────────┘         │
                    │                                               │
                    │         ┌───────────────────────────┐         │
                    └────────►│       Redis 7 Cache       │◄────────┘
                              │   (Queues, Locks, Limits) │
                              └───────────────────────────┘
```

---

## 1. Multi-Tenant Isolation Model

Tenant isolation is enforced strictly at the logical database level. The application treats each user as belonging to an isolated `Tenant` context.

### Database Schema Scoping
Every core domain entity in PostgreSQL includes a non-nullable foreign key referencing the `Tenant` table:

```prisma
model Post {
  id             String        @id @default(cuid())
  tenantId       String
  userId         String
  name           String
  canvasSnapshot Json
  format         String        @default("feed")
  
  tenant         Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user           User          @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([tenantId, updatedAt])
  @@map("posts")
}
```

### Invariant Rules
1. **Server-Derived Context:** The `tenantId` is never trusted from request URLs, query parameters, or request payloads. It is extracted securely from the verified server-side session token via `session.user.tenantId`.
2. **Query Enforcement:** All queries must include the tenant identifier:
   ```typescript
   // Correct pattern:
   const post = await prisma.post.findFirst({
     where: { id: postId, tenantId: session.user.tenantId }
   });
   ```
3. **Cascading Teardown:** A deletion at the `Tenant` root safely purges posts, uploaded assets, subscription ties, and audit records via foreign-key cascade rules configured in Prisma.

---

## 2. API Pipeline Architecture

To prevent authorization bypass, data poisoning, and CSRF vulnerabilities, all mutating API route handlers (`POST`, `PATCH`, `DELETE`) follow a mandatory 4-tier pipeline:

```
[Incoming HTTP Request]
          │
          ▼
   1. CSRF Verification  ──► Fails? ──► HTTP 403 Forbidden (Origin mismatch)
          │
          ▼
   2. Session Auth       ──► Missing? ─► HTTP 401 Unauthorized (No valid tenant session)
          │
          ▼
   3. Zod Validation     ──► Fails? ──► HTTP 400 Bad Request (Detailed error issues)
          │
          ▼
   4. Tenant-Scoped DB   ──► Executes query filtered by session.user.tenantId
```

---

## 3. Next.js Standalone Build Optimization

The project produces a standalone containerized artifact through `output: "standalone"` in `next.config.ts`.

* **Traced Dependencies:** Next.js automatically traces imports and bundles only the required `node_modules` into the `.next/standalone` folder.
* **Minimal Footprint:** The final production container image weighs under 150MB when packaged on Alpine Linux, excluding devDependencies and unused tooling.
* **Separation of Runtime Responsibilities:** The primary HTTP container runs `node server.js`, while the worker container shares the same base image but executes `src/workers/index.ts` via `tsx`.
