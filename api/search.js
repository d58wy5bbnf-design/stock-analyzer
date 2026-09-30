const https = require("https");

/*
  api/search.js

  台股完整搜尋

  資料來源：
  FinMind TaiwanStockInfo

  支援：
  2330   → 台積電
  233    → 233 開頭股票
  台積電 → 台積電
  台積   → 台積電
  積電   → 台積電
  聯發   → 聯發科
  鴻     → 鴻海等相關結果

  不再使用手寫股票名單。
*/


/* =========================================================
   簡易記憶體快取

   Vercel 同一個 instance 還活著時，
   不需要每次搜尋都重新向 FinMind
   下載整份股票清單。
========================================================= */

let stockCache = [];

let stockCacheTime = 0;

const CACHE_TIME =
  6 * 60 * 60 * 1000;


/* =========================================================
   API
========================================================= */

module.exports =
async function handler(req, res) {

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
    "no-store, no-cache, must-revalidate"
  );


  if (
    req.method === "OPTIONS"
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


    const raw =
      String(
        req.query.q || ""
      )
      .trim();


    if (!raw) {

      return res
        .status(200)
        .json({

          ok: true,

          query: "",

          count: 0,

          items: []

        });

    }


    /*
      取得完整股票清單
    */

    const stocks =
      await getStockList(
        token
      );


    const q =
      normalize(
        raw
      );


    const isNumber =
      /^\d+$/.test(
        q
      );


    /*
      搜尋
    */

    let results =
      stocks

      .map(
        stock => {

          const symbol =
            normalize(
              stock.symbol
            );

          const name =
            normalize(
              stock.name
            );


          let score = 0;


          /* ===============================================
             股票代號搜尋
          =============================================== */

          if (
            isNumber
          ) {

            /*
              完全相同

              2330
            */

            if (
              symbol === q
            ) {

              score =
                100000;

            }


            /*
              開頭相同

              23
              233
            */

            else if (
              symbol.startsWith(
                q
              )
            ) {

              score =
                90000;

            }


            /*
              中間包含

              330
            */

            else if (
              symbol.includes(
                q
              )
            ) {

              score =
                70000;

            }

          }


          /* ===============================================
             中文名稱搜尋
          =============================================== */

          else {

            /*
              完整名稱

              台積電
            */

            if (
              name === q
            ) {

              score =
                100000;

            }


            /*
              名稱開頭

              台積
              聯發
              長榮
            */

            else if (
              name.startsWith(
                q
              )
            ) {

              score =
                90000;

            }


            /*
              名稱包含

              積電
              發科
              榮航
            */

            else if (
              name.includes(
                q
              )
            ) {

              score =
                80000;

            }


            /*
              模糊字元順序

              例如：

              台電

              可以找到名稱中
              台...電
            */

            else if (
              fuzzyContains(
                name,
                q
              )
            ) {

              score =
                60000;

            }

          }


          /*
            名稱越接近輸入長度，
            排名稍微提高。
          */

          if (
            score > 0
          ) {

            score -=
              Math.abs(
                name.length -
                q.length
              ) * 10;

          }


          /*
            一般股票代號
            稍微提高排序。

            避免某些特殊商品、
            權證、非普通股票
            排在前面。
          */

          if (
            /^[0-9]{4}$/.test(
              stock.symbol
            )
          ) {

            score +=
              100;

          }


          return {

            ...stock,

            score

          };

        }
      )


      /*
        沒有匹配的移除
      */

      .filter(
        stock =>
          stock.score > 0
      )


      /*
        排序
      */

      .sort(
        (a, b) => {

          if (
            b.score !==
            a.score
          ) {

            return (
              b.score -
              a.score
            );

          }


          return (
            String(
              a.symbol
            )
            .localeCompare(
              String(
                b.symbol
              )
            )
          );

        }
      )


      /*
        搜尋候選最多 30 筆
      */

      .slice(
        0,
        30
      )


      /*
        前端需要的格式
      */

      .map(
        stock => ({

          symbol:
            stock.symbol,

          name:
            stock.name,

          market:
            stock.market

        })
      );


    return res
      .status(200)
      .json({

        ok: true,

        query:
          raw,

        count:
          results.length,

        items:
          results

      });


  } catch (error) {

    console.error(
      "search api error:",
      error
    );


    return res
      .status(500)
      .json({

        ok: false,

        error:
          error?.message ||
          "股票搜尋失敗"

      });

  }

};


/* =========================================================
   取得完整台股股票清單
========================================================= */

async function getStockList(
  token
) {

  /*
    快取還有效，
    直接使用。
  */

  if (
    stockCache.length &&
    Date.now() -
      stockCacheTime <
      CACHE_TIME
  ) {

    return stockCache;

  }


  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockInfo";


  const json =
    await requestJSON(
      url,
      token
    );


  checkFinMind(
    json
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
    整理成我們前端統一格式
  */

  const map =
    new Map();


  for (
    const row
    of data
  ) {

    const symbol =
      String(
        row.stock_id ||
        ""
      )
      .trim();


    const name =
      String(
        row.stock_name ||
        ""
      )
      .trim();


    if (
      !symbol ||
      !name
    ) {

      continue;

    }


    /*
      主要保留一般股票代號。

      4～6 位數字可涵蓋
      上市、上櫃及部分特殊股票。
    */

    if (
      !/^[0-9]{4,6}$/.test(
        symbol
      )
    ) {

      continue;

    }


    const market =
      normalizeMarket(
        row.type ||
        row.market ||
        row.industry_category ||
        ""
      );


    /*
      同代號只留一筆
    */

    if (
      !map.has(
        symbol
      )
    ) {

      map.set(
        symbol,
        {

          symbol,

          name,

          market

        }
      );

    }

  }


  stockCache =
    [
      ...map.values()
    ];


  stockCacheTime =
    Date.now();


  return stockCache;

}


/* =========================================================
   市場名稱
========================================================= */

function normalizeMarket(
  value
) {

  const original =
    String(
      value || ""
    );


  const x =
    original
    .toLowerCase();


  /*
    上市
  */

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


  /*
    上櫃
  */

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


  /*
    興櫃
  */

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


  /*
    ETF
  */

  if (
    x.includes(
      "etf"
    )
  ) {

    return "ETF";

  }


  return original;

}


/* =========================================================
   搜尋字串 Normalize
========================================================= */

function normalize(
  value
) {

  return String(
    value || ""
  )

  .toLowerCase()

  .trim()

  /*
    移除空白
  */

  .replace(
    /\s+/g,
    ""
  )

  /*
    台 / 臺
    搜尋時視為相同
  */

  .replace(
    /臺/g,
    "台"
  )

  /*
    移除部分符號
  */

  .replace(
    /[\-_.()（）]/g,
    ""
  );

}


/* =========================================================
   中文模糊搜尋
========================================================= */

function fuzzyContains(
  text,
  query
) {

  if (
    !text ||
    !query
  ) {

    return false;

  }


  let index = 0;


  for (
    const char
    of text
  ) {

    if (
      char ===
      query[index]
    ) {

      index++;

    }


    if (
      index ===
      query.length
    ) {

      return true;

    }

  }


  return false;

}


/* =========================================================
   FinMind API 檢查
========================================================= */

function checkFinMind(
  json
) {

  if (
    !json ||
    typeof json !==
    "object"
  ) {

    throw new Error(
      "FinMind 股票清單格式錯誤"
    );

  }


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
      "FinMind 股票清單取得失敗"
    );

  }


  if (
    !Array.isArray(
      json.data
    )
  ) {

    throw new Error(
      "FinMind 沒有回傳股票清單"
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

                /*
                  防止異常回傳太大
                */

                if (
                  body.length <
                  15 *
                  1024 *
                  1024
                ) {

                  body +=
                    chunk;

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

                  const json =
                    JSON.parse(
                      body
                    );


                  resolve(
                    json
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
              "FinMind 股票清單連線逾時"
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
