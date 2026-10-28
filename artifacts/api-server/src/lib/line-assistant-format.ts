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

export function getLineDailySummaryMode(
  question: string,
): "premarket" | "closing" | null {
  const normalized = question
    .normalize("NFKC")
    .replace(/[\s，。？！!?、]/gu, "");
  const match = normalized.match(
    /^(?:(?:請|麻煩|再)?(?:給我|提供)?)(?:(?:今天|今日|台股|臺股|大盤|加權指數|的)*)?(盤前|盤後)(?:摘要|總結)$/u,
  );
  if (!match) return null;
  return match[1] === "盤前" ? "premarket" : "closing";
}

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

function formatAnswerForLine(value: string, hasSources: boolean): string {
  return value
    .trim()
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/```[\s\S]*?```/gu, (block) => block.replace(/```[^\n]*\n?|```/gu, "").trim())
    .replace(/https?:\/\/[^\s，。；）】]+/gu, (rawUrl) => {
      try {
        const host = new URL(rawUrl).hostname.replace(/^www\./u, "");
        return hasSources ? "（連結見下方參考來源）" : `（${host} 連結）`;
      } catch {
        return "（連結見下方參考來源）";
      }
    })
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/\n(?=(?:📈|📊|加權指數|技術依據|美股資料|美股收盤|可能走勢|消息面留意|本日重要事件|AI 主觀建議|觀察重點|未來 5 日|近期事件|AI 方向|自選股收盤))/gu, "\n\n")
    .replace(/(?<!\n)(?=(?:結論|原因|不買原因|主要理由|操作方向|可以買|不建議買|買進條件|買入條件|風險|資料時間|來源)：)/gu, "\n")
    .trim()
    .slice(0, MAX_LINE_ANSWER_LENGTH);
}

export function formatLineAssistantReply(
  reply: AssistantChatReply,
): LineAssistantMessage {
  const inlineSources = [...reply.answer.matchAll(/https?:\/\/[^\s，。；）】]+/gu)]
    .map((match) => match[0].replace(/[.,!?]+$/u, ""))
    .flatMap((url) => {
      try {
        return [{ title: `來源：${new URL(url).hostname.replace(/^www\./u, "")}`, url }];
      } catch {
        return [];
      }
    });
  const seenUrls = new Set<string>();
  const sources = [...reply.sources, ...inlineSources]
    .slice(0, 5)
    .flatMap((source) => {
      const uri = safeSourceUrl(source.url);
      const title = compactTitle(source.title);
      if (!uri || !title || seenUrls.has(uri)) return [];
      seenUrls.add(uri);
      return [{ uri, title }];
    });
  const answer = formatAnswerForLine(reply.answer, sources.length > 0);

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
