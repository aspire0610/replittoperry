---
name: AI day-trade screening
description: User's requested short-term day-trading framing for the Taiwan stock AI picks screen.
---

AI 選股以短線當沖條件作觀察參考。盤後掃描保留，但必須標示為「下一交易日觀察清單」，不可呈現為當日可用的當沖訊號。歷史日線、多日回測不是當沖績效，顯示時需明確區分。

CDP levels use the prior completed session: CDP=(H+L+2C)/4, AH=CDP+(H-L), NH=2CDP-L, NL=2CDP-H, AL=CDP-(H-L). The scan may show opening/current price zones, but must not claim a breakout or reversal without intraday crossing sequence evidence.

**Why:** The user requested switching AI stock picks to reference short-term day-trading conditions and explicitly chose to retain after-hours scans as next-session watchlists.

**How to apply:** Use fresh intraday quotes only during the selected entry window; after hours, label the list for the next trading session and require users to recheck price and liquidity after the open. Never label daily-bar statistics as intraday hit rates. Treat CDP as supporting resistance context, not a standalone entry signal; preserve its source link in the UI.
