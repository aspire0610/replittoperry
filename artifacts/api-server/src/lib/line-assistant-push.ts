import type { AssistantChatReply } from "@workspace/api-zod";
import { formatLineAssistantReply } from "./line-assistant-format.js";

export async function pushLineAssistantReply(
  lineUserId: string,
  reply: AssistantChatReply,
): Promise<void> {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [formatLineAssistantReply(reply)],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`LINE push API returned HTTP ${response.status}`);
  }
}
