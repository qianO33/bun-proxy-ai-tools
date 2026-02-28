import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { ChatCompletion, ChatCompletionChunk } from "openai/resources";
import type { RouteConfig } from "./proxy.ts";

// ─── Mock openai SDK（必须在 import proxy.ts 之前） ─────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreate = mock(async (): Promise<any> => undefined);

mock.module("openai", () => ({
  default: class MockOpenAI {
    constructor(public config: unknown) {}
    chat = { completions: { create: mockCreate } };
  },
}));

// 动态 import，确保 mock 先注册
const {
  findRoute,
  proxyRequest,
  runanytimeTransformChunk,
  runanytimeTransformCompletion,
} = await import("./proxy.ts");

// ─── helpers ──────────────────────────────────────────────

/** 构造一个 async iterable，模拟 SDK 流式返回 */
function fakeStream<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          if (i < items.length) return { value: items[i++]!, done: false };
          return { value: undefined as unknown as T, done: true };
        },
      };
    },
  };
}

async function responseToSSELines(res: Response): Promise<string[]> {
  const text = await res.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// ─── findRoute ────────────────────────────────────────────

describe("findRoute", () => {
  test("匹配 /runanytime 前缀", () => {
    const route = findRoute("/runanytime/chat/completions");
    expect(route).toBeDefined();
    expect(route!.prefix).toBe("/runanytime");
    expect(route!.target).toBe("https://runanytime.hxi.me/v1");
  });

  test("匹配 /example-nonstandard 前缀", () => {
    const route = findRoute("/example-nonstandard/chat/completions");
    expect(route).toBeDefined();
    expect(route!.prefix).toBe("/example-nonstandard");
  });

  test("不匹配未知路径返回 undefined", () => {
    expect(findRoute("/unknown/path")).toBeUndefined();
    expect(findRoute("/")).toBeUndefined();
  });
});

// ─── runanytimeTransformChunk ─────────────────────────────
// 使用 runanytime 真实返回的数据结构测试

describe("runanytimeTransformChunk", () => {
  test("第一个 chunk：保留 role + content，去除 reasoning_content / matched_stop 等", () => {
    // runanytime 实际返回（含非标准字段）
    const input = {
      id: "2057d2ccd58c438894fd7865044569c8",
      object: "chat.completion.chunk",
      created: 1772279658,
      model: "deepseek-ai/deepseek-v3.2",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "",
            reasoning_content: null, // 非标准
            tool_calls: null,
          },
          logprobs: null,       // 非标准
          finish_reason: null,
          matched_stop: null,   // 非标准
        },
      ],
      usage: null,
    } as unknown as ChatCompletionChunk;

    const result = runanytimeTransformChunk(input);
    const delta = result.choices[0]!.delta;

    expect(result.id).toBe("2057d2ccd58c438894fd7865044569c8");
    expect(result.object).toBe("chat.completion.chunk");
    expect(delta.role).toBe("assistant");
    expect(delta.content).toBe("");

    // 非标准字段已清除
    expect(delta).not.toHaveProperty("reasoning_content");
    expect(delta).not.toHaveProperty("tool_calls");
    expect(result.choices[0]).not.toHaveProperty("matched_stop");

    // usage: null 不出现在结果中
    expect(result.usage).toBeUndefined();
  });

  test("内容 chunk：保留 content，去除 role: null", () => {
    const input = {
      id: "2057d2ccd58c438894fd7865044569c8",
      object: "chat.completion.chunk",
      created: 1772279658,
      model: "deepseek-ai/deepseek-v3.2",
      choices: [
        {
          index: 0,
          delta: { role: null, content: "我是 DeepSeek", reasoning_content: null, tool_calls: null },
          logprobs: null,
          finish_reason: null,
          matched_stop: null,
        },
      ],
      usage: null,
    } as unknown as ChatCompletionChunk;

    const result = runanytimeTransformChunk(input);
    const delta = result.choices[0]!.delta;

    expect(delta.content).toBe("我是 DeepSeek");
    expect(delta).not.toHaveProperty("role");
  });

  test("结束 chunk：finish_reason=stop，delta 为空对象", () => {
    const input = {
      id: "2057d2ccd58c438894fd7865044569c8",
      object: "chat.completion.chunk",
      created: 1772279674,
      model: "deepseek-ai/deepseek-v3.2",
      choices: [
        {
          index: 0,
          delta: { role: null, content: null, reasoning_content: null, tool_calls: null },
          logprobs: null,
          finish_reason: "stop",
          matched_stop: 1,
        },
      ],
      usage: null,
    } as unknown as ChatCompletionChunk;

    const result = runanytimeTransformChunk(input);
    const delta = result.choices[0]!.delta;

    expect(result.choices[0]!.finish_reason).toBe("stop");
    expect(delta).not.toHaveProperty("role");
    expect(delta).not.toHaveProperty("content");
  });

  test("usage chunk：choices 为空，清理非标准 usage 字段", () => {
    const input = {
      id: "2057d2ccd58c438894fd7865044569c8",
      object: "chat.completion.chunk",
      created: 1772279674,
      model: "deepseek-ai/deepseek-v3.2",
      choices: [],
      usage: {
        prompt_tokens: 12,
        total_tokens: 122,
        completion_tokens: 110,
        prompt_tokens_details: null,  // 非标准
        reasoning_tokens: 0,          // 非标准
      },
    } as unknown as ChatCompletionChunk;

    const result = runanytimeTransformChunk(input);
    const usage = result.usage!;

    expect(result.choices).toHaveLength(0);
    expect(usage.prompt_tokens).toBe(12);
    expect(usage.completion_tokens).toBe(110);
    expect(usage.total_tokens).toBe(122);
    expect(usage).not.toHaveProperty("prompt_tokens_details");
    expect(usage).not.toHaveProperty("reasoning_tokens");
  });
});

// ─── runanytimeTransformCompletion ────────────────────────

describe("runanytimeTransformCompletion", () => {
  test("清理非流式响应中的非标准字段", () => {
    const input = {
      id: "abc123",
      object: "chat.completion",
      created: 1772279674,
      model: "deepseek-ai/deepseek-v3.2",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "你好！",
            reasoning_content: null,  // 非标准
            tool_calls: null,
            refusal: null,
          },
          logprobs: null,
          finish_reason: "stop",
          matched_stop: 1,            // 非标准
        },
      ],
      usage: {
        prompt_tokens: 12,
        total_tokens: 122,
        completion_tokens: 110,
        prompt_tokens_details: null,  // 非标准
        reasoning_tokens: 0,          // 非标准
      },
    } as unknown as ChatCompletion;

    const result = runanytimeTransformCompletion(input);
    const msg = result.choices[0]!.message;
    const usage = result.usage!;

    expect(result.id).toBe("abc123");
    expect(result.object).toBe("chat.completion");
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("你好！");
    expect(msg).not.toHaveProperty("reasoning_content");
    expect(result.choices[0]).not.toHaveProperty("matched_stop");
    // logprobs: null 是 OpenAI 标准字段，保留
    expect(result.choices[0]!.logprobs).toBeNull();
    expect(usage.prompt_tokens).toBe(12);
    expect(usage).not.toHaveProperty("prompt_tokens_details");
    expect(usage).not.toHaveProperty("reasoning_tokens");
  });
});

// ─── proxyRequest ─────────────────────────────────────────

describe("proxyRequest", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  test("非流式：透传 Authorization 中的 apiKey 给 SDK，返回 JSON", async () => {
    const mockCompletion: ChatCompletion = {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1234567890,
      model: "deepseek-v3",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    mockCreate.mockResolvedValue(mockCompletion);

    const route: RouteConfig = {
      prefix: "/test",
      target: "https://upstream.example.com/v1",
      headers: { "User-Agent": "TestAgent" },
    };

    const req = new Request("http://localhost:8888/test/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-user-key-123",
      },
      body: JSON.stringify({ model: "deepseek-v3", messages: [], stream: false }),
    });

    const res = await proxyRequest(req, route);
    const json = (await res.json()) as ChatCompletion;

    expect(res.headers.get("content-type")).toContain("application/json");
    expect(json.id).toBe("chatcmpl-test");
    expect(json.choices[0]!.message.content).toBe("hello");
  });

  test("流式：返回 text/event-stream，chunks 包含 data: 行和 [DONE]", async () => {
    const chunk1: ChatCompletionChunk = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "deepseek-v3",
      choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null, logprobs: null }],
    };
    const chunk2: ChatCompletionChunk = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "deepseek-v3",
      choices: [{ index: 0, delta: { content: "!" }, finish_reason: "stop", logprobs: null }],
    };

    mockCreate.mockResolvedValue(fakeStream([chunk1, chunk2]));

    const route: RouteConfig = {
      prefix: "/test",
      target: "https://upstream.example.com/v1",
      headers: {},
    };

    const req = new Request("http://localhost:8888/test/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v3", messages: [], stream: true }),
    });

    const res = await proxyRequest(req, route);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const lines = await responseToSSELines(res);
    expect(lines.some((l) => l.startsWith("data: {"))).toBe(true);
    expect(lines).toContain("data: [DONE]");
  });

  test("流式 + transformChunk：输出的是转换后的 chunk", async () => {
    const rawChunk = {
      id: "2057d2ccd58c438894fd7865044569c8",
      object: "chat.completion.chunk",
      created: 1772279658,
      model: "deepseek-ai/deepseek-v3.2",
      choices: [
        {
          index: 0,
          delta: { role: null, content: "你好", reasoning_content: null, tool_calls: null },
          logprobs: null,
          finish_reason: null,
          matched_stop: null,
        },
      ],
      usage: null,
    } as unknown as ChatCompletionChunk;

    mockCreate.mockResolvedValue(fakeStream([rawChunk]));

    const route: RouteConfig = {
      prefix: "/test",
      target: "https://upstream.example.com/v1",
      headers: {},
      transformChunk: runanytimeTransformChunk,
    };

    const req = new Request("http://localhost:8888/test/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v3", messages: [], stream: true }),
    });

    const res = await proxyRequest(req, route);
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data: {"));
    const parsed = JSON.parse(dataLine!.slice(6)) as Record<string, unknown>;
    const delta = (parsed.choices as Array<Record<string, unknown>>)[0]!
      .delta as Record<string, unknown>;

    expect(delta.content).toBe("你好");
    expect(delta).not.toHaveProperty("reasoning_content");
    expect(delta).not.toHaveProperty("role"); // null 已被清除
  });
});
