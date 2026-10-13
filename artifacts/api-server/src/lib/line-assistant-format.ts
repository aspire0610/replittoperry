import type { AssistantChatReply } from "@workspace/api-zod";

type FlexComponent = Record<string, unknown>;

export type LineAssistantMessage =
  | { type: "text"; text: string }
  | {
      type: "flex";
      altText: string;
      contents: {
        type: "bubble";
        body: {
          type: "box";
          layout: "vertical";
          spacing: "md";
          contents: FlexComponent[];
        };
      };
    };

const MAX_LINE_ANSWER_LENGTH = 4_000;
const MAX_SOURCE_TITLE_LENGTH = 64;
const MAX_FLEX_ALT_TEXT_LENGTH = 400;

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function compactTitle(value: string): string {
  const title = value.replace(/\s+/gu, " ").trim();
  return title.length > MAX_SOURCE_TITLE_LENGTH
    ? `${title.slice(0, MAX_SOURCE_TITLE_LENGTH - 1)}…`
    : title;
}

export function formatLineAssistantReply(
  reply: AssistantChatReply,
): LineAssistantMessage {
  const answer = reply.answer.trim().slice(0, MAX_LINE_ANSWER_LENGTH);
  const sources = reply.sources
    .slice(0, 5)
    .flatMap((source) => {
      const uri = safeSourceUrl(source.url);
      const title = compactTitle(source.title);
      return uri && title ? [{ uri, title }] : [];
    });

  if (!sources.length) return { type: "text", text: answer };

  const sourceComponents: FlexComponent[] = sources.map(({ uri, title }, index) => ({
    type: "text",
    text: `${index + 1}. ${title}`,
    wrap: true,
    size: "sm",
    color: "#2563EB",
    action: { type: "uri", label: "開啟參考來源", uri },
  }));
  const contents: FlexComponent[] = [
    { type: "text", text: answer, wrap: true, size: "sm", color: "#222222" },
    { type: "separator", margin: "lg" },
    {
      type: "text",
      text: "參考來源（點選標題開啟）",
      weight: "bold",
      size: "xs",
      color: "#687385",
    },
    ...sourceComponents,
  ];
  const altText = `${answer} 參考來源：${sources.map(({ title }) => title).join("；")}`
    .slice(0, MAX_FLEX_ALT_TEXT_LENGTH);

  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents,
      },
    },
  };
}
