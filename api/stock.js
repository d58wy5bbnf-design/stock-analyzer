const https = require("https");

/*
  api/stock.js
  Stock Analysis API 6.1 - FinMind Save Mode

  目的：
  1. 大幅降低 FinMind API 使用量
  2. 避免重複查詢同一資料
  3. 非必要資料 402 不讓整頁死亡
  4. 保留原本前端需要的欄位
  5. 保留五大分析需要的法人 / 基本面

  Cache：
  歷史 K       10 分鐘
  即時報價      30 秒
  法人          30 分鐘
  股票名稱      24 小時
  月營收         6 小時
  財報           6 小時
*/


/* =========================================================
   MEMORY CACHE
========================================================= */

const CACHE =
  global.__STOCK_API_CACHE__ ||
  new Map();

global.__STOCK_API_CACHE__ =
  CACHE;


function cacheGet(key) {

  const item =
    CACHE.get(key);

  if (!item) {
    return null;
  }

  if (
    Date.now() >
    item.expire
  ) {

    CACHE.delete(key);

    return null;
  }

  return item.value;
}


function cacheSet(
  key,
  value,
  ttl
) {

  CACHE.set(
    key,
    {
      value,
      expire:
        Date.now() + ttl
    }
  );

  return value;
}


async function cached(
  key,
  ttl,
  loader
) {

  const old =
    cacheGet(key);

  if (old !== null) {
    return old;
  }

  const value =
    await loader();

  cacheSet(
    key,
    value,
    ttl
  );

  return value;
}


/* =========================================================
   CACHE TIME
========================================================= */

const CACHE_TIME = {

  historical:
    10 * 60 * 1000,

  realtime:
    30 * 1000,

  institutional:
    30 * 60 * 1000,

  info:
    24 * 60 * 60 * 1000,

  revenue:
    6 * 60 * 60 * 1000,

  financial:
    6 * 60 * 60 * 1000

};


/* =========================================================
   MAIN
========================================================= */

module.exports =
async function handler(
  req,
  res
) {

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

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );


  if (
    req.method ===
    "OPTIONS"
  ) {

    return res
      .status(200)
      .end();

  }


  try {

    const token =
      process.env.FINMIND_TOKEN;


    if (!token) {

      throw new Error(
        "Vercel 尚未設定 FINMIND_TOKEN"
      );

    }


    const symbol =
      String(
        req.query.symbol ||
        ""
      )
      .trim()
      .toUpperCase();


    if (
      !/^[0-9A-Z]{4,10}$/
        .test(symbol)
    ) {

      throw new Error(
        "股票代號格式錯誤"
      );

    }


    const end =
      new Date();


    const priceStart =
      new Date();

    priceStart.setDate(
      priceStart.getDate() -
      500
    );


    const revenueStart =
      new Date();

    revenueStart.setMonth(
      revenueStart.getMonth() -
      18
    );


    const financialStart =
      new Date();

    financialStart.setFullYear(
      financialStart.getFullYear() -
      2
    );


    const startDate =
      formatDate(
        priceStart
      );


    const endDate =
      formatDate(
        end
      );


    const revenueStartDate =
      formatDate(
        revenueStart
      );


    const financialStartDate =
      formatDate(
        financialStart
      );


    /*
      六種資料仍然並行取得，
      但每一種都有自己的 Cache。

      同一個 Vercel instance 裡，
      重複搜尋不會一直打 FinMind。
    */

    const [
      priceResult,
      realtimeResult,
      institutionalResult,
      infoResult,
      revenueResult,
      financialResult
    ] =
      await Promise.allSettled([


        cached(

          `historical:${symbol}:${startDate}:${endDate}`,

          CACHE_TIME.historical,

          () =>
            getHistorical(
              symbol,
              startDate,
              endDate,
              token
            )

        ),


        cached(

          `realtime:${symbol}`,

          CACHE_TIME.realtime,

          () =>
            getRealtime(
              symbol,
              token
            )

        ),


        cached(

          `institutional:${symbol}:${endDate}`,

          CACHE_TIME.institutional,

          () =>
            getInstitutional(
              symbol,
              startDate,
              endDate,
              token
            )

        ),


        cached(

          "stock-info",

          CACHE_TIME.info,

          () =>
            getStockInfo(
              token
            )

        ),


        cached(

          `revenue:${symbol}`,

          CACHE_TIME.revenue,

          () =>
            getMonthRevenue(
              symbol,
              revenueStartDate,
              endDate,
              token
            )

        ),


        cached(

          `financial:${symbol}`,

          CACHE_TIME.financial,

          () =>
            getFinancialStatements(
              symbol,
              financialStartDate,
              endDate,
              token
            )

        )

      ]);


    /*
      歷史 K 是唯一真正必要的資料。

      沒有 K 線無法做技術分析。

      其他資料失敗：
      降級處理，不讓整頁掛掉。
    */

    if (
      priceResult.status !==
      "fulfilled"
    ) {

      throw (
        priceResult.reason ||
        new Error(
          "歷史股價取得失敗"
        )
      );

    }


    const rows =
      priceResult.value;


    if (
      !Array.isArray(rows)
      ||
      rows.length < 60
    ) {

      throw new Error(
        "歷史 K 線不足 60 根"
      );

    }


    /* =====================================================
       STOCK INFO
    ===================================================== */

    let name =
      "";

    let market =
      "";


    let infoError =
      "";


    if (
      infoResult.status ===
      "fulfilled"
    ) {

      const info =
        infoResult.value.find(
          x =>
            String(
              x.stock_id ||
              ""
            ) ===
            symbol
        );


      if (info) {

        name =
          String(
            info.stock_name ||
            ""
          );


        market =
          normalizeMarket(
            info.type ||
            info.industry_category ||
            ""
          );

      }

    }
    else {

      infoError =
        safeError(
          infoResult.reason,
          "股票名稱暫時無法取得"
        );

    }


    /* =====================================================
       REALTIME
    ===================================================== */

    let realtime =
      null;


    let realtimeError =
      "";


    if (
      realtimeResult.status ===
      "fulfilled"
    ) {

      realtime =
        realtimeResult.value;

    }
    else {

      realtimeError =
        safeError(
          realtimeResult.reason,
          "即時報價暫時無法取得"
        );

    }


    /* =====================================================
       INSTITUTIONAL
    ===================================================== */

    let institutional =
      emptyInstitutional();


    let institutionalError =
      "";


    if (
      institutionalResult.status ===
      "fulfilled"
    ) {

      institutional =
        institutionalResult.value;

    }
    else {

      institutionalError =
        safeError(
          institutionalResult.reason,
          "法人籌碼暫時無法取得"
        );

    }


    /* =====================================================
       REVENUE
    ===================================================== */

    let revenue =
      emptyRevenue();


    let revenueError =
      "";


    if (
      revenueResult.status ===
      "fulfilled"
    ) {

      revenue =
        revenueResult.value;

    }
    else {

      revenueError =
        safeError(
          revenueResult.reason,
          "月營收暫時無法取得"
        );

    }


    /* =====================================================
       FINANCIAL
    ===================================================== */

    let financial =
      emptyFinancial();


    let financialError =
      "";


    if (
      financialResult.status ===
      "fulfilled"
    ) {

      financial =
        financialResult.value;

    }
    else {

      financialError =
        safeError(
          financialResult.reason,
          "財報暫時無法取得"
        );

    }


    /* =====================================================
       PRICE
    ===================================================== */

    const latest =
      rows[
        rows.length - 1
      ];


    const previous =
      rows.length >= 2
        ?
        rows[
          rows.length - 2
        ]
        :
        latest;


    /*
      即時資料失敗時，
      自動退回最後一根 K。
    */

    const currentPrice =
      positive(

        realtime?.price,

        realtime?.close,

        realtime?.last_price,

        realtime?.lastPrice,

        latest.close

      );


    const previousClose =
      positive(

        realtime?.previous_close,

        realtime?.previousClose,

        realtime?.reference_price,

        realtime?.referencePrice,

        previous.close

      );


    const currentOpen =
      positive(

        realtime?.open,

        realtime?.open_price,

        realtime?.openPrice,

        latest.open

      );


    const currentHigh =
      positive(

        realtime?.high,

        realtime?.max,

        realtime?.high_price,

        realtime?.highPrice,

        latest.high,

        currentPrice

      );


    const currentLow =
      positive(

        realtime?.low,

        realtime?.min,

        realtime?.low_price,

        realtime?.lowPrice,

        latest.low,

        currentPrice

      );


    const currentVolume =
      nonNegative(

        realtime?.volume,

        realtime?.total_volume,

        realtime?.totalVolume,

        realtime?.Trading_Volume,

        latest.volume

      );


    /* =====================================================
       MERGE TODAY K
    ===================================================== */

    const today =
      formatDate(
        new Date()
      );


    let mergedRows =
      rows.map(
        x => ({
          ...x
        })
      );


    const last =
      mergedRows[
        mergedRows.length - 1
      ];


    if (
      realtime
      &&
      currentPrice > 0
    ) {

      if (
        last
        &&
        normalizeDate(
          last.date
        ) ===
        today
      ) {

        last.open =
          currentOpen ||
          last.open;


        last.high =
          Math.max(

            last.high || 0,

            currentHigh || 0,

            currentPrice

          );


        const lows =
          [

            last.low,

            currentLow,

            currentPrice

          ]
          .filter(
            x =>
              Number.isFinite(
                Number(x)
              )
              &&
              Number(x) > 0
          );


        if (
          lows.length
        ) {

          last.low =
            Math.min(
              ...lows
            );

        }


        last.close =
          currentPrice;


        if (
          currentVolume > 0
        ) {

          last.volume =
            currentVolume;

        }

      }
      else {

        const lows =
          [

            currentLow,

            currentPrice

          ]
          .filter(
            x =>
              Number.isFinite(
                Number(x)
              )
              &&
              Number(x) > 0
          );


        mergedRows.push({

          date:
            today,

          open:
            currentOpen ||
            currentPrice,

          high:
            Math.max(
              currentHigh ||
              currentPrice,
              currentPrice
            ),

          low:
            lows.length
              ?
              Math.min(
                ...lows
              )
              :
              currentPrice,

          close:
            currentPrice,

          volume:
            currentVolume ||
            0

        });

      }

    }


    mergedRows =
      mergedRows.slice(-300);


    /* =====================================================
       CHANGE
    ===================================================== */

    const change =
      currentPrice -
      previousClose;


    const changePercent =
      previousClose > 0
        ?
        change /
        previousClose *
        100
        :
        0;


    /* =====================================================
       FUNDAMENTAL
    ===================================================== */

    const fundamental = {

      available:
        Boolean(
          revenue.available ||
          financial.available
        ),


      revenue: {

        available:
          revenue.available,

        latestDate:
          revenue.latestDate,

        year:
          revenue.year,

        month:
          revenue.month,

        latest:
          revenue.latest,

        previousMonth:
          revenue.previousMonth,

        lastYearSameMonth:
          revenue.lastYearSameMonth,

        mom:
          revenue.mom,

        yoy:
          revenue.yoy,

        recent:
          revenue.recent

      },


      financial: {

        available:
          financial.available,

        latestDate:
          financial.latestDate,

        eps:
          financial.eps,

        previousEPS:
          financial.previousEPS,

        epsGrowth:
          financial.epsGrowth,

        incomeAfterTaxes:
          financial.incomeAfterTaxes,

        previousIncomeAfterTaxes:
          financial.previousIncomeAfterTaxes,

        netIncomeGrowth:
          financial.netIncomeGrowth,

        grossProfit:
          financial.grossProfit,

        operatingIncome:
          financial.operatingIncome,

        profitable:
          financial.profitable,

        recent:
          financial.recent

      }

    };


    /* =====================================================
       DEGRADED
    ===================================================== */

    const degraded =
      Boolean(

        realtimeError ||

        institutionalError ||

        infoError ||

        revenueError ||

        financialError

      );


    /* =====================================================
       RESPONSE
    ===================================================== */

    return res
      .status(200)
      .json({

        ok:
          true,

        source:
          "FinMind",

        engine:
          "Stock Analysis 6.1 Save Mode",

        symbol,

        name:
          name ||
          symbol,

        market,

        realtime:
          Boolean(
            realtime
          ),

        degraded,

        price:
          round(
            currentPrice
          ),

        previousClose:
          round(
            previousClose
          ),

        change:
          round(
            change
          ),

        changePercent:
          round(
            changePercent
          ),

        open:
          round(
            currentOpen
          ),

        high:
          round(
            currentHigh
          ),

        low:
          round(
            currentLow
          ),

        volume:
          currentVolume,

        quoteDate:
          today,

        updatedAt:
          new Date()
            .toLocaleString(
              "zh-TW",
              {

                timeZone:
                  "Asia/Taipei",

                hour12:
                  false

              }
            ),


        errors: {

          realtime:
            realtimeError,

          institutional:
            institutionalError,

          info:
            infoError,

          revenue:
            revenueError,

          financial:
            financialError

        },


        /*
          保留舊欄位，
          避免舊前端讀不到。
        */

        realtimeError,

        institutionalError,

        revenueError,

        financialError,


        institutional,

        fundamental,

        revenue,

        financial,

        rows:
          mergedRows

      });


  }
  catch (error) {

    console.error(
      "stock api error:",
      error
    );


    return res
      .status(500)
      .json({

        ok:
          false,

        source:
          "FinMind",

        engine:
          "Stock Analysis 6.1 Save Mode",

        error:
          safeError(
            error,
            "股票資料取得失敗"
          )

      });

  }

};


/* =========================================================
   HISTORICAL
========================================================= */

async function getHistorical(
  symbol,
  startDate,
  endDate,
  token
) {

  const url =
