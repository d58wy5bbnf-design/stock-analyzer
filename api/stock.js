const https = require("https");

module.exports = async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {

    let symbol = String(req.query.symbol || "")
      .trim()
      .toUpperCase()
      .replace(".TW", "")
      .replace(".TWO", "");

    if (!/^\d{4,6}$/.test(symbol)) {
      return res.status(400).json({
        ok: false,
        error: "請輸入正確的台股代號"
      });
    }

    /*
      Yahoo 台股：
      上市 = .TW
      上櫃 = .TWO

      先嘗試上市，
      找不到再自動嘗試上櫃。
    */

    let result = null;

    try {
      result = await loadStock(symbol + ".TW");
    } catch (e) {}

    if (!result || !result.rows || result.rows.length < 60) {
      try {
        result = await loadStock(symbol + ".TWO");
      } catch (e) {}
    }

    if (!result || !result.rows || result.rows.length < 60) {
      throw new Error("找不到股票資料");
    }

    const rows = result.rows;

    const latest = rows[rows.length - 1];
    const previous = rows.length >= 2 ? rows[rows.length - 2] : latest;

    /*
      即時價格優先順序：

      1. Yahoo chart meta regularMarketPrice
      2. 最新 K 線 close
    */

    let price = Number(result.price);

    if (!Number.isFinite(price) || price <= 0) {
      price = Number(latest.close);
    }

    /*
      昨收優先使用 Yahoo meta previousClose。
    */

    let previousClose = Number(result.previousClose);

    if (!Number.isFinite(previousClose) || previousClose <= 0) {
      previousClose = Number(previous.close);
    }

    let change = price - previousClose;

    let changePercent =
      previousClose > 0
        ? (change / previousClose) * 100
        : 0;

    /*
      名稱
    */

    let name =
      result.longName ||
      result.shortName ||
      symbol;

    /*
      今日 OHLC

      即時交易期間 Yahoo 最新一根日 K
      有時 close 尚未更新，因此價格仍以 meta 為優先。
    */

    let todayOpen = Number(result.open);

    if (!Number.isFinite(todayOpen) || todayOpen <= 0) {
      todayOpen = Number(latest.open);
    }

    let todayHigh = Number(result.dayHigh);

    if (!Number.isFinite(todayHigh) || todayHigh <= 0) {
      todayHigh = Number(latest.high);
    }

    let todayLow = Number(result.dayLow);

    if (!Number.isFinite(todayLow) || todayLow <= 0) {
      todayLow = Number(latest.low);
    }

    let volume = Number(result.volume);

    if (!Number.isFinite(volume) || volume < 0) {
      volume = Number(latest.volume || 0);
    }

    return res.status(200).json({

      ok: true,

      symbol,

      yahooSymbol: result.yahooSymbol,

      market:
        result.yahooSymbol.endsWith(".TWO")
          ? "TWO"
          : "TW",

      name,

      price: round(price),

      previousClose: round(previousClose),

      change: round(change),

      changePercent: round(changePercent),

      open: round(todayOpen),

      high: round(todayHigh),

      low: round(todayLow),

      volume,

      currency: "TWD",

      marketState:
        result.marketState || "",

      timestamp:
        result.timestamp || Date.now(),

      rows

    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      ok: false,
      error:
        error && error.message
          ? error.message
          : "股票資料取得失敗"
    });

  }
};


/* =========================================================
   Yahoo Finance
========================================================= */

async function loadStock(yahooSymbol) {

  /*
    取約一年資料。

    前端目前需要：
    MA20
    MA60
    RSI
    MACD
    ATR
    支撐
    壓力
    成交量

    所以一年日 K 足夠。
  */

  const period2 = Math.floor(Date.now() / 1000);

  /*
    多抓 450 天，
    避免假日造成交易日不足。
  */

  const period1 =
    period2 - 450 * 24 * 60 * 60;

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSymbol) +
    "?period1=" +
    period1 +
    "&period2=" +
    period2 +
    "&interval=1d" +
    "&includePrePost=false" +
    "&events=div%2Csplits" +
    "&corsDomain=finance.yahoo.com";

  const json = await requestJSON(url);

  if (
    !json ||
    !json.chart ||
    json.chart.error
  ) {

    throw new Error(
      json &&
      json.chart &&
      json.chart.error &&
      json.chart.error.description
        ? json.chart.error.description
        : "Yahoo 股票資料取得失敗"
    );

  }

  const result =
    json.chart.result &&
    json.chart.result[0];

  if (!result) {
    throw new Error("查無股票資料");
  }

  const timestamps =
    Array.isArray(result.timestamp)
      ? result.timestamp
      : [];

  const quote =
    result.indicators &&
    result.indicators.quote &&
    result.indicators.quote[0];

  if (!quote) {
    throw new Error("股票 K 線資料不存在");
  }

  const opens =
    quote.open || [];

  const highs =
    quote.high || [];

  const lows =
    quote.low || [];

  const closes =
    quote.close || [];

  const volumes =
    quote.volume || [];

  const rows = [];

  for (
    let i = 0;
    i < timestamps.length;
    i++
  ) {

    const open =
      Number(opens[i]);

    const high =
      Number(highs[i]);

    const low =
      Number(lows[i]);

    const close =
      Number(closes[i]);

    const volume =
      Number(volumes[i] || 0);

    /*
      缺 OHLC 的資料不加入技術分析。
    */

    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      close <= 0
    ) {
      continue;
    }

    rows.push({

      timestamp:
        timestamps[i] * 1000,

      date:
        formatDate(
          timestamps[i] * 1000
        ),

      open:
        round(open),

      high:
        round(high),

      low:
        round(low),

      close:
        round(close),

      volume:
        Number.isFinite(volume)
          ? volume
          : 0

    });

  }

  if (rows.length < 60) {
    throw new Error("歷史資料不足");
  }

  /*
    最多保留最近 365 個交易資料。

    已足夠前端技術分析，
    同時減少 API 傳輸量。
  */

  const cleanRows =
    rows.slice(-365);

  const meta =
    result.meta || {};

  return {

    yahooSymbol,

    rows: cleanRows,

    price:
      firstNumber(
        meta.regularMarketPrice,
        cleanRows.at(-1)?.close
      ),

    previousClose:
      firstNumber(
        meta.chartPreviousClose,
        meta.previousClose,
        cleanRows.at(-2)?.close
      ),

    open:
      firstNumber(
        meta.regularMarketOpen,
        cleanRows.at(-1)?.open
      ),

    dayHigh:
      firstNumber(
        meta.regularMarketDayHigh,
        cleanRows.at(-1)?.high
      ),

    dayLow:
      firstNumber(
        meta.regularMarketDayLow,
        cleanRows.at(-1)?.low
      ),

    volume:
      firstNumber(
        meta.regularMarketVolume,
        cleanRows.at(-1)?.volume,
        0
      ),

    longName:
      meta.longName || "",

    shortName:
      meta.shortName || "",

    marketState:
      meta.marketState || "",

    timestamp:
      Number(meta.regularMarketTime)
        ? Number(meta.regularMarketTime) * 1000
        : Date.now()

  };

}


/* =========================================================
   HTTP Request
========================================================= */

function requestJSON(url) {

  return new Promise(
    (resolve, reject) => {

      const options = {
        headers: {

          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",

          "Accept":
            "application/json,text/plain,*/*",

          "Accept-Language":
            "zh-TW,zh;q=0.9,en;q=0.8",

          "Cache-Control":
            "no-cache",

          "Pragma":
            "no-cache"

        },

        timeout: 12000
      };

      const req =
        https.get(
          url,
          options,
          response => {

            let data = "";

            response.on(
              "data",
              chunk => {
                data += chunk;
              }
            );

            response.on(
              "end",
              () => {

                if (
                  response.statusCode < 200 ||
                  response.statusCode >= 300
                ) {

                  return reject(
                    new Error(
                      "行情服務回傳錯誤 " +
                      response.statusCode
                    )
                  );

                }

                try {

                  const json =
                    JSON.parse(data);

                  resolve(json);

                } catch (e) {

                  reject(
                    new Error(
                      "行情資料格式錯誤"
                    )
                  );

                }

              }
            );

          }
        );

      req.on(
        "timeout",
        () => {

          req.destroy();

          reject(
            new Error(
              "行情服務連線逾時"
            )
          );

        }
      );

      req.on(
        "error",
        reject
      );

    }
  );

}


/* =========================================================
   Helpers
========================================================= */

function firstNumber(...values) {

  for (const value of values) {

    const n =
      Number(value);

    if (
      Number.isFinite(n) &&
      n >= 0
    ) {
      return n;
    }

  }

  return 0;
}


function round(value) {

  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  /*
    台股高價股也保留兩位，
    前端會統一格式化。
  */

  return Math.round(
    n * 100
  ) / 100;

}


function formatDate(ms) {

  const d =
    new Date(ms);

  const year =
    d.getUTCFullYear();

  const month =
    String(
      d.getUTCMonth() + 1
    ).padStart(
      2,
      "0"
    );

  const day =
    String(
      d.getUTCDate()
    ).padStart(
      2,
      "0"
    );

  return (
    year +
    "-" +
    month +
    "-" +
    day
  );

}
