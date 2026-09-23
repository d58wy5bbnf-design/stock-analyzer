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

    /*
      只向 Yahoo 發送一次請求
      6mo / 1d：
      - rows 給 MA、RSI、MACD、ATR、支撐壓力
      - meta.regularMarketPrice 給最新行情
    */

    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=6mo&interval=1d&includePrePost=false&events=div%2Csplits`;

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8"
      }
    });

    if (!response.ok) {
      console.error(
        "Yahoo HTTP error:",
        response.status,
        response.statusText
      );

      throw new Error(
        `Yahoo 行情暫時無法取得 (${response.status})`
      );
    }

    const data = await response.json();

    const result =
      data?.chart?.result?.[0];

    if (!result) {
      const yahooError =
        data?.chart?.error?.description;

      return res.status(404).json({
        error:
          yahooError ||
          "找不到這個股票代號"
      });
    }

    const meta =
      result.meta || {};

    const quote =
      result.indicators?.quote?.[0] || {};

    const timestamps =
      result.timestamp || [];

    /*
      歷史日 K
    */

    const rows = timestamps
      .map((time, i) => ({
        time: Number(time),

        open:
          Number(quote.open?.[i]),

        high:
          Number(quote.high?.[i]),

        low:
          Number(quote.low?.[i]),

        close:
          Number(quote.close?.[i]),

        volume:
          Number(quote.volume?.[i])
      }))
      .filter(x =>
        Number.isFinite(x.time) &&
        Number.isFinite(x.close) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low)
      );

    if (rows.length < 30) {
      throw new Error(
        "歷史行情資料不足"
      );
    }

    /*
      最新行情

      優先使用 regularMarketPrice。
      如果 Yahoo 沒有提供，
      才退回最新一根日 K close。
    */

    let livePrice =
      Number(meta.regularMarketPrice);

    let liveSource =
      "Yahoo 最新行情";

    if (!Number.isFinite(livePrice)) {
      livePrice =
        rows.at(-1).close;

      liveSource =
        "最新日K收盤價";
    }

    /*
      行情時間
    */

    let liveTime =
      Number(meta.regularMarketTime);

    if (!Number.isFinite(liveTime)) {
      liveTime =
        rows.at(-1).time;
    }

    /*
      昨收
    */

    let previousClose =
      Number(meta.previousClose);

    if (!Number.isFinite(previousClose)) {
      previousClose =
        Number(meta.chartPreviousClose);
    }

    /*
      再沒有昨收時，
      使用倒數第二根日 K
    */

    if (
      !Number.isFinite(previousClose) &&
      rows.length >= 2
    ) {
      previousClose =
        rows.at(-2).close;
    }

    /*
      今日高低

      Yahoo 的 chart meta 不一定都會提供
      regularMarketDayHigh / DayLow，
      所以先嘗試 meta。
    */

    let dayHigh =
      Number(meta.regularMarketDayHigh);

    let dayLow =
      Number(meta.regularMarketDayLow);

    /*
      如果 meta 沒有，
      使用最後一根日 K 高低作備援。
    */

    if (!Number.isFinite(dayHigh)) {
      dayHigh =
        rows.at(-1).high;
    }

    if (!Number.isFinite(dayLow)) {
      dayLow =
        rows.at(-1).low;
    }

    /*
      漲跌
    */

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
        (change / previousClose) * 100;
    }

    /*
      不要讓 Vercel 快取太久
    */

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=5, stale-while-revalidate=10"
    );

    return res.status(200).json({
      symbol:
        meta.symbol || symbol,

      name:
        meta.shortName ||
        meta.longName ||
        meta.symbol ||
        symbol,

      currency:
        meta.currency || "",

      exchange:
        meta.exchangeName || "",

      marketState:
        meta.marketState || "",

      /*
        最新行情
      */

      price:
        livePrice,

      livePrice,

      liveTime,

      liveSource,

      previousClose,

      change,

      changePercent,

      dayHigh,

      dayLow,

      /*
        技術分析歷史資料
      */

      rows
    });

  } catch (error) {
    console.error(
      "stock API error:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "股票資料取得失敗"
    });
  }
}
