// api/stock.js
// 妖子平台 2.3
// 🇹🇼 台股 + 🇺🇸 美股個股分析資料 API

const API_URL =
  "https://api.finmindtrade.com/api/v4/data";

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  const p = 10 ** digits;

  return (
    Math.round(
      (n + Number.EPSILON) * p
    ) / p
  );
}

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function detectMarket(symbol) {
  // 純數字 → 台股
  if (/^\d{4,6}$/.test(symbol)) {
    return "TW";
  }

  // 英文股票代號 → 美股
  if (
    /^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)
  ) {
    return "US";
  }

  return null;
}

async function finmindRequest(
  params,
  token
) {
  const url =
    new URL(API_URL);

  Object.entries(params)
    .forEach(([key, value]) => {
      if (
        value !== undefined &&
        value !== null &&
        value !== ""
      ) {
        url.searchParams.set(
          key,
          value
        );
      }
    });

  const response =
    await fetch(
      url.toString(),
      {
        headers: {
          Authorization:
            `Bearer ${token}`,
          Accept:
            "application/json"
        }
      }
    );

  let body;

  try {
    body =
      await response.json();
  } catch {
    throw new Error(
      "FinMind 回傳格式異常"
    );
  }

  if (
    !response.ok ||
    (
      body?.status !== undefined &&
      Number(body.status) !== 200
    )
  ) {
    throw new Error(
      body?.msg ||
      body?.message ||
      `FinMind API 錯誤 (${response.status})`
    );
  }

  return Array.isArray(body?.data)
    ? body.data
    : [];
}


// ===============================
// 台股名稱
// ===============================

async function getTaiwanStockName(
  symbol,
  token
) {
  try {
    const list =
      await finmindRequest(
        {
          dataset:
            "TaiwanStockInfo"
        },
        token
      );

    const found =
      list.find(
        item =>
          String(item.stock_id) ===
          symbol
      );

    return {
      name:
        found?.stock_name || "",
      industry:
        found?.industry_category || "",
      exchange:
        found?.type || "TW"
    };

  } catch {
    return {
      name: "",
      industry: "",
      exchange: "TW"
    };
  }
}


// ===============================
// 美股名稱
// ===============================

async function getUSStockName(
  symbol,
  token
) {
  try {
    const list =
      await finmindRequest(
        {
          dataset:
            "USStockInfo"
        },
        token
      );

    const found =
      list.find(
        item =>
          String(
            item.stock_id || ""
          ).toUpperCase() === symbol
      );

    return {
      name:
        found?.stock_name ||
        found?.name ||
        "",
      industry:
        found?.industry_category ||
        found?.industry ||
        "",
      exchange:
        found?.type ||
        found?.exchange ||
        "US"
    };

  } catch {
    return {
      name: "",
      industry: "",
      exchange: "US"
    };
  }
}


// ===============================
// 台股歷史資料
// ===============================

async function getTaiwanPrice(
  symbol,
  startDate,
  endDate,
  token
) {
  const data =
    await finmindRequest(
      {
        dataset:
          "TaiwanStockPrice",
        data_id:
          symbol,
        start_date:
          startDate,
        end_date:
          endDate
      },
      token
    );

  return data.map(item => ({
    time:
      `${item.date}T13:30:00+08:00`,

    date:
      item.date,

    open:
      num(item.open),

    high:
      num(item.max),

    low:
      num(item.min),

    close:
      num(item.close),

    volume:
      num(
        item.Trading_Volume
      )
  }))
  .filter(
    row =>
      Number.isFinite(row.close)
  );
}


// ===============================
// 美股歷史資料
// ===============================

async function getUSPrice(
  symbol,
  startDate,
  endDate,
  token
) {
  const data =
    await finmindRequest(
      {
        dataset:
          "USStockPrice",
        data_id:
          symbol,
        start_date:
          startDate,
        end_date:
          endDate
      },
      token
    );

  return data.map(item => {

    const open =
      num(
        item.Open ??
        item.open
      );

    const high =
      num(
        item.High ??
        item.high
      );

    const low =
      num(
        item.Low ??
        item.low
      );

    const close =
      num(
        item.Close ??
        item.close
      );

    const volume =
      num(
        item.Volume ??
        item.volume
      );

    return {
      time:
        `${item.date}T16:00:00-04:00`,

      date:
        item.date,

      open,
      high,
      low,
      close,
      volume
    };
  })
  .filter(
    row =>
      Number.isFinite(row.close)
  );
}


// ===============================
// 計算最新價格資訊
// ===============================

function buildMarketData(rows) {
  if (!rows.length) {
    return null;
  }

  const latest =
    rows.at(-1);

  const previous =
    rows.length >= 2
      ? rows.at(-2)
      : null;

  const price =
    num(latest.close);

  const previousClose =
    previous
      ? num(previous.close)
      : price;

  const change =
    price !== null &&
    previousClose !== null
      ? price - previousClose
      : 0;

  const changePercent =
    previousClose
      ? (
          change /
          previousClose
        ) * 100
      : 0;

  return {
    price:
      round(price),

    previousClose:
      round(previousClose),

    change:
      round(change),

    changePercent:
      round(changePercent),

    dayHigh:
      round(latest.high),

    dayLow:
      round(latest.low),

    dayOpen:
      round(latest.open),

    volume:
      num(latest.volume),

    latestDate:
      latest.date
  };
}


// ===============================
// API
// ===============================

export default async function handler(
  req,
  res
) {
  try {

    if (req.method !== "GET") {
      return res
        .status(405)
        .json({
          ok: false,
          error:
            "Method Not Allowed"
        });
    }

    const token =
      process.env.FINMIND_TOKEN;

    if (!token) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Vercel 尚未設定 FINMIND_TOKEN"
        });
    }

    const symbol =
      normalizeSymbol(
        req.query.symbol
      );

    if (!symbol) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "請輸入股票代號，例如 2330 或 NVDA"
        });
    }

    const market =
      detectMarket(symbol);

    if (!market) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "股票代號格式不正確"
        });
    }


    // 約抓 14 個月
    // 確保 MA60 / RSI / ATR 有足夠資料

    const end =
      new Date();

    const start =
      new Date();

    start.setMonth(
      start.getMonth() - 14
    );

    const startDate =
      dateString(start);

    const endDate =
      dateString(end);


    let rows = [];
    let info = null;


    // ===============================
    // 🇹🇼 台股
    // ===============================

    if (market === "TW") {

      [
        rows,
        info
      ] =
        await Promise.all([
          getTaiwanPrice(
            symbol,
            startDate,
            endDate,
            token
          ),

          getTaiwanStockName(
            symbol,
            token
          )
        ]);
    }


    // ===============================
    // 🇺🇸 美股
    // ===============================

    if (market === "US") {

      [
        rows,
        info
      ] =
        await Promise.all([
          getUSPrice(
            symbol,
            startDate,
            endDate,
            token
          ),

          getUSStockName(
            symbol,
            token
          )
        ]);
    }


    if (!rows.length) {
      return res
        .status(404)
        .json({
          ok: false,

          market,

          symbol,

          error:
            market === "TW"
              ? `找不到台股 ${symbol} 的價格資料`
              : `找不到美股 ${symbol} 的價格資料`
        });
    }


    rows.sort(
      (a, b) =>
        String(a.date)
          .localeCompare(
            String(b.date)
          )
    );


    const marketData =
      buildMarketData(rows);


    if (!marketData) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "沒有足夠價格資料"
        });
    }


    // ===============================
    // 回傳
    // ===============================

    const isTaiwan =
      market === "TW";


    res.setHeader(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=120"
    );


    return res
      .status(200)
      .json({

        ok: true,

        platform:
          "妖子平台2.3",

        market,

        marketName:
          isTaiwan
            ? "台股"
            : "美股",

        marketEmoji:
          isTaiwan
            ? "🇹🇼"
            : "🇺🇸",

        symbol,

        name:
          info?.name || "",

        industry:
          info?.industry || "",

        exchange:
          info?.exchange ||
          market,

        currency:
          isTaiwan
            ? "TWD"
            : "USD",

        price:
          marketData.price,

        livePrice:
          marketData.price,

        previousClose:
          marketData.previousClose,

        change:
          marketData.change,

        changePercent:
          marketData.changePercent,

        dayOpen:
          marketData.dayOpen,

        dayHigh:
          marketData.dayHigh,

        dayLow:
          marketData.dayLow,

        volume:
          marketData.volume,

        latestDate:
          marketData.latestDate,

        liveTime:
          rows.at(-1)?.time ||
          null,

        liveSource:
          isTaiwan
            ? "FinMind 台股最新日行情"
            : "FinMind 美股最新日行情",

        isRealtime:
          false,

        rows,

        notice:
          isTaiwan
            ? "個股技術分析使用 FinMind 台股日行情；盤中即時異動請以首頁台股即時雷達為準。"
            : "美股個股分析目前使用 FinMind USStockPrice 日行情，並非盤中即時報價。"
      });


  } catch (error) {

    console.error(
      "Stock API error:",
      error
    );

    return res
      .status(500)
      .json({

        ok: false,

        error:
          error?.message ||
          "Stock API server error"
      });
  }
}
