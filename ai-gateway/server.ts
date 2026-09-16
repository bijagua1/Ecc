import { serve } from "bun";

const PORT = 37778;

const providers = [
  {
    name: "groq",
    type: "openai",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY,
    model: "openai/gpt-oss-120b",
  },
  {
    name: "gemini",
    type: "gemini",
    key: process.env.GEMINI_API_KEY,
    model: "gemini-3.6-flash",
  },
  {
    name: "cerebras",
    type: "openai",
    url: "https://api.cerebras.ai/v1/chat/completions",
    key: process.env.CEREBRAS_API_KEY,
    model: "gpt-oss-120b",
  },
  {
    name: "huggingface",
    type: "openai",
    url: "https://router.huggingface.co/v1/chat/completions",
    key: process.env.HF_TOKEN,
    model: "openai/gpt-oss-120b:fastest",
  },
  {
    name: "openrouter",
    type: "openai",
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: process.env.OPENROUTER_API_KEY,
    model: "openrouter/free",
  },
  {
    name: "cohere",
    type: "openai",
    url: "https://api.cohere.ai/compatibility/v1/chat/completions",
    key: process.env.COHERE_API_KEY,
    model: "command-a-03-2025",
  },
  {
    name: "nvidia",
    type: "openai",
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    key: process.env.NVIDIA_API_KEY,
    model: "openai/gpt-oss-20b",
  },
  {
    name: "cloudflare",
    type: "openai",
    url: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
    key: process.env.CLOUDFLARE_API_TOKEN,
    model: "@cf/meta/llama-3.1-8b-instruct",
  },
];

const TIMEOUT_MS = 90000;
const RETRIES = 2;
const GROQ_MAX_TOKENS_LIMIT = 65536;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Gemini request/response translation ----------

function convertOpenAIMessagesToGemini(body: any) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let systemInstruction: any = null;
  const contents: any[] = [];

  for (const msg of messages) {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content ?? "");

    if (msg.role === "system") {
      systemInstruction = systemInstruction
        ? { parts: [...systemInstruction.parts, { text }] }
        : { parts: [{ text }] };
      continue;
    }

    const role = msg.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text }] });
  }

  const generationConfig: any = {
    // Kimi consumes only the final answer text, not reasoning traces.
    // Without this, the model can spend its entire output budget
    // "thinking" and return zero visible text on large requests.
    thinkingConfig: { thinkingBudget: 0 },
  };
  if (typeof body.max_tokens === "number") {
    generationConfig.maxOutputTokens = body.max_tokens;
  }
  if (typeof body.temperature === "number") {
    generationConfig.temperature = body.temperature;
  }
  if (typeof body.top_p === "number") {
    generationConfig.topP = body.top_p;
  }

  const geminiBody: any = { contents, generationConfig };
  if (systemInstruction) geminiBody.systemInstruction = systemInstruction;

  return geminiBody;
}

function convertGeminiJsonToOpenAI(geminiJson: any, modelName: string) {
  const candidate = geminiJson.candidates?.[0];
  const text =
    candidate?.content?.parts?.map((p: any) => p.text || "").join("") || "";
  const rawFinish = candidate?.finishReason;
  const finishReason = rawFinish === "STOP" ? "stop" : (rawFinish || "stop").toLowerCase();

  return {
    id: `gemini-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: geminiJson.usageMetadata?.promptTokenCount || 0,
      completion_tokens: geminiJson.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: geminiJson.usageMetadata?.totalTokenCount || 0,
    },
  };
}

function createOpenAIStreamFromGeminiSSE(
  geminiResponse: Response,
  modelName: string
) {
  const reader = geminiResponse.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let roleSent = false;

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();

      if (done) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const candidate = parsed.candidates?.[0];
          const text =
            candidate?.content?.parts
              ?.map((p: any) => p.text || "")
              .join("") || "";
          const rawFinish = candidate?.finishReason;

          if (text || rawFinish) {
            const delta: any = {};
            if (!roleSent) {
              delta.role = "assistant";
              roleSent = true;
            }
            if (text) delta.content = text;

            const chunk = {
              id: `gemini-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: rawFinish === "STOP" ? "stop" : null,
                },
              ],
            };

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
            );
          }
        } catch {
          // Incomplete/malformed fragment; ignore and continue buffering.
        }
      }
    },
  });
}

async function geminiProviderRequest(provider: any, body: any) {
  const isStream = Boolean(body.stream);
  const geminiBody = convertOpenAIMessagesToGemini(body);

  const url = isStream
    ? `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:streamGenerateContent?alt=sse`
    : `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent`;

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": provider.key,
        },
        body: JSON.stringify(geminiBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        console.log(
          `AI provider SUCCESS: ${provider.name} (${provider.model})`
        );

        if (isStream) {
          const stream = createOpenAIStreamFromGeminiSSE(
            response,
            provider.model
          );
          return {
            ok: true,
            response: {
              body: stream,
              status: 200,
              headers: new Headers({ "content-type": "text/event-stream" }),
            },
          };
        }

        const geminiJson = await response.json();
        const openaiJson = convertGeminiJsonToOpenAI(geminiJson, provider.model);
        return {
          ok: true,
          response: {
            body: JSON.stringify(openaiJson),
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
          },
        };
      }

      const errorText = await response.text();

      console.log(
        `AI provider FAILED: ${provider.name} HTTP ${response.status} ` +
        `(attempt ${attempt}/${RETRIES})`
      );
      console.log(`${provider.name} error: ${errorText.slice(0, 2000)}`);

      if (response.status === 429) {
        return {
          ok: false,
          error: `${provider.name}: HTTP 429 rate limited`,
        };
      }

      if (response.status >= 500 && attempt < RETRIES) {
        await sleep(1000 * attempt);
        continue;
      }

      return {
        ok: false,
        error: `${provider.name}: HTTP ${response.status} - ${errorText.slice(0, 500)}`,
      };
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);

      console.log(
        `AI provider ERROR: ${provider.name} ${message} (attempt ${attempt}/${RETRIES})`
      );

      if (attempt < RETRIES) {
        await sleep(1000 * attempt);
        continue;
      }

      return { ok: false, error: `${provider.name}: ${message}` };
    }
  }

  return { ok: false, error: `${provider.name}: exhausted retries` };
}

// ---------- Existing OpenAI-compatible passthrough ----------

async function providerRequest(provider: any, body: any) {
  if (provider.type === "gemini") {
    return geminiProviderRequest(provider, body);
  }

  const providerBody = { ...body };

  // Kimi may send OpenAI-compatible cache fields that Groq does not support.
  if (provider.name === "groq") {
    delete providerBody.prompt_cache_key;
    delete providerBody.prompt_cache_retention;

    if (
      typeof providerBody.max_tokens === "number" &&
      providerBody.max_tokens > GROQ_MAX_TOKENS_LIMIT
    ) {
      providerBody.max_tokens = GROQ_MAX_TOKENS_LIMIT;
    }
  }

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(provider.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.key}`,
        },
        body: JSON.stringify({
          ...providerBody,
          model: provider.model,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        console.log(
          `AI provider SUCCESS: ${provider.name} (${provider.model})`
        );

        return {
          ok: true,
          response,
        };
      }

      const errorText = await response.text();

      console.log(
        `AI provider FAILED: ${provider.name} HTTP ${response.status} ` +
        `(attempt ${attempt}/${RETRIES})`
      );

      console.log(
        `${provider.name} error: ${errorText.slice(0, 2000)}`
      );

      if (response.status === 429) {
        return {
          ok: false,
          error: `${provider.name}: HTTP 429 rate limited`,
        };
      }

      if (response.status >= 500 && attempt < RETRIES) {
        await sleep(1000 * attempt);
        continue;
      }

      return {
        ok: false,
        error: `${provider.name}: HTTP ${response.status} - ${errorText.slice(0, 500)}`,
      };
    } catch (error) {
      clearTimeout(timeout);

      const message =
        error instanceof Error ? error.message : String(error);

      console.log(
        `AI provider ERROR: ${provider.name} ${message} ` +
        `(attempt ${attempt}/${RETRIES})`
      );

      if (attempt < RETRIES) {
        await sleep(1000 * attempt);
        continue;
      }

      return {
        ok: false,
        error: `${provider.name}: ${message}`,
      };
    }
  }

  return {
    ok: false,
    error: `${provider.name}: exhausted retries`,
  };
}

async function chat(body: any) {
  let lastError = "No providers available";

  for (const provider of providers) {
    if (!provider.key) {
      console.log(`AI provider SKIPPED: ${provider.name} (no API key)`);
      continue;
    }

    console.log(
      `AI provider TRY: ${provider.name} (${provider.model})`
    );

    const result = await providerRequest(provider, body);

    if (result.ok) {
      return new Response(result.response.body, {
        status: result.response.status,
        headers: {
          "Content-Type":
            result.response.headers.get("content-type") ||
            "application/json",
        },
      });
    }

    lastError = result.error;
  }

  console.log(`ALL AI PROVIDERS FAILED: ${lastError}`);

  return Response.json(
    {
      error: {
        message: `All AI providers failed. Last error: ${lastError}`,
        type: "provider_error",
      },
    },
    { status: 503 }
  );
}

const server = serve({
  hostname: "127.0.0.1",
  port: PORT,

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        providers: providers.map((p) => ({
          name: p.name,
          configured: Boolean(p.key),
          model: p.model,
        })),
      });
    }

    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [
          {
            id: "ecc-auto",
            object: "model",
            owned_by: "ECC",
          },
        ],
      });
    }

    if (
      url.pathname === "/v1/chat/completions" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        console.log(
          `Incoming AI request: model=${body.model || "unknown"} ` +
          `stream=${Boolean(body.stream)} ` +
          `messages=${Array.isArray(body.messages) ? body.messages.length : 0}`
        );

        return await chat(body);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);

        console.log(`Gateway request error: ${message}`);

        return Response.json(
          {
            error: {
              message: `Invalid gateway request: ${message}`,
              type: "gateway_error",
            },
          },
          { status: 400 }
        );
      }
    }

    return new Response("ECC AI Gateway", { status: 200 });
  },
});

console.log(
  `ECC AI Gateway running on http://127.0.0.1:${PORT}`
);
