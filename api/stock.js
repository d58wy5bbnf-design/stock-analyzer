export default async function handler(req, res) {
  const raw = String(req.query.symbol || "").trim().toUpperCase();

  if (!raw) {
    return res.status(400).json({ error: "請輸入股票代號" });
  }

  // 台股輸入 2330，自動轉成 2330.TW
  const symbol = /^\d{4,6}$/.test(raw) ? `${raw}.TW` : raw;

  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/` +
      `${encodeURIComponent(symbol)}?range=6mo&interval=1d`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error("行情資料暫時無法取得");
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];

    if (!result) {
      return res.status(404).json({ error: "找不到這個股票代號" });
    }

    const quote = result.indicators?.quote?.[0] || {};

    const rows = (result.timestamp || [])
      .map((time, i) => ({
        time,
        open: quote.open?.[i],
        high: quote.high?.[i],
        low: quote.low?.[i],
        close: quote.close?.[i],
        volume: quote.volume?.[i]
      }))
      .filter(
        x =>
          Number.isFinite(x.close) &&
          Number.isFinite(x.high) &&
          Number.isFinite(x.low)
      );

    if (rows.length < 30) {
      return res.status(400).json({ error: "歷史行情資料不足" });
    }

    res.setHeader(
      "Cache-Control",
      "s-maxage=60, stale-while-revalidate=300"
    );

    return res.status(200).json({
      symbol,
      name:
        result.meta?.longName ||
        result.meta?.shortName ||
        symbol,
      currency: result.meta?.currency || "",
      rows
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message || "股票資料取得失敗"
    });
  }
}
