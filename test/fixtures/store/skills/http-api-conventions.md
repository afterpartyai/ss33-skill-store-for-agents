---
name: http-api-conventions
description: House rules for HTTP API endpoints in our TypeScript services. Use when adding or changing a route, its validation, its error responses or its pagination.
---

# HTTP API endpoint conventions

## Errors

1. Every error response uses `Content-Type: application/problem+json` with a body `{ type, title, status, detail }`.
2. `type` is a URL under `https://errors.acme.dev/`, named after the error, e.g. `https://errors.acme.dev/order-not-found`.
3. Use the `problem(res, status, slug, title, detail)` helper pattern: one small function in `src/http/problem.ts`, used by every route.

## Request IDs

4. Every response, success or error, sets the `X-Request-Id` header. Echo the incoming `x-request-id` if present, otherwise generate one with `crypto.randomUUID()`.

## Validation

5. Validate params and query strings with zod schemas declared in `src/schemas/<resource>.ts`. A validation failure is a 400 with type `https://errors.acme.dev/invalid-request`.

## Lists

6. List endpoints are cursor-paginated: query `?cursor=<opaque>&limit=<n>`, default limit 20, maximum 100. The response body is `{ data: [...], nextCursor: string | null }`. Never return a bare array.

## Layout

7. Routes live in `src/routes/<resource>.ts` and export `register(app: Express)`.
