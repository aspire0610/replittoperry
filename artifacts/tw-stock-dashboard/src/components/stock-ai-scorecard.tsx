import type { StockAiAssessment } from "@workspace/api-client-react";
import "./stock-ai-scorecard.css";

function formatScenarioPrice(price: number | null): string {
  return price === null
    ? "—"
    : `${price.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元`;
}

export function StockAiScorecardDetails({
  assessment,
}: {
  assessment: StockAiAssessment;
}) {
  const { scorecard, tradeScenarios: scenarios } = assessment;
  const scenarioRows = [
    {
      label: "現價進場",
      scenario: scenarios.directEntry,
    },
    {
      label: "回測支撐進場",
      scenario: scenarios.pullbackEntry,
    },
  ];

  return (
    <details className="ai-detail-disclosure stock-scorecard-panel" open data-testid="panel-stock-scorecard">
      <summary className="stock-scorecard-heading">
        <span>量化評分與交易情境</span>
        <span className="stock-scorecard-total">
          <strong>{scorecard.earnedPoints}</strong>
          <small>/ {scorecard.maximumPoints} 分 · 可評估 {scorecard.availablePoints} 分</small>
        </span>
      </summary>
      <div className="stock-scorecard-content">
        <section className="stock-score-section" aria-labelledby="stock-scorecard-score-title">
          <div className="stock-score-section-heading">
            <strong id="stock-scorecard-score-title">量化證據評分</strong>
            <small>{scorecard.items.length} 項</small>
          </div>
          <p className="stock-scorecard-caveat">{scorecard.note}</p>
          <div className="stock-score-list">
            {scorecard.items.map((item) => (
              <details className="stock-score-row" key={item.id}>
                <summary>
                  <span className="stock-score-label">{item.label}</span>
                  <span className={`stock-score-value${item.points === null ? " is-unavailable" : ""}`}>
                    {item.points === null
                      ? `未取得 / ${item.maximumPoints}`
                      : `${item.points} / ${item.maximumPoints}`}
                  </span>
                  <span className="stock-score-chevron" aria-hidden="true" />
                </summary>
                <p>{item.note}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="stock-score-section stock-scenario-section" aria-labelledby="stock-scorecard-scenario-title">
          <div className="stock-score-section-heading">
            <strong id="stock-scorecard-scenario-title">價位情境試算</strong>
            <small>參考價 {formatScenarioPrice(scenarios.referencePrice)}</small>
          </div>
          <div className="stock-scenario-levels">
            <div><span>近期支撐</span><strong>{formatScenarioPrice(scenarios.supportPrice)}</strong></div>
            <div><span>近期壓力</span><strong>{formatScenarioPrice(scenarios.resistancePrice)}</strong></div>
          </div>
          <div className="stock-scenario-grid">
            {scenarioRows.map(({ label, scenario }) => (
              <article className="stock-scenario-card" key={label}>
                <header>
                  <strong>{label}</strong>
                  <span>風險報酬比 <b>{scenario.rewardToRisk === null ? "無法計算" : `1 : ${scenario.rewardToRisk.toFixed(2)}`}</b></span>
                </header>
                <dl>
                  <div><dt>進場參考</dt><dd>{formatScenarioPrice(scenario.entryPrice)}</dd></div>
                  <div><dt>停利參考</dt><dd>{formatScenarioPrice(scenario.targetPrice)}</dd></div>
                  <div><dt>停損參考（含 ATR 防守）</dt><dd>{formatScenarioPrice(scenario.stopPrice)}</dd></div>
                  <div className="stock-scenario-reward">
                    <dt>潛在報酬 / 風險</dt>
                    <dd>
                      {scenario.profitPercent === null || scenario.lossPercent === null
                        ? "無法計算"
                        : `${scenario.profitPercent.toFixed(1)}% / ${scenario.lossPercent.toFixed(1)}%`}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
          <p className="stock-scenario-method">{scenarios.methodNote}</p>
        </section>

        <details className="stock-scorecard-report">
          <summary>完整 Markdown 報告</summary>
          <pre>{assessment.reportMarkdown}</pre>
        </details>
      </div>
    </details>
  );
}
