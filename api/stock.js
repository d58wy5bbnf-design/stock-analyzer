export default async function handler(req, res) {

  try {

    const raw = String(req.query.symbol || "")
      .trim()
      .toUpperCase();

    if (!raw) {
      return res.status(400).json({
        error: "請輸入股票代號"
      });
    }

    // 台股純數字自動加 .TW
    const symbol = /^\d{4,6}$/.test(raw)
      ? `${raw}.TW`
      : raw;


    const headers = {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      "Accept": "application/json"
    };


    /* =====================================
       1. 六個月日 K
       給 MA / RSI / MACD / ATR / 支撐壓力
    ===================================== */

    const dailyUrl =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d&includePrePost=false`;


    /* =====================================
       2. 今日 1 分鐘資料
       給最新價格
    ===================================== */

    const liveUrl =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=false`;


    const [dailyResponse, liveResponse] =
      await Promise.all([
        fetch(dailyUrl,{headers}),
        fetch(liveUrl,{headers})
      ]);


    if (!dailyResponse.ok) {
      throw new Error("歷史行情資料暫時無法取得");
    }


    const dailyData =
      await dailyResponse.json();


    const dailyResult =
      dailyData?.chart?.result?.[0];


    if (!dailyResult) {

      return res.status(404).json({
        error:"找不到這個股票代號"
      });

    }


    /* =====================================
       日 K
    ===================================== */

    const quote =
      dailyResult.indicators?.quote?.[0] || {};

    const timestamps =
      dailyResult.timestamp || [];


    const rows =
      timestamps.map((time,i)=>({

        time,

        open:Number(quote.open?.[i]),

        high:Number(quote.high?.[i]),

        low:Number(quote.low?.[i]),

        close:Number(quote.close?.[i]),

        volume:Number(quote.volume?.[i])

      }))
      .filter(x=>
        Number.isFinite(x.close) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low)
      );


    if (rows.length < 30) {
      throw new Error("歷史行情資料不足");
    }


    /* =====================================
       最新行情
    ===================================== */

    let livePrice = null;
    let liveTime = null;

    let previousClose = null;

    let dayHigh = null;
    let dayLow = null;

    let liveSource =
      "Yahoo 最新行情";


    if (liveResponse.ok) {

      const liveData =
        await liveResponse.json();

      const liveResult =
        liveData?.chart?.result?.[0];

      const meta =
        liveResult?.meta || {};


      /*
        第一優先：
        Yahoo meta.regularMarketPrice
      */

      if (
        Number.isFinite(
          Number(meta.regularMarketPrice)
        )
      ) {

        livePrice =
          Number(meta.regularMarketPrice);

      }


      if (
        Number.isFinite(
          Number(meta.regularMarketTime)
        )
      ) {

        liveTime =
          Number(meta.regularMarketTime);

      }


      if (
        Number.isFinite(
          Number(meta.previousClose)
        )
      ) {

        previousClose =
          Number(meta.previousClose);

      }

      else if (
        Number.isFinite(
          Number(meta.chartPreviousClose)
        )
      ) {

        previousClose =
          Number(meta.chartPreviousClose);

      }


      if (
        Number.isFinite(
          Number(meta.regularMarketDayHigh)
        )
      ) {

        dayHigh =
          Number(meta.regularMarketDayHigh);

      }


      if (
        Number.isFinite(
          Number(meta.regularMarketDayLow)
        )
      ) {

        dayLow =
          Number(meta.regularMarketDayLow);

      }


      /*
        第二層：
        如果 meta 沒有價格，
        使用最後一根有效 1 分鐘 close
      */

      if (!Number.isFinite(livePrice)) {

        const minuteQuote =
          liveResult?.indicators?.quote?.[0];

        const minuteClose =
          minuteQuote?.close || [];

        const minuteTimes =
          liveResult?.timestamp || [];


        for (
          let i=minuteClose.length-1;
          i>=0;
          i--
        ) {

          if (
            Number.isFinite(
              Number(minuteClose[i])
            )
          ) {

            livePrice =
              Number(minuteClose[i]);

            liveTime =
              Number(minuteTimes[i]) ||
              liveTime;

            liveSource =
              "Yahoo 1分鐘行情";

            break;

          }

        }

      }

    }


    /* =====================================
       如果分鐘行情失敗
       最後才使用日 K meta
    ===================================== */

    const dailyMeta =
      dailyResult.meta || {};


    if (!Number.isFinite(livePrice)) {

      if (
        Number.isFinite(
          Number(dailyMeta.regularMarketPrice)
        )
      ) {

        livePrice =
          Number(
            dailyMeta.regularMarketPrice
          );

        liveTime =
          Number(
            dailyMeta.regularMarketTime
          ) || null;

        liveSource =
          "Yahoo 市場行情";

      }

      else {

        livePrice =
          rows.at(-1).close;

        liveTime =
          rows.at(-1).time;

        liveSource =
          "最新日K收盤價";

      }

    }


    if (!Number.isFinite(previousClose)) {

      previousClose =
        Number(
          dailyMeta.previousClose ??
          dailyMeta.chartPreviousClose
        );

    }


    /* =====================================
       漲跌
    ===================================== */

    let change = null;
    let changePercent = null;


    if (
      Number.isFinite(livePrice) &&
      Number.isFinite(previousClose) &&
      previousClose !== 0
    ) {

      change =
        livePrice - previousClose;

      changePercent =
        change / previousClose * 100;

    }


    /* =====================================
       回傳
    ===================================== */

    res.setHeader(
      "Cache-Control",
      "s-maxage=5, stale-while-revalidate=10"
    );


    return res.status(200).json({

      symbol:
        dailyMeta.symbol || symbol,

      name:
        dailyMeta.shortName ||
        dailyMeta.longName ||
        dailyMeta.symbol ||
        symbol,

      currency:
        dailyMeta.currency || "",


      // 最新行情
      price:livePrice,

      livePrice,

      liveTime,

      liveSource,

      previousClose,

      change,

      changePercent,

      dayHigh,

      dayLow,


      // 技術分析用日 K
      rows

    });


  }

  catch(error) {

    console.error(error);

    return res.status(500).json({

      error:
        error?.message ||
        "股票資料取得失敗"

    });

  }

}
