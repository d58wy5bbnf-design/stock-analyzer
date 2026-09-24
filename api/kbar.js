// 妖子平台 3.2
// Fugle 台股盤中 K 棒 API
// Vercel Environment Variable：FUGLE_API_KEY
//
// 支援：
// 1 分 K
// 5 分 K
// 15 分 K
// 30 分 K
// 60 分 K
//
// 使用方式：
// /api/kbar?symbol=2330&timeframe=1
// /api/kbar?symbol=2330&timeframe=5
// /api/kbar?symbol=2330&timeframe=15
// /api/kbar?symbol=2330&timeframe=30
// /api/kbar?symbol=2330&timeframe=60

const FUGLE_BASE =
  "https://api.fugle.tw/marketdata/v1.0/stock/intraday/candles";

/* =========================
   BASIC
========================= */

function setCors(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
}

function send(res, status, data) {
  return res.status(status).json(data);
}

function num(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeTimeframe(value) {
  const tf =
    String(value || "1").trim();

  const allowed = [
    "1",
    "5",
    "15",
    "30",
    "60"
  ];

  return allowed.includes(tf)
    ? tf
    : "1";
}

/* =========================
   TIME
========================= */

function timestampOf(candle) {
  const raw =
    candle.date ??
    candle.time ??
    candle.timestamp ??
    candle.datetime ??
    candle.at;

  if (raw == null) {
    return null;
  }

  /*
    Unix milliseconds
  */

  if (
    typeof raw === "number" &&
    raw > 1000000000000
  ) {
    return raw;
  }

  /*
    Unix seconds
  */

  if (
    typeof raw === "number" &&
    raw > 1000000000
  ) {
    return raw * 1000;
  }

  /*
    ISO time
  */

  const parsed =
    new Date(raw).getTime();

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

/* =========================
   NORMALIZE K
========================= */

function normalizeCandle(candle) {
  const timestamp =
    timestampOf(candle);

  return {
    timestamp,

    time:
      timestamp != null
        ? new Date(timestamp).toISOString()
        : candle.date || null,

    open:
      num(candle.open),

    high:
      num(candle.high),

    low:
      num(candle.low),

    close:
      num(candle.close),

    volume:
      num(
        candle.volume ??
        candle.totalVolume ??
        candle.tradeVolume
      ),

    average:
      num(
        candle.average ??
        candle.avgPrice
      )
  };
}

/* =========================
   MAIN
========================= */

export default async function handler(
  req,
  res
) {
  setCors(res);

  /*
    OPTIONS
  */

  if (req.method === "OPTIONS") {
    return res
      .status(204)
      .end();
  }

  /*
    GET ONLY
  */

  if (req.method !== "GET") {
    return send(
      res,
      405,
      {
        ok: false,
        error:
          "Method not allowed"
      }
    );
  }

  /*
    API KEY

    注意：
    Key 只從 Vercel Environment Variable 讀取。
    不會傳到前端。
  */

  const apiKey =
    process.env.FUGLE_API_KEY;

  if (!apiKey) {
    return send(
      res,
      500,
      {
        ok: false,
        error:
          "Vercel 尚未設定 FUGLE_API_KEY"
      }
    );
  }

  /*
    QUERY
  */

  const symbol =
    normalizeSymbol(
      req.query.symbol
    );

  const timeframe =
    normalizeTimeframe(
      req.query.timeframe
    );

  /*
    SYMBOL CHECK
  */

  if (!symbol) {
    return send(
      res,
      400,
      {
        ok: false,
        error:
          "缺少股票代號，例如 ?symbol=2330&timeframe=1"
      }
    );
  }

  /*
    目前這支 API 專門處理台股代號。

    允許：
    2330
    0050
    006208
    00878
    等台股代號。
  */

  if (
    !/^[0-9A-Z]{4,10}$/.test(symbol)
  ) {
    return send(
      res,
      400,
      {
        ok: false,
        error:
          "股票代號格式錯誤"
      }
    );
  }

  try {
    /*
      Fugle Intraday Candles

      Fugle 直接提供 timeframe，
      所以不需要自己拿 1 分 K
      再聚合成 5 / 15 / 30 / 60。
    */

    const url =
      `${FUGLE_BASE}/` +
      `${encodeURIComponent(symbol)}` +
      `?timeframe=${encodeURIComponent(timeframe)}` +
      `&sort=asc`;

    /*
      重要：
      Fugle API Key 必須放 X-API-KEY Header。

      不把 Key 放網址。
    */

    const response =
      await fetch(
        url,
        {
          method: "GET",

          headers: {
            "X-API-KEY": apiKey,
            "Accept":
              "application/json"
          },

          cache:
            "no-store"
        }
      );

    /*
      先取得原始文字，
      避免 Fugle 回非 JSON 時
      直接造成程式錯誤。
    */

    const rawText =
      await response.text();

    let raw = null;

    try {
      raw =
        JSON.parse(rawText);
    } catch (error) {
      raw = null;
    }

    /*
      FUGLE ERROR
     */

    if (!response.ok) {
      return send(
        res,
        response.status,
        {
          ok: false,

          source:
            "Fugle",

          symbol,

          timeframe:
            timeframe + "m",

          error:
            raw?.message ||
            raw?.error ||
            rawText ||
            `Fugle HTTP ${response.status}`
        }
      );
    }

    /*
      Fugle 正常格式通常為：

      {
        date: "...",
        type: "EQUITY",
        exchange: "TWSE",
        market: "TSE",
        symbol: "2330",
        timeframe: "1",
        data: [...]
      }

      這裡也保留其他可能格式的相容處理。
    */

    let sourceCandles = [];

    if (
      raw &&
      Array.isArray(raw.data)
    ) {
      sourceCandles =
        raw.data;

    } else if (
      raw &&
      Array.isArray(raw.candles)
    ) {
      sourceCandles =
        raw.candles;

    } else if (
      raw &&
      raw.data &&
      Array.isArray(
        raw.data.candles
      )
    ) {
      sourceCandles =
        raw.data.candles;

    } else if (
      Array.isArray(raw)
    ) {
      sourceCandles =
        raw;
    }

    /*
      NORMALIZE
    */

    const candles =
      sourceCandles
        .map(
          normalizeCandle
        )
        .filter(
          candle =>
            Number.isFinite(
              candle.timestamp
            ) &&
            candle.open != null &&
            candle.high != null &&
            candle.low != null &&
            candle.close != null
        )
        .sort(
          (a, b) =>
            a.timestamp -
            b.timestamp
        );

    /*
      Fugle 有回應，
      但目前沒有 K 棒。
    */

    if (!candles.length) {
      return send(
        res,
        502,
        {
          ok: false,

          source:
            "Fugle",

          symbol,

          timeframe:
            timeframe + "m",

          error:
            "Fugle 有回應，但目前沒有取得可用 K 棒",

          rawKeys:
            raw &&
            typeof raw ===
              "object"
              ? Object.keys(raw)
              : [],

          rawTimeframe:
            raw?.timeframe ??
            null,

          rawDate:
            raw?.date ??
            null
        }
      );
    }

    /*
      最新一根 K
    */

    const latest =
      candles[
        candles.length - 1
      ];

    /*
      前一根 K
    */

    const previous =
      candles.length >= 2
        ? candles[
            candles.length - 2
          ]
        : null;

    /*
      最新 K 漲跌
    */

    let latestChange = null;

    if (
      previous &&
      previous.close &&
      latest.close
    ) {
      latestChange =
        (
          (
            latest.close -
            previous.close
          ) /
          previous.close
        ) * 100;
    }

    /*
      今日 K 棒最高 / 最低
    */

    const dayHigh =
      Math.max(
        ...candles.map(
          x => x.high
        )
      );

    const dayLow =
      Math.min(
        ...candles.map(
          x => x.low
        )
      );

    /*
      成交量
    */

    const totalVolume =
      candles.reduce(
        (sum, x) =>
          sum +
          (
            Number(x.volume) ||
            0
          ),
        0
      );

    /*
      禁止 Vercel / Browser 快取。
      盤中重新請求才會拿到最新資料。
    */

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    res.setHeader(
      "Pragma",
      "no-cache"
    );

    res.setHeader(
      "Expires",
      "0"
    );

    /*
      SUCCESS
    */

    return send(
      res,
      200,
      {
        ok: true,

        platform:
          "妖子平台 3.2",

        source:
          "Fugle MarketData",

        sourceType:
          "Intraday Candles",

        market:
          "TW",

        symbol,

        name:
          raw?.name ||
          null,

        exchange:
          raw?.exchange ||
          null,

        marketType:
          raw?.market ||
          null,

        date:
          raw?.date ||
          null,

        timeframe:
          timeframe + "m",

        count:
          candles.length,

        latest,

        previous,

        latestChangePercent:
          latestChange,

        dayHigh,

        dayLow,

        totalVolume,

        candles,

        updatedAt:
          new Date()
            .toISOString(),

        notice:
          `Fugle ${timeframe} 分 K`
      }
    );

  } catch (error) {
    console.error(
      "妖子平台 kbar error:",
      error
    );

    return send(
      res,
      500,
      {
        ok: false,

        source:
          "Fugle",

        symbol,

        timeframe:
          timeframe + "m",

        error:
          error?.message ||
          "取得 K 棒時發生未知錯誤"
      }
    );
  }
}
