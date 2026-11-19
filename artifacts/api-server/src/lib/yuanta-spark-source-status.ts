/** Public fallback explanations must never include upstream bodies, URLs or credentials. */
export function describeYuantaSparkFailure(reason: string): string {
  reason = reason.replace(/^SPARK TXF8 /u, "SPARK TXF1 ").replace("夜盤", "日盤").replace("當前", "當日");
  const http = reason.match(/^Yuanta SPARK (relay|期貨逐筆)回應 HTTP (\d{3})$/u)
    ?? reason.match(/^Yuanta SPARK (relay|期貨逐筆) 回應 HTTP (\d{3})$/u);
  if (http) return `${http[1] === "relay" ? "報價" : "逐筆"} HTTP ${http[2]}`;
  if (/timeout|timed out|逾時/iu.test(reason)) return "SPARK 查詢逾時";
  if (reason === "fetch failed") return "SPARK 連線失敗";
  if (reason === "SPARK relay 尚未設定") return "SPARK 連線未設定";
  if (reason === "SPARK TXF1 沒有新鮮報價") return "SPARK 報價時間未通過檢查";
  if (reason === "SPARK TXF1 日盤一分 K 已過期") return "SPARK 分 K 已過期";
  if (reason === "SPARK TXF1 尚無當日日盤一分 K") return "SPARK 當日日盤分 K 為空";
  if (reason === "SPARK TXF1 分 K 缺少有效的同日價格尺度驗證") return "SPARK 同日價格驗證未通過";
  return "SPARK 回應無法使用";
}
