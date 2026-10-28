type Exchange = "TW" | "TWO";
type Status = "available" | "unavailable";

export type StockResearchData = {
  symbol: string;
  ticker: string | null;
  fundamentals: {
    status: Status;
    reason: string | null;
    source: string | null;
    filedAt: string | null;
    fiscalYear: number | null;
    quarter: number | null;
    currency: string;
    revenueThousandTwd: number | null;
    operatingIncomeThousandTwd: number | null;
    netIncomeThousandTwd: number | null;
    epsTwd: number | null;
    assetsThousandTwd: number | null;
    liabilitiesThousandTwd: number | null;
    equityThousandTwd: number | null;
  };
  institutional: {
    status: Status;
    reason: string | null;
    source: string | null;
    observedAt: string | null;
    foreignNetShares: number | null;
    investmentTrustNetShares: number | null;
    dealerNetShares: number | null;
    totalNetShares: number | null;
  };
};

const UA = "Mozilla/5.0 (compatible; TaiwanStockDashboard/1.0)";
const cache = new Map<string, { expires: number; promise: Promise<unknown> }>();

async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.promise as Promise<T>;
  const promise = (async () => {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  })();
  cache.set(url, { expires: Date.now() + 5 * 60_000, promise });
  try { return await promise; } catch (error) { cache.delete(url); throw error; }
}

async function fetchText(url: string): Promise<string> {
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.promise as Promise<string>;
  const promise = (async () => {
    const response = await fetch(url, {
      headers: { Accept: "text/csv,*/*", "User-Agent": UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  })();
  cache.set(url, { expires: Date.now() + 30 * 60_000, promise });
  try { return await promise; } catch (error) { cache.delete(url); throw error; }
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) { row.push(field); field = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function numberOrNull(value: string | undefined): number | null {
  const clean = value?.trim().replaceAll(",", "");
  if (!clean || clean === "-" || clean === "--") return null;
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}

function rocDate(value: string | undefined): string | null {
  const match = value?.trim().match(/^(\d{2,3})(\d{2})(\d{2})$/) ??
    value?.trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]) + 1911;
  const month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((header) => header.trim() === name);
}

function rowByCode(rows: string[][], code: string): { headers: string[]; row: string[] } | null {
  if (!rows.length) return null;
  const headers = rows[0]!.map((header) => header.replace(/^\uFEFF/, ""));
  const index = headerIndex(headers, "公司代號");
  if (index < 0) return null;
  const row = rows.slice(1).find((candidate) => candidate[index]?.trim() === code);
  return row ? { headers, row } : null;
}

function value(headers: string[], row: string[], name: string): number | null {
  const index = headerIndex(headers, name);
  return index < 0 ? null : numberOrNull(row[index]);
}

function blankFundamentals(reason: string): StockResearchData["fundamentals"] {
  return {
    status: "unavailable", reason, source: null, filedAt: null, fiscalYear: null, quarter: null,
    currency: "TWD; financial amounts in thousand TWD", revenueThousandTwd: null,
    operatingIncomeThousandTwd: null, netIncomeThousandTwd: null, epsTwd: null,
    assetsThousandTwd: null, liabilitiesThousandTwd: null, equityThousandTwd: null,
  };
}

async function loadFundamentals(code: string, exchange: Exchange | null): Promise<StockResearchData["fundamentals"]> {
  const exchanges: Exchange[] = exchange ? [exchange] : ["TW", "TWO"];
  for (const market of exchanges) {
    for (const sector of ["ci", "basi", "bd", "fh", "ins", "mim"]) {
      try {
        const prefix = market === "TW" ? "L" : "O";
        const [incomeText, balanceText] = await Promise.all([
          fetchText(`https://mopsfin.twse.com.tw/opendata/t187ap06_${prefix}_${sector}.csv`),
          fetchText(`https://mopsfin.twse.com.tw/opendata/t187ap07_${prefix}_${sector}.csv`),
        ]);
        const income = rowByCode(csvRows(incomeText), code);
        const balance = rowByCode(csvRows(balanceText), code);
        if (!income || !balance) continue;
        const fiscalYear = numberOrNull(income.row[headerIndex(income.headers, "年度")]);
        const quarter = numberOrNull(income.row[headerIndex(income.headers, "季別")]);
        const balanceYear = numberOrNull(balance.row[headerIndex(balance.headers, "年度")]);
        const balanceQuarter = numberOrNull(balance.row[headerIndex(balance.headers, "季別")]);
        if (fiscalYear === null || quarter === null || fiscalYear !== balanceYear || quarter !== balanceQuarter) {
          return blankFundamentals("官方損益表與資產負債表期間不一致，未合併顯示");
        }
        return {
          status: "available", reason: null,
          source: `MOPS Open Data (${market === "TW" ? "上市" : "上櫃"} · ${sector})`,
          filedAt: rocDate(income.row[headerIndex(income.headers, "出表日期")]),
          fiscalYear: fiscalYear + 1911, quarter,
          currency: "TWD; financial amounts in thousand TWD",
          revenueThousandTwd: value(income.headers, income.row, "營業收入"),
          operatingIncomeThousandTwd: value(income.headers, income.row, "營業利益（損失）"),
          netIncomeThousandTwd: value(income.headers, income.row, "本期淨利（淨損）"),
          epsTwd: value(income.headers, income.row, "基本每股盈餘（元）"),
          assetsThousandTwd: value(balance.headers, balance.row, "資產總計"),
          liabilitiesThousandTwd: value(balance.headers, balance.row, "負債總計"),
          equityThousandTwd: value(balance.headers, balance.row, "權益總計"),
        };
      } catch { /* Try the next official sector file. */ }
    }
  }
  return blankFundamentals("官方 MOPS 尚未提供此代號可配對的季報");
}

function taipeiDate(offset: number): { iso: string; roc: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const date = new Date(Date.UTC(part("year"), part("month") - 1, part("day") - offset));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return { iso, roc: `${year - 1911}/${pad(month)}/${pad(day)}` };
}

function blankInstitutional(reason: string): StockResearchData["institutional"] {
  return { status: "unavailable", reason, source: null, observedAt: null, foreignNetShares: null, investmentTrustNetShares: null, dealerNetShares: null, totalNetShares: null };
}

async function loadInstitutional(
  code: string,
  exchange: Exchange | null,
  preferredDate?: string,
): Promise<StockResearchData["institutional"]> {
  const markets: Exchange[] = exchange ? [exchange] : ["TW", "TWO"];
  const dates = preferredDate
    ? (() => {
        const [year, month, day] = preferredDate.split("-").map(Number);
        const pad = (value: number) => String(value).padStart(2, "0");
        return [{ iso: preferredDate, roc: `${year! - 1911}/${pad(month!)}\/${pad(day!)}` }];
      })()
    : Array.from({ length: 7 }, (_, offset) => taipeiDate(offset));
  for (const date of dates) {
    for (const market of markets) {
      try {
        if (market === "TWO") {
          const url = `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&d=${date.roc}&s=0,asc,0&o=json`;
          const payload = await fetchJson<{ tables?: Array<{ date?: string; data?: string[][] }> }>(url, preferredDate ? 6_000 : 15_000);
          const row = payload.tables?.[0]?.data?.find((item) => item[0]?.trim() === code);
          if (row) return {
            status: "available", reason: null, source: "TPEx 三大法人日交易資訊",
            observedAt: date.iso, foreignNetShares: numberOrNull(row[10]),
            investmentTrustNetShares: numberOrNull(row[13]), dealerNetShares: numberOrNull(row[22]),
            totalNetShares: numberOrNull(row[23]),
          };
        } else {
          const url = new URL("https://www.twse.com.tw/rwd/zh/fund/T86");
          url.searchParams.set("response", "json"); url.searchParams.set("date", date.iso.replaceAll("-", ""));
          url.searchParams.set("selectType", "ALLBUT0999");
          const payload = await fetchJson<{ stat?: string; fields?: string[]; data?: string[][] }>(url.toString(), preferredDate ? 6_000 : 15_000);
          const row = payload.data?.find((item) => item[0]?.trim() === code);
          if (row) {
            const fields = payload.fields ?? [];
            const net = (labels: string[]) => {
              const index = fields.findIndex((field) => labels.some((label) => field.includes(label)));
              return index < 0 ? null : numberOrNull(row[index]);
            };
            const foreignExcludingDealer = net(["外陸資買賣超股數(不含外資自營商)"]);
            const foreignDealer = net(["外資自營商買賣超股數"]);
            return { status: "available", reason: null, source: "TWSE T86 三大法人日買賣超", observedAt: date.iso,
              foreignNetShares: foreignExcludingDealer !== null && foreignDealer !== null
                ? foreignExcludingDealer + foreignDealer
                : null,
              investmentTrustNetShares: net(["投信買賣超股數"]),
              dealerNetShares: net(["自營商買賣超股數"]), totalNetShares: net(["三大法人買賣超股數"]) };
          }
        }
      } catch { /* A holiday or provider error: try the prior date/source. */ }
    }
  }
  return blankInstitutional("近七個日曆日沒有官方三大法人資料");
}

async function loadFinMindInstitutional(
  code: string,
  marketDate: string,
): Promise<StockResearchData["institutional"] | null> {
  const token = process.env.FINMIND_API_TOKEN?.trim();
  if (!token) return null;
  try {
    const url = new URL("https://api.finmindtrade.com/api/v4/data");
    url.searchParams.set("dataset", "TaiwanStockInstitutionalInvestorsBuySell");
    url.searchParams.set("data_id", code);
    url.searchParams.set("start_date", marketDate);
    url.searchParams.set("end_date", marketDate);
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": UA },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as {
      status?: number;
      data?: Array<{ date?: string; name?: string; buy?: number | string; sell?: number | string }>;
    };
    if (payload.status !== 200 || !Array.isArray(payload.data)) return null;
    const rows = payload.data.filter((row) => row.date === marketDate);
    const netFor = (names: string[]) => {
      const matching = rows.filter((row) => names.includes(row.name ?? ""));
      if (!matching.length) return null;
      const values = matching.map((row) => {
        const buy = typeof row.buy === "number" ? row.buy : numberOrNull(String(row.buy ?? ""));
        const sell = typeof row.sell === "number" ? row.sell : numberOrNull(String(row.sell ?? ""));
        return buy === null || sell === null ? null : buy - sell;
      });
      return values.some((value) => value === null)
        ? null
        : values.reduce<number>((sum, value) => sum + value!, 0);
    };
    const foreignNetShares = netFor(["Foreign_Investor", "Foreign_Dealer_Self"]);
    const investmentTrustNetShares = netFor(["Investment_Trust"]);
    if (foreignNetShares === null || investmentTrustNetShares === null) return null;
    return {
      status: "available",
      reason: null,
      source: "FinMind TaiwanStockInstitutionalInvestorsBuySell（備援）",
      observedAt: marketDate,
      foreignNetShares,
      investmentTrustNetShares,
      dealerNetShares: netFor(["Dealer_self", "Dealer_Hedging"]),
      totalNetShares: netFor(["Foreign_Investor", "Foreign_Dealer_Self", "Investment_Trust", "Dealer_self", "Dealer_Hedging"]),
    };
  } catch {
    return null;
  }
}

export async function getStockResearchData(symbol: string, ticker?: string): Promise<StockResearchData> {
  const code = symbol.trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
  if (!/^[A-Z0-9]{4,6}$/.test(code)) throw new Error("請輸入台灣股票代號");
  const normalizedTicker = ticker?.trim().toUpperCase() || null;
  const exchange = normalizedTicker?.endsWith(".TWO") ? "TWO" : normalizedTicker?.endsWith(".TW") ? "TW" : null;
  const [fundamentals, institutional] = await Promise.all([
    loadFundamentals(code, exchange), loadInstitutional(code, exchange),
  ]);
  return { symbol: code, ticker: normalizedTicker ?? (institutional.status === "available" ? `${code}.${institutional.source?.startsWith("TPEx") ? "TWO" : "TW"}` : null), fundamentals, institutional };
}

export async function getStockInstitutionalData(
  symbol: string,
  ticker?: string,
  marketDate?: string,
): Promise<StockResearchData["institutional"]> {
  const code = symbol.trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
  if (!/^[A-Z0-9]{4,6}$/.test(code)) throw new Error("請輸入台灣股票代號");
  const normalizedTicker = ticker?.trim().toUpperCase() || "";
  const exchange = normalizedTicker.endsWith(".TWO")
    ? "TWO"
    : normalizedTicker.endsWith(".TW")
      ? "TW"
      : null;
  const official = await loadInstitutional(code, exchange, marketDate);
  if (
    official.status === "available" &&
    official.foreignNetShares !== null &&
    official.investmentTrustNetShares !== null &&
    (!marketDate || official.observedAt === marketDate)
  ) {
    return official;
  }
  const finMind = marketDate ? await loadFinMindInstitutional(code, marketDate) : null;
  if (finMind) return finMind;
  return official;
}

export async function getInvestmentTrustBuyStreak(
  symbol: string,
  ticker?: string,
  { includeToday = true, maxCalendarDays = 14 }: {
    includeToday?: boolean;
    maxCalendarDays?: number;
  } = {},
): Promise<{ count: number; observedDates: string[]; source: string }> {
  const code = symbol.trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
  if (!/^[A-Z0-9]{4,6}$/.test(code)) throw new Error("請輸入台灣股票代號");
  const normalizedTicker = ticker?.trim().toUpperCase() ?? "";
  const market: Exchange | null = normalizedTicker.endsWith(".TWO")
    ? "TWO"
    : normalizedTicker.endsWith(".TW")
      ? "TW"
      : null;
  const markets: Exchange[] = market ? [market] : ["TW", "TWO"];
  const observedDates: string[] = [];
  let count = 0;
  let source = "";

  for (let offset = includeToday ? 0 : 1; offset <= maxCalendarDays; offset += 1) {
    const date = taipeiDate(offset);
    let foundTradingDay = false;
    let trustNet: number | null = null;
    for (const exchange of markets) {
      try {
        if (exchange === "TWO") {
          const url = `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&d=${date.roc}&s=0,asc,0&o=json`;
          const payload = await fetchJson<{ tables?: Array<{ date?: string; data?: string[][] }> }>(url);
          const table = payload.tables?.[0];
          if (!table?.date && !table?.data?.length) continue;
          foundTradingDay = true;
          const row = table.data?.find((item) => item[0]?.trim() === code);
          trustNet = row ? numberOrNull(row[13]) : 0;
          source = "TPEx 三大法人日交易資訊";
        } else {
          const url = new URL("https://www.twse.com.tw/rwd/zh/fund/T86");
          url.searchParams.set("response", "json");
          url.searchParams.set("date", date.iso.replaceAll("-", ""));
          url.searchParams.set("selectType", "ALLBUT0999");
          const payload = await fetchJson<{ stat?: string; fields?: string[]; data?: string[][] }>(url.toString());
          if (payload.stat !== "OK") continue;
          foundTradingDay = true;
          const row = payload.data?.find((item) => item[0]?.trim() === code);
          const index = payload.fields?.findIndex((field) => field.includes("投信買賣超股數")) ?? -1;
          trustNet = row && index >= 0 ? numberOrNull(row[index]) : 0;
          source = "TWSE T86 三大法人日買賣超";
        }
        break;
      } catch {
        // A holiday/provider failure is skipped; a valid trading-day row below
        // is required before counting a consecutive positive streak.
      }
    }
    if (!foundTradingDay) continue;
    observedDates.push(date.iso);
    if (trustNet === null || trustNet <= 0) break;
    count += 1;
  }
  return { count, observedDates, source: source || "TWSE／TPEx 三大法人日交易資料" };
}

export async function getOfficialHolderMarginScore(
  symbol: string,
  dates: string[],
  exchange: "TW" | "TWO",
): Promise<{ points: number | null; note: string; source: string | null }> {
  const code = symbol.trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
  if (exchange === "TWO") {
    const [holders, marginRows] = await Promise.all([
      fetchJson<Array<Record<string, unknown>>>("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap02_O"),
      fetchJson<Array<Record<string, unknown>>>("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance"),
    ]);
    const holderRow = holders.find((row) => String(row.SecuritiesCompanyCode ?? "").trim() === code);
    const holderDate = rocDate(String(holderRow?.Date ?? holders[0]?.Date ?? ""));
    const margin = marginRows.find((row) => String(row.SecuritiesCompanyCode ?? "").trim() === code);
    if (!margin || !holderDate) {
      return { points: null, note: "TPEx 官方融資融券餘額尚無此股票資料，未估分。", source: "TPEx OpenAPI" };
    }
    const expectedDate = dates.at(-1);
    const observedDate = rocDate(String(margin.Date ?? ""));
    if (!expectedDate || observedDate !== expectedDate) {
      return { points: null, note: "TPEx 融資融券資料日期與最新完整日線不一致，未估分。", source: "TPEx OpenAPI" };
    }
    const currentFinancing = numberOrNull(String(margin.MarginPurchaseBalance ?? ""));
    const priorFinancing = numberOrNull(String(margin.MarginPurchaseBalancePreviousDay ?? ""));
    const currentShort = numberOrNull(String(margin.ShortSaleBalance ?? ""));
    const priorShort = numberOrNull(String(margin.ShortSaleBalancePreviousDay ?? ""));
    if ([currentFinancing, priorFinancing, currentShort, priorShort].some((value) => value === null)) {
      return { points: null, note: "TPEx 官方融資融券餘額欄位不完整，未估分。", source: "TPEx OpenAPI" };
    }
    const marginPoints = currentFinancing! < priorFinancing! && currentShort! <= priorShort!
      ? 5
      : currentFinancing! <= priorFinancing! || currentShort! > priorShort!
        ? 2
        : 0;
    return {
      points: (holderRow ? 5 : 0) + marginPoints,
      note: `TPEx 逾 10% 大股東名單${holderRow ? "有列示" : "未列示"}（${holderDate}）；融資融券餘額資料日 ${observedDate}，融資${currentFinancing! < priorFinancing! ? "下降" : currentFinancing! > priorFinancing! ? "上升" : "持平"}、融券${currentShort! < priorShort! ? "下降" : currentShort! > priorShort! ? "上升" : "持平"}。`,
      source: "TPEx OpenAPI 大股東名單與融資融券餘額",
    };
  }
  if (dates.length < 2) {
    return { points: null, note: "TWSE 日線交易日不足兩日，未估分。", source: null };
  }
  const [holders, currentMargin, previousMargin] = await Promise.all([
    fetchJson<Array<Record<string, unknown>>>("https://openapi.twse.com.tw/v1/opendata/t187ap02_L"),
    fetchJson<{ date?: string; tables?: Array<{ title?: string; data?: string[][] }> }>(
      `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${dates.at(-1)!.replaceAll("-", "")}&selectType=ALL&response=json`,
    ),
    fetchJson<{ date?: string; tables?: Array<{ title?: string; data?: string[][] }> }>(
      `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${dates.at(-2)!.replaceAll("-", "")}&selectType=ALL&response=json`,
    ),
  ]);
  if (
    currentMargin.date !== dates.at(-1)!.replaceAll("-", "") ||
    previousMargin.date !== dates.at(-2)!.replaceAll("-", "")
  ) {
    return { points: null, note: "TWSE 融資融券資料日期與最新完整日線不一致，未估分。", source: "TWSE Open Data／MI_MARGN" };
  }
  const holderRow = holders.find((row) => String(row["公司代號"] ?? "").trim() === code);
  const holderDate = rocDate(String(holderRow?.["出表日期"] ?? holders[0]?.["出表日期"] ?? ""));
  if (!holderDate) {
    return { points: null, note: "TWSE 官方大股東快照日期無法確認，未估分。", source: "TWSE Open Data／MI_MARGN" };
  }
  const findMarginRow = (payload: { tables?: Array<{ title?: string; data?: string[][] }> }) =>
    payload.tables?.find((table) => table.title?.includes("融資融券彙總"))?.data
      ?.find((row) => row[0]?.trim() === code);
  const current = findMarginRow(currentMargin);
  const previous = findMarginRow(previousMargin);
  if (!current || !previous) {
    return {
      points: null,
      note: "官方大股東或兩個交易日的融資融券資料不完整，未估分。",
      source: "TWSE Open Data／MI_MARGN",
    };
  }
  const currentFinancing = numberOrNull(current[6]);
  const priorFinancing = numberOrNull(previous[6]);
  const currentShort = numberOrNull(current[12]);
  const priorShort = numberOrNull(previous[12]);
  if ([currentFinancing, priorFinancing, currentShort, priorShort].some((value) => value === null)) {
    return { points: null, note: "官方融資融券欄位不完整，未估分。", source: "TWSE Open Data／MI_MARGN" };
  }
  const marginPoints = currentFinancing! < priorFinancing! && currentShort! <= priorShort!
    ? 5
    : currentFinancing! <= priorFinancing! || currentShort! > priorShort!
      ? 2
      : 0;
  const points = (holderRow ? 5 : 0) + marginPoints;
  return {
    points,
    note: `TWSE 逾 10% 大股東名單${holderRow ? "有列示" : "未列示"}（${holderDate}）；融資融券餘額資料日 ${dates.at(-1)}，融資${currentFinancing! < priorFinancing! ? "下降" : currentFinancing! > priorFinancing! ? "上升" : "持平"}、融券${currentShort! < priorShort! ? "下降" : currentShort! > priorShort! ? "上升" : "持平"}。`,
    source: "TWSE Open Data 大股東名單與 MI_MARGN",
  };
}