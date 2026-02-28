# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

openclaw-proxy is a lightweight HTTP reverse proxy built with Bun. It routes incoming requests by URL prefix to upstream targets, forwarding headers and request bodies. The entire server is a single file (`index.ts`).

## Commands

- `bun install` — install dependencies
- `bun run dev` — 本地开发，`--watch` 模式（文件变动自动重启）
- `bun run start` — 生产启动（无 watch）
- `bun test` — run tests

### 服务器后台运行（tmux）

```bash
bun run bg      # 后台启动，新建 tmux session "proxy"
bun run attach  # 回来查看日志
bun run stop    # 停止服务
```

## Tech Stack

- **Runtime**: Bun (not Node.js). Use Bun APIs and tooling exclusively.
- **Language**: TypeScript with strict mode enabled
- **Server**: `Bun.serve()` — do not use Express or other HTTP frameworks.
- Bun auto-loads `.env` files — do not use dotenv.

## Architecture

The proxy is configured via the `ROUTES` array in `proxy.ts`. Each route has:
- `prefix` — URL path prefix to match (e.g. `/runanytime`)
- `target` — upstream base URL to forward to
- `headers` — custom headers to add to proxied requests
- `transformChunk` — (optional) clean/transform each SSE chunk (`ChatCompletionChunk`)
- `transformCompletion` — (optional) clean/transform non-streaming response (`ChatCompletion`)

Request flow: incoming request → `findRoute()` matches by prefix → `proxyRequest()` extracts API key from `Authorization` header → OpenAI SDK forwards to upstream → optional transform → response returned to client.

**Streaming**: SDK stream iterated in an async IIFE writing to a `TransformStream` writer (avoids Bun bug where `for await` inside `ReadableStream.start` drops all chunks after the first).

**Adding a new upstream**: add an entry to `ROUTES` in `proxy.ts` with optional `transformChunk`/`transformCompletion` to strip non-standard fields. See `runanytimeTransformChunk` as reference.
