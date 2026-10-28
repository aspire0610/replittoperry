# 台股量化儀表板

Streamlit 台股量化儀表板，提供市場總覽、個股行情、技術分析與多因子方向評估。

## Run & Operate

- `streamlit run app.py --server.port 5000 --server.address 0.0.0.0` — run the dashboard
- `python -m py_compile app.py` — check Python syntax
- Required env: none

## Stack

- Python 3.13
- Streamlit, pandas, NumPy, Plotly, requests, yfinance

## Where things live

- `app.py` — complete dashboard implementation

## Architecture decisions

- Keep the original Streamlit application as the source of truth rather than rewriting its analysis in another framework.
- Use external quote/history sources with explicit safe fallbacks; fallback values are not live market data.
- Treat direction confidence as a heuristic score, not a calibrated probability or win rate.

## Product

The dashboard lets users inspect Taiwan market conditions, choose a ticker, review technical and quantitative signals, and explore price/risk scenarios.

## User preferences

- The user wants to edit and run the dashboard in the cloud.
- The user prefers a glass-like light UI with readable, high-contrast text.

## Gotchas

- Some quote/history data depends on Yahoo Finance and TWSE endpoints; availability and freshness vary.
- Heuristic scores are not investment advice or statistically calibrated probabilities.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
