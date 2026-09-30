const https = require("https");

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

    const token = String(
      process.env.FINMIND_TOKEN || ""
    ).trim();

    if (!token) {
      return res.status(500).json({
        ok: false,
        error: "Vercel 尚未設定 FINMIND_TOKEN"
      });
    }

    const symbol = String(
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

    const now = new Date();

    const historyStart = new Date(now);
    historyStart.setDate(
      historyStart.getDate() - 550
    );

    const chipStart = new Date(now);
    chipStart.setDate(
      chipStart.getDate() - 45
    );

    const endDate = formatDate(now);

    const results = await Promise.allSettled([

      getData(
        "TaiwanStockPrice",
        symbol,
        formatDate(historyStart),
        endDate,
        token
      ),

      getRealtime(
        symbol,
        token
      ),

      getData(
        "TaiwanStockInstitutionalInvestorsBuySell",
        symbol,
        formatDate(chipStart),
        endDate,
        token
      )

    ]);

    /* =========================
       歷史 K
    ========================= */

    if (results[0].status !== "fulfilled") {
      throw new Error(
        "歷史股價取得失敗：" +
        (
          results[0].reason?.message ||
          "未知錯誤"
        )
      );
    }

    const history = results[0].value;

    let rows = history
      .map(x => {

        const open = num(x.open);
        const high = num(x.max);
        const low = num(x.min);
        const close = num(x.close);
        const volume = num(x.Trading_Volume);

        if (
          open === null ||
          high === null ||
          low === null ||
          close === null ||
          close <= 0
        ) {
          return null;
        }

        return {
          date: String(x.date || ""),
          open: round(open),
          high: round(high),
          low: round(low),
          close: round(close),
          volume:
            volume !== null && volume >= 0
              ? volume
              : 0
        };

      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date)
      )
      .slice(-365);

    if (rows.length < 60) {
      throw new Error(
        "歷史 K 線不足 60 筆"
      );
    }

    const latest =
      rows[rows.length - 1];

    const previous =
      rows.length >= 2
        ? rows[rows.length - 2]
        : latest;

    /* =========================
       即時
    ========================= */

    let realtime = null;
    let realtimeError = null;

    if (results[1].status === "fulfilled") {
      realtime = results[1].value;
    } else {
      realtimeError =
        results[1].reason?.message ||
        "即時行情取得失敗";
    }

    const realtimePrice =
      positive(
        realtime?.close,
        realtime?.price
      );

    const price =
      realtimePrice ||
      positive(latest.close);

    if (!price) {
      throw new Error(
        "目前股價取得失敗"
      );
    }

    const realtimeDate =
      normalizeDate(
        realtime?.date || ""
      );

    let previousClose = 0;

    const realtimeChange =
      finite(
        realtime?.change_price
      );

    if (
      realtimePrice &&
      realtimeChange !== null
    ) {

      const calculated =
        realtimePrice -
        realtimeChange;

      if (calculated > 0) {
        previousClose = calculated;
      }
    }

    if (!previousClose) {

      if (
        realtimeDate &&
        latest.date === realtimeDate
      ) {
        previousClose =
          positive(previous.close);
      } else {
        previousClose =
          positive(latest.close);
      }

    }

    if (!previousClose) {
      previousClose = price;
    }

    const change =
      price - previousClose;

    const changePercent =
      previousClose > 0
        ? change / previousClose * 100
        : 0;

    const open =
      positive(
        realtime?.open,
        latest.open,
        price
      );

    const high =
      positive(
        realtime?.high,
        realtime?.max,
        latest.high,
        price
      );

    const low =
      positive(
        realtime?.low,
        realtime?.min,
        latest.low,
        price
      );

    const volume =
      nonNegative(
        realtime?.total_volume,
        realtime?.volume,
        latest.volume,
        0
      );

    /* =========================
       今日即時 K 併入 rows
    ========================= */

    if (
      realtime &&
      realtimePrice &&
      realtimeDate
    ) {

      const last =
        rows[rows.length - 1];

      if (
        last &&
        last.date === realtimeDate
      ) {

        last.open = round(open);

        last.high = round(
          Math.max(high, price)
        );

        last.low = round(
          Math.min(low, price)
        );

        last.close = round(price);

        last.volume = volume;

      } else {

        rows.push({
          date: realtimeDate,
          open: round(open),
          high: round(
            Math.max(high, price)
          ),
          low: round(
            Math.min(low, price)
          ),
          close: round(price),
          volume
        });

      }

    }

    rows = rows.slice(-365);

    /* =========================
       法人籌碼
    ========================= */

    let institutional = [];

    if (results[2].status === "fulfilled") {
      institutional = results[2].value;
    }

    const chip =
      summarizeInstitutional(
        institutional
      );

    return res.status(200).json({

      ok: true,

      source: "FinMind",

      realtime:
        Boolean(
          realtime &&
          realtimePrice
        ),

      symbol,

      name:
        getStockName(symbol) ||
        symbol,

      price: round(price),

      previousClose:
        round(previousClose),

      change:
        round(change),

      changePercent:
        round(changePercent),

      open:
        round(open),

      high:
        round(high),

      low:
        round(low),

      volume,

      quoteDate:
        realtimeDate ||
        latest.date,

      updatedAt:
        Date.now(),

      realtimeError,

      institutional:
        chip,

      rows

    });

  } catch (error) {

    console.error(
      "STOCK API ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      source: "FinMind",
      error:
        error?.message ||
        "FinMind 股票資料取得失敗"
    });

  }

};


/* =========================================================
   FinMind Dataset
========================================================= */

async function getData(
  dataset,
  symbol,
  startDate,
  endDate,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=" +
    encodeURIComponent(dataset) +
    "&data_id=" +
    encodeURIComponent(symbol) +
    "&start_date=" +
    encodeURIComponent(startDate) +
    "&end_date=" +
    encodeURIComponent(endDate);

  const json =
    await requestJSON(
      url,
      token
    );

  if (
    json.status !== undefined &&
    Number(json.status) !== 200
  ) {
    throw new Error(
      json.msg ||
      dataset + " API 錯誤"
    );
  }

  if (!Array.isArray(json.data)) {
    throw new Error(
      dataset + " 資料格式錯誤"
    );
  }

  return json.data;

}


/* =========================================================
   即時
========================================================= */

async function getRealtime(
  symbol,
  token
) {

  const url =
    "https://api.finmindtrade.com" +
    "/api/v4/taiwan_stock_tick_snapshot" +
    "?data_id=" +
    encodeURIComponent(symbol) +
    "&_=" +
    Date.now();

  const json =
    await requestJSON(
      url,
      token
    );

  if (
    json.status !== undefined &&
    Number(json.status) !== 200
  ) {
    throw new Error(
      json.msg ||
      "FinMind 即時 API 錯誤"
    );
  }

  if (
    !Array.isArray(json.data) ||
    !json.data.length
  ) {
    throw new Error(
      "FinMind 查無即時行情"
    );
  }

  return (
    json.data.find(
      x =>
        String(x.stock_id) ===
        String(symbol)
    )
    ||
    json.data[0]
  );

}


/* =========================================================
   法人整理
========================================================= */

function summarizeInstitutional(data) {

  const daily = {};

  for (const row of data || []) {

    const date =
      String(row.date || "");

    if (!date) continue;

    if (!daily[date]) {

      daily[date] = {
        foreign: 0,
        trust: 0,
        dealer: 0,
        total: 0
      };

    }

    const buy =
      Number(row.buy) || 0;

    const sell =
      Number(row.sell) || 0;

    const net =
      buy - sell;

    const name =
      String(row.name || "");

    if (
      name === "Foreign_Investor" ||
      name === "Foreign_Dealer_Self"
    ) {

      daily[date].foreign += net;

    }

    if (
      name === "Investment_Trust"
    ) {

      daily[date].trust += net;

    }

    if (
      name === "Dealer" ||
      name === "Dealer_self" ||
      name === "Dealer_Hedging"
    ) {

      daily[date].dealer += net;

    }

    daily[date].total += net;

  }

  const dates =
    Object.keys(daily)
      .sort();

  const recent5 =
    dates.slice(-5);

  const recent10 =
    dates.slice(-10);

  const sum =
    (dates, key) =>
      dates.reduce(
        (s, d) =>
          s +
          (daily[d]?.[key] || 0),
        0
      );

  const latestDate =
    dates.length
      ? dates[dates.length - 1]
      : "";

  return {

    available:
      dates.length > 0,

    latestDate,

    foreignLatest:
      latestDate
        ? daily[latestDate].foreign
        : 0,

    trustLatest:
      latestDate
        ? daily[latestDate].trust
        : 0,

    dealerLatest:
      latestDate
        ? daily[latestDate].dealer
        : 0,

    totalLatest:
      latestDate
        ? daily[latestDate].total
        : 0,

    foreign5:
      sum(recent5, "foreign"),

    trust5:
      sum(recent5, "trust"),

    dealer5:
      sum(recent5, "dealer"),

    total5:
      sum(recent5, "total"),

    total10:
      sum(recent10, "total")

  };

}


/* =========================================================
   HTTPS
========================================================= */

function requestJSON(url, token) {

  return new Promise(
    (resolve, reject) => {

      let settled = false;

      const request =
        https.get(

          url,

          {

            headers: {

              Authorization:
                "Bearer " +
                token,

              Accept:
                "application/json",

              "User-Agent":
                "stock-analyzer/2.0",

              "Cache-Control":
                "no-cache"

            },

            timeout:
              12000

          },

          response => {

            let body = "";

            response.setEncoding(
              "utf8"
            );

            response.on(
              "data",
              chunk => {

                if (
                  body.length <
                  12 * 1024 * 1024
                ) {
                  body += chunk;
                }

              }
            );

            response.on(
              "end",
              () => {

                if (settled) return;

                settled = true;

                if (
                  response.statusCode < 200 ||
                  response.statusCode >= 300
                ) {

                  return reject(
                    new Error(
                      "FinMind HTTP " +
                      response.statusCode
                    )
                  );

                }

                try {

                  resolve(
                    JSON.parse(body)
                  );

                } catch {

                  reject(
                    new Error(
                      "FinMind JSON 解析失敗"
                    )
                  );

                }

              }
            );

          }

        );

      request.on(
        "timeout",
        () => {

          if (settled) return;

          settled = true;

          request.destroy();

          reject(
            new Error(
              "FinMind 連線逾時"
            )
          );

        }
      );

      request.on(
        "error",
        error => {

          if (settled) return;

          settled = true;

          reject(error);

        }
      );

    }
  );

}


/* =========================================================
   工具
========================================================= */

function formatDate(date) {

  return (
    date.getFullYear() +
    "-" +
    String(
      date.getMonth() + 1
    ).padStart(2, "0") +
    "-" +
    String(
      date.getDate()
    ).padStart(2, "0")
  );

}


function normalizeDate(value) {

  const match =
    String(value || "")
      .match(
        /^(\d{4}-\d{2}-\d{2})/
      );

  return match
    ? match[1]
    : "";

}


function num(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;

}


function positive(...values) {

  for (const value of values) {

    const n = num(value);

    if (
      n !== null &&
      n > 0
    ) {
      return n;
    }

  }

  return 0;

}


function finite(value) {

  return num(value);

}


function nonNegative(...values) {

  for (const value of values) {

    const n = num(value);

    if (
      n !== null &&
      n >= 0
    ) {
      return n;
    }

  }

  return 0;

}


function round(value) {

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return (
    Math.round(n * 100) /
    100
  );

}


/* =========================================================
   股票名稱
========================================================= */

function getStockName(symbol) {

  const names = {

    "1101":"台泥",
    "1102":"亞泥",
    "1216":"統一",
    "1301":"台塑",
    "1303":"南亞",
    "1326":"台化",

    "1503":"士電",
    "1513":"中興電",
    "1519":"華城",

    "2002":"中鋼",
    "2207":"和泰車",

    "2303":"聯電",
    "2308":"台達電",
    "2317":"鴻海",
    "2330":"台積電",
    "2337":"旺宏",
    "2344":"華邦電",
    "2345":"智邦",
    "2357":"華碩",
    "2368":"金像電",
    "2376":"技嘉",
    "2377":"微星",
    "2379":"瑞昱",
    "2382":"廣達",
    "2383":"台光電",
    "2408":"南亞科",
    "2412":"中華電",
    "2454":"聯發科",

    "2603":"長榮",
    "2609":"陽明",
    "2610":"華航",
    "2615":"萬海",
    "2618":"長榮航",

    "2881":"富邦金",
    "2882":"國泰金",
    "2884":"玉山金",
    "2885":"元大金",
    "2886":"兆豐金",
    "2891":"中信金",

    "2912":"統一超",

    "3008":"大立光",
    "3017":"奇鋐",
    "3035":"智原",
    "3037":"欣興",

    "3231":"緯創",
    "3293":"鈊象",
    "3324":"雙鴻",
    "3443":"創意",
    "3481":"群創",
    "3661":"世芯-KY",

    "3711":"日月光投控",

    "6505":"台塑化",
    "6669":"緯穎",
    "6770":"力積電",
    "8046":"南電"

  };

  return names[symbol] || "";

}
