#!/usr/bin/env python3
"""Run a first long-only Taiwan stock momentum backtest with FinLab."""

from __future__ import annotations

import contextlib
import argparse
import html
import io
import re
import sys
import os
from pathlib import Path

import finlab
import pandas as pd
from finlab import data
from finlab.backtest import sim


HISTORY_START = "2010-01-01"
RECENT_COMPLETENESS_BARS = 486
MOMENTUM_LOOKBACK = 126
MOMENTUM_SKIP = 21
TREND_WINDOW = 120
LIQUIDITY_WINDOW = 20
MIN_AVERAGE_DAILY_TURNOVER_NTD = 30_000_000
HOLDINGS = 20
FEE_RATIO = 0.001425
SELL_TAX_RATIO = 0.003
OUTPUT_PATH = Path("generated-artifacts/finlab-tw-momentum.html")


def quiet_call(fn, *args, **kwargs):
    """Keep SDK logs out of the console, including any auth response details."""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return fn(*args, **kwargs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="run a clearly labeled backtest using only fully covered current stocks",
    )
    args = parser.parse_args()

    missing = [
        key
        for key in ("FINLAB_REFRESH_TOKEN", "FINLAB_SESSION_ID", "FINLAB_API_KEY")
        if not os.environ.get(key)
    ]
    if missing:
        print("FinLab credentials are not configured: " + ", ".join(missing), file=sys.stderr)
        return 2

    stage = "login"
    try:
        quiet_call(finlab.login)

        stage = "download close prices"
        close = quiet_call(data.get, "price:收盤價", start=HISTORY_START)
        stage = "download current listed and OTC universe"
        categories = quiet_call(
            data.get, "security_categories_history", start="2026-10-01"
        )
        frames = {
            "open": quiet_call(data.get, "price:開盤價", start=HISTORY_START),
            "high": quiet_call(data.get, "price:最高價", start=HISTORY_START),
            "low": quiet_call(data.get, "price:最低價", start=HISTORY_START),
            "volume": quiet_call(data.get, "price:成交股數", start=HISTORY_START),
            "amount": quiet_call(data.get, "price:成交金額", start=HISTORY_START),
        }

        # Taiwanese listed and OTC common-share tickers use four digits and do
        # not begin with zero; this excludes ETF codes and warrants.
        close = close.copy()
        close.columns = close.columns.map(str)
        if close.columns.has_duplicates:
            raise ValueError("duplicate ticker columns in FinLab close data")
        symbols = [
            symbol
            for symbol in close.columns
            if re.fullmatch(r"[1-9]\d{3}", symbol)
        ]
        if not symbols:
            raise ValueError("no four-digit Taiwan common-stock symbols found")

        current_categories = (
            categories.sort_values("date")
            .drop_duplicates("symbol", keep="last")
        )
        current_symbols = sorted(
            str(symbol)
            for symbol, market in zip(
                current_categories["symbol"], current_categories["market"]
            )
            if market in {"sii", "otc"}
            and re.fullmatch(r"[1-9]\d{3}", str(symbol))
        )
        if not current_symbols:
            raise ValueError("FinLab current listed/OTC stock universe is empty")

        close = close.loc[:, symbols].sort_index().apply(pd.to_numeric, errors="coerce")
        aligned = {"close": close}
        for name, frame in frames.items():
            frame = frame.copy()
            frame.columns = frame.columns.map(str)
            if frame.columns.has_duplicates:
                raise ValueError(f"duplicate ticker columns in FinLab {name} data")
            aligned[name] = frame.reindex(index=close.index, columns=symbols).apply(
                pd.to_numeric, errors="coerce"
            )

        if close.empty or close.index.has_duplicates:
            raise ValueError("FinLab price data is empty or has duplicate dates")
        for name, frame in aligned.items():
            if frame.index.max() != close.index.max():
                raise ValueError(f"{name} has a different latest date from close prices")

        current_frames = {
            name: frame.reindex(columns=current_symbols)
            for name, frame in aligned.items()
        }
        complete_486_close_window = current_frames["close"].tail(
            RECENT_COMPLETENESS_BARS
        )
        complete_486_close = (
            complete_486_close_window.notna().all(axis=0)
            if len(complete_486_close_window) == RECENT_COMPLETENESS_BARS
            else pd.Series(False, index=current_symbols)
        )
        complete_486_ohlcv = pd.Series(True, index=current_symbols)
        for name, frame in aligned.items():
            window = current_frames[name].tail(RECENT_COMPLETENESS_BARS)
            complete_486_ohlcv &= (
                window.notna().all(axis=0)
                if len(window) == RECENT_COMPLETENESS_BARS
                else pd.Series(False, index=current_symbols)
            )
        latest = close.index.max()
        complete_count = int(complete_486_ohlcv.sum())
        if complete_count != len(current_symbols) and not args.allow_partial:
            print("coverage_check_failed: current listed/OTC market is incomplete")
            print(f"latest_price_date: {latest.date()}")
            print(f"current_sii_otc_stocks: {len(current_symbols)}")
            print(
                "complete_486_ohlcv_and_turnover: "
                f"{int(complete_486_ohlcv.sum())}/{len(current_symbols)}"
            )
            print(
                "incomplete_or_missing_tickers: "
                f"{len(current_symbols) - int(complete_486_ohlcv.sum())}"
            )
            print("backtest: not run; no partial-market report was written")
            return 3
        if complete_count == 0:
            raise ValueError("no current stocks pass the complete 486-bar check")

        # Keep the historical simulation on the currently listed securities
        # with a fully verified recent OHLCV/turnover window. When partial mode
        # is explicitly chosen, the report warns about the resulting survivor
        # bias and incomplete market coverage.
        backtest_symbols = list(complete_486_ohlcv[complete_486_ohlcv].index)
        close = close.reindex(columns=backtest_symbols)
        aligned = {
            name: frame.reindex(columns=backtest_symbols)
            for name, frame in aligned.items()
        }

        # 6–1 month cross-sectional momentum: 126 sessions of history, excluding
        # the most recent 21 sessions; require a 120-session uptrend and
        # sufficient 20-session average traded value before ranking.
        momentum = close.shift(MOMENTUM_SKIP).div(close.shift(MOMENTUM_LOOKBACK)).sub(1)
        trend_filter = close.gt(
            close.rolling(TREND_WINDOW, min_periods=TREND_WINDOW).mean()
        )
        avg_turnover = aligned["amount"].rolling(
            LIQUIDITY_WINDOW, min_periods=LIQUIDITY_WINDOW
        ).mean()
        eligible = (
            momentum.gt(0)
            & trend_filter
            & avg_turnover.ge(MIN_AVERAGE_DAILY_TURNOVER_NTD)
        )
        score = momentum.where(eligible)
        selected = score.rank(axis=1, ascending=False, method="first").le(HOLDINGS)
        position = selected.fillna(False).astype(bool)

        # Do not silently produce a strategy with no current constituents.
        latest_positions = position.loc[:latest].iloc[-1]
        if not latest_positions.any():
            raise ValueError("no stocks pass the strategy filters on the latest date")

        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        stage = "backtest"
        report = sim(
            position,
            resample="M",
            trade_at_price="close",
            position_limit=1 / HOLDINGS,
            fee_ratio=FEE_RATIO,
            tax_ratio=SELL_TAX_RATIO,
            market="TW_STOCK",
            name="台股 6–1 月動能（部分市場、20 檔、月調整）",
            upload=False,
        )

        stage = "write HTML report"
        report.to_html(str(OUTPUT_PATH))
        method_note = f"""
<aside role="note" aria-label="回測策略與資料說明"
 style="margin:16px auto;max-width:1200px;padding:16px 20px;border:1px solid #93c5fd;
 border-radius:12px;background:#eff6ff;color:#172554;font:14px/1.65 system-ui,sans-serif">
 <strong style="font-size:16px">台股 6–1 月動能策略｜部分市場回測</strong>
 <div>資料期間：{html.escape(str(close.index.min().date()))} 至 {html.escape(str(latest.date()))}；
 FinLab 回測區間：2010-07-30 至 {html.escape(str(latest.date()))}。</div>
 <div>選股：近 126 個交易日報酬（排除最近 21 日）為正、收盤價高於 120 日均線、
 近 20 日平均成交金額至少新台幣 3,000 萬元；每月選前 20 檔，等權重上限 5%。</div>
 <div>交易假設：FinLab 收盤價成交；手續費 0.1425%，賣出證交稅 0.3%。</div>
 <div>覆蓋範圍：FinLab 現行上市櫃股票 {len(current_symbols):,} 檔中，
 本回測只使用最近 486 日開、高、低、收、成交股數及成交金額完整的
 {len(backtest_symbols):,} 檔；排除 {len(current_symbols) - len(backtest_symbols):,} 檔。</div>
 <div><strong>重大限制：</strong>這不是全市場回測。為保持本次選定的完整資料門檻，
 歷史回測也只使用目前仍上市且資料完整的股票，存在存活者偏差；不可視為完整市場排名或實盤建議。
 FinLab 將本次回測標示為非交易就緒（historical data selection）。</div>
 <div>FinLab 亦提示市場值歷史資料曾於排程外更新；此報告是研究快照，結果可能隨資料修訂而變動。</div>
</aside>
"""
        report_html = OUTPUT_PATH.read_text(encoding="utf-8")
        body_match = re.search(r"<body[^>]*>", report_html, flags=re.IGNORECASE)
        if not body_match:
            raise ValueError("FinLab HTML report does not contain a body element")
        report_html = (
            report_html[: body_match.end()]
            + method_note
            + report_html[body_match.end() :]
        )
        OUTPUT_PATH.write_text(report_html, encoding="utf-8")
        if OUTPUT_PATH.stat().st_size > 5_242_880:
            raise ValueError("HTML report exceeds the 5 MiB delivery limit")

        print("backtest: success")
        print(f"data_period: {close.index.min().date()} to {latest.date()}")
        print(f"data_rows: {len(close)}")
        print(f"backtest_universe: {len(backtest_symbols)}")
        print(f"current_sii_otc_stocks: {len(current_symbols)}")
        print(f"complete_486_close_series: {int(complete_486_close.sum())}")
        print(f"complete_486_ohlcv_and_turnover_series: {complete_count}")
        print(f"excluded_current_stocks: {len(current_symbols) - complete_count}")
        print(f"latest_close_date: {latest.date()}")
        print(f"latest_selected_stocks: {int(latest_positions.sum())}")
        print(f"html_report: {OUTPUT_PATH}")
        print(f"html_bytes: {OUTPUT_PATH.stat().st_size}")

        stats = getattr(report, "stats", None)
        if stats is not None:
            if hasattr(stats, "to_string"):
                print("backtest_stats:")
                print(stats.to_string()[:5000])
            else:
                print("backtest_stats:", str(stats)[:5000])
        return 0
    except Exception as exc:
        print(f"finlab_run_failed_at: {stage}")
        print(f"error_type: {type(exc).__name__}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
