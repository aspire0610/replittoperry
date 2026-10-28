import "./_group.css";

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

export function Current() {
  return (
    <main className="stock-analysis-current">
      <details className="ai-detail-disclosure" open data-testid="panel-stock-scorecard">
        <summary>
          <span>量化評分與交易情境</span>
          <small>53 / 100 分 · 可評估 80 / 100 分</small>
        </summary>
        <div className="ai-detail-narrative">
          <strong>三大面向評分</strong>
          <p>只顯示可由本次資料計算的點數；不可用已得分除以可用分數換算成 100 分。評分是診斷資訊，不會覆蓋 AI 行動判斷。</p>
          <div className="ql-table-wrap">
            <table className="ql-table">
              <thead><tr><th>項目</th><th>得分</th><th>說明</th></tr></thead>
              <tbody>
                {scoreItems.map(([label, score, note]) => (
                  <tr key={label}><td>{label}</td><td>{score}</td><td>{note}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <strong>價位情境試算</strong>
          <p>參考價 2,430 元；近期支撐 2,375 元；近期壓力 2,590 元。</p>
          <div className="ql-table-wrap">
            <table className="ql-table">
              <thead><tr><th>情境</th><th>進場參考</th><th>停利參考</th><th>停損參考（含 ATR 防守）</th><th>潛在報酬 / 風險</th><th>風險報酬比</th></tr></thead>
              <tbody>
                {scenarios.map(([label, entry, target, stop, reward, ratio]) => (
                  <tr key={label}><td>{label}</td><td>{entry}</td><td>{target}</td><td>{stop}</td><td>{reward}</td><td>{ratio}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <small>技術價位取最近 20 個交易日最低／最高價；深層支撐取最近 60 日最低價。ATR(14) 為 39.29 元；R/R 僅在價位順序有效時計算。</small>
          <details><summary>完整 Markdown 報告</summary><pre>完整個股分析報告內容</pre></details>
        </div>
      </details>
    </main>
  );
}
