# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

openclaw-proxy is a lightweight HTTP reverse proxy built with Bun. It routes incoming requests by URL prefix to upstream targets, forwarding headers and request bodies. The entire server is a single file (`index.ts`).

## Commands

- `bun install` — install dependencies
- `bun run start` — run the server with `--watch` (auto-restart on changes)
- `bun run index.ts` — run the server directly
- `bun test` — run tests (none exist yet)

## Tech Stack

- **Runtime**: Bun (not Node.js). Use Bun APIs and tooling exclusively.
- **Language**: TypeScript with strict mode enabled
- **Server**: `Bun.serve()` — do not use Express or other HTTP frameworks.
- Bun auto-loads `.env` files — do not use dotenv.

## Architecture

The proxy is configured via the `ROUTES` array in `index.ts`. Each route has:
- `prefix` — URL path prefix to match (e.g. `/runanytime`)
- `target` — upstream base URL to forward to
- `headers` — custom headers to add to proxied requests

Request flow: incoming request → `findRoute()` matches by prefix → `proxyFetch()` strips the prefix, rewrites Host header, merges custom headers, forwards the request → upstream response is returned as-is.

TLS support is commented out but available (uncomment port 443 + tls config with cert/key paths).
