export type SavedSeatReport = {
  status: "completed" | "failed";
  marketDate: string | null;
  asOf: string;
  answer: string;
  assessment?: Record<string, unknown>;
};

export type SavedResearchSeat = {
  symbol: string;
  name: string;
  mission: string;
  reports: SavedSeatReport[];
};

export function buildLineResearchSeatContext(
  seats: SavedResearchSeat[],
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
): string | null {
  const conversation = [question, ...history.slice(-6).map(({ content }) => content)]
    .join("\n")
    .toLocaleLowerCase("zh-TW");
  const matched = seats
    .filter((seat) => [seat.symbol, seat.name].some((identifier) =>
      identifier.trim().length > 1 &&
      conversation.includes(identifier.trim().toLocaleLowerCase("zh-TW")),
    ))
    .map((seat) => ({
      seat,
      latestReport: seat.reports[0],
      report: seat.reports.find((item) => item.status === "completed"),
    }))
    .filter((item) => Boolean(item.report || item.latestReport?.status === "failed"))
    .slice(0, 2);

  if (!matched.length) return null;
  return [
    "以下是這個已連結帳號的個股研究席位最近已完成報告，屬於歷史研究紀錄，不是即時行情。",
    ...matched.map(({ seat, latestReport, report }) => {
      const assessmentContext = report?.assessment?.context;
      const sourceLabels =
        assessmentContext && typeof assessmentContext === "object"
          ? (assessmentContext as Record<string, unknown>).sources
          : null;
      const sources = Array.isArray(sourceLabels)
        ? sourceLabels.filter((value): value is string => typeof value === "string").slice(0, 3)
        : [];
      return [
        `標的：${seat.name}（${seat.symbol}）`,
        `席位任務：${seat.mission.slice(0, 240)}`,
        latestReport?.status === "failed"
          ? `最近一次執行：失敗（${latestReport.asOf}）；以下若有舊報告，僅代表最近一次已完成的研究。`
          : "",
        report
          ? `報告交易日：${report.marketDate ?? "未提供"}；報告時間：${report.asOf}`
          : "",
        report
          ? `報告摘要：${report.answer.replace(/\s+/gu, " ").slice(0, 800)}`
          : "目前沒有已完成報告，不可把這次未完成的研究描述為已完成。",
        sources.length ? `報告記錄的資料來源：${sources.join("、")}` : "",
      ].filter(Boolean).join("\n");
    }),
  ].join("\n\n").slice(0, 2_500);
}
