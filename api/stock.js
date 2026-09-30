const https = require("https");

/*
=========================================================
  台股行情 API - FinMind Sponsor
  /api/stock?symbol=2330

  即時行情：
  FinMind taiwan_stock_tick_snapshot

  歷史日K：
  FinMind TaiwanStockPrice

  Vercel Environment Variable：
  FINMIND_TOKEN

  Yahoo Finance：
  完全不使用
=========================================================
*/

module.exports = async function handler(req, res) {

  /* =========================
     Headers
  ========================= */

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");


  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }


  try {

    /* =========================
       FinMind Token
    ========================= */

    const token =
      String(
        process.env.FINMIND_TOKEN || ""
      ).trim();


    if (!token) {

      return res.status(500).json({
        ok: false,
        source: "FinMind",
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
        .toUpperCase()
        .replace(/\.TW$/i, "")
        .replace(/\.TWO$/i, "");


    if (!/^\d{4,6}$/.test(symbol)) {

      return res.status(400).json({
        ok: false,
        source: "FinMind",
        error: "請輸入正確的台股代號"
      });

    }


    /* =========================
       歷史資料日期

       抓 500 天
       足夠 MA60 / RSI / MACD / ATR
    ========================= */

    const now =
      new Date();


    const start =
      new Date(
        now.getTime()
      );


    start.setDate(
      start.getDate() - 500
    );


    const startDate =
      formatDate(start);


    const endDate =
      formatDate(now);


    /* =========================
       同時抓：
       1. 歷史日 K
       2. 即時行情
    ========================= */

    const results =
      await Promise.allSettled([

        getHistory(
          symbol,
          token,
          startDate,
          endDate
        ),

        getRealtime(
          symbol,
          token
        )

      ]);


    const historyResult =
      results[0];


    const realtimeResult =
      results[1];


    /* =========================
       歷史資料必須成功
    ========================= */

    if (
      historyResult.status !==
      "fulfilled"
    ) {

      const reason =
        historyResult.reason &&
        historyResult.reason.message
          ?
          historyResult.reason.message
          :
          "未知錯誤";


      throw new Error(
        "歷史股價取得失敗：" +
        reason
      );

    }


    const history =
      historyResult.value;


    if (
      !Array.isArray(history)
      ||
      history.length === 0
    ) {

      throw new Error(
        "FinMind 查無此股票歷史資料"
      );

    }


    /* =========================
       整理歷史 K 線
    ========================= */

    let rows =
      history
        .map(function (row) {

          const open =
            toNumber(
              row.open
            );


          const high =
            toNumber(
              row.max
            );


          const low =
            toNumber(
              row.min
            );


          const close =
            toNumber(
              row.close
            );


          const volume =
            toNumber(
              row.Trading_Volume
            );


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

            date:
              String(
                row.date || ""
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
              volume !== null &&
              volume >= 0
                ?
                volume
                :
                0

          };

        })

        .filter(function (row) {

          return (
            row &&
            row.date
          );

        })

        .sort(function (a, b) {

          return a.date.localeCompare(
            b.date
          );

        });


    if (rows.length < 60) {

      throw new Error(
        "歷史 K 線不足 60 筆"
      );

    }


    /*
      最多保留 365 個交易日
    */

    rows =
      rows.slice(-365);


    /* =========================
       最新歷史 K
    ========================= */

    const latestHistory =
      rows[
        rows.length - 1
      ];


    const previousHistory =
      rows.length >= 2
        ?
        rows[
          rows.length - 2
        ]
        :
        latestHistory;


    /* =========================
       即時行情

       即時失敗時：
       網頁仍可使用歷史 K
    ========================= */

    let realtime =
      null;


    let realtimeError =
      null;


    if (
      realtimeResult.status ===
      "fulfilled"
    ) {

      realtime =
        realtimeResult.value;

    } else {

      realtimeError =
        realtimeResult.reason &&
        realtimeResult.reason.message
          ?
          realtimeResult.reason.message
          :
          "即時行情取得失敗";


      console.error(
        "FinMind realtime:",
        realtimeError
      );

    }


    /* =========================
       即時價格
    ========================= */

    const realtimePrice =
      getFirstPositive(
        realtime
          ?
          realtime.close
          :
          null,

        realtime
          ?
          realtime.price
          :
          null
      );


    const price =
      realtimePrice
      ||
      getFirstPositive(
        latestHistory.close
      );


    if (!price) {

      throw new Error(
        "目前股價取得失敗"
      );

    }


    /* =========================
       即時日期
    ========================= */

    const realtimeDate =
      normalizeDate(
        realtime
          ?
          realtime.date
          :
          ""
      );


    /* =========================
       昨收

       優先：
       即時漲跌反推

       再 fallback：
       歷史 K
    ========================= */

    let previousClose =
      0;


    const realtimeChange =
      getFirstFinite(
        realtime
          ?
          realtime.change_price
          :
          null
      );


    if (
      realtimePrice &&
      realtimeChange !== null
    ) {

      const calculated =
        realtimePrice -
        realtimeChange;


      if (
        Number.isFinite(
          calculated
        )
        &&
        calculated > 0
      ) {

        previousClose =
          calculated;

      }

    }


    if (!previousClose) {

      /*
        如果歷史 K 最後一筆就是今天，
        昨收使用倒數第二筆。

        如果歷史 K 尚未包含今天，
        最後一筆就是昨收。
      */

      if (
        realtimeDate &&
        latestHistory.date ===
        realtimeDate
      ) {

        previousClose =
          getFirstPositive(
            previousHistory.close
          );

      } else {

        previousClose =
          getFirstPositive(
            latestHistory.close
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


    const calculatedChangePercent =
      previousClose > 0
        ?
        (
          change /
          previousClose
        ) * 100
        :
        0;


    /*
      直接使用計算值，
      避免不同 API change_rate
      百分比單位定義不同。
    */

    const changePercent =
      calculatedChangePercent;


    /* =========================
       今日開高低
    ========================= */

    const open =
      getFirstPositive(

        realtime
          ?
          realtime.open
          :
          null,

        latestHistory.open,

        price

      );


    const high =
      getFirstPositive(

        realtime
          ?
          realtime.high
          :
          null,

        realtime
          ?
          realtime.max
          :
          null,

        latestHistory.high,

        price

      );


    const low =
      getFirstPositive(

        realtime
          ?
          realtime.low
          :
          null,

        realtime
          ?
          realtime.min
          :
          null,

        latestHistory.low,

        price

      );


    /* =========================
       成交量
    ========================= */

    const volume =
      getFirstNonNegative(

        realtime
          ?
          realtime.total_volume
          :
          null,

        realtime
          ?
          realtime.volume
          :
          null,

        latestHistory.volume,

        0

      );


    /* =========================
       把今日即時行情放進 K 線

       這樣策略分析會用目前價格，
       而不是只用昨天收盤。
    ========================= */

    if (
      realtime &&
      realtimePrice &&
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
          round(open);


        last.high =
          round(
            Math.max(
              high,
              price
            )
          );


        last.low =
          round(
            Math.min(
              low,
              price
            )
          );


        last.close =
          round(price);


        last.volume =
          volume;

      } else {

        rows.push({

          date:
            realtimeDate,

          open:
            round(open),

          high:
            round(
              Math.max(
                high,
                price
              )
            ),

          low:
            round(
              Math.min(
                low,
                price
              )
            ),

          close:
            round(price),

          volume:
            volume

        });

      }

    }


    rows =
      rows.slice(-365);


    /* =========================
       名稱
    ========================= */

    const name =
      getStockName(symbol)
      ||
      symbol;


    /* =========================
       回傳給 index.html

       保留原本前端需要的格式：
       ok
       symbol
       name
       price
       changePercent
       rows
    ========================= */

    return res
      .status(200)
      .json({

        ok: true,

        source:
          "FinMind",

        realtime:
          Boolean(
            realtime &&
            realtimePrice
          ),

        symbol:
          symbol,

        name:
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

        volume:
          volume,

        quoteDate:
          realtimeDate
          ||
          latestHistory.date,

        updatedAt:
          Date.now(),

        realtimeError:
          realtime
            ?
            null
            :
            realtimeError,

        rows:
          rows

      });


  } catch (error) {

    console.error(
      "STOCK API ERROR:",
      error
    );


    return res
      .status(500)
      .json({

        ok: false,

        source:
          "FinMind",

        error:
          error &&
          error.message
            ?
            error.message
            :
            "FinMind 股票資料取得失敗"

      });

  }

};


/* =========================================================
   FinMind 即時行情
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


  if (!json) {

    throw new Error(
      "FinMind 即時資料沒有回應"
    );

  }


  if (
    json.status !== undefined &&
    Number(json.status) !== 200
  ) {

    throw new Error(
      json.msg
        ?
        String(json.msg)
        :
        "FinMind 即時 API 錯誤"
    );

  }


  if (
    !Array.isArray(
      json.data
    )
  ) {

    throw new Error(
      "FinMind 即時資料格式錯誤"
    );

  }


  if (
    json.data.length === 0
  ) {

    throw new Error(
      "FinMind 查無即時行情"
    );

  }


  const exact =
    json.data.find(
      function (item) {

        return (
          String(
            item.stock_id || ""
          ) ===
          String(symbol)
        );

      }
    );


  return (
    exact ||
    json.data[0]
  );

}


/* =========================================================
   FinMind 歷史日 K
========================================================= */

async function getHistory(
  symbol,
  token,
  startDate,
  endDate
) {

  const query =

    "dataset=" +
    encodeURIComponent(
      "TaiwanStockPrice"
    ) +

    "&data_id=" +
    encodeURIComponent(
      symbol
    ) +

    "&start_date=" +
    encodeURIComponent(
      startDate
    ) +

    "&end_date=" +
    encodeURIComponent(
      endDate
    );


  const url =
    "https://api.finmindtrade.com" +
    "/api/v4/data?" +
    query;


  const json =
    await requestJSON(
      url,
      token
    );


  if (!json) {

    throw new Error(
      "FinMind 歷史資料沒有回應"
    );

  }


  if (
    json.status !== undefined &&
    Number(json.status) !== 200
  ) {

    throw new Error(
      json.msg
        ?
        String(json.msg)
        :
        "FinMind 歷史 API 錯誤"
    );

  }


  if (
    !Array.isArray(
      json.data
    )
  ) {

    throw new Error(
      "FinMind 歷史資料格式錯誤"
    );

  }


  if (
    json.data.length === 0
  ) {

    throw new Error(
      "FinMind 查無此股票"
    );

  }


  return json.data;

}


/* =========================================================
   HTTPS
========================================================= */

function requestJSON(
  url,
  token
) {

  return new Promise(
    function (
      resolve,
      reject
    ) {

      let settled =
        false;


      const request =
        https.get(

          url,

          {

            headers: {

              "Authorization":
                "Bearer " +
                token,

              "Accept":
                "application/json",

              "User-Agent":
                "Mozilla/5.0 stock-analyzer",

              "Cache-Control":
                "no-cache",

              "Pragma":
                "no-cache"

            },

            timeout:
              12000

          },

          function (response) {

            let body =
              "";


            response.setEncoding(
              "utf8"
            );


            response.on(
              "data",
              function (chunk) {

                if (
                  body.length <
                  10 * 1024 * 1024
                ) {

                  body +=
                    chunk;

                }

              }
            );


            response.on(
              "end",
              function () {

                if (settled) {
                  return;
                }


                settled =
                  true;


                const statusCode =
                  Number(
                    response.statusCode || 0
                  );


                if (
                  statusCode < 200 ||
                  statusCode >= 300
                ) {

                  let apiMessage =
                    "";


                  try {

                    const parsed =
                      JSON.parse(
                        body
                      );


                    if (
                      parsed &&
                      parsed.msg
                    ) {

                      apiMessage =
                        String(
                          parsed.msg
                        );

                    }

                  } catch (_) {}


                  return reject(

                    new Error(

                      "FinMind HTTP " +
                      statusCode +
                      (
                        apiMessage
                          ?
                          "：" +
                          apiMessage
                          :
                          ""
                      )

                    )

                  );

                }


                try {

                  const json =
                    JSON.parse(
                      body
                    );


                  resolve(
                    json
                  );


                } catch (_) {

                  reject(

                    new Error(
                      "FinMind 回傳不是有效 JSON"
                    )

                  );

                }

              }
            );

          }

        );


      request.on(
        "timeout",
        function () {

          if (settled) {
            return;
          }


          settled =
            true;


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
        function (error) {

          if (settled) {
            return;
          }


          settled =
            true;


          reject(
            error
          );

        }
      );

    }
  );

}


/* =========================================================
   日期工具
========================================================= */

function formatDate(date) {

  const year =
    date.getFullYear();


  const month =
    String(
      date.getMonth() + 1
    ).padStart(
      2,
      "0"
    );


  const day =
    String(
      date.getDate()
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


function normalizeDate(value) {

  if (!value) {
    return "";
  }


  const text =
    String(value).trim();


  const match =
    text.match(
      /^(\d{4}-\d{2}-\d{2})/
    );


  if (match) {
    return match[1];
  }


  return "";

}


/* =========================================================
   數字工具
========================================================= */

function toNumber(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;

  }


  const number =
    Number(value);


  if (
    !Number.isFinite(number)
  ) {

    return null;

  }


  return number;

}


function getFirstPositive() {

  for (
    let i = 0;
    i < arguments.length;
    i++
  ) {

    const number =
      toNumber(
        arguments[i]
      );


    if (
      number !== null &&
      number > 0
    ) {

      return number;

    }

  }


  return 0;

}


function getFirstFinite() {

  for (
    let i = 0;
    i < arguments.length;
    i++
  ) {

    const number =
      toNumber(
        arguments[i]
      );


    if (
      number !== null
    ) {

      return number;

    }

  }


  return null;

}


function getFirstNonNegative() {

  for (
    let i = 0;
    i < arguments.length;
    i++
  ) {

    const number =
      toNumber(
        arguments[i]
      );


    if (
      number !== null &&
      number >= 0
    ) {

      return number;

    }

  }


  return 0;

}


function round(value) {

  const number =
    Number(value);


  if (
    !Number.isFinite(number)
  ) {

    return 0;

  }


  return (
    Math.round(
      number * 100
    ) / 100
  );

}


/* =========================================================
   股票名稱備援
========================================================= */

function getStockName(symbol) {

  const names = {

    "1101": "台泥",
    "1102": "亞泥",

    "1216": "統一",

    "1301": "台塑",
    "1303": "南亞",
    "1326": "台化",

    "1503": "士電",
    "1513": "中興電",
    "1519": "華城",

    "2002": "中鋼",

    "2207": "和泰車",

    "2303": "聯電",
    "2308": "台達電",
    "2317": "鴻海",
    "2330": "台積電",
    "2337": "旺宏",
    "2344": "華邦電",
    "2345": "智邦",
    "2357": "華碩",
    "2368": "金像電",
    "2376": "技嘉",
    "2377": "微星",
    "2379": "瑞昱",
    "2382": "廣達",
    "2383": "台光電",
    "2408": "南亞科",
    "2412": "中華電",
    "2454": "聯發科",

    "2603": "長榮",
    "2609": "陽明",
    "2610": "華航",
    "2615": "萬海",
    "2618": "長榮航",

    "2881": "富邦金",
    "2882": "國泰金",
    "2884": "玉山金",
    "2885": "元大金",
    "2886": "兆豐金",
    "2891": "中信金",

    "2912": "統一超",

    "3008": "大立光",
    "3017": "奇鋐",
    "3035": "智原",
    "3037": "欣興",

    "3231": "緯創",
    "3293": "鈊象",
    "3324": "雙鴻",
    "3443": "創意",
    "3661": "世芯-KY",

    "3711": "日月光投控",

    "6505": "台塑化",
    "6669": "緯穎",
    "6770": "力積電",

    "8046": "南電"

  };


  return (
    names[symbol] ||
    ""
  );

}
