import type {
  QuantResearchExecutionInput,
  QuantResearchResult,
  QuantResearchStreamEvent,
} from "@workspace/api-client-react";

export type QuantResearchProgressEvent = Extract<
  QuantResearchStreamEvent,
  { type: "progress" }
>;

function parseEventFrame(frame: string): QuantResearchStreamEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;

  try {
    return JSON.parse(data) as QuantResearchStreamEvent;
  } catch {
    throw new Error("研究進度回應格式錯誤，請重新執行。");
  }
}

async function responseError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return `研究服務回應錯誤（${response.status}）。請稍後重試。`;
}

export async function streamQuantResearch(
  input: QuantResearchExecutionInput,
  onProgress: (event: QuantResearchProgressEvent) => void,
): Promise<QuantResearchResult> {
  const response = await fetch("/api/account/quant-research/stream", {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  if (!response.body) {
    throw new Error("瀏覽器無法讀取研究進度串流，請重新整理後再試。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: QuantResearchResult | null = null;

  const handleFrame = (frame: string) => {
    const event = parseEventFrame(frame);
    if (!event) return;
    if (event.type === "progress") {
      onProgress(event);
    } else if (event.type === "error") {
      throw new Error(event.message);
    } else {
      result = event.result;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) handleFrame(frame);
      if (done) {
        if (buffer.trim()) handleFrame(buffer);
        break;
      }
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The server may have already closed the stream after sending an error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (!result) {
    throw new Error("研究連線提前中斷；已保存的官方行情會保留，請再次執行。");
  }
  return result;
}
