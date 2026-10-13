# ----------------- app_18.py (完整專業終端升級版 - 大盤與買進試算優化版) -----------------
from datetime import datetime, timedelta
from html import escape
import textwrap
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import requests
import streamlit as st
import yfinance as yf
import time

# ----------------- 1. 頁面配置與 CSS 樣式 -----------------
st.set_page_config(
    page_title="AI 股市量化決策控制台 (專業終端版)",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown(
    """<style>
.stApp { background-color: #0b0e14; color: #e0e6ed; }

.block-container { 
    padding-top: 3rem !important; 
    padding-bottom: 3rem !important; 
    padding-left: 3rem !important; 
    padding-right: 3rem !important; 
}

.card-header { font-size: 0.95rem; font-weight: bold; color: #8b9bb4; margin-bottom: 8px; display: flex; align-items: center; }
.card-header-badge { background-color: #1e2638; color: #38bdf8; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; margin-right: 8px; font-weight: bold; letter-spacing: 0.5px; border: 1px solid #334155; }

/* 頂部資訊列 */
.top-header { 
    background-color: #12161f; 
    border-bottom: 1px solid #232a36; 
    padding: 14px 18px; 
    border-radius: 8px; 
    margin-bottom: 16px; 
}
.header-container { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.header-title-box { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 250px; }
.header-stats-box { display: flex; align-items: center; flex-wrap: wrap; gap: 20px; }

.symbol-title { font-size: clamp(1.4rem, 2vw, 1.8rem); font-weight: 800; color: #ffffff; line-height: 1.2; }
.price-large { font-size: clamp(1.4rem, 2vw, 1.8rem); font-weight: 800; line-height: 1.2; }
.up-red { color: #ff4d4d; }
.down-green { color: #00e676; }

/* 側邊欄卡片 */
.market-card { background: linear-gradient(135deg, #151b26 0%, #10141d 100%); border: 1px solid #2a3447; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.market-title { font-size: 0.85rem; font-weight: bold; color: #94a3b8; display: flex; justify-content: space-between; align-items: center; }
.market-price { font-size: 1.35rem; font-weight: 800; margin-top: 4px; }

/* 市場環境側邊欄卡片樣式 */
.env-sidebar-card { background: #121621; border: 1px solid #232d3f; border-radius: 8px; padding: 10px; margin-bottom: 12px; font-size: 0.8rem; }
.env-status-badge { font-size: 0.85rem; font-weight: bold; padding: 4px 8px; border-radius: 4px; display: inline-block; }
.badge-bull { background-color: rgba(0, 230, 118, 0.15); color: #00e676; border: 1px solid #00e676; }
.badge-neutral { background-color: rgba(255, 204, 0, 0.15); color: #ffcc00; border: 1px solid #ffcc00; }
.badge-bear { background-color: rgba(255, 77, 77, 0.15); color: #ff4d4d; border: 1px solid #ff4d4d; }

/* 買進建議判定徽章 */
.badge-buy-green { background-color: rgba(0, 230, 118, 0.2); color: #00e676; border: 1px solid #00e676; padding: 6px 14px; border-radius: 6px; font-weight: bold; font-size: 1.05rem; }
.badge-buy-yellow { background-color: rgba(245, 158, 11, 0.2); color: #f59e0b; border: 1px solid #f59e0b; padding: 6px 14px; border-radius: 6px; font-weight: bold; font-size: 1.05rem; }
.badge-buy-red { background-color: rgba(255, 77, 77, 0.2); color: #ff4d4d; border: 1px solid #ff4d4d; padding: 6px 14px; border-radius: 6px; font-weight: bold; font-size: 1.05rem; }

/* 主頁分區塊分組樣式 */
.main-section {
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 20px;
}
.main-section-title {
    font-size: 1.1rem;
    font-weight: bold;
    color: #58a6ff;
    margin-bottom: 12px;
    border-bottom: 1px solid #30363d;
    padding-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
}

@media (max-width: 768px) {
    .header-container { flex-direction: column; align-items: flex-start; }
    .header-stats-box { width: 100%; justify-content: space-between; gap: 10px; }
}
</style>""",
    unsafe_allow_html=True,
)

st.markdown(
    """<style>
:root { color-scheme: light; }
.stApp, [data-testid="stAppViewContainer"] {
    color: #1e293b;
    background:
      radial-gradient(ellipse at 8% 2%, rgba(183, 218, 255, .36), transparent 33%),
      radial-gradient(ellipse at 94% 8%, rgba(217, 204, 255, .28), transparent 30%),
      linear-gradient(145deg, #f8fbff 0%, #f2f6fc 48%, #fbfcff 100%);
}
[data-testid="stAppViewContainer"], [data-testid="stSidebar"],
[data-testid="stAppViewContainer"] .stMarkdown,
[data-testid="stSidebar"] .stMarkdown,
[data-testid="stWidgetLabel"] p,
[data-testid="stWidgetLabel"] label,
[data-testid="stCaptionContainer"] {
    color: #1e293b !important;
}
[data-testid="stCaptionContainer"] { color:#475569 !important; }
[data-testid="stExpander"] details {
    background: rgba(255,255,255,.78);
    border: 1px solid rgba(176,196,225,.52);
    border-radius: 14px;
    box-shadow: 0 8px 22px rgba(71,91,126,.06);
    transition: box-shadow 220ms ease, transform 220ms ease, border-color 220ms ease;
}
[data-testid="stExpander"] summary { color:#1e293b !important; }
[data-testid="stExpander"] summary:hover { color:#0f172a !important; }
[data-testid="stHeader"] { background: rgba(248, 251, 255, .68); }
[data-testid="stSidebar"] {
    background: linear-gradient(180deg, rgba(255,255,255,.88), rgba(242,247,255,.82));
    border-right: 1px solid rgba(255,255,255,.9);
    box-shadow: 12px 0 38px rgba(69, 96, 138, .08);
    transition: width 260ms cubic-bezier(.2,.75,.25,1), box-shadow 220ms ease;
}
.block-container { max-width: 1580px; }
.main-section, .top-header, .market-card, .env-sidebar-card,
.stPlotlyChart, [data-testid="stMetric"] {
    background: linear-gradient(135deg, rgba(255,255,255,.88), rgba(247,250,255,.72)) !important;
    border: 1px solid rgba(255,255,255,.96) !important;
    border-radius: 20px !important;
    box-shadow: 0 16px 44px rgba(67, 91, 130, .09), inset 0 1px 0 rgba(255,255,255,.95);
    backdrop-filter: blur(18px) saturate(145%);
    -webkit-backdrop-filter: blur(18px) saturate(145%);
}
.main-section { border-color: rgba(186, 203, 229, .46) !important; padding: 20px; }
.top-header { border-color: rgba(181, 204, 238, .55) !important; }
.main-section-title { color: #2563eb !important; border-color: rgba(148, 163, 184, .25) !important; }
.card-header { color: #475569 !important; }
.card-header-badge {
    color: #2563eb !important; background: rgba(219,234,254,.74) !important;
    border-color: rgba(96,165,250,.38) !important; border-radius: 999px !important;
}
.symbol-title { color: #172554 !important; }
.market-title { color: #475569 !important; }
.market-price { color: #172554; }
.env-sidebar-card { color: #475569; }
[class*="badge-bull"] { background: rgba(220,252,231,.78) !important; color: #15803d !important; border-color: #86efac !important; }
[class*="badge-neutral"] { background: rgba(254,249,195,.82) !important; color: #a16207 !important; border-color: #fde047 !important; }
[class*="badge-bear"] { background: rgba(254,226,226,.82) !important; color: #b91c1c !important; border-color: #fca5a5 !important; }
.up-red { color: #dc2626 !important; }
.down-green { color: #059669 !important; }
.badge-buy-green { color:#15803d !important; background:rgba(220,252,231,.8) !important; border-color:#86efac !important; }
.badge-buy-yellow { color:#a16207 !important; background:rgba(254,249,195,.8) !important; border-color:#fde047 !important; }
.badge-buy-red { color:#b91c1c !important; background:rgba(254,226,226,.8) !important; border-color:#fca5a5 !important; }
/* Restyle the legacy inline dark cards without losing their signal accent colors. */
[style*="background:#121621"], [style*="background:#121824"],
[style*="background:#131a29"], [style*="background:#111827"],
[style*="background:#161d2a"], [style*="background:#182030"],
[style*="background:#1e293b"], [style*="background:#1a2332"],
[style*="background:#0f172a"] {
    background: linear-gradient(135deg, rgba(255,255,255,.9), rgba(244,248,255,.8)) !important;
    border-color: rgba(176,196,225,.5) !important;
    box-shadow: 0 8px 24px rgba(71,91,126,.07), inset 0 1px rgba(255,255,255,.9);
    border-radius: 14px !important;
}
[style*="color:#ffffff"], [style*="color:#fff"], [style*="color:#f8fafc"],
[style*="color:#e0e6ed"], [style*="color:#cbd5e1"], [style*="color:#d1d5db"] {
    color: #1e293b !important;
}
[style*="color:#94a3b8"], [style*="color:#8b9bb4"], [style*="color:#64748b"] {
    color: #64748b !important;
}
[style*="color:#38bdf8"] { color:#0369a1 !important; }
[style*="color:#f59e0b"], [style*="color:#ffaa00"] { color:#a16207 !important; }
[style*="color:#ff4d4d"] { color:#dc2626 !important; }
[style*="color:#00e676"] { color:#047857 !important; }
[style*="color:#a855f7"] { color:#7e22ce !important; }
[style*="color:#ec4899"] { color:#be185d !important; }
[style*="border-left:4px solid"] { background-color: rgba(255,255,255,.78) !important; }
.stTextInput input, .stNumberInput input, [data-baseweb="select"] > div {
    background: rgba(255,255,255,.82) !important; color:#1e293b !important;
    border-color: rgba(148,163,184,.42) !important; border-radius: 12px !important;
}
.stButton button { border-radius: 12px; }
.main-section, .top-header, .market-card, .env-sidebar-card,
.sidebar-signal-card, [data-testid="stPlotlyChart"], [data-testid="stMetric"],
[data-testid="stExpander"] details,
div[style*="background:#121621"], div[style*="background:#121824"],
div[style*="background:#131a29"], div[style*="background:#111827"],
div[style*="background:#161d2a"], div[style*="background:#182030"],
div[style*="background:#1e293b"], div[style*="background:#1a2332"],
div[style*="background:#0f172a"] {
    position: relative;
    transition: transform 220ms cubic-bezier(.2,.75,.25,1),
                box-shadow 240ms ease, border-color 220ms ease,
                filter 220ms ease;
    transform-origin: center;
}
.sidebar-signal-card {
    background: linear-gradient(135deg, rgba(255,255,255,.94), rgba(241,247,255,.82));
    border: 1px solid rgba(176,196,225,.55);
    border-radius: 16px;
    padding: 12px;
    box-shadow: 0 10px 28px rgba(71,91,126,.08), inset 0 1px rgba(255,255,255,.95);
    backdrop-filter: blur(16px) saturate(145%);
}
.sidebar-signal-card .signal-title { font-weight:800; font-size:1rem; margin:7px 0 2px; }
.sidebar-signal-card .signal-confidence { color:#475569; font-size:.8rem; }
.sidebar-signal-card .signal-reasons { padding-left:1.2rem; margin:.4rem 0 0; font-size:.76rem; line-height:1.45; }
.main-section::after, .top-header::after, .market-card::after,
.env-sidebar-card::after, .sidebar-signal-card::after {
    content:"";
    position:absolute;
    inset:0;
    border-radius:inherit;
    pointer-events:none;
    opacity:0;
    background:linear-gradient(112deg, transparent 26%, rgba(255,255,255,.72) 49%, transparent 66%);
    transform:translateX(-110%);
    transition:transform 480ms cubic-bezier(.2,.75,.25,1), opacity 220ms ease;
}
@media (hover: hover) and (pointer: fine) {
    .main-section:hover, .top-header:hover, .market-card:hover,
    .env-sidebar-card:hover, .sidebar-signal-card:hover,
    [data-testid="stPlotlyChart"]:hover, [data-testid="stMetric"]:hover,
    [data-testid="stExpander"] details:hover,
    div[style*="background:#121621"]:hover,
    div[style*="background:#121824"]:hover,
    div[style*="background:#131a29"]:hover,
    div[style*="background:#111827"]:hover,
    div[style*="background:#161d2a"]:hover,
    div[style*="background:#182030"]:hover,
    div[style*="background:#1e293b"]:hover,
    div[style*="background:#1a2332"]:hover,
    div[style*="background:#0f172a"]:hover {
        transform: translateY(-3px) scale(1.003);
        border-color: rgba(96,165,250,.52) !important;
        box-shadow: 0 20px 48px rgba(58,88,139,.15),
                    0 0 0 1px rgba(147,197,253,.18),
                    inset 0 1px 0 rgba(255,255,255,.98);
        filter: saturate(1.04);
    }
    .main-section:hover::after, .top-header:hover::after, .market-card:hover::after,
    .env-sidebar-card:hover::after, .sidebar-signal-card:hover::after {
        opacity:.55;
        transform:translateX(110%);
    }
    .stButton button:hover, .stDownloadButton button:hover,
    [data-testid="stSidebarCollapseButton"] button:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 20px rgba(59,130,246,.18);
        border-color: rgba(96,165,250,.58) !important;
    }
}
.stButton button, .stDownloadButton button,
[data-testid="stSidebarCollapseButton"] button {
    transition: transform 180ms ease, box-shadow 200ms ease, border-color 180ms ease;
}
button:focus-visible, input:focus-visible {
    outline: 3px solid rgba(59,130,246,.32) !important;
    outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
        transition-duration: .01ms !important;
        scroll-behavior: auto !important;
    }
}
@media (max-width: 768px) {
    .block-container { padding: 1.1rem 1rem 2rem !important; }
    .main-section { padding: 14px; }
}
</style>""",
    unsafe_allow_html=True,
)


# ----------------- 2. 數據抓取與智慧雙軌自動備援引擎 (大盤數據高精確修復版) -----------------
_HTTP = requests.Session()
_HTTP.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
})


def _to_float(value, default=None):
    try:
        if value is None:
            return default
        value = str(value).strip().replace(",", "")
        if value in ("", "-", "--", "null", "None"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _make_quote(curr, change=None, pct=None, ref=None, source="", quote_time=""):
    curr = _to_float(curr)
    ref = _to_float(ref)

    if change is None:
        change = curr - ref if curr is not None and ref is not None and curr > 0 and ref > 0 else None
    else:
        change = _to_float(change)

    if pct is None:
        pct = (change / ref * 100.0) if change is not None and ref is not None and ref > 0 else None
    else:
        pct = _to_float(pct)

    return {
        "curr": round(curr, 2) if curr is not None else None,
        "change": round(change, 2) if change is not None else None,
        "pct": round(pct, 2) if pct is not None else None,
        "source": source,
        "quote_time": str(quote_time or ""),
        "received_at": time.time(),
    }


def _fetch_twse_taiex():
    ts = int(time.time() * 1000)
    url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
    params = {"ex_ch": "tse_t00.tw", "_": str(ts)}

    r = _HTTP.get(url, params=params, timeout=3.5)
    r.raise_for_status()
    payload = r.json()
    rows = payload.get("msgArray", [])

    if not rows:
        raise ValueError("TWSE MIS 沒有回傳 TAIEX 資料")

    d = rows[0]
    curr = _to_float(d.get("z"))
    prev = _to_float(d.get("y"))

    if curr is None or curr <= 0:
        raise ValueError(f"TWSE MIS TAIEX 最新成交值無效: {d.get('z')}")

    change = curr - prev if prev is not None and prev > 0 else _to_float(d.get("p"))
    pct = (change / prev * 100.0) if change is not None and prev is not None and prev > 0 else _to_float(d.get("o"))
    quote_time = d.get("t") or d.get("d") or ""

    quote = _make_quote(
        curr,
        change=change,
        pct=pct,
        ref=prev,
        source="TWSE MIS",
        quote_time=quote_time,
    )
    quote["is_realtime"] = True
    quote["available"] = True
    return quote


def _fetch_taifex_txf():
    try:
        txf_ticker = yf.Ticker("TX=F")
        hist = txf_ticker.history(period="5d")
        if not hist.empty and len(hist) >= 2:
            curr = float(hist["Close"].iloc[-1])
            prev = float(hist["Close"].iloc[-2])
            change = round(curr - prev, 2)
            pct = round((change / prev) * 100, 2)
            return {
                "curr": round(curr, 2),
                "change": change,
                "pct": pct,
                "source": "Yahoo Finance (TX=F)",
                "quote_time": hist.index[-1].strftime("%H:%M:%S"),
            }
    except Exception:
        pass
    return {
        "curr": None,
        "change": None,
        "pct": None,
        "source": "TAIFEX／期貨來源目前無法取得",
        "quote_time": "",
        "available": False,
        "is_realtime": False,
    }


def fetch_realtime_index_and_futures():
    try:
        tse = _fetch_twse_taiex()
        st.session_state["last_known_tse"] = tse
    except Exception as exc:
        tse = st.session_state.get("last_known_tse")
        if tse is None or tse.get("curr") is None or tse.get("curr", 0) <= 0:
            tse = {
                "curr": None,
                "change": None,
                "pct": None,
                "source": "TWSE MIS 暫時無法取得",
                "quote_time": "",
                "received_at": None,
                "available": False,
                "is_realtime": False,
                "error": str(exc),
            }
        else:
            tse = {**tse, "stale": True, "stale_reason": "TWSE MIS 暫時無法取得，沿用最近一次實際交易所報價"}
    return tse, _fetch_taifex_txf()


@st.cache_data(ttl=10)
def fetch_realtime_stock_quote(symbol):
    symbol = str(symbol).strip().upper()
    for t in [f"{symbol}.TW", f"{symbol}.TWO", symbol]:
        try:
            stock = yf.Ticker(t)
            hist = stock.history(period="5d")
            if not hist.empty:
                curr = float(hist["Close"].iloc[-1])
                prev = float(hist["Close"].iloc[-2]) if len(hist) >= 2 else curr
                change = round(curr - prev, 2)
                pct = round((change / prev) * 100, 2) if prev > 0 else 0.0
                vol = int(hist["Volume"].iloc[-1])
                high = float(hist["High"].iloc[-1])
                low = float(hist["Low"].iloc[-1])
                return {
                    "curr": round(curr, 2),
                    "change": change,
                    "pct": pct,
                    "volume": vol,
                    "high": high,
                    "low": low,
                    "source": f"Yahoo Finance ({t}) 日線（非即時）",
                    "success": False,
                    "available": True,
                    "is_realtime": False,
                    "quote_time": hist.index[-1].strftime("%Y-%m-%d %H:%M:%S"),
                }
        except Exception:
            continue
    return {
        "curr": None,
        "change": None,
        "pct": None,
        "volume": None,
        "high": None,
        "low": None,
        "source": "個股日線來源目前無法取得",
        "success": False,
        "available": False,
        "is_realtime": False,
        "error": "Yahoo Finance 未回傳有效日線",
    }


@st.cache_data(ttl=30)
def fetch_taiex_market_env():
    tse_data, _ = fetch_realtime_index_and_futures()
    env_res = {
        "curr": tse_data["curr"],
        "change": tse_data["change"],
        "pct": tse_data["pct"],
        "ma20": None,
        "ma60": None,
        "ma120": None,
        "ma20_gt_ma60": False,
        "price_gt_ma20": False,
        "price_data_available": False,
        "vol": None,
        "vol_status": "資料不足",
        "score": None,
        "quote_available": tse_data.get("curr") is not None,
    }

    try:
        twii = yf.Ticker("^TWII")
        hist = twii.history(period="6m")
        if not hist.empty and len(hist) >= 120:
            ma20 = float(hist["Close"].rolling(20).mean().iloc[-1])
            ma60 = float(hist["Close"].rolling(60).mean().iloc[-1])
            ma120 = float(hist["Close"].rolling(120).mean().iloc[-1])
            vol_curr = int(hist["Volume"].iloc[-1])
            vol_ma5 = float(hist["Volume"].rolling(5).mean().iloc[-1])

            env_res["ma20"] = ma20
            env_res["ma60"] = ma60
            env_res["ma120"] = ma120
            env_res["ma20_gt_ma60"] = ma20 > ma60
            env_res["price_gt_ma20"] = (
                env_res["curr"] is not None and env_res["curr"] > ma20
            )
            env_res["price_data_available"] = True
            env_res["vol"] = vol_curr
            env_res["vol_status"] = "量增" if vol_ma5 > 0 and vol_curr >= vol_ma5 else "量縮"
    except Exception:
        pass

    score = 0
    cond1 = env_res["ma20_gt_ma60"]
    cond2 = env_res["price_gt_ma20"]
    cond3 = env_res["vol_status"] == "量增" and env_res["price_data_available"]
    cond4 = env_res["change"] is not None and env_res["change"] >= 0
    cond5 = (
        env_res["ma60"] is not None
        and env_res["ma120"] is not None
        and env_res["ma60"] > env_res["ma120"] > 0
    )
    cond6 = env_res["pct"] is not None and env_res["pct"] > -1.0

    if env_res["price_data_available"] and env_res["quote_available"]:
        if cond1: score += 1
        if cond2: score += 1
        if cond3: score += 1
        if cond4: score += 1
        if cond5: score += 1
        if cond6: score += 1
    else:
        score = None

    env_res["score"] = score
    env_res["cond1"] = cond1
    env_res["cond2"] = cond2
    env_res["cond3"] = cond3
    env_res["cond4"] = cond4
    env_res["cond5"] = cond5
    env_res["cond6"] = cond6

    if score is None:
        env_res["env_style"] = "badge-neutral"
        env_res["env_light"] = "⚪ 大盤資料不足"
        env_res["env_desc"] = "未取得足夠的大盤即時報價與 120 個交易日資料，暫停市場環境評分。"
    elif score >= 5:
        env_res["env_style"] = "badge-bull"
        env_res["env_light"] = "🟢 強勢多頭 (允許做多)"
        env_res["env_desc"] = "大盤均線多頭排列且站穩月線，動能充沛。"
    elif score >= 3:
        env_res["env_style"] = "badge-neutral"
        env_res["env_light"] = "🟡 區間震盪 (謹慎做多)"
        env_res["env_desc"] = "大盤區間整理，宜嚴格控管倉位。"
    else:
        env_res["env_style"] = "badge-bear"
        env_res["env_light"] = "🔴 空頭修正 (嚴禁追高)"
        env_res["env_desc"] = "大盤趨勢偏空，系統性風險高，建議觀望。"

    return env_res


# ----------------- 3. 側邊欄：市場總覽 → 選股 → AI 決策 → 個人設定 -----------------
with st.sidebar:
    sidebar_overview_slot = st.container()
    sidebar_selection_slot = st.container()
    sidebar_decision_slot = st.container()
    sidebar_settings_slot = st.container()

with sidebar_overview_slot:
    st.subheader("🌐 市場總覽")
    enable_autorefresh = st.checkbox("每 2 秒更新大盤行情", value=True)

@st.fragment(run_every=2.0 if enable_autorefresh else None)
def render_sidebar_market_fragment():
    tse_data, _ = fetch_realtime_index_and_futures()
    current_time_str = datetime.now().strftime("%H:%M:%S")
    tse_live = tse_data.get("curr") is not None and tse_data.get("is_realtime", False)
    tse_stale = tse_data.get("curr") is not None and not tse_live
    tse_display = f"{tse_data['curr']:,.2f}" if tse_data.get("curr") is not None else "無法取得"

    change = tse_data.get("change")
    pct = tse_data.get("pct")
    tse_class = "up-red" if change is not None and change >= 0 else ("down-green" if change is not None else "")
    tse_sign = "+" if change is not None and change >= 0 else ""
    change_display = (
        f"{tse_sign}{change:,.2f} ({tse_sign}{pct:.2f}%)"
        if change is not None and pct is not None
        else "漲跌資料不足"
    )
    status_display = "即時" if tse_live else ("沿用舊報價（已過期）" if tse_stale else "目前無資料")

    st.markdown(
        f"""
    <div style="font-size:0.75rem; color:#0369a1; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
        <span>📡 行情資料</span>
        <span>{current_time_str}</span>
    </div>
    <div class="market-card">
        <div class="market-title">
            <span>📈 即時加權指數 (TAIEX)</span>
        </div>
        <div class="market-price {tse_class}">{tse_display}</div>
        <div style="font-size:0.85rem; font-weight:bold;" class="{tse_class}">
             {change_display}
        </div>
         <div style="font-size:0.68rem; color:#64748b; margin-top:4px;">狀態：{status_display} · 來源：{tse_data.get('source','')}</div>
         <div style="font-size:0.68rem; color:#64748b; margin-top:2px;">來源時間：{tse_data.get('quote_time') or '—'}</div>
    </div>
    """,
        unsafe_allow_html=True,
    )

with sidebar_overview_slot:
    render_sidebar_market_fragment()

env_data = fetch_taiex_market_env()
with sidebar_overview_slot:
    score_display = f"{env_data['score']}/6" if env_data["score"] is not None else "無法評分"
    trend_display = (
        ("多頭" if env_data["cond1"] else "空頭")
        if env_data["price_data_available"] and env_data["quote_available"]
        else "無法判定"
    )
    st.markdown(
        f"""
<div class="env-sidebar-card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <span class="card-header-badge" style="margin:0;">市場狀態</span>
        <span class="env-status-badge {env_data['env_style']}">{env_data['env_light']}</span>
    </div>
        <div style="color:#334155; margin-bottom:6px; line-height:1.3;">{env_data['env_desc']}</div>
    <div style="display:flex; justify-content:space-between; color:#475569; font-size:0.75rem;">
        <span>環境評分: <strong style="color:#0369a1;">{score_display}</strong></span>
        <span>均線結構: <strong>{trend_display}</strong></span>
    </div>
</div>
""",
        unsafe_allow_html=True,
    )

with sidebar_selection_slot:
    st.divider()
    st.subheader("🔎 選擇股票")
    input_symbol = (
        st.text_input("股票代號", value="2330", help="輸入台股代號，例如 2330 或 2454。")
        .strip()
        .upper()
    )

with sidebar_settings_slot:
    st.divider()
    st.subheader("⚙️ 個人與分析設定")
    with st.expander("💼 持倉設定", expanded=False):
        has_position = st.checkbox("啟用持倉損益分析", value=True)
        if has_position:
            buy_price = st.number_input(
                "平均成本 (元)", value=0.0, step=5.0,
                help="請輸入你的實際平均成本；0 表示尚未提供。",
            )
            holding_shares = st.number_input("持有股數", value=2000, step=1000)
        else:
            buy_price = 0.0
            holding_shares = 0

    with st.expander("🎛️ 分析與圖表", expanded=True):
        forecast_days = st.slider("預測交易日數", 3, 20, 10)
        show_ma_lines = st.checkbox("K 線顯示移動平均線", value=True)
        min_volume_threshold = st.number_input("最低成交量 (張)", value=1000, step=500)
        recent_high_days = st.slider("近期新高觀察日數", 10, 60, 20)
        atr_period = st.slider("ATR 計算週期", 5, 30, 14)


# ----------------- 4. 數據抓取與計算引擎 -----------------
@st.cache_data(ttl=60)
def fetch_accurate_stock_data(symbol):
    if not symbol:
        symbol = "2330"
    symbol = str(symbol).strip().upper()

    tickers = [f"{symbol}.TW", f"{symbol}.TWO", symbol] if symbol.isdigit() else [symbol, f"{symbol}.TW", f"{symbol}.TWO"]
    for t in tickers:
        try:
            stock = yf.Ticker(t)
            hist = stock.history(period="1y")
            if not hist.empty and len(hist) >= 5:
                return hist[["Open", "High", "Low", "Close", "Volume"]], f"{t} (Yahoo Finance)"
        except Exception:
            continue

    return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"]), (
        f"{symbol}（沒有可驗證的日線資料）"
    )


hist_df, matched_ticker = fetch_accurate_stock_data(input_symbol)
realtime_q = fetch_realtime_stock_quote(input_symbol)

if hist_df.empty or len(hist_df) < 120:
    st.error(
        f"無法取得 {input_symbol} 足夠的已驗證日線資料（需要至少 120 個交易日，"
        f"目前只有 {len(hist_df)} 筆）。已停止技術分析，不使用預設或合成資料。"
    )
    st.stop()
if not np.isfinite(hist_df[["Open", "High", "Low", "Close", "Volume"]].astype(float).to_numpy()).all():
    st.error("取得的日線含缺漏或非有限數值，已停止技術分析；不使用填補或合成資料。")
    st.stop()
if env_data["score"] is None:
    st.warning("大盤即時報價或歷史資料不足，已停止需要大盤評分的分析路徑。")
    st.stop()

if realtime_q.get("success", False) and realtime_q["curr"] > 0:
    curr_p = realtime_q["curr"]
    change_val = realtime_q["change"]
    change_pct = realtime_q["pct"]
    vol = realtime_q["volume"]
    high_p = max(float(hist_df["High"].max()), realtime_q["high"])
    low_p = min(float(hist_df["Low"].min()), realtime_q["low"])
    matched_ticker = f"{input_symbol} · {realtime_q['source']}"
else:
    curr_p = float(hist_df["Close"].iloc[-1])
    prev_p = float(hist_df["Close"].iloc[-2]) if len(hist_df) >= 2 else curr_p
    change_val = round(curr_p - prev_p, 2)
    change_pct = round((change_val / prev_p) * 100, 2) if prev_p > 0 else 0.0
    vol = int(hist_df["Volume"].iloc[-1])
    high_p = float(hist_df["High"].max())
    low_p = float(hist_df["Low"].min())
    matched_ticker = f"{matched_ticker} · 最近收盤（非即時）"


def evaluate_stock_screening(df, curr_price, min_vol_limit, high_days, atr_n, market_score):
    df_calc = df.copy()
    vol_shares = float(df_calc["Volume"].iloc[-1])
    # Yahoo Finance reports Taiwan-listed volume as shares, so always convert to lots.
    vol_lots = vol_shares / 1000.0
    vol_ma5 = df_calc["Volume"].rolling(5).mean().iloc[-1]
    if pd.isna(vol_ma5) or not np.isfinite(vol_ma5):
        raise ValueError("歷史資料不足以計算成交量均線")
    vol_ma5_lots = float(vol_ma5) / 1000.0

    cond_liquidity = vol_lots >= min_vol_limit
    cond_vol_surge = vol_lots >= (vol_ma5_lots * 1.2)

    ma20 = df_calc["Close"].rolling(20).mean().iloc[-1]
    ma60 = df_calc["Close"].rolling(60).mean().iloc[-1]
    ma120 = df_calc["Close"].rolling(120).mean().iloc[-1]

    cond_gt_ma20 = curr_price > ma20
    cond_gt_ma60 = curr_price > ma60
    cond_gt_ma120 = curr_price > ma120
    cond_trend_bull = (curr_price > ma20) and (ma20 > ma60) and (ma60 > ma120)

    prior_bars = df_calc.iloc[:-1]
    high_window = prior_bars["High"].tail(high_days)
    range_window = prior_bars.tail(20)
    past_high = float(high_window.max())
    cond_new_high = curr_price >= past_high

    resistance_20 = float(range_window["High"].max())
    support_20 = float(range_window["Low"].min())

    cond_break_res = curr_price > resistance_20
    cond_below_sup = curr_price < support_20

    high_low = df_calc["High"] - df_calc["Low"]
    high_close = np.abs(df_calc["High"] - df_calc["Close"].shift())
    low_close = np.abs(df_calc["Low"] - df_calc["Close"].shift())
    tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
    atr = tr.rolling(atr_n).mean().iloc[-1]
    atr = float(atr)
    atr_pct = (atr / curr_price) * 100 if curr_price > 0 else 0

    delta = df_calc["Close"].diff()
    gain = (delta.where(delta > 0, 0)).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi_series = 100 - (100 / (1 + rs))
    rsi_val = float(rsi_series.iloc[-1])

    return {
        "vol_lots": vol_lots,
        "cond_liquidity": cond_liquidity,
        "cond_vol_surge": cond_vol_surge,
        "ma20": ma20,
        "ma60": ma60,
        "ma120": ma120,
        "cond_gt_ma20": cond_gt_ma20,
        "cond_gt_ma60": cond_gt_ma60,
        "cond_gt_ma120": cond_gt_ma120,
        "cond_trend_bull": cond_trend_bull,
        "past_high": past_high,
        "cond_new_high": cond_new_high,
        "resistance_20": resistance_20,
        "support_20": support_20,
        "cond_break_res": cond_break_res,
        "cond_below_sup": cond_below_sup,
        "atr": atr,
        "atr_pct": atr_pct,
        "rsi": rsi_val,
        "rsi_series": rsi_series,
        "market_allow_long": (market_score >= 4)
    }


screen_res = evaluate_stock_screening(
    hist_df, curr_p, min_volume_threshold, recent_high_days, atr_period, env_data["score"]
)


def run_mlp_tracker(df):
    returns = df["Close"].pct_change().fillna(0).values[-20:]
    vol_ma5 = df["Volume"].rolling(5).mean().replace(0, np.nan)
    vol_ratio = (df["Volume"] / vol_ma5).fillna(1.0).values[-20:]

    f1 = float(np.prod(1 + returns[-5:]) - 1)
    f2 = float(vol_ratio[-1])
    high_20 = float(df["High"].iloc[-20:].max())
    low_20 = float(df["Low"].iloc[-20:].min())
    curr_c = float(df["Close"].iloc[-1])
    f3 = (curr_c - low_20) / (high_20 - low_20) if high_20 != low_20 else 0.5

    # Transparent price/volume proxy; this is not a trained neural network or broker-flow feed.
    mlp_score = float(np.clip(
        50.0 + np.clip(f1 * 250, -12, 12)
        + np.clip((f2 - 1.0) * 12, -12, 12)
        + np.clip((f3 - 0.5) * 20, -10, 10),
        15.0, 85.0
    ))

    if mlp_score >= 75:
        status = "量價代理偏多"
        signal_color = "#dc2626"
    elif mlp_score >= 45:
        status = "量價代理中性"
        signal_color = "#a16207"
    else:
        status = "量價代理偏空"
        signal_color = "#047857"

    return {
        "score": round(mlp_score, 1),
        "status": status,
        "color": signal_color,
        "vol_ratio": round(f2, 2),
        "pos_ratio": round(f3 * 100, 1),
    }


mlp_res = run_mlp_tracker(hist_df)


def run_enhanced_ai_decision(df, curr_price):
    close = df["Close"].astype(float)
    ma5 = float(close.rolling(5).mean().iloc[-1])
    ma20 = float(close.rolling(20).mean().iloc[-1])
    ma60 = float(close.rolling(60).mean().iloc[-1]) if len(close) >= 60 else ma20
    support_low = float(df["Low"].tail(20).min())
    resistance_high = float(df["High"].tail(20).max())

    if curr_price > ma20 and ma20 > ma60:
        state = "📈 多頭趨勢結構"
        advice = f"現價高於 MA20，且 MA20 高於 MA60。趨勢方向為多方；關注近 20 日支撐 ${support_low:.1f}。"
        hold_days = "3–7 個交易日"
    elif curr_price < ma20 and ma20 < ma60:
        state = "📉 空頭趨勢結構"
        advice = f"現價低於 MA20，且 MA20 低於 MA60。趨勢方向為空方；反彈先看近 20 日壓力 ${resistance_high:.1f}。"
        hold_days = "防守優先"
    else:
        state = "⏸️ 均線交錯／區間結構"
        advice = f"短中期均線尚未形成一致排列，訊號分類為中性；區間參考 ${support_low:.1f}–${resistance_high:.1f}。"
        hold_days = "等待收盤確認"

    return {
        "state": state,
        "advice": advice,
        "support": support_low,
        "resistance": resistance_high,
        "hold_days": hold_days,
    }


ai_dec = run_enhanced_ai_decision(hist_df, curr_p)


def run_monte_carlo(current_price, df, days=10, sims=1000):
    returns = df["Close"].pct_change().dropna().tail(252)
    if len(returns) >= 20:
        returns = returns.clip(lower=returns.quantile(0.01), upper=returns.quantile(0.99))
    mu = float(returns.mean()) if len(returns) else 0.0
    sigma = float(returns.std()) if len(returns) else 0.0
    if not np.isfinite(sigma) or sigma == 0:
        sigma = 0.018
    # Historical daily drift is noisy; cap it so one unusual session cannot dominate.
    mu = float(np.clip(mu, -0.03, 0.03))
    rng = np.random.default_rng(42 + int(round(current_price * 100)) + int(days))

    sim_results = np.zeros((days + 1, sims))
    sim_results[0] = current_price

    for t in range(1, days + 1):
        rand_shocks = rng.normal(0, 1, sims)
        sim_results[t] = sim_results[t - 1] * np.exp(
            (mu - 0.5 * sigma**2) + sigma * rand_shocks
        )

    upper = np.percentile(sim_results, 80, axis=1)
    mean = np.percentile(sim_results, 50, axis=1)
    lower = np.percentile(sim_results, 20, axis=1)
    prob_up = (np.sum(sim_results[-1] > current_price) / sims) * 100

    return {
        "days": np.arange(0, days + 1),
        "upper": upper,
        "mean": mean,
        "lower": lower,
        "prob_up": prob_up,
        "prob_down": 100 - prob_up,
    }


mc_res = run_monte_carlo(curr_p, hist_df, days=forecast_days)


def compute_ai_probability_and_advice(df, curr_price, mlp_score, market_score, mc_prob_up):
    close = df["Close"].astype(float)
    volume = df["Volume"].astype(float)

    def last_mean(series, window):
        value = series.rolling(window).mean().iloc[-1]
        if pd.isna(value) or not np.isfinite(value):
            raise ValueError(f"歷史資料不足以計算 MA{window}")
        return float(value)

    ma20 = last_mean(close, 20)
    ma60 = last_mean(close, 60)
    ma120 = last_mean(close, 120)
    ma20_prior = float(close.rolling(20).mean().iloc[-6])
    trend_score = 50.0
    trend_score += 15 if curr_price >= ma20 else -15
    trend_score += 15 if ma20 >= ma60 else -15
    trend_score += 10 if ma60 >= ma120 else -10
    trend_score += 10 if ma20 >= ma20_prior else -10
    trend_score = float(np.clip(trend_score, 10, 90))

    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = -delta.clip(upper=0).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi_series = 100 - (100 / (1 + rs))
    if pd.isna(rsi_series.iloc[-1]):
        raise ValueError("歷史資料不足以計算 RSI")
    rsi = float(rsi_series.iloc[-1])
    rsi_score = 50 + (rsi - 50) * 0.65
    if rsi > 70:
        rsi_score -= (rsi - 70) * 0.6
    elif rsi < 30:
        rsi_score += (30 - rsi) * 0.35

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    macd_signal = macd.ewm(span=9, adjust=False).mean()
    macd_bull = float(macd.iloc[-1]) >= float(macd_signal.iloc[-1])
    ret5_pct = float(close.pct_change(5).iloc[-1] * 100) if len(close) >= 6 else 0.0
    momentum_score = float(np.clip(
        rsi_score + (8 if macd_bull else -8) + np.clip(ret5_pct * 2, -12, 12),
        10, 90
    ))

    vol_ma5 = float(volume.rolling(5).mean().iloc[-1]) if len(volume) >= 5 else float(volume.mean())
    vol_ratio = float(volume.iloc[-1] / vol_ma5) if vol_ma5 > 0 else 1.0
    ret1_pct = float(close.pct_change().iloc[-1] * 100) if len(close) >= 2 else 0.0
    volume_impulse = np.sign(ret1_pct) * min(max(vol_ratio - 1.0, 0.0) * 22, 24)
    volume_score = float(np.clip(50 + volume_impulse, 20, 80))

    market_factor = float(np.clip(market_score / 6.0 * 100, 0, 100))
    monte_carlo_factor = float(np.clip(mc_prob_up, 0, 100))
    chip_proxy_factor = float(np.clip(mlp_score, 0, 100))

    factors = [
        {"key": "trend", "label": "趨勢結構", "score": trend_score, "weight": 0.25,
         "evidence": f"現價相對 MA20 {('上方' if curr_price >= ma20 else '下方')}；MA20/60/120 結構 {('偏多' if ma20 >= ma60 >= ma120 else '未呈多頭排列')}"},
        {"key": "momentum", "label": "動能指標", "score": momentum_score, "weight": 0.20,
         "evidence": f"RSI(14) {rsi:.1f}；5 日報酬 {ret5_pct:+.2f}%；MACD {('偏多' if macd_bull else '偏空')}"},
        {"key": "volume", "label": "量價配合", "score": volume_score, "weight": 0.15,
         "evidence": f"當日量為 5 日均量 {vol_ratio:.2f} 倍；當日價格變動 {ret1_pct:+.2f}%"},
        {"key": "chip_proxy", "label": "籌碼代理（價量）", "score": chip_proxy_factor, "weight": 0.15,
         "evidence": f"近 20 日報酬、量比與區間位置合成 {chip_proxy_factor:.1f}/100；非法人買賣超資料"},
        {"key": "market", "label": "大盤環境", "score": market_factor, "weight": 0.15,
         "evidence": f"加權指數環境 {market_score}/6，換算因子分數 {market_factor:.1f}/100"},
        {"key": "monte_carlo", "label": "蒙地卡羅", "score": monte_carlo_factor, "weight": 0.10,
         "evidence": f"歷史報酬路徑模擬中，{forecast_days} 日終值高於現價的比例 {monte_carlo_factor:.1f}%"},
    ]
    direction_score = float(sum(item["score"] * item["weight"] for item in factors))
    distance_from_neutral = abs(direction_score - 50.0)

    if direction_score >= 56.5:
        direction = "BULLISH"
        signal = "BULLISH｜看多"
        signal_color = "#dc2626"
        bg_color = "rgba(254, 226, 226, .72)"
        action_advice = "多方量化訊號成立。依 ATR 設定停損與單筆風險上限，不以模型分數取代部位控管。"
        position_advice = "方向：偏多；部位依個人風險限額設定"
    elif direction_score <= 43.5:
        direction = "BEARISH"
        signal = "BEARISH｜看空"
        signal_color = "#059669"
        bg_color = "rgba(209, 250, 229, .78)"
        action_advice = "空方量化訊號成立。優先控制曝險，持倉依預設停損規則處理。"
        position_advice = "方向：偏空；避免新增無停損部位"
    else:
        direction = "NEUTRAL"
        signal = "NEUTRAL｜盤整觀望"
        signal_color = "#a16207"
        bg_color = "rgba(254, 249, 195, .82)"
        action_advice = "量化分數落在中性區。採觀望，等待收盤價突破區間或趨勢因子轉向後再重新評估。"
        position_advice = "方向：中性；等待訊號確認"

    if direction == "NEUTRAL":
        neutral_agreement = sum(
            item["weight"] for item in factors if 43.5 <= item["score"] <= 56.5
        )
        confidence = min(82.0, 57.0 + max(0.0, 6.5 - distance_from_neutral) * 1.5 + neutral_agreement * 10)
        # Show the largest offsetting factor contributions when the aggregate is neutral.
        ranked = sorted(factors, key=lambda item: item["weight"] * abs(item["score"] - 50), reverse=True)
    else:
        aligned_weight = sum(
            item["weight"] for item in factors
            if (item["score"] >= 50 if direction == "BULLISH" else item["score"] <= 50)
        )
        confidence = min(92.0, 54.0 + distance_from_neutral * 0.9 + aligned_weight * 10)
        ranked = sorted(factors, key=lambda item: item["weight"] * abs(item["score"] - 50), reverse=True)
    confidence = round(float(np.clip(confidence, 50, 92)), 1)
    top_reasons = [
        f"{item['label']}｜{item['evidence']}（因子 {item['score']:.1f}/100）"
        for item in ranked[:3]
    ]

    return {
        # These are weighted model scores, not statistically calibrated probabilities.
        "prob_up": round(direction_score, 1),
        "prob_down": round(100.0 - direction_score, 1),
        "direction": direction,
        "confidence": confidence,
        "top_reasons": top_reasons,
        "components": {item["key"]: round(item["score"], 1) for item in factors},
        "signal": signal,
        "color": signal_color,
        "bg_color": bg_color,
        "advice": action_advice,
        "position": position_advice,
    }


ai_prob = compute_ai_probability_and_advice(
    hist_df, curr_p, mlp_res["score"], env_data["score"], mc_res["prob_up"]
)
top_reasons_html = "".join(f"<li>{escape(reason)}</li>" for reason in ai_prob["top_reasons"])
matched_ticker_html = escape(str(matched_ticker))

with sidebar_decision_slot:
    st.divider()
    st.subheader("🤖 AI 量化決策")
    st.markdown(
        f"""
<div class="sidebar-signal-card">
    <div class="signal-title" style="color:{ai_prob['color']}">{escape(ai_prob['signal'])}</div>
    <div class="signal-confidence">啟發式信心指數 <strong>{ai_prob['confidence']}%</strong></div>
    <div style="font-size:.76rem; color:#64748b; margin-top:5px;">
        多方分數 {ai_prob['prob_up']:.1f} / 100
    </div>
    <ol class="signal-reasons">{top_reasons_html}</ol>
</div>
""",
        unsafe_allow_html=True,
    )
    st.caption("分數為啟發式模型輸出，未經歷史回測校準；不代表統計勝率。")


# ==============================================================================
# ----------------- 5. 量化控制模組 UI 排版 (MODULES 01 - 18) -----------------
# ==============================================================================

st.markdown('<div class="main-section"><div class="main-section-title">🌐 即時行情與 AI 綜合預測導航</div>', unsafe_allow_html=True)

price_class = "up-red" if change_val >= 0 else "down-green"
sign_symbol = "+" if change_val >= 0 else ""

st.markdown(
    f"""
<div class="top-header">
    <div class="header-container">
        <div class="header-title-box">
            <span class="card-header-badge">MODULE 01</span>
             <span class="symbol-title">📌 {input_symbol} 行情控制台</span>
            <span style="font-size:0.85rem; color:#475569; background:rgba(219,234,254,.86); padding:2px 8px; border-radius:999px;">{matched_ticker_html}</span>
        </div>
        <div class="header-stats-box">
            <div>
                 <span style="font-size:0.8rem; color:#475569; display:block;">最新可用收盤價（非即時）</span>
                <span class="price-large {price_class}">${curr_p:,.2f}</span>
            </div>
            <div>
                <span style="font-size:0.8rem; color:#475569; display:block;">今日漲跌</span>
                <span style="font-size:1.2rem; font-weight:bold;" class="{price_class}">{sign_symbol}{change_val:,.2f} ({sign_symbol}{change_pct:.2f}%)</span>
            </div>
            <div>
                <span style="font-size:0.8rem; color:#475569; display:block;">今日成交量</span>
                <span style="font-size:1.1rem; font-weight:bold; color:#1e293b;">{vol/1000:,.0f} 張</span>
            </div>
            <div>
                <span style="font-size:0.8rem; color:#475569; display:block;">最高 / 最低</span>
                <span style="font-size:0.95rem; font-weight:bold; color:#334155;">${high_p:,.1f} / ${low_p:,.1f}</span>
            </div>
        </div>
    </div>
</div>
""",
    unsafe_allow_html=True,
)

st.markdown(
    f"""
<div style="background:rgba(255,255,255,.9); border:1px solid rgba(148,163,184,.34); border-radius:18px; padding:16px; margin-bottom:10px; box-shadow:0 10px 28px rgba(71,91,126,.07); backdrop-filter:blur(16px) saturate(140%);">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom:1px solid #1f2937; padding-bottom:8px; flex-wrap:wrap; gap:8px;">
        <div style="font-size:1.05rem; font-weight:bold; color:#0f172a; display:flex; align-items:center; gap:6px;">
            <span class="card-header-badge">AI NAVIGATOR</span>
            <span>🤖 多因子方向判定與核心操作依據</span>
        </div>
        <div style="background:{ai_prob['bg_color']}; color:{ai_prob['color']}; border:1px solid {ai_prob['color']}; padding:4px 12px; border-radius:6px; font-weight:bold; font-size:0.9rem;">
            {ai_prob['signal']}
        </div>
    </div>
    <div style="display:flex; flex-wrap:wrap; gap:16px; align-items:center;">
        <div style="flex:1 1 320px; background:rgba(255,255,255,.84); padding:14px; border-radius:14px; border:1px solid rgba(148,163,184,.32);">
            <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
                <span style="font-size:0.9rem; color:#dc2626; font-weight:bold;">📈 多方量化分數：{ai_prob['prob_up']}/100</span>
                <span style="font-size:0.9rem; color:#047857; font-weight:bold;">📉 空方量化分數：{ai_prob['prob_down']}/100</span>
            </div>
            <div style="background-color:#d1fae5; height:14px; border-radius:7px; overflow:hidden; display:flex; border:1px solid rgba(148,163,184,.32);">
                <div style="background-color:#dc2626; width:{ai_prob['prob_up']}%; height:100%;"></div>
            </div>
            <div style="font-size:.82rem; color:#64748b; margin-top:10px;">啟發式信心值 <strong style="color:{ai_prob['color']};">{ai_prob['confidence']}%</strong>（非歷史回測校準機率）</div>
        </div>
        <div style="flex:2 1 400px; background:rgba(255,255,255,.86); padding:14px; border-radius:14px; border-left:4px solid {ai_prob['color']};">
            <div style="font-size:0.95rem; font-weight:bold; color:#0f172a; margin-bottom:6px;">💡 AI 量化導航指南</div>
            <div style="font-size:0.88rem; color:#334155; line-height:1.5; margin-bottom:10px;">{ai_prob['advice']}</div>
            <div style="font-size:.85rem; font-weight:700; margin:10px 0 4px;">前三大量化依據</div>
            <ol style="font-size:.82rem; line-height:1.55; margin:0 0 10px; padding-left:1.35rem;">{top_reasons_html}</ol>
            <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:0.8rem;">
                <span style="background:rgba(254,249,195,.72); padding:4px 10px; border-radius:999px; color:#854d0e; border:1px solid rgba(202,138,4,.3); font-weight:bold;">⚖️ {ai_prob['position']}</span>
                <span style="background:rgba(219,234,254,.78); padding:4px 10px; border-radius:999px; color:#1e40af; border:1px solid rgba(59,130,246,.28);">🎯 關鍵支撐: ${ai_dec['support']:.1f} / 壓力: ${ai_dec['resistance']:.1f}</span>
            </div>
        </div>
    </div>
</div>
""",
    unsafe_allow_html=True,
)
st.markdown('</div>', unsafe_allow_html=True)


# ----------------- 5. 預想買入試算與 AI 買進決策控制台 (即時數據 AI 動態運算修復) -----------------
st.markdown('<div class="main-section"><div class="main-section-title">🧮 預想買入試算與 AI 買進決策控制台</div>', unsafe_allow_html=True)

sim_col1, sim_col2 = st.columns([1, 2])

with sim_col1:
    st.markdown('<div style="font-size:0.95rem; font-weight:bold; color:#0369a1; margin-bottom:8px;">📥 預想交易條件自由輸入</div>', unsafe_allow_html=True)
    sim_price_input = st.number_input(
        "預想買入價格 (元)",
        value=float(round(curr_p, 1)),
        step=1.0,
        format="%.1f",
        key="sim_price_input_key"
    )
    sim_unit_type = st.radio("買入單位類型", ["張數 (1張=1000股)", "股數"], horizontal=True, key="sim_unit_radio")
    
    if "張數" in sim_unit_type:
        sim_lots = st.number_input("預想買入張數", value=1, min_value=1, step=1, key="sim_lots_input")
        sim_shares = sim_lots * 1000
    else:
        sim_shares = st.number_input("預想買入股數", value=1000, min_value=100, step=100, key="sim_shares_input")
        sim_lots = sim_shares / 1000.0

    total_budget_yuan = sim_price_input * sim_shares
    total_budget_wan = total_budget_yuan / 10000.0

    # 根據即時股價與 ATR 計算目標價與停損價
    sim_target_p = round(sim_price_input + (screen_res["atr"] * 2.5), 1)
    sim_stop_p = round(sim_price_input - (screen_res["atr"] * 1.5), 1)

    max_gain_yuan = round((sim_target_p - sim_price_input) * sim_shares)
    max_loss_yuan = round((sim_price_input - sim_stop_p) * sim_shares)
    
    sim_rr_ratio = round((sim_target_p - sim_price_input) / (sim_price_input - sim_stop_p), 2) if (sim_price_input - sim_stop_p) > 0 else 0.0

    # 這是依條件調整的量化評分，不是經回測校準的實際勝率。
    price_diff_pct = ((sim_price_input - curr_p) / curr_p) * 100.0
    
    # 邏輯運算：若預想買價低於市價（逢低佈局），安全邊際較高；若高於市價（突破追價），依大盤與動能調整
    base_calc_win = ai_prob["prob_up"]
    if price_diff_pct <= 0:
        # 折價只作為情境評分加分；不代表價格必然有支撐。
        price_bonus = min(abs(price_diff_pct) * 1.5, 14.0)
    else:
        # 追價買進：若大盤多頭且突破壓力則給予加分，否則扣分
        price_bonus = -min(price_diff_pct * 1.8, 18.0)
        if screen_res["cond_break_res"]:
            price_bonus += 6.0

    ma20_bonus = 5.0 if sim_price_input <= screen_res["ma20"] else -3.0
    
    sim_signal_score = base_calc_win + price_bonus + ma20_bonus
    sim_signal_score = round(float(np.clip(sim_signal_score, 0.0, 100.0)), 1)

    # 根據量化分數、風報比與大盤評分判定買進條件燈號。
    if sim_signal_score >= 60.0 and sim_rr_ratio >= 1.4 and env_data["score"] >= 3:
        buy_badge_class = "badge-buy-green"
        buy_badge_text = "🟢 多因子分數與風報比達標"
    elif sim_signal_score >= 45.0 and sim_rr_ratio >= 1.1:
        buy_badge_class = "badge-buy-yellow"
        buy_badge_text = "🟡 條件部分符合 (分批進場/控制倉位)"
    else:
        buy_badge_class = "badge-buy-red"
        buy_badge_text = "🔴 未達量化進場門檻"

with sim_col2:
    st.markdown('<div style="font-size:0.95rem; font-weight:bold; color:#0369a1; margin-bottom:8px;">🎯 AI 試算判定與戰術評估</div>', unsafe_allow_html=True)
    
    st.markdown(
        f"""
    <div style="background:rgba(255,255,255,.9); border:1px solid rgba(148,163,184,.34); border-radius:16px; padding:12px 16px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; box-shadow:0 10px 24px rgba(71,91,126,.06); backdrop-filter:blur(16px) saturate(140%);">
        <div>
            <span style="font-size:0.8rem; color:#475569; display:block;">AI 買進許可評定 (即時運算)</span>
            <span class="{buy_badge_class}">{buy_badge_text}</span>
        </div>
        <div style="text-align:right;">
            <span style="font-size:0.8rem; color:#475569; display:block;">預想價位量化評分（非勝率）</span>
            <span style="font-size:1.8rem; font-weight:800; color:{'#dc2626' if sim_signal_score>=60 else ('#a16207' if sim_signal_score>=45 else '#047857')};">{sim_signal_score}/100</span>
        </div>
    </div>
    """,
        unsafe_allow_html=True,
    )

    st.markdown(
        f"""
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:10px; margin-bottom:12px;">
        <div style="background:rgba(255,255,255,.86); padding:10px; border-radius:14px; border:1px solid rgba(148,163,184,.32);">
            <div style="font-size:0.78rem; color:#475569;">最佳建議掛單買進區間</div>
            <div style="font-size:1.05rem; font-weight:bold; color:#0369a1; margin-top:2px;">
                ${min(screen_res['ma20'], curr_p*0.985):.1f} ~ ${curr_p:.1f}
            </div>
        </div>
        <div style="background:rgba(255,255,255,.86); padding:10px; border-radius:14px; border:1px solid rgba(148,163,184,.32);">
            <div style="font-size:0.78rem; color:#475569;">目標獲利價 (+2.5x ATR)</div>
            <div style="font-size:1.05rem; font-weight:bold; color:#dc2626; margin-top:2px;">${sim_target_p:.1f}</div>
        </div>
        <div style="background:rgba(255,255,255,.86); padding:10px; border-radius:14px; border:1px solid rgba(148,163,184,.32);">
            <div style="font-size:0.78rem; color:#475569;">防守停損價 (-1.5x ATR)</div>
            <div style="font-size:1.05rem; font-weight:bold; color:#047857; margin-top:2px;">${sim_stop_p:.1f}</div>
        </div>
        <div style="background:rgba(255,255,255,.86); padding:10px; border-radius:14px; border:1px solid rgba(148,163,184,.32);">
            <div style="font-size:0.78rem; color:#475569;">風報比 (Risk-Reward)</div>
            <div style="font-size:1.05rem; font-weight:bold; color:#a16207; margin-top:2px;">1 : {sim_rr_ratio}</div>
        </div>
    </div>
    """,
        unsafe_allow_html=True,
    )

    st.markdown(
        f"""
    <div style="background:rgba(255,255,255,.9); border:1px solid rgba(148,163,184,.34); border-radius:14px; padding:10px 14px; font-size:0.85rem; margin-bottom:12px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; backdrop-filter:blur(14px);">
        <div>所需總資金: <strong style="color:#1e293b;">${total_budget_yuan:,.0f} 元</strong> (<span style="color:#0369a1;">約 {total_budget_wan:.2f} 萬</span>)</div>
        <div>預期最大獲利: <strong style="color:#dc2626;">+${max_gain_yuan:,.0f} 元</strong></div>
        <div>最大風險損失: <strong style="color:#047857;">-${max_loss_yuan:,.0f} 元</strong></div>
    </div>
    """,
        unsafe_allow_html=True,
    )

    if sim_price_input < curr_p:
        tactics_title = "🛡️ AI 戰術指南：左側拉回逢低掛單戰術"
        tactics_desc = f"預想買價 (<strong>${sim_price_input:.1f}</strong>) 低於現價 (<strong>${curr_p:.1f}</strong>)，折價 <strong>{abs(price_diff_pct):.1f}%</strong>。此為低於現價的掛單情境；是否有支撐仍以支撐位與停損條件確認。"
        tactics_color = "#0369a1"
    elif sim_price_input > curr_p:
        tactics_title = "⚡ AI 戰術指南：右側突破追價買進戰術"
        tactics_desc = f"預想買價 (<strong>${sim_price_input:.1f}</strong>) 高於現價 (<strong>${curr_p:.1f}</strong>)，溢價 <strong>{price_diff_pct:.1f}%</strong>。屬追價情境；僅在價格實際突破壓力且量能配合時，才符合突破策略條件。"
        tactics_color = "#a16207"
    else:
        tactics_title = "⚖️ AI 戰術指南：市價/平盤分批布局戰術"
        tactics_desc = f"預想買價等於當前市價 (<strong>${curr_p:.1f}</strong>)。建議採 2~3 批分批建倉。"
        tactics_color = "#7e22ce"

    st.markdown(
        f"""
    <div style="background:rgba(255,255,255,.88); border:1px solid rgba(148,163,184,.28); border-left:4px solid {tactics_color}; border-radius:14px; padding:12px; box-shadow:0 8px 22px rgba(71,91,126,.06);">
        <div style="font-size:0.9rem; font-weight:bold; color:#1e293b; margin-bottom:4px;">{tactics_title}</div>
        <div style="font-size:0.83rem; color:#334155; line-height:1.5;">{tactics_desc}</div>
    </div>
    """,
        unsafe_allow_html=True,
    )

st.markdown('</div>', unsafe_allow_html=True)


# ----------------- 6. 其餘量化控制模組 (MODULES 03 - 18) -----------------
st.markdown('<div class="main-section"><div class="main-section-title">🧠 AI 籌碼診斷與量化篩選決策</div>', unsafe_allow_html=True)
col3, col4 = st.columns(2)

with col3:
    st.markdown(
        f"""
    <div style="background:rgba(255,255,255,.92); color:#1e293b; border:1px solid rgba(148,163,184,.36); border-radius:16px; padding:14px; height:100%; box-shadow:0 10px 28px rgba(71,91,126,.07); backdrop-filter:blur(16px) saturate(140%);">
        <div class="card-header"><span class="card-header-badge">MODULE 03</span> 📊 量價動能與籌碼代理指標</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
            <span style="font-size:1.8rem; font-weight:800; color:{mlp_res['color']}">{mlp_res['score']} <span style="font-size:1rem;">分</span></span>
            <span style="font-size:0.95rem; font-weight:bold; color:{mlp_res['color']}; background:rgba(219,234,254,.78); padding:4px 10px; border:1px solid rgba(148,163,184,.32); border-radius:999px;">{mlp_res['status']}</span>
        </div>
        <div style="margin-top:10px; font-size:0.82rem; color:#475569;">
            代理分數由近 5 日報酬、量比 ({mlp_res['vol_ratio']}x) 與近 20 日區間位置 ({mlp_res['pos_ratio']}%) 組成；不代表券商或法人實際持倉。
        </div>
    </div>
    """,
        unsafe_allow_html=True,
    )

with col4:
    st.markdown(
        f"""
    <div style="background:rgba(255,255,255,.92); color:#1e293b; border:1px solid rgba(148,163,184,.36); border-radius:16px; padding:14px; height:100%; box-shadow:0 10px 28px rgba(71,91,126,.07); backdrop-filter:blur(16px) saturate(140%);">
        <div class="card-header"><span class="card-header-badge">MODULE 04</span> 💡 AI 戰略導航與型態評估</div>
        <div style="margin-top:8px;">
            <div style="font-size:1.1rem; font-weight:bold; color:#0369a1;">{ai_dec['state']}</div>
            <div style="font-size:0.85rem; color:#334155; margin-top:6px; line-height:1.4;">{ai_dec['advice']}</div>
            <div style="margin-top:8px; font-size:0.8rem; color:#475569;">建議持有時間：<strong style="color:#a16207;">{ai_dec['hold_days']}</strong></div>
        </div>
    </div>
    """,
        unsafe_allow_html=True,
    )

st.markdown("<br>", unsafe_allow_html=True)
col5, col6 = st.columns(2)

with col5:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 05</span> 🚦 個股關鍵條件燈號檢核 (10項指標)</div>', unsafe_allow_html=True)
    conds = [
        ("流動性門檻 (>= 門檻張數)", screen_res["cond_liquidity"]),
        ("成交量動能爆發 (>= 5日均量1.2倍)", screen_res["cond_vol_surge"]),
        ("站穩 20日移動平均線 (MA20)", screen_res["cond_gt_ma20"]),
        ("站穩 60日季線 (MA60)", screen_res["cond_gt_ma60"]),
        ("站穩 120日半年線 (MA120)", screen_res["cond_gt_ma120"]),
        ("均線呈多頭排列 (MA20 > MA60 > MA120)", screen_res["cond_trend_bull"]),
        ("創近 N 日高點突破", screen_res["cond_new_high"]),
        ("突破 20 日近端壓力位", screen_res["cond_break_res"]),
        ("未跌破 20 日近端支撐位", not screen_res["cond_below_sup"]),
        ("大盤環境評分達標 (評分 >= 4)", screen_res["market_allow_long"]),
    ]
    for title_name, flag in conds:
        icon = "🟢" if flag else "🔴"
        st.markdown(
            f"<div style='display:flex; justify-content:space-between; padding:7px 10px; color:#1e293b; background:rgba(255,255,255,.9); border:1px solid rgba(148,163,184,.28); margin-bottom:5px; border-radius:12px; font-size:0.85rem; box-shadow:0 4px 12px rgba(71,91,126,.04);'>{title_name}<span>{icon}</span></div>",
            unsafe_allow_html=True,
        )

with col6:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 06</span> 🎯 客觀量化買進訊號決策面板</div>', unsafe_allow_html=True)
    pass_count = sum([1 for _, f in conds if f])
    signal_status = "🔥 強烈買進 (訊號完全符合)" if pass_count >= 8 else ("🟡 觀望或分批布局" if pass_count >= 5 else "🔴 嚴禁做多 (條件不符)")
    st.markdown(
        f"""
    <div style="background:rgba(255,255,255,.92); color:#1e293b; border:1px solid rgba(148,163,184,.36); border-radius:16px; padding:16px; box-shadow:0 10px 28px rgba(71,91,126,.07); backdrop-filter:blur(16px);">
        <div style="font-size:1.2rem; font-weight:bold; color:#0f172a; margin-bottom:10px;">量化條件通過數: <span style="color:#0369a1;">{pass_count} / 10</span></div>
        <div style="font-size:1.1rem; font-weight:bold; margin-bottom:12px; color:{'#dc2626' if pass_count>=8 else ('#a16207' if pass_count>=5 else '#047857')};">{signal_status}</div>
        <div style="font-size:0.85rem; color:#475569; line-height:1.5;">依據多維量化燈號客觀評估，去除主觀情緒干擾。</div>
    </div>
    """,
        unsafe_allow_html=True,
    )

st.markdown("<br>", unsafe_allow_html=True)
col7, col8 = st.columns(2)

with col7:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 07</span> 📐 系統化進場價格與風報比試算</div>', unsafe_allow_html=True)
    target_p = round(curr_p + (screen_res["atr"] * 3), 1)
    stop_p = round(curr_p - (screen_res["atr"] * 1.5), 1)
    risk_val = curr_p - stop_p
    reward_val = target_p - curr_p
    rr_ratio = round(reward_val / risk_val, 2) if risk_val > 0 else 0
    st.markdown(
        f"""
    <div style="background:rgba(255,255,255,.92); color:#1e293b; border:1px solid rgba(148,163,184,.36); border-radius:16px; padding:12px; font-size:0.85rem; box-shadow:0 8px 24px rgba(71,91,126,.06); backdrop-filter:blur(14px);">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span>建倉參考價:</span><strong>${curr_p:.1f}</strong></div>
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span>目標獲利價 (+3.0x ATR):</span><strong style="color:#dc2626;">${target_p:.1f}</strong></div>
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span>防守停損價 (-1.5x ATR):</span><strong style="color:#047857;">${stop_p:.1f}</strong></div>
        <div style="display:flex; justify-content:space-between; margin-bottom:6px; border-top:1px solid rgba(148,163,184,.35); padding-top:6px;"><span>風險報酬比 (R/R):</span><strong style="color:#0369a1; font-size:1.1rem;">1 : {rr_ratio}</strong></div>
    </div>
    """,
        unsafe_allow_html=True,
    )

with col8:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 08</span> 🛡️ 系統化停損公式與執行決策</div>', unsafe_allow_html=True)
    st.markdown(
        f"""
    <div style="background:rgba(255,255,255,.92); color:#1e293b; border:1px solid rgba(148,163,184,.36); border-radius:16px; padding:12px; font-size:0.85rem; box-shadow:0 8px 24px rgba(71,91,126,.06); backdrop-filter:blur(14px);">
        <div style="margin-bottom:6px;">1. 波動度固定停損 (1.5 ATR): <strong>${curr_p - (screen_res['atr']*1.5):.1f}</strong></div>
        <div style="margin-bottom:6px;">2. 關鍵均線防守 (MA20): <strong>${screen_res['ma20']:.1f}</strong></div>
        <div style="margin-bottom:6px;">3. 近期低點支撐 (20日低): <strong>${screen_res['support_20']:.1f}</strong></div>
        <div style="color:#a16207; font-weight:bold; margin-top:8px;">紀律提示: 觸及上述停損價時應堅決執行。</div>
    </div>
    """,
        unsafe_allow_html=True,
    )
st.markdown('</div>', unsafe_allow_html=True)


# ----------------- 7. 技術指標圖表與預測 -----------------
st.markdown('<div class="main-section"><div class="main-section-title">📈 技術指標圖表與 AI 未來走勢預測</div>', unsafe_allow_html=True)
st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 09 & 10</span> 📊 K線技術分析與動能指標</div>', unsafe_allow_html=True)

fig = make_subplots(rows=3, cols=1, shared_xaxes=True, vertical_spacing=0.03, row_heights=[0.55, 0.22, 0.23])
fig.add_trace(go.Candlestick(
    x=hist_df.index, open=hist_df["Open"], high=hist_df["High"], low=hist_df["Low"], close=hist_df["Close"],
    name="K線",
    increasing=dict(line=dict(color="#dc2626"), fillcolor="#fee2e2"),
    decreasing=dict(line=dict(color="#059669"), fillcolor="#d1fae5"),
), row=1, col=1)

if show_ma_lines:
    fig.add_trace(go.Scatter(x=hist_df.index, y=hist_df["Close"].rolling(5).mean(), line=dict(color="#0369a1", width=1), name="MA5"), row=1, col=1)
    fig.add_trace(go.Scatter(x=hist_df.index, y=hist_df["Close"].rolling(20).mean(), line=dict(color="#b45309", width=1.5), name="MA20"), row=1, col=1)
    fig.add_trace(go.Scatter(x=hist_df.index, y=hist_df["Close"].rolling(60).mean(), line=dict(color="#7e22ce", width=1.5), name="MA60"), row=1, col=1)

colors_vol = ["#dc2626" if c >= o else "#059669" for c, o in zip(hist_df["Close"], hist_df["Open"])]
fig.add_trace(go.Bar(x=hist_df.index, y=hist_df["Volume"] / 1000, marker_color=colors_vol, name="成交量 (張)"), row=2, col=1)
fig.add_trace(go.Scatter(x=hist_df.index, y=screen_res["rsi_series"], line=dict(color="#be185d", width=1.5), name="RSI (14)"), row=3, col=1)

fig.update_layout(
    height=650, template="plotly_white", paper_bgcolor="rgba(255,255,255,0)",
    plot_bgcolor="rgba(255,255,255,0)", font=dict(color="#1e293b"),
    hoverlabel=dict(bgcolor="#ffffff", font=dict(color="#0f172a")),
    margin=dict(l=10, r=10, t=10, b=10), xaxis_rangeslider_visible=False, showlegend=True,
)
fig.update_xaxes(gridcolor="rgba(148,163,184,.18)", zerolinecolor="rgba(148,163,184,.25)")
fig.update_yaxes(gridcolor="rgba(148,163,184,.18)", zerolinecolor="rgba(148,163,184,.25)")
st.plotly_chart(fig, use_container_width=True)

col11, col12 = st.columns(2)
with col11:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 11</span> 🎯 AI 買賣點位與未來走勢預測</div>', unsafe_allow_html=True)
    fig_pred = go.Figure()
    fig_pred.add_trace(go.Scatter(x=hist_df.index[-30:], y=hist_df["Close"].iloc[-30:], name="歷史股價", line=dict(color="#0369a1", width=2)))
    future_dates = [hist_df.index[-1] + timedelta(days=i) for i in range(1, forecast_days + 1)]
    fig_pred.add_trace(go.Scatter(x=[hist_df.index[-1]] + future_dates, y=[curr_p] + list(mc_res["mean"][1:]), name="AI預測走勢", line=dict(color="#b45309", width=2.5, dash="dash")))
    fig_pred.add_hline(y=ai_dec["support"], line_dash="dash", line_color="#047857", annotation_text="AI 支撐")
    fig_pred.add_hline(y=ai_dec["resistance"], line_dash="dash", line_color="#dc2626", annotation_text="AI 壓力")
    fig_pred.update_layout(height=320, template="plotly_white", paper_bgcolor="rgba(255,255,255,0)", plot_bgcolor="rgba(255,255,255,0)", font=dict(color="#1e293b"), hoverlabel=dict(bgcolor="#ffffff", font=dict(color="#0f172a")), margin=dict(l=10, r=10, t=20, b=10))
    st.plotly_chart(fig_pred, use_container_width=True)

with col12:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 12</span> 📈 蒙地卡羅多路徑預測</div>', unsafe_allow_html=True)
    fig_mc = go.Figure()
    fut_dates = [hist_df.index[-1] + timedelta(days=i) for i in range(len(mc_res["days"]))]
    fig_mc.add_trace(go.Scatter(x=fut_dates, y=mc_res["upper"], line=dict(color="#dc2626", dash="dot"), name="上軌"))
    fig_mc.add_trace(go.Scatter(x=fut_dates, y=mc_res["mean"], line=dict(color="#b45309", width=2), name="中軸"))
    fig_mc.add_trace(go.Scatter(x=fut_dates, y=mc_res["lower"], line=dict(color="#047857", dash="dot"), name="下軌"))
    fig_mc.update_layout(height=320, template="plotly_white", paper_bgcolor="rgba(255,255,255,0)", plot_bgcolor="rgba(255,255,255,0)", font=dict(color="#1e293b"), hoverlabel=dict(bgcolor="#ffffff", font=dict(color="#0f172a")), margin=dict(l=10, r=10, t=20, b=10))
    st.plotly_chart(fig_mc, use_container_width=True)
st.markdown('</div>', unsafe_allow_html=True)


# ----------------- 8. 籌碼與個人庫存檢核 (MODULES 13 - 18) -----------------
st.markdown('<div class="main-section"><div class="main-section-title">🛡️ 籌碼面、風險矩陣與個人庫存執行檢核</div>', unsafe_allow_html=True)
col13, col14, col15 = st.columns(3)

with col13:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 13</span> ⚠️ 隔日沖與短線風險</div>', unsafe_allow_html=True)
    st.markdown(f"""<div style="background:rgba(255,255,255,.9); color:#1e293b; border:1px solid rgba(148,163,184,.32); padding:12px; border-radius:14px; font-size:0.83rem; box-shadow:0 8px 24px rgba(71,91,126,.06); backdrop-filter:blur(14px);"><div style="margin-bottom:6px;">隔日沖／分點資料：<strong>未接入，不顯示即時風險等級</strong></div><div style="color:#475569;">執行提示：開盤檢查跳空與量價變化；風險界線參照 ATR 停損 ${curr_p - screen_res['atr'] * 1.5:.1f}。</div></div>""", unsafe_allow_html=True)

with col14:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 14</span> 🏛️ 法人籌碼資料狀態</div>', unsafe_allow_html=True)
    st.markdown(f"""<div style="background:rgba(255,255,255,.9); color:#1e293b; border:1px solid rgba(148,163,184,.32); padding:12px; border-radius:14px; font-size:0.83rem; box-shadow:0 8px 24px rgba(71,91,126,.06); backdrop-filter:blur(14px);"><div style="margin-bottom:6px;">法人買賣超：<strong>未接入來源，不提供虛構數值</strong></div><div style="margin-bottom:6px;">價量籌碼代理：<strong>{mlp_res['score']:.1f}/100（{mlp_res['status']}）</strong></div><div style="color:#475569;">判斷只使用本頁行情的報酬、量比及區間位置。</div></div>""", unsafe_allow_html=True)

with col15:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 15</span> 🧱 支撐與壓力關卡解析</div>', unsafe_allow_html=True)
    st.markdown(f"""<div style="background:rgba(255,255,255,.9); color:#1e293b; border:1px solid rgba(148,163,184,.32); padding:12px; border-radius:14px; font-size:0.83rem; box-shadow:0 8px 24px rgba(71,91,126,.06); backdrop-filter:blur(14px);"><div style="margin-bottom:6px;">強壓力位: <strong style="color:#dc2626;">${screen_res['past_high']:.1f}</strong></div><div style="margin-bottom:6px;">近端支撐: <strong style="color:#047857;">${screen_res['support_20']:.1f}</strong></div></div>""", unsafe_allow_html=True)

st.markdown("<br>", unsafe_allow_html=True)
col16, col17, col18 = st.columns(3)

with col16:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 16</span> 💼 個人持股未實現損益</div>', unsafe_allow_html=True)
    if has_position and holding_shares > 0 and buy_price > 0:
        total_cost = buy_price * holding_shares
        current_val = curr_p * holding_shares
        pnl_val = current_val - total_cost
        pnl_pct = (pnl_val / total_cost) * 100
        pnl_color = "#dc2626" if pnl_val >= 0 else "#047857"
        pnl_sign = "+" if pnl_val >= 0 else ""
        st.markdown(f"""<div style="background:rgba(255,255,255,.9); color:#1e293b; border:1px solid rgba(148,163,184,.32); border-radius:14px; padding:12px; font-size:0.85rem; box-shadow:0 8px 24px rgba(71,91,126,.06); backdrop-filter:blur(14px);"><div style="margin-bottom:4px;">成本/現價: <strong>${buy_price:.1f} / ${curr_p:.1f}</strong></div><div style="margin-bottom:4px;">未實現損益: <strong style="color:{pnl_color};">{pnl_sign}${pnl_val:,.0f}</strong></div><div>報酬率: <strong style="color:{pnl_color};">{pnl_sign}{pnl_pct:.2f}%</strong></div></div>""", unsafe_allow_html=True)
    else:
        st.markdown('<div style="background:rgba(255,255,255,.9); color:#475569; border:1px solid rgba(148,163,184,.32); padding:12px; border-radius:14px; font-size:0.85rem; box-shadow:0 8px 24px rgba(71,91,126,.06);">尚未啟用個人庫存資料。</div>', unsafe_allow_html=True)

with col17:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 17</span> 🔔 風險警示與智慧動態通知</div>', unsafe_allow_html=True)
    st.markdown(f"""<div style="background:rgba(255,255,255,.9); color:#1e293b; border:1px solid rgba(148,163,184,.32); padding:12px; border-radius:14px; font-size:0.83rem; box-shadow:0 8px 24px rgba(71,91,126,.06); backdrop-filter:blur(14px);"><div style="margin-bottom:6px;">ATR 波動: <strong style="color:#0369a1;">${screen_res['atr']:.1f} ({screen_res['atr_pct']:.1f}%)</strong></div><div style="color:#047857;">系統狀態: 穩定運行正常。</div></div>""", unsafe_allow_html=True)

with col18:
    st.markdown('<div class="card-header"><span class="card-header-badge">MODULE 18</span> ⚙️ AI 量化決策總結與最終紀律</div>', unsafe_allow_html=True)
    st.markdown("""<div style="background:rgba(255,255,255,.9); color:#1e293b; border:1px solid rgba(148,163,184,.32); padding:12px; border-radius:14px; font-size:0.83rem; line-height:1.5; box-shadow:0 8px 24px rgba(71,91,126,.06); backdrop-filter:blur(14px);">遵循 <strong>嚴格風控、分批進場、依 ATR 停損</strong> 三大原則，實現穩定複利。</div>""", unsafe_allow_html=True)

st.markdown('</div>', unsafe_allow_html=True)