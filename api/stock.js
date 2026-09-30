const https = require("https");

/*
  api/stock.js

  FinMind Sponsor 版本
  ----------------------------
  即時價格：
  taiwan_stock_tick_snapshot

  歷史日 K：
  TaiwanStockPrice

  Vercel Environment Variable：
  FINMIND_TOKEN

  Yahoo Finance：完全不使用
*/

module.exports = async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {

    /* =========================
       Token
    ========================= */

    const token =
      process.env.FINMIND_TOKEN;


    if (!token) {

      return res.status(500).json({
        ok: false,
        error: "Vercel 尚未設定 FINMIND_TOKEN"
      });

    }


    /* =========================
       股票代號
    ========================= */

    const symbol =
      String(
        req.query.symbol || ""
      )
      .trim()
      .replace(/\.TW$/i, "")
      .replace(/\.TWO$/i, "");


    if (!/^\d{4,6}$/.test(symbol)) {

      return res.status(400).json({
        ok: false,
        error: "股票代號格式錯誤"
      });

    }


    /* =========================
       日期

       抓約 1 年，
       確保 MA60 / RSI / MACD / ATR
       有足夠資料
    ========================= */

    const today =
      new Date();


    const start =
      new Date();


    start.setDate(
      start.getDate() - 450
    );


    const startDate =
      formatDate(start);


    const endDate =
      formatDate(today);


    /* =========================
       同時抓：
       1. 即時快照
       2. 歷史日 K
    ========================= */

    const [
      realtimeResult,
      historyResult
    ] = await Promise.allSettled([

      getRealtime(
        symbol,
        token
      ),

      getHistory(
        symbol,
        token,
        startDate,
        endDate
      )

    ]);


    /* =========================
       歷史資料
    ========================= */

    if (
      historyResult.status !==
      "fulfilled"
    ) {

      throw new Error(
        "FinMind 歷史股價取得失敗：" +
        (
          historyResult.reason?.message ||
          "未知錯誤"
        )
      );

    }


    const history =
      historyResult.value;


    if (
      !Array.isArray(history)
      ||
      history.length < 60
    ) {

      throw new Error(
        "FinMind 歷史 K 線不足"
      );

    }


    const rows =
      history
      .map(row => {

        const open =
          Number(row.open);

        const high =
          Number(
            row.max
          );

        const low =
          Number(
            row.min
          );

        const close =
          Number(
            row.close
          );

        const volume =
          Number(
            row.Trading_Volume
          );


        if (
          !Number.isFinite(open)
          ||
          !Number.isFinite(high)
          ||
          !Number.isFinite(low)
          ||
          !Number.isFinite(close)
          ||
          close <= 0
        ) {

          return null;

        }


        return {

          date:
            row.date,

          open,

          high,

          low,

          close,

          volume:
            Number.isFinite(volume)
              ? volume
              : 0

        };

      })

      .filter(Boolean)

      .sort(
        (a, b) =>
          String(a.date)
          .localeCompare(
            String(b.date)
          )
      )

      .slice(-365);


    if (rows.length < 60) {

      throw new Error(
        "有效歷史 K 線不足"
      );

    }


    /* =========================
       最新 / 前一日
    ========================= */

    const latest =
      rows[
        rows.length - 1
      ];


    const previous =
      rows.length >= 2
        ? rows[
            rows.length - 2
          ]
        : latest;


    /* =========================
       即時資料
    ========================= */

    let realtime =
      null;


    if (
      realtimeResult.status ===
      "fulfilled"
    ) {

      realtime =
        realtimeResult.value;

    } else {

      console.error(
        "FinMind realtime error:",
        realtimeResult.reason
      );

    }


    /* =========================
       即時價格

       有 Sponsor 快照：
       使用快照 close

       快照暫時沒資料：
       才 fallback 最新日 K
    ========================= */

    const realtimePrice =
      positiveNumber(
        realtime?.close
      );


    const price =
      realtimePrice
      ||
      positiveNumber(
        latest.close
      );


    if (!price) {

      throw new Error(
        "找不到目前股價"
      );

    }


    /* =========================
       昨收

       FinMind 即時快照提供
       change_price / change_rate。

       若有 change_price：
       昨收 = 現價 - 漲跌

       沒有才使用歷史 K
    ========================= */

    let previousClose =
      0;


    const changePrice =
      finiteNumber(
        realtime?.change_price
      );


    if (
      realtimePrice
      &&
      changePrice !== null
    ) {

      previousClose =
        realtimePrice -
        changePrice;

    }


    if (
      !Number.isFinite(
        previousClose
      )
      ||
      previousClose <= 0
    ) {

      /*
        如果今日歷史 K 已經包含今天，
        previous 才是真正上一交易日。

        如果歷史資料還沒包含今天，
        latest 就是上一交易日。
      */

      const realtimeDate =
        String(
          realtime?.date || ""
        )
        .slice(0, 10);


      if (
        realtimeDate
        &&
        latest.date ===
        realtimeDate
      ) {

        previousClose =
          positiveNumber(
            previous.close
          );

      } else {

        previousClose =
          positiveNumber(
            latest.close
          );

      }

    }


    if (!previousClose) {

      previousClose =
        price;

    }


    /* =========================
       漲跌
    ========================= */

    const change =
      price -
      previousClose;


    let changePercent =
      previousClose > 0
        ?
        (
          change /
          previousClose
        ) * 100
        :
        0;


    /*
      如果 FinMind 有直接提供 change_rate，
      優先採用官方即時值。
    */

    const realtimeRate =
      finiteNumber(
        realtime?.change_rate
      );


    if (
      realtimeRate !== null
    ) {

      changePercent =
        realtimeRate;

    }


    /* =========================
       今日 OHLC
    ========================= */

    const open =
      positiveNumber(
        realtime?.open
      )
      ||
      positiveNumber(
        latest.open
      )
      ||
      price;


    const high =
      positiveNumber(
        realtime?.high
      )
      ||
      positiveNumber(
        latest.high
      )
      ||
      price;


    const low =
      positiveNumber(
        realtime?.low
      )
      ||
      positiveNumber(
        latest.low
      )
      ||
      price;


    /* =========================
       成交量
    ========================= */

    const volume =
      nonNegativeNumber(
        realtime?.total_volume
      )
      ??
      nonNegativeNumber(
        realtime?.volume
      )
      ??
      nonNegativeNumber(
        latest.volume
      )
      ??
      0;


    /* =========================
       把即時今日資料更新進 rows

       這樣技術分析不是只看到昨收，
       而是會納入目前即時價格。
    ========================= */

    const realtimeDate =
      String(
        realtime?.date || ""
      )
      .slice(0, 10);


    if (
      realtime
      &&
      realtimeDate
    ) {

      const last =
        rows[
          rows.length - 1
        ];


      if (
        last &&
        last.date ===
        realtimeDate
      ) {

        last.open =
          open;

        last.high =
          high;

        last.low =
          low;

        last.close =
          price;

        last.volume =
          volume;

      } else {

        rows.push({

          date:
            realtimeDate,

          open,

          high,

          low,

          close:
            price,

          volume

        });

      }

    }


    /*
      最多留 365 根
    */

    const finalRows =
      rows.slice(-365);


    /* =========================
       股票名稱

       FinMind 即時快照未必提供名稱，
       先使用名稱表。
    ========================= */

    const name =
      getStockName(
        symbol
      )
      ||
      symbol;


    /* =========================
       回傳
    ========================= */

    return res
      .status(200)
      .json({

        ok: true,

        source:
          "FinMind",

        realtime:
          !!realtime,

        symbol,

        name,

        price:
          round(price),

        previousClose:
          round(
            previousClose
          ),

        change:
          round(change),

        changePercent:
          round(
            changePercent
          ),

        open:
          round(open),

        high:
          round(high),

        low:
          round(low),

        volume,

        averagePrice:
          round(
            positiveNumber(
              realtime?.average_price
            )
            || 0
          ),

        buyPrice:
          round(
            positiveNumber(
              realtime?.buy_price
            )
            || 0
          ),

        sellPrice:
          round(
            positiveNumber(
              realtime?.sell_price
            )
            || 0
          ),

        buyVolume:
          nonNegativeNumber(
            realtime?.buy_volume
          )
          ?? 0,

        sellVolume:
          nonNegativeNumber(
            realtime?.sell_volume
          )
          ?? 0,

        totalAmount:
          nonNegativeNumber(
            realtime?.total_amount
          )
          ?? 0,

        volumeRatio:
          finiteNumber(
            realtime?.volume_ratio
          )
          ?? null,

        yesterdayVolume:
          nonNegativeNumber(
            realtime?.yesterday_volume
          )
          ?? null,

        quoteDate:
          realtime?.date
          || latest.date,

        updatedAt:
          Date.now(),

        rows:
          finalRows

      });


  } catch (error) {

    console.error(
      "FinMind stock API error:",
      error
    );


    return res
      .status(500)
      .json({

        ok: false,

        source:
          "FinMind",

        error:
          error?.message ||
          "FinMind 股票資料取得失敗"

     
