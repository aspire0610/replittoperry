const PLAIN_LANGUAGE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/年化報酬率|年化報酬/g, "按一年換算的報酬"],
  [/年化/g, "按一年換算的"],
  [/最大回撤/g, "過程中最大的跌幅"],
  [/回撤/g, "跌幅"],
  [/夏普比率|夏普值|Sharpe(?: ratio)?/gi, "報酬和價格起伏的整體表現"],
  [/波動率|波動度|波動/g, "價格起伏"],
  [/再平衡/g, "調整持股"],
  [/流動性/g, "交易活絡程度"],
  [/因子/g, "選股條件"],
  [/相對同期大盤/g, "和同一段期間的大盤相比"],
  [/同期大盤/g, "同一段期間的大盤"],
  [/相對大盤/g, "和大盤相比"],
  [/超額報酬/g, "比大盤多的報酬"],
  [/策略表現/g, "這個做法的結果"],
  [/回測績效/g, "回測結果"],
  [/績效穩定度偏弱|績效穩定度較弱/g, "結果不太穩"],
  [/績效/g, "結果"],
];

function usePlainLanguage(summary: string): string {
  return PLAIN_LANGUAGE_REPLACEMENTS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    summary,
  );
}

export function parseQuantResearchSummaryOutput(
  text: string | null,
): string | null {
  if (!text?.trim()) return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const payload: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return null;
    }
    const summary = (payload as Record<string, unknown>).summary;
    if (
      typeof summary !== "string" ||
      summary.trim().length < 15 ||
      summary.trim().length > 240 ||
      /[\d０-９%％]/.test(summary) ||
      /買進|買入|賣出|加碼|減碼|進場|停損|停利|目標價|保證獲利|一定會/.test(
        summary,
      )
    ) {
      return null;
    }
    const plainSummary = usePlainLanguage(summary.trim());
    if (plainSummary.length < 15 || plainSummary.length > 240) return null;
    return plainSummary;
  } catch {
    return null;
  }
}
