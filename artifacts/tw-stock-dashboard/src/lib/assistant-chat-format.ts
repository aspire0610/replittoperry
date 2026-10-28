const sectionLabels = [
  "方向結論",
  "方向判斷",
  "歷史回測",
  "規則命中率",
  "近期行情消息",
  "近期行情",
  "即時消息",
  "消息面",
  "反向訊號",
  "資料限制",
  "預測目標",
];

export type AssistantAnswerSection = {
  label: string | null;
  body: string;
};

export function splitAssistantAnswer(content: string): AssistantAnswerSection[] {
  const labels = sectionLabels.join("|");
  const normalized = content
    .replace(new RegExp(`\\s*(?=(${labels})[：:])`, "gu"), "\n\n")
    .trim();
  const sections = normalized.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  const parsedSections = sections.map((text) => {
    const match = new RegExp(`^(${labels})[：:]\\s*([\\s\\S]*)$`, "u").exec(text);
    return match ? { label: match[1]!, body: match[2]!.trim() } : null;
  });

  if (parsedSections.length < 2 || parsedSections.some((section) => section === null)) {
    return [{ label: null, body: content }];
  }
  return parsedSections as AssistantAnswerSection[];
}
