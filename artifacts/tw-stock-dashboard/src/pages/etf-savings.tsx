import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Search, Plus, Trash2, Save, CircleAlert, RefreshCw } from "lucide-react";
import {
  getGetAccountMeQueryKey,
  getGetEtfMarketQueryKey,
  useGetEtfMarket,
  usePutAccountWatchlist,
} from "@workspace/api-client-react";
import { useAccountWatchlist } from "../components/account-watchlist";
import "./etf-savings.css";

type Holding = { symbol: string; shares: number };
const money = (value: number | null | undefined) =>
  value == null ? "—" : `NT$ ${value.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const quoteMoney = (value: number | null | undefined) =>
  value == null ? "—" : `NT$ ${value.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const pct = (value: number | null | undefined) =>
  value == null ? "—" : `${value.toFixed(2)}%`;
const premiumClassName = (amount: number | null | undefined) =>
  amount == null || amount === 0
    ? ""
    : amount > 0 ? "etf-premium-positive" : "etf-premium-negative";
const premiumLabel = (amount: number | null | undefined) =>
  amount == null ? "暫無估值" : amount > 0 ? "溢價" : amount < 0 ? "折價" : "平價";
const navTime = (value: string | null | undefined) =>
  value == null
    ? "無估值時間"
    : new Intl.DateTimeFormat("zh-TW", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Taipei",
      }).format(new Date(value));

export default function EtfSavingsPage() {
  const { isSignedIn, isLoading: accountLoading, profile } = useAccountWatchlist();
  const queryClient = useQueryClient();
  const market = useGetEtfMarket({
    query: {
      queryKey: getGetEtfMarketQueryKey(),
      enabled: isSignedIn,
      staleTime: 5 * 60_000,
    },
  });
  const saveMutation = usePutAccountWatchlist({
    request: { credentials: "include" },
  });
  const [query, setQuery] = useState("");
  const [symbol, setSymbol] = useState("");
  const [sharesInput, setSharesInput] = useState("1000");
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    setHoldings(profile?.etfHoldings ?? []);
    setSaved(true);
  }, [profile?.userId, profile?.etfHoldings]);

  const instruments = market.data?.instruments ?? [];
  const bySymbol = useMemo(
    () => new Map(instruments.map((item) => [item.symbol, item])),
    [instruments],
  );
  const topTen = useMemo(
    () => instruments
      .filter((item) => item.trailing12MonthYieldPercent != null && item.trailing12MonthDividend > 0)
      .toSorted((a, b) => (b.trailing12MonthYieldPercent ?? -1) - (a.trailing12MonthYieldPercent ?? -1))
      .slice(0, 10),
    [instruments],
  );
  const searchResults = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    if (!value) return [];
    return instruments.filter((item) =>
      item.symbol.toLocaleLowerCase().includes(value) ||
      item.name.toLocaleLowerCase().includes(value),
    ).slice(0, 12);
  }, [instruments, query]);
  const selected = bySymbol.get(symbol);
  const annualEstimate = holdings.reduce(
    (sum, holding) => sum + (bySymbol.get(holding.symbol)?.trailing12MonthDividend ?? 0) * holding.shares,
    0,
  );

  const addHolding = () => {
    const shares = Number(sharesInput);
    if (!selected || !Number.isInteger(shares) || shares < 1) return;
    setHoldings((current) => {
      const existing = current.find((item) => item.symbol === selected.symbol);
      const next = existing
        ? current.map((item) => item.symbol === selected.symbol ? { ...item, shares: item.shares + shares } : item)
        : [...current, { symbol: selected.symbol, shares }];
      return next;
    });
    setSaved(false);
  };
  const updateShares = (target: string, value: string) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    setHoldings((current) => current.map((item) => item.symbol === target ? { ...item, shares: parsed } : item));
    setSaved(false);
  };
  const saveHoldings = () => {
    if (!profile || saveMutation.isPending) return;
    saveMutation.mutate(
      { data: { watchlist: profile.watchlist, etfHoldings: holdings.filter((holding) => holding.shares > 0) } },
      {
        onSuccess: () => {
          setSaved(true);
          void queryClient.invalidateQueries({ queryKey: getGetAccountMeQueryKey() });
        },
      },
    );
  };

  if (accountLoading) return <div className="account-route-loading" role="status">正在確認帳號…</div>;
  if (!isSignedIn) return <main className="dashboard-main route-page"><section className="glass-panel etf-notice"><h1>登入後管理 ETF 存股</h1><p>ETF 持倉是私人資料，登入後可跨裝置保存。</p><a className="route-primary-link" href="/sign-in">前往登入</a></section></main>;

  return (
    <main className="dashboard-main route-page etf-savings-page">
      <header className="route-page-heading">
        <div><p className="section-eyebrow">ETF INCOME TRACKER</p><h1>ETF 存股與配息</h1><p className="lede">搜尋上市櫃 ETF、查看近 12 個月實際配息率，並依持有股數估算配息。</p></div>
      </header>
      <section className="etf-summary glass-panel">
        <div><span>持有 ETF</span><strong>{holdings.length} 檔</strong></div>
        <div><span>近 12 個月估算配息</span><strong data-testid="text-etf-annual-estimate">{money(annualEstimate)}</strong></div>
        <small>以過去 12 個月實際配息估算，不代表未來保證配息。</small>
      </section>
      <section className="glass-panel etf-search-panel">
        <div className="etf-section-title"><div><span className="section-eyebrow">全市場 ETF</span><h2>搜尋並加入持倉</h2></div></div>
        <label className="etf-search"><Search size={17} aria-hidden="true"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="輸入 ETF 代號或名稱" aria-label="搜尋 ETF" data-testid="input-etf-search"/></label>
        {query && <div className="etf-search-results" role="listbox" aria-label="ETF 搜尋結果">
          {searchResults.length ? searchResults.map((item) => <button key={item.symbol} type="button" className={`etf-result ${symbol === item.symbol ? "selected" : ""}`} onClick={() => setSymbol(item.symbol)} data-testid={`button-select-etf-${item.symbol}`}>
            <span><strong>{item.symbol}</strong><small>{item.name}</small></span>
            <span className="etf-result-values">
              <span className="etf-result-metric"><small>年殖利率</small><b>{pct(item.trailing12MonthYieldPercent)}</b></span>
              <span className="etf-result-metric"><small>折溢價</small><b className={`etf-result-premium ${premiumClassName(item.discountPremiumAmount)}`}>{premiumLabel(item.discountPremiumAmount)}{item.discountPremiumAmount == null ? "" : ` ${quoteMoney(item.discountPremiumAmount)} · ${pct(item.discountPremiumPercent)}`}</b></span>
            </span>
          </button>) : <p className="etf-empty">沒有符合的 ETF。</p>}
        </div>}
        <div className="etf-add-row">
          <label>選擇 ETF<select value={symbol} onChange={(event) => setSymbol(event.target.value)} data-testid="select-etf-holding"><option value="">請先搜尋並選擇</option>{instruments.map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol} {item.name}</option>)}</select></label>
          <label>持有股數<input type="number" min="1" step="1" value={sharesInput} onChange={(event) => setSharesInput(event.target.value)} data-testid="input-etf-shares"/></label>
          <button type="button" className="route-primary-link" disabled={!selected} onClick={addHolding} data-testid="button-add-etf-holding"><Plus size={15}/>加入持倉</button>
        </div>
      </section>
      <section className="glass-panel etf-table-panel">
        <div className="etf-section-title"><div><span className="section-eyebrow">TOP 10 BY TRAILING DISTRIBUTION YIELD</span><h2>近 12 個月歷史配息率前 10 名</h2></div><div className="etf-asof"><span>行情日期：{market.data?.asOf?.slice(0, 10) ?? "—"}</span><span>淨值更新至：{navTime(market.data?.navDataUpdatedAt)}</span></div></div>
        {market.isLoading ? <p className="etf-state" role="status">正在載入 ETF 清單與配息紀錄…</p> : market.isError ? <p className="etf-state error" role="alert"><CircleAlert size={16}/> ETF 資料暫時無法載入。<button type="button" onClick={() => void market.refetch()}><RefreshCw size={14}/>重試</button></p> : (
          <>
            <div className="etf-table-scroll"><table><thead><tr><th>代號／名稱</th><th>市價</th><th>預估淨值</th><th>折溢價金額</th><th>折溢價率</th><th>配息概況</th><th>年殖利率*</th><th></th></tr></thead><tbody>
              {topTen.map((item, index) => {
                const premiumClass = item.discountPremiumAmount == null || item.discountPremiumAmount === 0
                  ? ""
                  : item.discountPremiumAmount > 0 ? "etf-premium-positive" : "etf-premium-negative";
                return <tr key={item.symbol}>
                  <td><span className="etf-rank">{String(index + 1).padStart(2, "0")}</span><strong>{item.symbol}</strong><small>{item.name}</small></td>
                  <td className="etf-numeric">{quoteMoney(item.marketPrice)}</td>
                  <td className="etf-numeric"><span className="etf-cell-main">{quoteMoney(item.netAssetValue)}</span><small className="etf-cell-subtitle">{navTime(item.navUpdatedAt)}</small></td>
                  <td className={`etf-numeric ${premiumClass}`}>{quoteMoney(item.discountPremiumAmount)}</td>
                  <td className={`etf-numeric ${premiumClass}`}>{pct(item.discountPremiumPercent)}</td>
                  <td><div className="etf-payout-summary"><strong>{item.frequency}</strong><span>最近 {money(item.latestDistribution)}</span><span>近 12 月 {money(item.trailing12MonthDividend)}</span></div></td>
                  <td className="etf-yield">{pct(item.trailing12MonthYieldPercent)}</td>
                  <td><button type="button" className="etf-quick-add" onClick={() => { setSymbol(item.symbol); setQuery(item.symbol); }} aria-label={`選取 ${item.symbol}`} data-testid={`button-add-top-etf-${item.symbol}`}><Plus size={15}/></button></td>
                </tr>;
              })}
            </tbody></table></div>
            <div className="etf-mobile-list" aria-label="ETF 配息率排行">
              {topTen.map((item, index) => {
                const premiumClass = item.discountPremiumAmount == null || item.discountPremiumAmount === 0
                  ? ""
                  : item.discountPremiumAmount > 0 ? "etf-premium-positive" : "etf-premium-negative";
                return <article className="etf-mobile-card" key={item.symbol}>
                  <div className="etf-mobile-card-heading">
                    <div className="etf-mobile-card-name">
                      <span className="etf-mobile-symbol"><span className="etf-rank">{String(index + 1).padStart(2, "0")}</span><strong>{item.symbol}</strong></span>
                      <span className="etf-mobile-fund-name">{item.name}</span>
                    </div>
                    <div className="etf-mobile-card-actions">
                      <span className="etf-mobile-yield"><small>年殖利率</small><strong>{pct(item.trailing12MonthYieldPercent)}</strong></span>
                      <button type="button" className="etf-quick-add" onClick={() => { setSymbol(item.symbol); setQuery(item.symbol); }} aria-label={`選取 ${item.symbol}`} data-testid={`button-add-top-etf-mobile-${item.symbol}`}><Plus size={15}/></button>
                    </div>
                  </div>
                  <div className="etf-mobile-metrics">
                    <div><span>市價</span><strong>{quoteMoney(item.marketPrice)}</strong></div>
                    <div><span>預估淨值</span><strong>{quoteMoney(item.netAssetValue)}</strong><small>{navTime(item.navUpdatedAt)}</small></div>
                    <div><span>折溢價金額</span><strong className={premiumClass}>{quoteMoney(item.discountPremiumAmount)}</strong></div>
                    <div><span>折溢價率</span><strong className={premiumClass}>{pct(item.discountPremiumPercent)}</strong></div>
                  </div>
                  <div className="etf-mobile-payout">
                    <span>{item.frequency}</span>
                    <span>最近 {money(item.latestDistribution)}</span>
                    <span>近 12 月 {money(item.trailing12MonthDividend)}</span>
                  </div>
                </article>;
              })}
            </div>
          </>
        )}
        <p className="etf-footnote">* 歷史配息率＝近 12 個月除息紀錄的每單位現金配息合計 ÷ 最新收盤價。折溢價金額＝市價－預估淨值；折溢價率＝（市價－預估淨值）÷ 預估淨值。紅色為溢價、綠色為折價；各 ETF 淨值更新時間不同，請參考欄位時間。預估淨值由投信／總代理人提供，經證交所 MIS 揭露，非最終官方淨值。不是未來殖利率或投資建議。{market.data?.navDataStatus === "partial" ? "部分 ETF 尚無近期淨值資料。" : market.data?.navDataStatus === "unavailable" ? "目前無法取得近期淨值資料。" : ""}來源：{market.data?.source ?? "官方市場與配息資料"}。</p>
      </section>
      <section className="glass-panel etf-holdings-panel">
        <div className="etf-section-title"><div><span className="section-eyebrow">MY ETF HOLDINGS</span><h2>目前持有與配息估算</h2></div><button type="button" className="route-primary-link" onClick={saveHoldings} disabled={saved || saveMutation.isPending} data-testid="button-save-etf-holdings"><Save size={15}/>{saveMutation.isPending ? "儲存中…" : saved ? "已同步帳號" : "儲存持倉"}</button></div>
        {saveMutation.isError && <p role="alert" className="etf-state error">儲存失敗，請稍後重試。</p>}
        {!holdings.length ? <p className="etf-state">搜尋 ETF 並輸入持有股數，配息估算會立即更新。</p> : <div className="etf-table-scroll"><table><thead><tr><th>ETF</th><th>持有股數</th><th>最近單次估算</th><th>近 12 月估算</th><th></th></tr></thead><tbody>
          {holdings.map((holding) => { const item = bySymbol.get(holding.symbol); return <tr key={holding.symbol}><td><strong>{holding.symbol}</strong><small>{item?.name ?? "ETF 資料載入中"}</small></td><td><input className="etf-shares-edit" type="number" min="1" step="1" value={holding.shares} onChange={(event) => updateShares(holding.symbol, event.target.value)} aria-label={`${holding.symbol} 持有股數`} data-testid={`input-holding-shares-${holding.symbol}`}/></td><td>{item?.latestDistribution == null ? "無官方配息紀錄" : money(item.latestDistribution * holding.shares)}</td><td className="etf-yield">{money((item?.trailing12MonthDividend ?? 0) * holding.shares)}</td><td><button type="button" className="etf-remove" onClick={() => { setHoldings((current) => current.filter((entry) => entry.symbol !== holding.symbol)); setSaved(false); }} aria-label={`移除 ${holding.symbol}`} data-testid={`button-remove-holding-${holding.symbol}`}><Trash2 size={15}/></button></td></tr>; })}
        </tbody></table></div>}
        <p className="etf-footnote">持倉股數會保存在目前登入帳號的私人資料中。估算使用近 12 個月已公告現金配息，不含稅費，實際配息依基金公告為準。</p>
      </section>
    </main>
  );
}
