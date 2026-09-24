// ============================================================
// 妖子平台 3.4
// api/kbar.js
//
// 功能：
// 1. Fugle 歷史分 K + 今日即時分 K 合併
// 2. 支援 1 / 3 / 5 / 10 / 15 / 30 / 60 分
// 3. 支援 2H / 4H / 6H / 12H
// 4. 小時 K 由 1 分 K 按「每個交易日 09:00」重新分桶
// 5. 自動去除重複 K 棒
// 6. 最新盤中資料覆蓋同時間歷史資料
//
// Vercel Environment Variable:
// FUGLE_API_KEY
// ============================================================

const FUGLE_BASE =
  "https://api.fugle.tw/marketdata/v1.0/stock";


// ============================================================
// BASIC
// ============================================================

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

  return res
    .status(status)
    .json(data);
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


// ============================================================
// TIMEFRAME
// ============================================================

function normalizeTimeframe(value) {

  const tf =
    String(value || "1m")
      .trim()
      .toLowerCase();

  const map = {

    "1": "1m",
    "3": "3m",
    "5": "5m",
    "10": "10m",
    "15": "15m",
    "30": "30m",
    "60": "60m",

    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "10m": "10m",
    "15m": "15m",
    "30m": "30m",
    "60m": "60m",

    "1h": "60m",

    "2h": "2h",
    "4h": "4h",
    "6h": "6h",
    "12h": "12h"
  };

  return map[tf] || "1m";
}


function nativeTimeframe(tf) {

  const map = {

    "1m": "1",
    "3m": "3",
    "5m": "5",
    "10m": "10",
    "15m": "15",
    "30m": "30",
    "60m": "60"
  };

  return map[tf] || null;
}


// ============================================================
// TAIPEI DATE
// ============================================================

function taipeiParts(timestamp) {

  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Asia/Taipei",

        year: "numeric",
        month: "2-digit",
        day: "2-digit",

        hour: "2-digit",
        minute: "2-digit",

        hourCycle: "h23"
      }
    )
    .formatToParts(
      new Date(timestamp)
    );

  const result = {};

  for (const p of parts) {

    if (p.type !== "literal") {
      result[p.type] = p.value;
    }
  }

  return {

    year: Number(result.year),

    month: Number(result.month),

    day: Number(result.day),

    hour: Number(result.hour),

    minute: Number(result.minute)
  };
}


function taipeiDateString(date) {

  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Asia/Taipei",

      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  )
  .format(date);
}


function addDaysTaipeiString(days) {

  const now = new Date();

  const shifted =
    new Date(
      now.getTime() +
      days * 86400000
    );

  return taipeiDateString(shifted);
}


// ============================================================
// TIMESTAMP
// ============================================================

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


  if (
    typeof raw === "number" &&
    raw > 1000000000000
  ) {

    return raw;
  }


  if (
    typeof raw === "number" &&
    raw > 1000000000
  ) {

    return raw * 1000;
  }


  const parsed =
    new Date(raw).getTime();


  return Number.isFinite(parsed)
    ? parsed
    : null;
}


// ============================================================
// NORMALIZE CANDLE
// ============================================================

function normalizeCandle(candle) {

  const timestamp =
    timestampOf(candle);


  return {

    timestamp,

    time:
      timestamp != null
        ? new Date(timestamp).toISOString()
        : null,

    open:
      num(candle.open),

    high:
      num(candle.high),

    low:
      num(candle.low),

    close:
      num(candle.close),

    volume:
      num(candle.volume) || 0,

    average:
      num(candle.average)
  };
}


function normalizeCandles(source) {

  if (!Array.isArray(source)) {
    return [];
  }


  return source

    .map(normalizeCandle)

    .filter(candle =>

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
}


// ============================================================
// FUGLE REQUEST
// ============================================================

async function fugleRequest(url, apiKey) {

  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {

          "X-API-KEY":
            apiKey,

          "Accept":
            "application/json"
        },

        cache:
          "no-store"
      }
    );


  const text =
    await response.text();


  let raw = null;


  try {

    raw =
      JSON.parse(text);

  } catch (error) {

    raw = null;
  }


  if (!response.ok) {

    const error =
      new Error(

        raw?.message ||
        raw?.error ||
        text ||
        `Fugle HTTP ${response.status}`
      );

    error.status =
      response.status;

    throw error;
  }


  return raw;
}


// ============================================================
// INTRADAY
// ============================================================

async function fetchIntraday(
  symbol,
  timeframe,
  apiKey
) {

  const url =

    `${FUGLE_BASE}` +
    `/intraday/candles/` +
    `${encodeURIComponent(symbol)}` +
    `?timeframe=` +
    `${encodeURIComponent(timeframe)}` +
    `&sort=asc`;


  const raw =
    await fugleRequest(
      url,
      apiKey
    );


  return {

    raw,

    candles:
      normalizeCandles(
        raw?.data || []
      )
  };
}


// ============================================================
// HISTORICAL
// ============================================================

async function fetchHistorical(
  symbol,
  timeframe,
  apiKey,
  days
) {

  const to =
    addDaysTaipeiString(0);

  const from =
    addDaysTaipeiString(-days);


  const url =

    `${FUGLE_BASE}` +
    `/historical/candles/` +
    `${encodeURIComponent(symbol)}` +

    `?timeframe=` +
    `${encodeURIComponent(timeframe)}` +

    `&from=` +
    `${encodeURIComponent(from)}` +

    `&to=` +
    `${encodeURIComponent(to)}` +

    `&fields=` +
    `open%2Chigh%2Clow%2Cclose%2Cvolume%2Caverage` +

    `&sort=asc`;


  try {

    const raw =
      await fugleRequest(
        url,
        apiKey
      );


    return {

      raw,

      candles:
        normalizeCandles(
          raw?.data || []
        )
    };


  } catch (error) {

    /*
      如果日期區間剛好完全沒有歷史資料，
      Fugle 可能回 404。

      不讓整個盤中圖表因此掛掉。
    */

    if (error.status === 404) {

      return {

        raw: null,

        candles: []
      };
    }


    throw error;
  }
}


// ============================================================
// MERGE
// ============================================================

function mergeCandles(
  historical,
  intraday
) {

  const map =
    new Map();


  /*
    先放歷史
  */

  for (const candle of historical) {

    map.set(
      candle.timestamp,
      candle
    );
  }


  /*
    再放盤中。

    如果同 timestamp，
    盤中最新資料覆蓋歷史。
  */

  for (const candle of intraday) {

    map.set(
      candle.timestamp,
      candle
    );
  }


  return Array
    .from(
      map.values()
    )
    .sort(
      (a, b) =>
        a.timestamp -
        b.timestamp
    );
}


// ============================================================
// LIMIT
// ============================================================

function limitCandles(
  candles,
  limit
) {

  if (
    candles.length <= limit
  ) {

    return candles;
  }


  return candles.slice(
    candles.length - limit
  );
}


// ============================================================
// TAIWAN SESSION MINUTES
// ============================================================

function sessionMinuteOfDay(
  timestamp
) {

  const p =
    taipeiParts(
      timestamp
    );


  return (
    p.hour * 60 +
    p.minute
  );
}


function sessionDateKey(
  timestamp
) {

  const p =
    taipeiParts(
      timestamp
    );


  return (
    String(p.year) +
    "-" +
    String(p.month).padStart(2, "0") +
    "-" +
    String(p.day).padStart(2, "0")
  );
}


// ============================================================
// HOURLY AGGREGATION
// ============================================================

function aggregateSessionCandles(
  candles,
  intervalMinutes
) {

  const buckets =
    new Map();


  /*
    台股整股一般盤：

    09:00 開始。

    每個交易日都重新從 09:00
    計算週期，避免跨日或用 Unix
    epoch 導致 2H / 4H 分桶錯位。
  */

  const SESSION_START =
    9 * 60;


  for (const candle of candles) {

    const minuteOfDay =
      sessionMinuteOfDay(
        candle.timestamp
      );


    if (
      minuteOfDay <
      SESSION_START
    ) {

      continue;
    }


    const sessionOffset =
      minuteOfDay -
      SESSION_START;


    const bucketIndex =
      Math.floor(
        sessionOffset /
        intervalMinutes
      );


    const key =

      sessionDateKey(
        candle.timestamp
      ) +

      "|" +

      bucketIndex;


    if (!buckets.has(key)) {

      buckets.set(
        key,
        {

          timestamp:
            candle.timestamp,

          time:
            candle.time,

          open:
            candle.open,

          high:
            candle.high,

          low:
            candle.low,

          close:
            candle.close,

          volume:
            Number(
              candle.volume
            ) || 0
        }
      );

      continue;
    }


    const current =
      buckets.get(key);


    current.high =
      Math.max(
        current.high,
        candle.high
      );


    current.low =
      Math.min(
        current.low,
        candle.low
      );


    current.close =
      candle.close;


    current.volume +=
      Number(
        candle.volume
      ) || 0;
  }


  return Array
    .from(
      buckets.values()
    )
    .sort(
      (a, b) =>
        a.timestamp -
        b.timestamp
    );
}


// ============================================================
// NATIVE MINUTE DATA
// ============================================================

async function getNativeMinuteCandles(
  symbol,
  timeframe,
  apiKey
) {

  /*
    取最近 7 個日曆日。

    正常可涵蓋約 5 個交易日，
    讓 30 / 60 分 K 往左仍有
    足夠歷史。

    前端一次不用塞幾千根。
  */

  const [
    historical,
    intraday
  ] =
    await Promise.all([

      fetchHistorical(
        symbol,
        timeframe,
        apiKey,
        7
      ),

      fetchIntraday(
        symbol,
        timeframe,
        apiKey
      )
    ]);


  const merged =
    mergeCandles(
      historical.candles,
      intraday.candles
    );


  return {

    candles:
      limitCandles(
        merged,
        800
      ),

    historicalCount:
      historical.candles.length,

    intradayCount:
      intraday.candles.length
  };
}


// ============================================================
// CUSTOM HOUR DATA
// ============================================================

async function getHourlyCandles(
  symbol,
  timeframe,
  apiKey
) {

  const intervalMap = {

    "2h": 120,
    "4h": 240,
    "6h": 360,
    "12h": 720
  };


  const interval =
    intervalMap[
      timeframe
    ];


  /*
    小時級圖直接抓最近 30 天 1 分 K，
    再按每個交易日 09:00 聚合。

    這樣 2H / 4H 不會只剩今天
    兩三根。
  */

  const [
    historical,
    intraday
  ] =
    await Promise.all([

      fetchHistorical(
        symbol,
        "1",
        apiKey,
        30
      ),

      fetchIntraday(
        symbol,
        "1",
        apiKey
      )
    ]);


  const merged =
    mergeCandles(
      historical.candles,
      intraday.candles
    );


  const aggregated =
    aggregateSessionCandles(
      merged,
      interval
    );


  return {

    candles:
      limitCandles(
        aggregated,
        500
      ),

    historicalCount:
      historical.candles.length,

    intradayCount:
      intraday.candles.length
  };
}


// ============================================================
// RESPONSE STATS
// ============================================================

function buildStats(
  candles
) {

  const latest =
    candles[
      candles.length - 1
    ];


  const previous =
    candles.length >= 2
      ? candles[
          candles.length - 2
        ]
      : null;


  let latestChangePercent =
    null;


  if (
    previous &&
    previous.close
  ) {

    latestChangePercent =

      (
        latest.close -
        previous.close
      ) /

      previous.close *

      100;
  }


  const high =
    Math.max(
      ...candles.map(
        x => x.high
      )
    );


  const low =
    Math.min(
      ...candles.map(
        x => x.low
      )
    );


  const totalVolume =
    candles.reduce(
      (sum, x) =>
        sum +
        (
          Number(
            x.volume
          ) || 0
        ),
      0
    );


  return {

    latest,

    previous,

    latestChangePercent,

    high,

    low,

    totalVolume
  };
}


// ============================================================
// HANDLER
// ============================================================

export default async function handler(
  req,
  res
) {

  setCors(res);


  if (
    req.method ===
    "OPTIONS"
  ) {

    return res
      .status(204)
      .end();
  }


  if (
    req.method !==
    "GET"
  ) {

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


  const apiKey =
    process.env
      .FUGLE_API_KEY;


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


  const symbol =
    normalizeSymbol(
      req.query.symbol
    );


  const timeframe =
    normalizeTimeframe(
      req.query.timeframe
    );


  if (!symbol) {

    return send(
      res,
      400,
      {

        ok: false,

        error:
          "缺少股票代號"
      }
    );
  }


  if (
    !/^[0-9A-Z]{4,10}$/
      .test(symbol)
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

    let result;


    const native =
      nativeTimeframe(
        timeframe
      );


    if (native) {

      result =
        await getNativeMinuteCandles(
          symbol,
          native,
          apiKey
        );

    } else {

      result =
        await getHourlyCandles(
          symbol,
          timeframe,
          apiKey
        );
    }


    const candles =
      result.candles;


    if (!candles.length) {

      return send(
        res,
        502,
        {

          ok: false,

          source:
            "Fugle",

          symbol,

          timeframe,

          error:
            "目前沒有可用 K 棒資料"
        }
      );
    }


    const stats =
      buildStats(
        candles
      );


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


    return send(
      res,
      200,
      {

        ok: true,

        platform:
          "妖子平台 3.4",

        source:
          "Fugle MarketData",

        sourceType:
          "Historical + Intraday Candles",

        market:
          "TW",

        symbol,

        timeframe,

        count:
          candles.length,

        historicalCount:
          result.historicalCount,

        intradayCount:
          result.intradayCount,

        latest:
          stats.latest,

        previous:
          stats.previous,

        latestChangePercent:
          stats.latestChangePercent,

        high:
          stats.high,

        low:
          stats.low,

        totalVolume:
          stats.totalVolume,

        candles,

        updatedAt:
          new Date()
            .toISOString(),

        notice:
          "歷史 K + 今日盤中 K 已合併"
      }
    );


  } catch (error) {

    console.error(
      "妖子平台 kbar error:",
      error
    );


    return send(
      res,
      error?.status || 500,
      {

        ok: false,

        source:
          "Fugle",

        symbol,

        timeframe,

        error:
          error?.message ||
          "取得 K 棒失敗"
      }
    );
  }
}
