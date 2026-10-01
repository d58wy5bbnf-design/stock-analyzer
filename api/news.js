const https = require("https");

/*
  api/news.js
  妖子平台 News Analysis API 1.0

  功能：
  1. 取得個股最近 3 天新聞
  2. 去除重複新聞
  3. 關鍵字初步判斷偏多 / 中性 / 偏空
  4. 新聞只作輔助，不直接決定買賣
*/

module.exports = async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  /*
    新聞不用每次重新打 FinMind。
    Vercel CDN 可短暫快取。
  */
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=600"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {

    const token = process.env.FINMIND_TOKEN;

    if (!token) {
      throw new Error("Vercel 尚未設定 FINMIND_TOKEN");
    }

    const symbol = String(req.query.symbol || "")
      .trim()
      .toUpperCase();

    if (!/^[0-9A-Z]{4,10}$/.test(symbol)) {
      throw new Error("股票代號格式錯誤");
    }

    /*
      TaiwanStockNews 單次只回一天，
      所以抓最近 3 個日曆日。

      不抓 7 / 14 / 30 天，
      避免浪費 FinMind API 額度。
    */
    const dates = [];

    for (let i = 0; i < 3; i++) {

      const d = taipeiDateOffset(-i);

      dates.push(d);

    }

    /*
      並行抓三天。
    */
    const results = await Promise.allSettled(
      dates.map(
        date =>
          getNews(
            symbol,
            date,
            token
          )
      )
    );

    let all = [];

    const errors = [];

    results.forEach(
      (result, index) => {

        if (result.status === "fulfilled") {

          all.push(
            ...result.value
          );

        } else {

          errors.push({
            date: dates[index],
            error:
              result.reason?.message ||
              "新聞取得失敗"
          });

        }

      }
    );

    /*
      去除重複。

      優先用 link，
      沒 link 才用 title。
    */
    const map = new Map();

    for (const item of all) {

      const key =
        item.link ||
        (
          item.date +
          "|" +
          item.title
        );

      if (!map.has(key)) {
        map.set(key, item);
      }

    }

    let news = [
      ...map.values()
    ];

    /*
      最新新聞排前面。
    */
    news.sort(
      (a, b) =>
        String(b.date)
          .localeCompare(
            String(a.date)
          )
    );

    /*
      最多回 30 則。
    */
    news = news
      .slice(0, 30)
      .map(
        item => {

          const sentiment =
            analyzeSentiment(
              item.title,
              item.description
            );

          return {

            ...item,

            sentiment:
              sentiment.label,

            sentimentScore:
              sentiment.score,

            positiveHits:
              sentiment.positiveHits,

            negativeHits:
              sentiment.negativeHits

          };

        }
      );

    /*
      統計整體新聞情緒。
    */
    const validScores =
      news.map(
        x =>
          Number(
            x.sentimentScore
          ) || 0
      );

    const totalScore =
      validScores.reduce(
        (a, b) =>
          a + b,
        0
      );

    /*
      防止單篇新聞影響過大。

      overallScore 範圍：
      -10 ~ +10
    */
    const rawAverage =
      validScores.length
        ?
        totalScore /
        validScores.length
        :
        0;

    const overallScore =
      clamp(
        round(rawAverage),
        -10,
        10
      );

    let overall = "資料不足";

    if (news.length) {

      if (overallScore >= 2) {
        overall = "偏多";
      }

      else if (overallScore <= -2) {
        overall = "偏空";
      }

      else {
        overall = "中性";
      }

    }

    const positiveCount =
      news.filter(
        x =>
          x.sentiment === "偏多"
      ).length;

    const negativeCount =
      news.filter(
        x =>
          x.sentiment === "偏空"
      ).length;

    const neutralCount =
      news.filter(
        x =>
          x.sentiment === "中性"
      ).length;

    return res
      .status(200)
      .json({

        ok: true,

        source: "FinMind",

        engine:
          "News Analysis 1.0",

        symbol,

        searchedDates:
          dates,

        count:
          news.length,

        available:
          news.length > 0,

        overall,

        overallScore,

        positiveCount,

        neutralCount,

        negativeCount,

        /*
          注意：
          這只是文字關鍵字輔助判斷，
          不是完整 NLP 財經模型。
        */
        methodology:
          "keyword-assist",

        errors,

        news

      });

  } catch (error) {

    console.error(
      "news api error:",
      error
    );

    return res
      .status(500)
      .json({

        ok: false,

        source: "FinMind",

        engine:
          "News Analysis 1.0",

        error:
          error?.message ||
          "新聞資料取得失敗",

        available: false,

        overall:
          "資料不足",

        overallScore: 0,

        news: []

      });

  }

};


/* =========================================================
   FinMind News
========================================================= */

async function getNews(
  symbol,
  date,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockNews" +
    "&data_id=" +
    encodeURIComponent(symbol) +
    "&start_date=" +
    encodeURIComponent(date);

  const json =
    await requestJSON(
      url,
      token
    );

  checkFinMind(
    json,
    "股票新聞"
  );

  const data =
    Array.isArray(json.data)
      ? json.data
      : [];

  return data
    .filter(
      row =>
        String(
          row.stock_id || ""
        ) === symbol
    )
    .map(
      row => ({

        date:
          String(
            row.date || ""
          ),

        stock_id:
          String(
            row.stock_id || symbol
          ),

        title:
          cleanText(
            row.title
          ),

        description:
          cleanDescription(
            row.description
          ),

        source:
          cleanText(
            row.source
          ),

        link:
          cleanLink(
            row.link
          )

      })
    )
    .filter(
      row =>
        row.title ||
        row.description
    );

}


/* =========================================================
   新聞文字情緒分析
========================================================= */

function analyzeSentiment(
  title,
  description
) {

  const text =
    (
      String(title || "") +
      " " +
      String(description || "")
    )
      .toLowerCase();

  /*
    偏多關鍵字。

    權重刻意不做太極端，
    避免一個字就讓新聞直接 +10。
  */
  const positiveWords = [

    ["營收創高", 3],
    ["歷史新高", 3],
    ["獲利創高", 3],
    ["訂單大增", 3],
    ["上修", 2],
    ["調升", 2],
    ["優於預期", 3],
    ["超乎預期", 3],
    ["轉虧為盈", 3],
    ["由虧轉盈", 3],
    ["獲利成長", 2],
    ["營收成長", 2],
    ["年增", 1],
    ["月增", 1],
    ["擴產", 1],
    ["接單", 1],
    ["訂單", 1],
    ["得標", 2],
    ["合作", 1],
    ["策略合作", 2],
    ["新產品", 1],
    ["漲價", 1],
    ["需求強勁", 2],
    ["需求回升", 2],
    ["展望樂觀", 2],
    ["展望正向", 2],
    ["看旺", 2],
    ["買超", 1],
    ["加碼", 1],
    ["增持", 1],
    ["庫藏股", 1],
    ["配息增加", 2],
    ["高股息", 1],
    ["創新高", 2],
    ["突破", 1],
    ["強勢", 1],
    ["成長動能", 2],
    ["受惠", 1],
    ["旺季", 1],
    ["復甦", 1],
    ["回溫", 1]

  ];

  /*
    偏空關鍵字。
  */
  const negativeWords = [

    ["營收衰退", -2],
    ["獲利衰退", -2],
    ["由盈轉虧", -3],
    ["轉盈為虧", -3],
    ["虧損擴大", -3],
    ["低於預期", -3],
    ["不如預期", -3],
    ["下修", -2],
    ["調降", -2],
    ["減產", -2],
    ["砍單", -3],
    ["訂單下滑", -2],
    ["需求疲弱", -2],
    ["需求下滑", -2],
    ["展望保守", -2],
    ["展望悲觀", -3],
    ["衰退", -1],
    ["年減", -1],
    ["月減", -1],
    ["賣超", -1],
    ["減持", -1],
    ["處分持股", -1],
    ["裁員", -2],
    ["停工", -3],
    ["停產", -3],
    ["違約", -3],
    ["跳票", -3],
    ["重訊", -1],
    ["遭罰", -2],
    ["罰款", -2],
    ["起訴", -3],
    ["搜索", -3],
    ["調查", -2],
    ["召回", -2],
    ["事故", -2],
    ["火災", -2],
    ["跌停", -2],
    ["重挫", -2],
    ["破底", -2],
    ["違約交割", -3],
    ["下市", -4],
    ["終止上市", -4],
    ["終止上櫃", -4]

  ];

  let score = 0;

  const positiveHits = [];
  const negativeHits = [];

  for (
    const [
      word,
      weight
    ]
    of positiveWords
  ) {

    if (
      text.includes(
        word.toLowerCase()
      )
    ) {

      score += weight;

      positiveHits.push(
        word
      );

    }

  }

  for (
    const [
      word,
      weight
    ]
    of negativeWords
  ) {

    if (
      text.includes(
        word.toLowerCase()
      )
    ) {

      score += weight;

      negativeHits.push(
        word
      );

    }

  }

  /*
    單篇新聞限制在 -10 ~ +10。
  */
  score =
    clamp(
      score,
      -10,
      10
    );

  let label =
    "中性";

  if (score >= 2) {
    label = "偏多";
  }

  else if (score <= -2) {
    label = "偏空";
  }

  return {

    label,

    score,

    positiveHits,

    negativeHits

  };

}


/* =========================================================
   清理 description
========================================================= */

function cleanDescription(
  value
) {

  let text =
    String(
      value || ""
    );

  /*
    FinMind description 有時可能帶 HTML。
  */
  text =
    text.replace(
      /<[^>]*>/g,
      " "
    );

  text =
    decodeBasicEntities(
      text
    );

  text =
    text.replace(
      /\s+/g,
      " "
    )
    .trim();

  /*
    避免 API 回傳太大。
  */
  if (
    text.length >
    500
  ) {

    text =
      text.slice(
        0,
        500
      ) +
      "…";

  }

  return text;

}


/* =========================================================
   清理一般文字
========================================================= */

function cleanText(
  value
) {

  return decodeBasicEntities(
    String(
      value || ""
    )
      .replace(
        /<[^>]*>/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim()
  );

}


/* =========================================================
   清理 URL
========================================================= */

function cleanLink(
  value
) {

  const link =
    String(
      value || ""
    )
      .trim();

  if (
    /^https?:\/\//i
      .test(
        link
      )
  ) {

    return link;

  }

  return "";

}


/* =========================================================
   HTML entity
========================================================= */

function decodeBasicEntities(
  value
) {

  return String(
    value || ""
  )
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /&quot;/g,
      "\""
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&lt;/g,
      "<"
    )
    .replace(
      /&gt;/g,
      ">"
    )
    .replace(
      /&nbsp;/g,
      " "
    );

}


/* =========================================================
   台北日期
========================================================= */

function taipeiDateOffset(
  offsetDays
) {

  /*
    先取得台北日期 YYYY-MM-DD。
  */
  const taipei =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Asia/Taipei",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit"
      }
    )
      .format(
        new Date()
      );

  const [
    year,
    month,
    day
  ] =
    taipei
      .split("-")
      .map(Number);

  /*
    用 UTC 做純日期加減，
    避免 Server timezone 影響。
  */
  const d =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day + offsetDays
      )
    );

  return (
    d.getUTCFullYear() +
    "-" +
    String(
      d.getUTCMonth() + 1
    ).padStart(
      2,
      "0"
    ) +
    "-" +
    String(
      d.getUTCDate()
    ).padStart(
      2,
      "0"
    )
  );

}


/* =========================================================
   FinMind 錯誤
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
                "stock-analyzer-news/1.0",

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
                  5 *
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

                if (settled) {
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

          if (settled) {
            return;
          }

          settled =
            true;

          request.destroy();

          reject(
            new Error(
              "FinMind 新聞連線逾時"
            )
          );

        }
      );

      request.on(
        "error",
        error => {

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
   Helpers
========================================================= */

function clamp(
  value,
  min,
  max
) {

  return Math.min(
    max,
    Math.max(
      min,
      value
    )
  );

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
