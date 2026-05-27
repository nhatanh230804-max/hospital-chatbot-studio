// =============================================================================
// src/anythingllm.js — AnythingLLM API client
// =============================================================================

export function anythingLLMConfig() {
  return {
    baseUrl: (process.env.ANYTHINGLLM_BASE_URL || "").replace(/\/$/, ""),
    apiKey: process.env.ANYTHINGLLM_API_KEY || "",
    workspaceSlug: process.env.ANYTHINGLLM_WORKSPACE_SLUG || "",
    mode: process.env.ANYTHINGLLM_MODE || "chat",
  };
}

export function isAnythingLLMConfigured() {
  const { baseUrl, apiKey, workspaceSlug } = anythingLLMConfig();
  return Boolean(
    baseUrl && apiKey && workspaceSlug && !apiKey.includes("replace_with"),
  );
}

export function getAnythingLLMText(data) {
  return (
    data?.textResponse ||
    data?.response ||
    data?.text ||
    data?.message ||
    data?.answer ||
    data?.output ||
    ""
  );
}

function extractStreamToken(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (data.type === "textResponseChunk") return String(data.textResponse || "");
  if (Array.isArray(data.choices)) {
    return String(
      data.choices[0]?.delta?.content ||
        data.choices[0]?.message?.content ||
        data.choices[0]?.text ||
        "",
    );
  }
  return String(
    data.token ||
      data.delta?.content ||
      data.message?.content ||
      data.content ||
      "",
  );
}

function extractFinalStreamText(data) {
  if (!data || typeof data !== "object") return "";
  if (data.type === "textResponse") return String(data.textResponse || "");
  return String(data.finalText || data.finalResponse || data.response || "");
}

async function readAnythingLLMStream(response, onToken) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("AnythingLLM stream khong co response body.");

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finalText = "";
  const raw = [];

  async function handleEvent(rawEvent) {
    const dataLines = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const dataText = (dataLines.length ? dataLines.join("\n") : rawEvent).trim();
    if (!dataText || dataText === "[DONE]") return;

    let data = dataText;
    try {
      data = JSON.parse(dataText);
    } catch {
      // Some providers stream raw text chunks instead of JSON events.
    }
    raw.push(data);

    if (data?.type === "abort") {
      throw new Error(data.error || "AnythingLLM stream bi huy.");
    }

    const token = extractStreamToken(data);
    if (token) {
      text += token;
      await onToken?.(token, data);
    }

    const complete = extractFinalStreamText(data);
    if (complete) finalText = complete;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const event of events) await handleEvent(event);
  }
  buffer += decoder.decode();
  if (buffer.trim()) await handleEvent(buffer);

  return { text: finalText || text, raw };
}

export async function callAnythingLLM(message, options = {}) {
  const { baseUrl, apiKey, workspaceSlug, mode } = anythingLLMConfig();
  if (!isAnythingLLMConfigured()) {
    throw new Error("AnythingLLM chưa được cấu hình trong .env");
  }

  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, {
    once: true,
  });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const useStream = Boolean(options.stream && options.onToken);
  let response;
  try {
    response = await fetch(
      `${baseUrl}/api/v1/workspace/${workspaceSlug}/${useStream ? "stream-chat" : "chat"}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          mode: options.mode || mode,
          sessionId: options.sessionId || `hospital-web-${Date.now()}`,
        }),
      },
    );
  } catch (error) {
    if (error.name === "AbortError") {
      if (externalSignal?.aborted) {
        throw new Error("AnythingLLM request da bi huy.");
      }
      throw new Error(`AnythingLLM phản hồi quá lâu (>${timeoutMs / 1000}s).`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }

  if (useStream) {
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(errorText || `AnythingLLM HTTP ${response.status}`);
    }
    const result = await readAnythingLLMStream(response, options.onToken);
    if (!result.text) throw new Error("AnythingLLM phan hoi rong.");
    return result;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data.error || data.message || `AnythingLLM HTTP ${response.status}`,
    );
  }
  const text = getAnythingLLMText(data);
  if (!text) throw new Error("AnythingLLM phản hồi rỗng.");
  return { text, raw: data };
}
