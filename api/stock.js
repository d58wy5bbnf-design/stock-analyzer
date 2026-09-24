const API_URL = "https://api.finmindtrade.com/api/v4/data";

const SNAPSHOT_URL =
  "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot";

/* =========================
   CACHE
========================= */

let twInfoCache = {
  data: null,
  expiresAt: 0
};

let usInfoCache = {
  data: null,
  expiresAt: 0
};

const INFO_CACHE_MS =
  6 * 60 * 60 * 1000;

/* =========================
   BASIC
========================= */

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
  const query =
    new URLSearchParams(params);

  const response =
    await fetch(
      `${API_URL}?${query.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

  const json =
    await response.json();

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

  if (
    twInfoCache.data &&
    Date.now() < twInfoCache.expiresAt
  ) {
    return twInfoCache.data;
  }

  const result =
    await finmindRequest(
      {
        dataset: "TaiwanStockInfo"
      },
      token
    );

  const list =
    Array.isArray(result.data)
      ? result.data
      : [];

  twInfoCache = {
    data: list,
    expiresAt:
      Date.now() + INFO_CACHE_MS
  };

  return list;
}

/* =========================
   中文名稱 → 股票代號
========================= */

function findTaiwanStock(input, list) {

  const keyword =
    String(input || "").trim();

  if (!keyword) return null;

  /* 代號完全符合 */

  let found =
    list.find(item =>
      String(
        item.stock_id || ""
      ) === keyword
    );

  if (found) return found;

  /* 中文名稱完全符合 */

  found =
    list.find(item =>
      String(
        item.stock_name || ""
      ).trim() === keyword
    );

  if (found) return found;

  /* 中文名稱部分符合 */

  const matches =
    list.filter(item =>
      String(
        item.stock_name || ""
      )
        .trim()
        .includes(keyword)
    );

  if (matches.length === 1) {
    return matches[0];
  }

  /*
    如果有多個部分符合，
    仍取第一個。
    之後可以再做搜尋候選清單。
  */

  return matches[0] || null;
}

/* =========================
   美股清單
========================= */

async function getUSStockList(token) {

  if (
    usInfoCache.data &&
    Date.now() < usInfoCache.expiresAt
  ) {
    return usInfoCache.data;
  }

  const result =
    await finmindRequest(
      {
        dataset: "USStockInfo"
      },
      token
    );

  const list =
    Array.isArray(result.data)
      ? result.data
      : [];

  usInfoCache = {
    data: list,
    expiresAt:
      Date.now() + INFO_CACHE_MS
  };

  return list;
}

async function getUSStockInfo(
  symbol,
  token
) {

  const list =
    await getUSStockList(token);

  return (
    list.find(item =>
      String(
        item.stock_id || ""
      ).toUpperCase() ===
      symbol.toUpperCase()
    ) || null
  );
}

/* =========================
   日期
========================= */

function dateString(date) {
  return date
    .toISOString()
    .slice(0, 10);
}

function getStartDate() {

  const date =
    new Date();

  date.setMonth(
    date.getMonth() - 14
  );

  return dateString(date);
}

/* =========================
   台股日 K
========================= */

async function getTaiwanPrice(
  symbol,
  token
) {

  const result =
    await finmindRequest(
      {
        dataset:
          "TaiwanStockPrice",

        data_id:
          symbol,

        start_date:
          getStartDate()
      },
      token
    );

  const rows =
    Array.isArray(result.data)
      ? result.data
      : [];

  return rows
    .map(item => ({
      date:
        item.date,

      open:
        Number(item.open),

      high:
        Number(item.max),

      low:
        Number(item.min),

      close:
        Number(item.close),

      volume:
        Number(
          item.Trading_Volume
        )
    }))
    .filter(row =>
      Number.isFinite(
        row.close
      )
    );
}

/* =========================
   美股日 K
========================= */

async function getUSPrice(
  symbol,
  token
) {

  const result =
    await finmindRequest(
      {
        dataset:
          "USStockPrice",

        data_id:
          symbol,

        start_date:
          getStartDate()
      },
      token
    );

  const rows =
    Array.isArray(result.data)
      ? result.data
      : [];

  return rows
    .map(item => ({
      date:
        item.date ||
        item.Date,

      open:
        Number(
          item.Open ??
          item.open
        ),

      high:
        Number(
          item.High ??
          item.high
        ),

      low:
        Number(
          item.Low ??
          item.low
        ),

      close:
        Number(
          item.Close ??
          item.close
        ),

      volume:
        Number(
          item.Volume ??
          item.volume
        )
    }))
    .filter(row =>
      Number.isFinite(
        row.close
      )
    );
}

/* =========================
   台股即時 SNAPSHOT
========================= */

async function getTaiwanSnapshot(
  symbol,
  token
) {

  try {

    const response =
      await fetch(
        SNAPSHOT_URL,
        {
          headers: {
            Authorization:
              `Bearer ${token}`,

            Accept:
              "application/json"
          },

          cache:
            "no-store"
        }
      );

    const json =
      await response.json();

    if (!response.ok) {
      return null;
    }

    const list =
      Array.isArray(json.data)
        ? json.data
        : [];

    const item =
      list.find(stock =>
        String(
          stock.stock_id ||
          stock.symbol ||
          stock.code ||
          ""
        ) === String(symbol)
      );

    if (!item) {
      return null;
    }

    const price =
      Number(
        item.price ??
        item.close ??
        item.last_price ??
        item.lastPrice
      );

    if (!Number.isFinite(price)) {
      return null;
    }

    return {
      price,

      open:
        Number(
          item.open ??
          item.open_price
        ),

      high:
        Number(
          item.high ??
          item.high_price
        ),

      low:
        Number(
          item.low ??
          item.low_price
        ),

      volume:
        Number(
          item.total_volume ??
          item.volume ??
          item.Trading_Volume
        ),

      changePercent:
        Number(
          item.change_rate ??
          item.change_percent ??
          item.changePercent
        ),

      time:
        item.time ||
        item.timestamp ||
        item.date ||
        null
    };

  } catch (error) {

    /*
      即時行情失敗時，
      不讓整個分析 API 掛掉。
      會自動退回最新日 K。
    */

    return null;
  }
}

/* =========================
   API
========================= */

export default async function handler(
  req,
  res
) {

  try {

    const token =
      process.env.FINMIND_TOKEN;

    if (!token) {

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "FINMIND_TOKEN 尚未設定"
        });
    }

    const rawInput =
      normalizeInput(
        req.query.symbol ||
        req.query.q
      );

    if (!rawInput) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "請輸入股票代號或名稱"
        });
    }

    let market = "";
    let symbol = "";
    let info = null;

    /* =========================
       台股代號
    ========================= */

    if (
      isTaiwanCode(rawInput)
    ) {

      market = "TW";
      symbol = rawInput;

      const list =
        await getTaiwanStockInfo(
          token
        );

      info =
        findTaiwanStock(
          symbol,
          list
        );

      if (!info) {

        return res
          .status(404)
          .json({
            ok: false,
            error:
              `找不到台股 ${rawInput}`
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
        再嘗試台股名稱
      */

      if (!info) {

        const list =
          await getTaiwanStockInfo(
            token
          );

        const tw =
          findTaiwanStock(
            rawInput,
            list
          );

        if (tw) {

          market = "TW";

          symbol =
            String(
              tw.stock_id
            );

          info = tw;
        }
      }

      if (!info) {

        return res
          .status(404)
          .json({
            ok: false,
            error:
              `找不到 ${rawInput}`
          });
      }
    }

    /* =========================
       中文名稱
    ========================= */

    else {

      const list =
        await getTaiwanStockInfo(
          token
        );

      info =
        findTaiwanStock(
          rawInput,
          list
        );

      if (!info) {

        return res
          .status(404)
          .json({
            ok: false,

            error:
              `找不到「${rawInput}」，請嘗試完整股票名稱或股票代號`
          });
      }

      market = "TW";

      symbol =
        String(
          info.stock_id
        );
    }

    /* =========================
       日 K + 即時行情
    ========================= */

    let rows = [];
    let snapshot = null;

    if (market === "TW") {

      /*
        並行抓：
        1. 日 K
        2. 即時 snapshot

        可以減少等待時間。
      */

      const results =
        await Promise.all([
          getTaiwanPrice(
            symbol,
            token
          ),

          getTaiwanSnapshot(
            symbol,
            token
          )
        ]);

      rows =
        results[0];

      snapshot =
        results[1];

    } else {

      rows =
        await getUSPrice(
          symbol,
          token
        );
    }

    if (!rows.length) {

      return res
        .status(404)
        .json({
          ok: false,
          error:
            "找不到歷史行情"
        });
    }

    /* =========================
       最新日 K
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
        : null;

    const dailyClose =
      Number(
        latest.close
      );

    const previousClose =
      previous
        ? Number(
            previous.close
          )
        : dailyClose;

    /* =========================
       現價
    ========================= */

    let livePrice =
      dailyClose;

    let isRealtime =
      false;

    let liveSource =
      market === "TW"
        ? "FinMind 台股最新日行情"
        : "FinMind 美股最新日行情";

    let liveTime =
      null;

    if (
      market === "TW" &&
      snapshot &&
      Number.isFinite(
        Number(
          snapshot.price
        )
      )
    ) {

      livePrice =
        Number(
          snapshot.price
        );

      isRealtime =
        true;

      liveSource =
        "FinMind 台股即時 Snapshot";

      liveTime =
        snapshot.time ||
        new Date()
          .toISOString();
    }

    /* =========================
       漲跌
    ========================= */

    const change =
      livePrice -
      previousClose;

    const changePercent =
      previousClose
        ? (
            change /
            previousClose *
            100
          )
        : 0;

    /* =========================
       名稱
    ========================= */

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

    /* =========================
       盤中 OHLC
    ========================= */

    const dayOpen =
      snapshot &&
      Number.isFinite(
        snapshot.open
      )
        ? snapshot.open
        : Number(
            latest.open
          );

    const dayHigh =
      snapshot &&
      Number.isFinite(
        snapshot.high
      )
        ? snapshot.high
        : Number(
            latest.high
          );

    const dayLow =
      snapshot &&
      Number.isFinite(
        snapshot.low
      )
        ? snapshot.low
        : Number(
            latest.low
          );

    const volume =
      snapshot &&
      Number.isFinite(
        snapshot.volume
      )
        ? snapshot.volume
        : Number(
            latest.volume
          );

    /*
      個股分析需要盤中更新，
      所以這個 API 不使用 CDN 長快取。
    */

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    return res
      .status(200)
      .json({

        ok: true,

        platform:
          "妖子平台 3.0",

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

        /*
          price 保留最新日 K，
          livePrice 才是盤中價格。
        */

        price:
          dailyClose,

        livePrice,

        previousClose,

        change,

        changePercent,

        dayOpen,

        dayHigh,

        dayLow,

        volume,

        latestDate:
          latest.date,

        liveTime,

        liveSource,

        isRealtime,

        rows,

        notice:
          isRealtime
            ? "目前使用 FinMind 台股即時行情進行盤中技術分析"
            : "目前使用最新可取得行情進行技術分析"
      });

  } catch (error) {

    return res
      .status(500)
      .json({
        ok: false,

        error:
          error?.message ||
          "伺服器錯誤"
      });
  }
}
