const API_URL = "https://api.finmindtrade.com/api/v4/data";

function normalizeInput(value) {
  return String(value || "").trim();
}

function isTaiwanCode(value) {
  return /^\d{4,6}$/.test(value);
}

function isUSSymbol(value) {
  return /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(value);
}

async function finmindRequest(params, token) {
  const query = new URLSearchParams(params);

  const response = await fetch(
    `${API_URL}?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    }
  );

  const json = await response.json();

  if (!response.ok) {
    throw new Error(
      json?.msg ||
      json?.message ||
      "FinMind API request failed"
    );
  }

  return json;
}

/* =========================
   台股清單
========================= */

async function getTaiwanStockInfo(token) {
  const result = await finmindRequest(
    {
      dataset: "TaiwanStockInfo"
    },
    token
  );

  return Array.isArray(result.data)
    ? result.data
    : [];
}

/* =========================
   中文名稱 → 股票代號
========================= */

function findTaiwanStock(input, list) {
  const keyword = String(input || "").trim();

  if (!keyword) return null;

  /* 先找完全相同代號 */
  let found = list.find(item =>
    String(item.stock_id || "") === keyword
  );

  if (found) return found;

  /* 再找完全相同中文名稱 */
  found = list.find(item =>
    String(item.stock_name || "").trim() === keyword
  );

  if (found) return found;

  /* 最後允許部分名稱 */
  found = list.find(item =>
    String(item.stock_name || "")
      .trim()
      .includes(keyword)
  );

  return found || null;
}

/* =========================
   美股資訊
========================= */

async function getUSStockInfo(symbol, token) {
  const result = await finmindRequest(
    {
      dataset: "USStockInfo"
    },
    token
  );

  const list = Array.isArray(result.data)
    ? result.data
    : [];

  return list.find(item =>
    String(item.stock_id || "")
      .toUpperCase() === symbol.toUpperCase()
  ) || null;
}

/* =========================
   日期
========================= */

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function getStartDate() {
  const d = new Date();

  d.setMonth(
    d.getMonth() - 14
  );

  return dateString(d);
}

/* =========================
   台股行情
========================= */

async function getTaiwanPrice(symbol, token) {
  const result = await finmindRequest(
    {
      dataset: "TaiwanStockPrice",
      data_id: symbol,
      start_date: getStartDate()
    },
    token
  );

  const rows = Array.isArray(result.data)
    ? result.data
    : [];

  return rows
    .map(item => ({
      date: item.date,
      open: Number(item.open),
      high: Number(item.max),
      low: Number(item.min),
      close: Number(item.close),
      volume: Number(item.Trading_Volume)
    }))
    .filter(row =>
      Number.isFinite(row.close)
    );
}

/* =========================
   美股行情
========================= */

async function getUSPrice(symbol, token) {
  const result = await finmindRequest(
    {
      dataset: "USStockPrice",
      data_id: symbol,
      start_date: getStartDate()
    },
    token
  );

  const rows = Array.isArray(result.data)
    ? result.data
    : [];

  return rows
    .map(item => ({
      date:
        item.date ||
        item.Date,

      open: Number(
        item.Open ??
        item.open
      ),

      high: Number(
        item.High ??
        item.high
      ),

      low: Number(
        item.Low ??
        item.low
      ),

      close: Number(
        item.Close ??
        item.close
      ),

      volume: Number(
        item.Volume ??
        item.volume
      )
    }))
    .filter(row =>
      Number.isFinite(row.close)
    );
}

/* =========================
   API
========================= */

export default async function handler(req, res) {
  try {
    const token =
      process.env.FINMIND_TOKEN;

    if (!token) {
      return res.status(500).json({
        ok: false,
        error: "FINMIND_TOKEN 尚未設定"
      });
    }

    const rawInput =
      normalizeInput(
        req.query.symbol ||
        req.query.q
      );

    if (!rawInput) {
      return res.status(400).json({
        ok: false,
        error: "請輸入股票代號或名稱"
      });
    }

    let market = "";
    let symbol = "";
    let info = null;

    /* =========================
       台股代號
    ========================= */

    if (isTaiwanCode(rawInput)) {
      market = "TW";
      symbol = rawInput;

      const list =
        await getTaiwanStockInfo(token);

      info =
        findTaiwanStock(
          symbol,
          list
        );

      if (!info) {
        return res.status(404).json({
          ok: false,
          error: `找不到台股 ${rawInput}`
        });
      }
    }

    /* =========================
       美股代號
    ========================= */

    else if (
      isUSSymbol(rawInput) &&
      /^[A-Za-z]/.test(rawInput)
    ) {
      market = "US";
      symbol =
        rawInput.toUpperCase();

      info =
        await getUSStockInfo(
          symbol,
          token
        );

      /*
        如果不是美股，
        再嘗試當作台股名稱搜尋
      */

      if (!info) {
        const list =
          await getTaiwanStockInfo(token);

        const tw =
          findTaiwanStock(
            rawInput,
            list
          );

        if (tw) {
          market = "TW";
          symbol =
            String(tw.stock_id);

          info = tw;
        }
      }

      if (!info) {
        return res.status(404).json({
          ok: false,
          error: `找不到 ${rawInput}`
        });
      }
    }

    /* =========================
       中文名稱搜尋
    ========================= */

    else {
      const list =
        await getTaiwanStockInfo(token);

      info =
        findTaiwanStock(
          rawInput,
          list
        );

      if (!info) {
        return res.status(404).json({
          ok: false,
          error:
            `找不到「${rawInput}」，請嘗試完整股票名稱或股票代號`
        });
      }

      market = "TW";
      symbol =
        String(info.stock_id);
    }

    /* =========================
       抓價格
    ========================= */

    let rows = [];

    if (market === "TW") {
      rows =
        await getTaiwanPrice(
          symbol,
          token
        );
    } else {
      rows =
        await getUSPrice(
          symbol,
          token
        );
    }

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        error: "找不到歷史行情"
      });
    }

    const latest =
      rows[rows.length - 1];

    const previous =
      rows.length >= 2
        ? rows[rows.length - 2]
        : null;

    const price =
      Number(latest.close);

    const previousClose =
      previous
        ? Number(previous.close)
        : price;

    const change =
      price - previousClose;

    const changePercent =
      previousClose
        ? change /
          previousClose *
          100
        : 0;

    const name =
      market === "TW"
        ? (
            info.stock_name ||
            symbol
          )
        : (
            info.stock_name ||
            info.name ||
            symbol
          );

    const industry =
      info.industry_category ||
      info.industry ||
      "";

    const exchange =
      info.exchange ||
      info.type ||
      "";

    res.setHeader(
      "Cache-Control",
      "s-maxage=60, stale-while-revalidate=120"
    );

    return res.status(200).json({
      ok: true,

      platform:
        "妖子平台 2.7",

      query:
        rawInput,

      market,

      marketName:
        market === "TW"
          ? "台股"
          : "美股",

      marketEmoji:
        market === "TW"
          ? "🇹🇼"
          : "🇺🇸",

      symbol,

      name,

      industry,

      exchange,

      currency:
        market === "TW"
          ? "TWD"
          : "USD",

      price,

      livePrice:
        price,

      previousClose,

      change,

      changePercent,

      dayOpen:
        Number(latest.open),

      dayHigh:
        Number(latest.high),

      dayLow:
        Number(latest.low),

      volume:
        Number(latest.volume),

      latestDate:
        latest.date,

      liveTime: null,

      liveSource:
        market === "TW"
          ? "FinMind 台股最新日行情"
          : "FinMind 美股最新日行情",

      isRealtime: false,

      rows,

      notice:
        "技術分析資料僅供市場觀察使用"
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "伺服器錯誤"
    });
  }
}
