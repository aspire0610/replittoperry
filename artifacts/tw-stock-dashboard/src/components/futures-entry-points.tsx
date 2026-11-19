import { useEffect, useMemo, useState } from "react";
import { Crosshair, ExternalLink } from "lucide-react";
import {
  calculateFuturesEntryPoints,
  FUTURES_ENTRY_REFERENCE,
  type FuturesEntryInput,
  type FuturesEntryResult,
  type FuturesEntryScenario,
} from "../lib/futures-entry-points";

const stateLabels: Record<FuturesEntryResult["state"], string> = {
  watching: "觀察中 · 未成立",
  ready: "規則條件成立",
  warming_up: "暖機中",
  closed: "休市／待開盤",
  stale: "資料過期 · 暫停",
  unavailable: "暫不可用",
};

const statusLabels: Record<FuturesEntryScenario["status"], string> = {
  waiting: "等待確認",
  level_reached: "已觸及・待收K",
  armed: "已佈署 · 未觸發",
  ready: "條件成立",
  missed: "已錯過 · 不追價",
  invalidated: "已失效 · 不反手",
  risk_too_wide: "風險過大 · 不出擊",
};

const points = (v: number | null) => v == null ? "—" : Math.round(v).toLocaleString("zh-TW");
const dec = (v: number | null) => v == null ? "—" : v.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function tpe(v: string | null) {
  if (!v) return "未提供";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function FuturesEntryPoints({ data, requestFailed = false }: { data: FuturesEntryInput | undefined; requestFailed?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);
  const result = useMemo(() => (data && !requestFailed ? calculateFuturesEntryPoints(data, now) : null), [data, requestFailed, now]);

  const state = result?.state ?? "unavailable";
  const reason = requestFailed
    ? "最新請求失敗；不沿用上一次成功資料的出擊點，待連線恢復後重新計算。"
    : !data ? "正在等待期貨觀測資料，尚未計算出擊點。" : result!.reason;
  const showLevels = result && result.scenarios.length > 0;

  return (
    <section className="fep" aria-labelledby="fep-heading" data-testid="panel-futures-entry-points">
      <header className="fep-head">
        <div>
          <p className="fep-eyebrow"><Crosshair size={12} /> OPTIONAL / FIXED 5-MIN PATTERN CHECK</p>
          <h3 id="fep-heading">5 分 K 型態補充</h3>
        </div>
        <span className={`fep-state is-${requestFailed ? "unavailable" : state}`} role="status" data-testid="status-futures-entry-state">
          {requestFailed ? "請求失敗 · 暫停" : !data ? "讀取中" : stateLabels[state]}
        </span>
      </header>
      <p className="fep-reason" data-testid="text-futures-entry-reason">
        本區是額外的固定 5 分 K 型態策略，不會阻擋上方依 EMA5／EMA13 判斷的即時趨勢訊號。{reason}
      </p>

      <dl className="fep-meta">
        <div><dt>來源</dt><dd>{data?.source || "未提供"}</dd></div>
        <div><dt>資料時間</dt><dd>{tpe(data?.asOf ?? null)}</dd></div>
        <div><dt>完成訊號 K 收盤</dt><dd>{tpe(result?.signalAt ?? null)}</dd></div>
        <div><dt>完整 5 分 K</dt><dd>{result ? `${result.completedBars} 根` : "—"}</dd></div>
      </dl>

      {result && (
        <dl className="fep-levels" data-testid="values-futures-entry-levels">
          <div><dt>支撐（前 20 根 5 分 K 最低）</dt><dd>{points(result.support)}</dd></div>
          <div><dt>壓力（前 20 根 5 分 K 最高）</dt><dd>{points(result.resistance)}</dd></div>
          <div><dt>關鍵價（20 根 5 分收盤均價，非 WinSmart 成本線）</dt><dd>{dec(result.keyPrice)}</dd></div>
          <div><dt>5 分 ATR14（14 根 TR 簡單平均，非日 ATR）</dt><dd>{dec(result.atr14)}</dd></div>
          <div><dt>最大追價距離</dt><dd>{points(result.maxChase)} 點</dd></div>
          <div><dt>停損風險上限（1× SPARK 5 分 ATR14）</dt><dd>{dec(result.atr14)} 點</dd></div>
        </dl>
      )}

      {showLevels ? (
        <ol className="fep-grid">
          {result.scenarios.map((s) => (
            <li key={s.id} className={`fep-card is-${s.direction} st-${s.status}`} data-testid={`card-futures-entry-${s.id}`}>
              <div className="fep-card-head">
                <strong>{s.title}</strong>
                <span className="fep-badge">{statusLabels[s.status]}</span>
              </div>
              <p className="fep-level">參考位 <b>{s.direction === "long" && s.id === "support_bounce" || s.id === "resistance_reject" ? points(s.level) : dec(s.level)}</b></p>
              <p className="fep-cond"><small>條件</small>{s.condition}</p>
              <p className="fep-evi">{s.evidence}</p>
              {s.entry != null ? (
                <dl className="fep-nums">
                  <div><dt>觸發</dt><dd>{points(s.entry)}</dd></div>
                  <div><dt>停損</dt><dd>{points(s.stop)}</dd></div>
                  <div><dt>示意目標 3R</dt><dd>{points(s.target)}</dd></div>
                  <div><dt>風險</dt><dd>{points(s.riskPoints)} 點</dd></div>
                </dl>
              ) : <p className="fep-none">未確認前不提供觸發／停損／目標價。</p>}
            </li>
          ))}
        </ol>
      ) : (
        <div className="fep-empty" data-testid="status-futures-entry-empty">
          四種情境（支撐止跌做多、站回關鍵價做多、壓力受阻做空、跌破關鍵價做空）是補充型態分析；暖機或資料不完整時不顯示價位，也不影響上方 5 分趨勢進場點。
        </div>
      )}

      <div className="fep-explain">
        <ul>
          <li><b>已佈署</b>：位置與收 K 確認成立，但現價尚未穿越觸發價，不等於已觸發。</li>
          <li><b>已觸及・待收K</b>：這張補充策略卡仍須完成回測與下一根 5 分 K 確認；不會延後上方 5 分趨勢進場點。</li>
          <li><b>等待確認</b>：尚未觸及參考位；未確認前不提供觸發、停損、目標。</li>
          <li><b>條件成立</b>：僅代表規則條件同時成立，不保證成交或獲利。</li>
          <li><b>已錯過</b>：現價超出最大追價距離，不追價。<b> 已失效</b>：穿越停損參考，不自動反手。</li>
        </ul>
        <p>
          參考 <a href={FUTURES_ENTRY_REFERENCE} target="_blank" rel="noreferrer">WinSmart〈期貨進場點出擊，掌握3要領〉<ExternalLink size={11} /></a>：
          等回檔／反彈止穩再進場、站回（或跌破）關鍵價才出手、方向錯誤先停損，之後再重新評估反向設定，而非自動反手。
          停損風險上限依本盤 Yuanta SPARK 逐筆成交彙整的分鐘 K 計算；固定規則使用 5 分 ATR14，超過一倍 ATR 不出擊。
        </p>
        <p className="fep-disclose">
          本補充策略固定使用 5 分 K，與電話線週期選擇無關；需連續 22 根完整 5 分 K（110 分鐘），只涵蓋觀測窗內資料，非整個盤別，也不是上方 EMA5／EMA13 趨勢訊號的門檻。
          3R 目標僅為示意、未經驗證；未計手續費與滑價；本系統不下單，亦無實測勝率。
        </p>
      </div>
    </section>
  );
}
