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

    /*
      妖子平台2.0
      台股資料來源：FinMind
      Yahoo 已完全移除
    */

    if (!/^\d{4,6}$/.test(raw)) {
      return res.status(400).json({
        error: "目前此版本先支援台股，例如 2330、2303"
      });
    }

    const stockId = raw;

    /*
      抓約 10 個月資料
      確保扣掉假日後仍足夠計算 MA60
    */

    const now = new Date();

    const start = new Date();
    start.setMonth(start.getMonth() - 10);

    function formatDate(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");

      return `${y}-${m}-${day}`;
    }

    const startDate = formatDate(start);
    const endDate = formatDate(now);

    const url =
      "https://api.finmindtrade.com/api/v4/data" +
      "?dataset=TaiwanStockPrice" +
      `&data_id=${encodeURIComponent(stockId)}` +
      `&start_date=${encodeURIComponent(startDate)}` +
      `&end_date=${encodeURIComponent(endDate)}`;

    /*
      FinMind API
    */

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "YaoZi-Platform-2.0"
      }
    });

    if (!response.ok) {
      console.error(
        "FinMind HTTP:",
        response.status,
        response.statusText
      );

      throw new Error(
        `台股資料暫時無法取得 (${response.status})`
      );
    }

    const json = await response.json();

    /*
      FinMind 有時 HTTP 200，
      但 API 本身可能回錯誤訊息
    */

    if (
      json?.status &&
      Number(json.status) !== 200
    ) {
      throw new Error(
        json?.msg ||
        "台股資料來源暫時無法取得"
      );
    }

    const data = Array.isArray(json?.data)
      ? json.data
      : [];

    if (!data.length) {
      return res.status(404).json({
        error: `找不到台股 ${stockId} 的行情資料`
      });
    }

    /*
      依日期排序
    */

    data.sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );

    /*
      轉換成 index.html 原本需要的格式

      time
      open
      high
      low
      close
      volume
    */

    const rows = data
      .map(item => {
        const time =
          new Date(
            `${item.date}T13:30:00+08:00`
          ).getTime() / 1000;

        return {
          time,

          open:
            Number(item.open),

          high:
            Number(item.max),

          low:
            Number(item.min),

          close:
            Number(item.close),

          volume:
            Number(item.Trading_Volume)
        };
      })
      .filter(x =>
        Number.isFinite(x.time) &&
        Number.isFinite(x.open) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.close)
      );

    if (rows.length < 60) {
      throw new Error(
        "歷史行情資料不足，暫時無法完成技術分析"
      );
    }

    /*
      最新一筆
    */

    const latest =
      rows.at(-1);

    const previous =
      rows.length >= 2
        ? rows.at(-2)
        : null;

    /*
      最新價格

      注意：
      TaiwanStockPrice 為日行情資料。
      不把它假裝成交易所逐筆 Tick 即時價。
    */

    const livePrice =
      Number(latest.close);

    const previousClose =
      previous
        ? Number(previous.close)
        : null;

    const dayHigh =
      Number(latest.high);

    const dayLow =
      Number(latest.low);

    const liveTime =
      Number(latest.time);

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
      嘗試取得股票名稱

      使用 TaiwanStockInfo
      如果失敗不影響主要分析
    */

    let stockName =
      stockId;

    try {
      const infoUrl =
        "https://api.finmindtrade.com/api/v4/data" +
        "?dataset=TaiwanStockInfo";

      const infoResponse =
        await fetch(infoUrl, {
          headers: {
            "Accept": "application/json",
            "User-Agent": "YaoZi-Platform-2.0"
          }
        });

      if (infoResponse.ok) {
        const infoJson =
          await infoResponse.json();

        const infoData =
          Array.isArray(infoJson?.data)
            ? infoJson.data
            : [];

        const found =
          infoData.find(
            x =>
              String(x.stock_id) ===
              stockId
          );

        if (found?.stock_name) {
          stockName =
            found.stock_name;
        }
      }
    } catch (e) {
      /*
        股票名稱抓不到沒關係
        主行情照常回傳
      */
      console.log(
        "Stock name unavailable"
      );
    }

    /*
      Cache

      日行情不用每秒重新打 API
    */

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=30, stale-while-revalidate=60"
    );

    /*
      回傳格式保持跟目前 index.html 相容
    */

    return res.status(200).json({
      symbol:
        stockId,

      name:
        stockName,

      currency:
        "TWD",

      exchange:
        "TW",

      marketState:
        "",

      /*
        最新行情
      */

      price:
        livePrice,

      livePrice,

      liveTime,

      liveSource:
        "FinMind 台股最新日行情",

      previousClose,

      change,

      changePercent,

      dayHigh,

      dayLow,

      /*
        技術分析資料
      */

      rows
    });

  } catch (error) {
    console.error(
      "妖子平台 stock API:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "台股資料取得失敗"
    });
  }
}
