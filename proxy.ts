/**
 * OpenAI 兼容的二次代理核心逻辑
 * - 路由匹配、请求转发（OpenAI SDK）、响应转换（流式 + 非流式）
 * - API Key 全部来自原始请求的 Authorization header，代理不存储任何 key
 */

import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionChunk } from "openai/resources";

/** 路由配置 */
export interface RouteConfig {
  /** 请求路径前缀，用于匹配 */
  prefix: string;
  /** 上游 baseUrl */
  target: string;
  /** 转发请求时附加的自定义请求头 */
  headers: Record<string, string>;
  /** 非流式：转换 ChatCompletion 对象 */
  transformCompletion?: (completion: ChatCompletion) => ChatCompletion;
  /** 流式：转换每个 ChatCompletionChunk 对象 */
  transformChunk?: (chunk: ChatCompletionChunk) => ChatCompletionChunk;
}

// ─── runanytime 转换器 ───────────────────────────────────
// runanytime 返回接近 OpenAI 格式，但带有 reasoning_content / matched_stop /
// logprobs 等非标准字段。转换器重建纯净的 OpenAI 对象，去除这些字段。

export const runanytimeTransformChunk = (
  chunk: ChatCompletionChunk
): ChatCompletionChunk => {
  const result: ChatCompletionChunk = {
    id: chunk.id,
    object: "chat.completion.chunk",
    created: chunk.created,
    model: chunk.model,
    choices: chunk.choices.map((choice) => {
      const delta: ChatCompletionChunk.Choice.Delta = {};
      if (choice.delta.role != null) delta.role = choice.delta.role;
      if (choice.delta.content != null) delta.content = choice.delta.content;
      if (choice.delta.tool_calls != null)
        delta.tool_calls = choice.delta.tool_calls;
      return {
        index: choice.index,
        delta,
        finish_reason: choice.finish_reason,
        logprobs: null,
      };
    }),
  };

  if (chunk.usage != null) {
    result.usage = {
      prompt_tokens: chunk.usage.prompt_tokens,
      completion_tokens: chunk.usage.completion_tokens,
      total_tokens: chunk.usage.total_tokens,
    };
  }

  return result;
};

export const runanytimeTransformCompletion = (
  completion: ChatCompletion
): ChatCompletion => {
  return {
    id: completion.id,
    object: "chat.completion",
    created: completion.created,
    model: completion.model,
    choices: completion.choices.map((choice) => ({
      index: choice.index,
      finish_reason: choice.finish_reason,
      message: {
        role: "assistant",
        content: choice.message.content,
        refusal: choice.message.refusal ?? null,
      },
      logprobs: null,
    })),
    usage: completion.usage
      ? {
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
          total_tokens: completion.usage.total_tokens,
        }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
};

// ─── 路由配置表 ───────────────────────────────────────────

export const ROUTES: RouteConfig[] = [
  {
    prefix: "/runanytime",
    target: "https://runanytime.hxi.me/v1",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    },
    transformChunk: runanytimeTransformChunk,
    transformCompletion: runanytimeTransformCompletion,
  },
  {
    prefix: "/example-nonstandard",
    target: "https://example.com/api",
    headers: {
      "User-Agent": "BunProxy/1.0",
    },
  },
];

// ─── 核心函数 ─────────────────────────────────────────────

/** 根据 pathname 前缀匹配路由 */
export function findRoute(pathname: string): RouteConfig | undefined {
  return ROUTES.find((r) => pathname.startsWith(r.prefix));
}

/** 使用 OpenAI SDK 向上游发起请求，支持流式和非流式两种模式 */
export async function proxyRequest(
  req: Request,
  route: RouteConfig
): Promise<Response> {
  const authHeader = req.headers.get("authorization") ?? "";
  const apiKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  const client = new OpenAI({
    baseURL: route.target,
    apiKey,
    defaultHeaders: route.headers,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params = (await req.json()) as Record<string, any>;
  const isStream = params.stream === true;

  if (isStream) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await (client.chat.completions.create as any)({
      ...params,
      stream: true,
    }) as AsyncIterable<ChatCompletionChunk>;

    const encoder = new TextEncoder();

    // 用 TransformStream + 外部 writer 驱动 SDK stream，避免 Bun 中
    // ReadableStream.start 里嵌套 for await 导致连接被提前关闭（curl 18）
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    ;(async () => {
      try {
        for await (const chunk of stream) {
          const out = route.transformChunk ? route.transformChunk(chunk) : chunk;
          await writer.write(encoder.encode(`data: ${JSON.stringify(out)}\n\n`));
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        await writer.close();
      } catch (err) {
        console.error("SSE stream error:", err);
        writer.abort(err as Error).catch(() => {});
      }
    })();

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completion = await (client.chat.completions.create as any)({
      ...params,
      stream: false,
    }) as ChatCompletion;

    const out = route.transformCompletion
      ? route.transformCompletion(completion)
      : completion;
    return Response.json(out);
  }
}
