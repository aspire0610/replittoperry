import "./_group.css";
import "./Compact.css";

const scoreItems = [
  ["外資單日淨買賣", "0 / 10", "僅反映外資最近一筆官方交易日淨買賣，不代表連續買賣天數。"],
  ["投信單日淨買賣", "10 / 10", "僅反映投信最近一筆官方交易日淨買賣，不代表連續買賣天數。"],
  ["大戶持股與融資融券", "未取得 / 10", "本次尚無同日期官方歷史序列，未估分。"],
  ["主力集中度", "未取得 / 10", "依目前設定略過；不以投信或法人買賣代替。"],
  ["成交量突破與流動性", "2 / 10", "當日量為前 20 日均量 2.49 倍；近 20 日平均成交金額約 63,018,600,414 元。"],
  ["OBV 量能趨勢", "0 / 10", "以近 20 根日線收漲／收跌方向累計成交量，和區間起點比較。"],
  ["收盤價相對 20／60 日均線", "5 / 10", "20 日與 60 日均線各占 5 分，價格在均線上方得分。"],
  ["MACD 柱狀體", "0 / 10", "柱狀體正值擴大得 10 分、負值擴大得 0 分，其餘 5 分。"],
  ["RSI／KD 動能", "6 / 10", "RSI 50–70 且 K>D 得 10 分；弱勢條件得 2 分；其他情況得 6 分。"],
  ["價格／RSI 背離觀察", "5 / 5", "比較前後各 10 根日線的收盤極值與 RSI；背離是簡化觀察，不是獨立買賣訊號。"],
  ["週線／日線趨勢一致性", "未取得 / 5", "以週收盤對照 5／10 週均線，日線對照 20／60 日均線。"],
];

const scenarios = [
  ["現價進場", "2,430 元", "2,590 元", "2,375 元", "6.6% / 2.3%", "1 : 2.91"],
  ["回測支撐進場", "2,375 元", "2,590 元", "2,180 元", "9.1% / 8.2%", "1 : 1.10"],
];
const scenarioFields = ["進場參考", "停利參考", "停損參考（含 ATR 防守）", "潛在報酬 / 風險", "風險報酬比"];

export function Compact() {
  return (
    <main className="stock-analysis-compact">
      <details className="compact-panel" open data-testid="panel-stock-scorecard">
        <summary className="compact-panel-heading">
          <span className="compact-heading-copy">
            <span className="compact-kicker">個股量化分析</span>
            <span className="compact-title">量化評分與交易情境</span>
          </span>
          <span className="compact-score">
            <strong>53 <i>/ 100</i></strong>
            <small>可評估 80 / 100 分</small>
          </span>
          <span className="compact-chevron" aria-hidden="true" />
        </summary>

        <div className="compact-content">
          <section className="compact-section" aria-labelledby="compact-score-heading">
            <header className="compact-section-heading">
              <div><span className="compact-index">01</span><h2 id="compact-score-heading">三大面向評分</h2></div>
              <span className="compact-count">11 項</span>
            </header>
            <p className="compact-caveat">只顯示可由本次資料計算的點數；不可用已得分除以可用分數換算成 100 分。評分是診斷資訊，不會覆蓋 AI 行動判斷。</p>

            <div className="compact-score-list">
              {scoreItems.map(([label, score, note], index) => (
                <details className="compact-score-row" key={label}>
                  <summary>
                    <span className="compact-row-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="compact-row-label">{label}</span>
                    <span className={`compact-row-score ${score.startsWith("未取得") ? "is-unavailable" : ""}`}>{score}</span>
                    <span className="compact-row-toggle" aria-label="查看說明" />
                  </summary>
                  <p className="compact-row-note">{note}</p>
                </details>
              ))}
            </div>
          </section>

          <section className="compact-section scenario-section" aria-labelledby="compact-scenario-heading">
            <header className="compact-section-heading">
              <div><span className="compact-index">02</span><h2 id="compact-scenario-heading">價位情境試算</h2></div>
              <span className="compact-count">參考價 2,430 元</span>
            </header>
            <p className="compact-levels">
              <span><b>近期支撐</b>2,375 元</span>
              <span><b>近期壓力</b>2,590 元</span>
            </p>

            <div className="compact-scenarios">
              {scenarios.map(([label, entry, target, stop, reward, ratio]) => (
                <article className="compact-scenario" key={label}>
                  <header>
                    <h3>{label}</h3>
                    <span>風險報酬比 <strong>{ratio}</strong></span>
                  </header>
                  <dl>
                    {scenarioFields.map((field, index) => (
                      <div className={index === 3 ? "is-reward" : ""} key={field}>
                        <dt>{field}</dt>
                        <dd>{[entry, target, stop, reward][index] ?? ratio}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
            <p className="compact-method-note">技術價位取最近 20 個交易日最低／最高價；深層支撐取最近 60 日最低價。ATR(14) 為 39.29 元；R/R 僅在價位順序有效時計算。</p>
          </section>

          <details className="compact-report">
            <summary><span>完整 Markdown 報告</span><span className="compact-report-arrow" aria-hidden="true" /></summary>
            <pre>完整個股分析報告內容</pre>
          </details>
        </div>
      </details>
    </main>
  );
}
