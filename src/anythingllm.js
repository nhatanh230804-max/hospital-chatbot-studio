// =============================================================================
// src/anythingllm.js — AnythingLLM API client
// =============================================================================

export function anythingLLMConfig() {
  return {
    baseUrl: (process.env.ANYTHINGLLM_BASE_URL || "").replace(/\/$/, ""),
    apiKey: process.env.ANYTHINGLLM_API_KEY || "",
    workspaceSlug: process.env.ANYTHINGLLM_WORKSPACE_SLUG || "",
    mode: process.env.ANYTHINGLLM_MODE || "chat"
  };
}

export function isAnythingLLMConfigured() {
  const { baseUrl, apiKey, workspaceSlug } = anythingLLMConfig();
  return Boolean(baseUrl && apiKey && workspaceSlug && !apiKey.includes("replace_with"));
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

export async function callAnythingLLM(message, options = {}) {
  const { baseUrl, apiKey, workspaceSlug, mode } = anythingLLMConfig();
  if (!isAnythingLLMConfigured()) {
    throw new Error("AnythingLLM chưa được cấu hình trong .env");
  }

  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/workspace/${workspaceSlug}/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        mode: options.mode || mode,
        sessionId: options.sessionId || `hospital-web-${Date.now()}`
      })
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`AnythingLLM phản hồi quá lâu (>${timeoutMs / 1000}s).`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `AnythingLLM HTTP ${response.status}`);
  }
  const text = getAnythingLLMText(data);
  if (!text) throw new Error("AnythingLLM phản hồi rỗng.");
  return { text, raw: data };
}
