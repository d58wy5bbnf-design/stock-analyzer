// 妖子平台 3.2
// Fugle 台股盤中 K 棒 API
// API Key 必須存在 Vercel Environment Variable：FUGLE_API_KEY

const FUGLE_BASE =
  "https://api.fugle.tw/marketdata/v1.0/stock/intraday/candles";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, status, data) {
  res.status(status).json(data);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeTimeframe(value) {
  const tf = String(value || "1").trim();

  const allowed = ["1", "5", "15", "30", "60"];

  return allowed.includes(tf) ? tf : "1";
}

function timestampOf(candle) {
  const raw =
    candle.date ??
    candle.time ??
    candle.timestamp ??
    candle.datetime ??
    candle.at;

  if (raw == null) return null;

  // Fugle 若回傳 Unix milliseconds
  if (typeof raw === "number") {
    if (raw > 1000000000000) return raw;
    if (raw > 1000000000) return raw * 1000;
  }

  const parsed = new Date(raw).getTime();

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function normalizeCandle(candle) {
  const timestamp = timestampOf(candle);

  return {
    timestamp,
    time:
      timestamp != null
        ? new Date(timestamp).toISOString()
        : null,

    open: num(candle.open),
    high: num(candle.high),
    low: num(candle.low),
    close: num(candle.close),

    volume: num(
      candle.volume ??
      candle.totalVolume ??
      candle.tradeVolume
    ),

    average: num(
      candle.average ??
      candle.avgPrice
    )
  };
}

/*
  將 1 分 K 聚合成：
  5 / 15 / 30 / 60 分 K
*/

function aggregateCandles(candles, minutes) {
  if (minutes === 1) {
    return candles;
  }

  const bucketMs = minutes * 60 * 1000;
  const groups = new Map();

  for (const c of candles) {
    if (
      !Number.isFinite(c.timestamp) ||
      c.open == null ||
      c.high == null ||
      c.low == null ||
      c.close == null
    ) {
      continue;
    }

    const bucket =
      Math.floor(c.timestamp / bucketMs) *
      bucketMs;

    if (!groups.has(bucket)) {
      groups.set(bucket, {
        timestamp: bucket,
        time: new Date(bucket).toISOString(),

        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,

        volume: c.volume || 0,

        average: c.average
      });

      continue;
    }

    const g = groups.get(bucket);

    g.high = Math.max(g.high, c.high);
    g.low = Math.min(g.low, c.low);
    g.close = c.close;

    g.volume += c.volume || 0;

    if (c.average != null) {
      g.average = c.average;
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => a.timestamp - b.timestamp);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return send(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  const apiKey =
    process.env.FUGLE_API_KEY;

  if (!apiKey) {
    return send(res, 500, {
      ok: false,
      error:
        "Vercel 尚未設定 FUGLE_API_KEY"
    });
  }

  const symbol =
    normalizeSymbol(req.query.symbol);

  const timeframe =
    normalizeTimeframe(req.query.timeframe);

  if (!symbol) {
    return send(res, 400, {
      ok: false,
      error:
        "缺少 symbol，例如 ?symbol=2330"
    });
  }

  /*
    目前這支 API 專門處理台股。
  */

  if (!/^[0-9A-Z]{4,10}$/.test(symbol)) {
    return send(res, 400, {
      ok: false,
      error: "股票代號格式錯誤"
    });
  }

  try {
    /*
      Fugle Intraday Candles

      先取得 1 分 K，
      其他週期由妖子平台自己聚合。

      這樣 5 / 15 / 30 / 60 分
      都使用同一組原始盤中資料。
    */

    const url =
      `${FUGLE_BASE}/${encodeURIComponent(symbol)}` +
      `?apiKey=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    const rawText =
      await response.text();

    let raw;

    try {
      raw = JSON.parse(rawText);
    } catch (e) {
      raw = null;
    }

    if (!response.ok) {
      return send(res, response.status, {
        ok: false,
        source: "Fugle",
        symbol,
        error:
          raw?.message ||
          raw?.error ||
          rawText ||
          `Fugle HTTP ${response.status}`
      });
    }

    /*
      相容不同回傳包裝格式：
      data
      candles
      data.candles
    */

    let sourceCandles = [];

    if (Array.isArray(raw)) {
      sourceCandles = raw;
    } else if (Array.isArray(raw?.data)) {
      sourceCandles = raw.data;
    } else if (Array.isArray(raw?.candles)) {
      sourceCandles = raw.candles;
    } else if (
      raw?.data &&
      Array.isArray(raw.data.candles)
    ) {
      sourceCandles =
        raw.data.candles;
    }

    let oneMinute =
      sourceCandles
        .map(normalizeCandle)
        .filter(c =>
          Number.isFinite(c.timestamp) &&
          c.open != null &&
          c.high != null &&
          c.low != null &&
          c.close != null
        )
        .sort(
          (a, b) =>
            a.timestamp - b.timestamp
        );

    if (!oneMinute.length) {
      return send(res, 502, {
        ok: false,
        source: "Fugle",
        symbol,
        error:
          "Fugle 有回應，但目前沒有取得可用 K 棒",
        rawKeys:
          raw && typeof raw === "object"
            ? Object.keys(raw)
            : []
      });
    }

    const minutes =
      Number(timeframe);

    const candles =
      aggregateCandles(
        oneMinute,
        minutes
      );

    const latest =
      candles[candles.length - 1] ||
      null;

    /*
      不快取，讓盤中重新呼叫時
      可以取得最新資料。
    */

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    return send(res, 200, {
      ok: true,

      platform: "妖子平台 3.2",

      source:
        "Fugle MarketData",

      market: "TW",

      symbol,

      timeframe:
        timeframe + "m",

      baseTimeframe:
        "1m",

      count:
        candles.length,

      latest,

      candles,

      updatedAt:
        new Date().toISOString(),

      notice:
        timeframe === "1"
          ? "Fugle 盤中分鐘 K"
          : `由 Fugle 1 分 K 聚合為 ${timeframe} 分 K`
    });

  } catch (error) {
    console.error(
      "kbar error:",
      error
    );

    return send(res, 500, {
      ok: false,
      source: "Fugle",
      symbol,
      error:
        error?.message ||
        "取得 K 棒時發生未知錯誤"
    });
  }
}
