const https = require("https");

/*
  api/stock.js

  FinMind 台股資料 API

  功能：
  1. 歷史日 K
  2. Sponsor 即時報價
  3. 三大法人籌碼
  4. TaiwanStockInfo 中文名稱
  5. 提供前端 SMC 分析需要的完整 K 線
*/

module.exports = async function handler(req, res) {

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

  if (req.method === "OPTIONS") {
    return res.status(200).end();
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
        req.query.symbol || ""
      )
      .trim()
      .toUpperCase();

    if (
      !/^[0-9A-Z]{4,10}$/.test(symbol)
    ) {
      throw new Error(
        "股票代號格式錯誤"
      );
    }

    /*
      抓約 500 天，
      確保 SMC 有足夠歷史結構。
    */

    const end =
      new Date();

    const start =
      new Date();

    start.setDate(
      start.getDate() - 500
    );

    const startDate =
      formatDate(start);

    const endDate =
      formatDate(end);


    /*
      歷史 K 線、即時報價、
      法人、股票名稱並行抓取。
    */

    const [
      priceResult,
      realtimeResult,
      institutionalResult,
      infoResult
    ] =
    await Promise.allSettled([

      getHistorical(
        symbol,
        startDate,
        endDate,
        token
      ),

      getRealtime(
        symbol,
        token
      ),

      getInstitutional(
        symbol,
        startDate,
        endDate,
        token
      ),

      getStockInfo(
        token
      )

    ]);


    /*
      歷史 K 線為必要資料。
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
      !Array.isArray(rows) ||
      rows.length < 60
    ) {

      throw new Error(
        "歷史 K 線不足 60 根"
      );

    }


    /*
      中文股票名稱
    */

    let name = "";

    let market = "";

    if (
      infoResult.status ===
      "fulfilled"
    ) {

      const info =
        infoResult.value
        .find(
          x =>
            String(
              x.stock_id || ""
            ) === symbol
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


    /*
      即時報價。
      即時 API 若暫時失敗，
      不讓整個分析頁一起掛掉。
    */

    let realtime = null;

    let realtimeError = "";

    if (
      realtimeResult.status ===
      "fulfilled"
    ) {

      realtime =
        realtimeResult.value;

    } else {

      realtimeError =
        realtimeResult.reason?.message ||
        "即時報價暫時無法取得";

    }


    /*
      法人籌碼。
      法人 API 暫時失敗也不阻止
      SMC 股價結構分析。
    */

    let institutional =
      emptyInstitutional();

    if (
      institutionalResult.status ===
      "fulfilled"
    ) {

      institutional =
        institutionalResult.value;

    }


    /*
      歷史最新一根。
    */

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


    /*
      優先使用即時價。
      沒有即時價才使用最新日 K。
    */

    let currentPrice =
      positive(
        realtime?.price,
        realtime?.close,
        realtime?.last_price,
        realtime?.lastPrice,
        latest.close
      );


    let previousClose =
      positive(
        realtime?.previous_close,
        realtime?.previousClose,
        realtime?.reference_price,
        realtime?.referencePrice,
        previous.close
      );


    /*
      即時 OHLC
    */

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


    /*
      今日即時價併入最後一根 K。

      這很重要：
      SMC 分析需要知道目前價格
      是否正在突破 BOS、
      Sweep、FVG、OB 等結構。
    */

    const today =
      formatDate(
        new Date()
      );

    let mergedRows =
      rows.map(
        x => ({ ...x })
      );


    const last =
      mergedRows[
        mergedRows.length - 1
      ];


    if (
      realtime &&
      currentPrice > 0
    ) {

      if (
        last &&
        normalizeDate(
          last.date
        ) === today
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

        last.low =
          Math.min(
            ...[
              last.low,
              currentLow,
              currentPrice
            ]
            .filter(
              x =>
                Number.isFinite(+x) &&
                +x > 0
            )
          );

        last.close =
          currentPrice;

        if (
          currentVolume > 0
        ) {

          last.volume =
            currentVolume;

        }

      } else {

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
            Math.min(
              ...[
                currentLow,
                currentPrice
              ]
              .filter(
                x =>
                  Number.isFinite(+x) &&
                  +x > 0
              )
            ),

          close:
            currentPrice,

          volume:
            currentVolume || 0

        });

      }

    }


    /*
      限制資料量。
      SMC 前端目前主要分析最近 140 根，
      但保留 300 根給未來擴充。
    */

    mergedRows =
      mergedRows
      .slice(-300);


    /*
      漲跌幅
    */

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


    /*
      回傳前端
    */

    return res
      .status(200)
      .json({

        ok: true,

        source:
          "FinMind",

        realtime:
          Boolean(
            realtime
          ),

        symbol,

        name:
          name ||
          symbol,

        market,

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

        realtimeError,

        institutional,

        rows:
          mergedRows

      });


  } catch (error) {

    console.error(
      "stock api error:",
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

      });

  }

};


/* =========================================================
   歷史日 K
========================================================= */

async function getHistorical(
  symbol,
  startDate,
  endDate,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockPrice" +
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


  const json =
    await requestJSON(
      url,
      token
    );


  checkFinMind(
    json,
    "歷史股價"
  );


  const data =
    Array.isArray(
      json.data
    )
    ?
    json.data
    :
    [];


  const rows =
    data
    .map(
      row => {

        const open =
          positive(
            row.open
          );

        const high =
          positive(
            row.max,
            row.high
          );

        const low =
          positive(
            row.min,
            row.low
          );

        const close =
          positive(
            row.close
          );

        const volume =
          nonNegative(
            row.Trading_Volume,
            row.volume
          );


        return {

          date:
            normalizeDate(
              row.date
            ),

          open,

          high,

          low,

          close,

          volume

        };

      }
    )

    .filter(
      row =>
        row.date &&
        row.open > 0 &&
        row.high > 0 &&
        row.low > 0 &&
        row.close > 0
    )

    .sort(
      (a, b) =>
        a.date.localeCompare(
          b.date
        )
    );


  /*
    防止同一天重複。
  */

  const map =
    new Map();

  for (
    const row
    of rows
  ) {

    map.set(
      row.date,
      row
    );

  }


  return [
    ...map.values()
  ];

}


/* =========================================================
   FinMind Sponsor 即時報價
========================================================= */

async function getRealtime(
  symbol,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot" +
    "?data_id=" +
    encodeURIComponent(
      symbol
    ) +
    "&_=" +
    Date.now();


  const json =
    await requestJSON(
      url,
      token
    );


  checkFinMind(
    json,
    "即時報價"
  );


  let data =
    json.data;


  if (
    Array.isArray(data)
  ) {

    data =
      data.find(
        x =>
          String(
            x.stock_id ||
            x.code ||
            x.symbol ||
            ""
          ) === symbol
      )
      ||
      data[0];

  }


  if (
    !data ||
    typeof data !==
    "object"
  ) {

    throw new Error(
      "即時報價沒有資料"
    );

  }


  /*
    FinMind 即時欄位可能因 API
    回傳版本有所不同，
    這裡統一轉成前端使用格式。
  */

  return {

    price:
      positive(
        data.price,
        data.close,
        data.last_price,
        data.lastPrice
      ),

    open:
      positive(
        data.open,
        data.open_price,
        data.openPrice
      ),

    high:
      positive(
        data.high,
        data.max,
        data.high_price,
        data.highPrice
      ),

    low:
      positive(
        data.low,
        data.min,
        data.low_price,
        data.lowPrice
      ),

    volume:
      nonNegative(
        data.volume,
        data.total_volume,
        data.totalVolume,
        data.Trading_Volume
      ),

    previous_close:
      positive(
        data.previous_close,
        data.previousClose,
        data.reference_price,
        data.referencePrice
      )

  };

}


/* =========================================================
   股票完整中文名稱
========================================================= */

async function getStockInfo(
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockInfo";


  const json =
    await requestJSON(
      url,
      token
    );


  checkFinMind(
    json,
    "股票名稱"
  );


  if (
    !Array.isArray(
      json.data
    )
  ) {

    return [];

  }


  return json.data;

}


/* =========================================================
   三大法人籌碼
========================================================= */

async function getInstitutional(
  symbol,
  startDate,
  endDate,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockInstitutionalInvestorsBuySell" +
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


  const json =
    await requestJSON(
      url,
      token
    );


  checkFinMind(
    json,
    "法人籌碼"
  );


  const data =
    Array.isArray(
      json.data
    )
    ?
    json.data
    :
    [];


  /*
    每天可能有：
    Foreign_Investor
    Investment_Trust
    Dealer_self
    Dealer_Hedging

    所以先依日期合併。
  */

  const daily = {};


  for (
    const row
    of data
  ) {

    const date =
      normalizeDate(
        row.date
      );

    if (!date) {
      continue;
    }


    if (
      !daily[date]
    ) {

      daily[date] = {

        date,

        foreign: 0,

        trust: 0,

        dealer: 0,

        total: 0

      };

    }


    const buy =
      nonNegative(
        row.buy
      );

    const sell =
      nonNegative(
        row.sell
      );

    const net =
      buy - sell;


    const name =
      String(
        row.name || ""
      )
      .toLowerCase();


    /*
      外資
    */

    if (
      name.includes(
        "foreign"
      ) ||
      name.includes(
        "外資"
      )
    ) {

      daily[date]
        .foreign += net;

    }


    /*
      投信
    */

    else if (
      name.includes(
        "investment_trust"
      ) ||
      name.includes(
        "investment trust"
      ) ||
      name.includes(
        "投信"
      )
    ) {

      daily[date]
        .trust += net;

    }


    /*
      自營商
    */

    else if (
      name.includes(
        "dealer"
      ) ||
      name.includes(
        "自營"
      )
    ) {

      daily[date]
        .dealer += net;

    }


    daily[date]
      .total += net;

  }


  const dates =
    Object
    .keys(daily)
    .sort();


  if (
    !dates.length
  ) {

    return emptyInstitutional();

  }


  const recent5 =
    dates
    .slice(-5)
    .map(
      date =>
        daily[date]
    );


  const recent10 =
    dates
    .slice(-10)
    .map(
      date =>
        daily[date]
    );


  const latestDate =
    dates[
      dates.length - 1
    ];


  return {

    latestDate,

    foreignLatest:
      daily[
        latestDate
      ].foreign,

    trustLatest:
      daily[
        latestDate
      ].trust,

    dealerLatest:
      daily[
        latestDate
      ].dealer,

    totalLatest:
      daily[
        latestDate
      ].total,

    foreign5:
      sum(
        recent5,
        "foreign"
      ),

    trust5:
      sum(
        recent5,
        "trust"
      ),

    dealer5:
      sum(
        recent5,
        "dealer"
      ),

    total5:
      sum(
        recent5,
        "total"
      ),

    total10:
      sum(
        recent10,
        "total"
      )

  };

}


/* =========================================================
   空法人資料
========================================================= */

function emptyInstitutional() {

  return {

    latestDate: "",

    foreignLatest: 0,

    trustLatest: 0,

    dealerLatest: 0,

    totalLatest: 0,

    foreign5: 0,

    trust5: 0,

    dealer5: 0,

    total5: 0,

    total10: 0

  };

}


/* =========================================================
   法人加總
========================================================= */

function sum(
  rows,
  key
) {

  return rows.reduce(
    (
      total,
      row
    ) =>
      total +
      (
        Number(
          row[key]
        ) || 0
      ),
    0
  );

}


/* =========================================================
   FinMind 錯誤檢查
========================================================= */

function checkFinMind(
  json,
  label
) {

  if (
    !json ||
    typeof json !==
    "object"
  ) {

    throw new Error(
      label +
      " API 回傳格式錯誤"
    );

  }


  /*
    FinMind status 通常為 200。
  */

  if (
    json.status !==
      undefined &&
    Number(
      json.status
    ) !== 200
  ) {

    throw new Error(
      json.msg ||
      json.message ||
      label +
      "取得失敗"
    );

  }

}


/* =========================================================
   HTTPS
========================================================= */

function requestJSON(
  url,
  token
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      let settled =
        false;


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
                "stock-analyzer/3.0",

              "Cache-Control":
                "no-cache"

            },

            timeout:
              15000

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
                  15 *
                  1024 *
                  1024
                ) {

                  body += chunk;

                }

              }
            );


            response.on(
              "end",
              () => {

                if (
                  settled
                ) {
                  return;
                }


                settled =
                  true;


                if (
                  response.statusCode <
                    200 ||
                  response.statusCode >=
                    300
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
                    JSON.parse(
                      body
                    )
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

          if (
            settled
          ) {
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
        error => {

          if (
            settled
          ) {
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
   市場名稱
========================================================= */

function normalizeMarket(
  value
) {

  const x =
    String(
      value || ""
    )
    .toLowerCase();


  if (
    x.includes(
      "twse"
    ) ||
    x.includes(
      "上市"
    )
  ) {

    return "上市";

  }


  if (
    x.includes(
      "tpex"
    ) ||
    x.includes(
      "otc"
    ) ||
    x.includes(
      "上櫃"
    )
  ) {

    return "上櫃";

  }


  if (
    x.includes(
      "emerging"
    ) ||
    x.includes(
      "興櫃"
    )
  ) {

    return "興櫃";

  }


  return value || "";

}


/* =========================================================
   日期
========================================================= */

function formatDate(
  date
) {

  return (
    date.getFullYear() +
    "-" +
    String(
      date.getMonth() + 1
    ).padStart(
      2,
      "0"
    ) +
    "-" +
    String(
      date.getDate()
    ).padStart(
      2,
      "0"
    )
  );

}


function normalizeDate(
  value
) {

  const match =
    String(
      value || ""
    )
    .match(
      /^(\d{4}-\d{2}-\d{2})/
    );


  return match
    ? match[1]
    : "";

}


/* =========================================================
   數字處理
========================================================= */

function num(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;

  }


  const n =
    Number(
      value
    );


  return Number.isFinite(
    n
  )
    ? n
    : null;

}


function positive(
  ...values
) {

  for (
    const value
    of values
  ) {

    const n =
      num(
        value
      );


    if (
      n !== null &&
      n > 0
    ) {

      return n;

    }

  }


  return 0;

}


function nonNegative(
  ...values
) {

  for (
    const value
    of values
  ) {

    const n =
      num(
        value
      );


    if (
      n !== null &&
      n >= 0
    ) {

      return n;

    }

  }


  return 0;

}


function round(
  value
) {

  const n =
    Number(
      value
    );


  if (
    !Number.isFinite(
      n
    )
  ) {

    return 0;

  }


  return (
    Math.round(
      n * 100
    ) /
    100
  );

}
