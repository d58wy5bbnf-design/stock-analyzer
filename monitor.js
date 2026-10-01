/* =========================================================
   api/monitor.js
   Stock Analysis Monitor 7.0

   流程：
   Radar 6.1
   全市場 Snapshot 約 1300+
   → Top 120 日 K 深掃
   → Radar 候選
   → Monitor 取高分候選 + 使用者自選
   → 五大類完整分析
   → Entry / SL / TP / RR
   → 符合條件才 Push

   正式 Push 條件：
   1. 綜合評分 >= 75
   2. 資料完整度 >= 60%
   3. 技術面 >= 12 / 20
   4. 量價 >= 10 / 20
   5. 已進入合理進場區
   6. 有有效 SL / TP1
   7. TP1 RR >= 1.3

   支援：
   - Radar 全市場候選
   - 使用者自選股
   - iPhone / iPad 多裝置
   - Redis
   - Vercel Cron
   - 08:55～13:40
   - 6 小時同 Setup 防重複
   - Push 失效裝置自動清除
   - ?test=1 測試
========================================================= */

const webpush = require("web-push");


/* =========================================================
   ENV
========================================================= */

const REDIS_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL;

const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN;

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY;

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY;

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  "mailto:liaozhanxjie@gmail.com";


/* =========================================================
   正式條件
========================================================= */

const MIN_SCORE = 75;

const MIN_COMPLETENESS = 60;

const MIN_TECHNICAL = 12;

const MIN_VOLUME = 10;

const MIN_RR = 1.3;


/*
  Radar 最多拿多少檔進 Monitor 完整分析。

  Radar 本身已經：
  1314 → 120 → Top 40

  Monitor 不需要 40 檔全部重算。
  先取前 20 檔，再加所有使用者自選。
*/

const RADAR_MONITOR_LIMIT = 20;


/*
  Radar 快速分數最低門檻。

  注意：
  這只是「進入完整分析」門檻，
  絕對不是 Push 門檻。
*/

const RADAR_PREFILTER_SCORE = 70;


/*
  Stock API 同時處理數量
*/

const STOCK_BATCH_SIZE = 3;


/*
  新聞同時處理數量
*/

const NEWS_BATCH_SIZE = 3;


/*
  同 Setup 6 小時防重複
*/

const DEDUPE_SECONDS = 21600;


/* =========================================================
   Redis
========================================================= */

async function redis(command) {

  if (
    !REDIS_URL ||
    !REDIS_TOKEN
  ) {

    throw new Error(
      "Redis 環境變數尚未設定"
    );
  }


  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      8000
    );


  try {

    const response =
      await fetch(
        REDIS_URL,
        {
          method: "POST",

          headers: {

            Authorization:
              `Bearer ${REDIS_TOKEN}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(
              command
            ),

          signal:
            controller.signal
        }
      );


    const data =
      await response.json();


    if (
      !response.ok ||
      data?.error
    ) {

      throw new Error(
        data?.error ||
        "Redis request failed"
      );
    }


    return data.result;

  } finally {

    clearTimeout(timer);
  }
}


async function deleteDevice(
  deviceId
) {

  try {

    await redis([
      "DEL",
      `swing:push:device:${deviceId}`
    ]);


    await redis([
      "SREM",
      "swing:push:devices",
      deviceId
    ]);


    return true;

  } catch (error) {

    console.error(
      "delete device error:",
      deviceId,
      error
    );


    return false;
  }
}


/* =========================================================
   基本工具
========================================================= */

function num(v) {

  const n =
    Number(v);


  return Number.isFinite(n)
    ? n
    : null;
}


function avg(a) {

  const values =
    (
      Array.isArray(a)
        ? a
        : []
    )
      .map(Number)
      .filter(
        Number.isFinite
      );


  if (!values.length) {

    return 0;
  }


  return (
    values.reduce(
      (x, y) =>
        x + y,
      0
    ) /
    values.length
  );
}


function sma(
  a,
  n
) {

  if (
    !Array.isArray(a) ||
    a.length < n
  ) {

    return null;
  }


  return avg(
    a.slice(-n)
  );
}


function emaSeries(
  values,
  period
) {

  if (
    !Array.isArray(values) ||
    !values.length
  ) {

    return [];
  }


  const k =
    2 /
    (period + 1);


  const result = [];


  let e =
    Number(
      values[0]
    );


  result.push(e);


  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    e =
      Number(
        values[i]
      ) *
      k +
      e *
      (1 - k);


    result.push(e);
  }


  return result;
}


function rsi(
  values,
  n = 14
) {

  if (
    !Array.isArray(values) ||
    values.length <= n
  ) {

    return 50;
  }


  let gain = 0;

  let loss = 0;


  for (
    let i =
      values.length - n;
    i < values.length;
    i++
  ) {

    const d =
      Number(
        values[i]
      ) -
      Number(
        values[i - 1]
      );


    if (d > 0) {

      gain += d;

    } else {

      loss +=
        Math.abs(d);
    }
  }


  if (loss === 0) {

    return 100;
  }


  const rs =
    (gain / n) /
    (loss / n);


  return (
    100 -
    100 /
    (1 + rs)
  );
}


function atr(
  rows,
  n = 14
) {

  if (
    !Array.isArray(rows) ||
    rows.length < 2
  ) {

    return 0;
  }


  const values = [];


  for (
    let i =
      Math.max(
        1,
        rows.length - n
      );
    i < rows.length;
    i++
  ) {

    const x =
      rows[i];


    const previous =
      rows[
        i - 1
      ].close;


    values.push(
      Math.max(

        x.high -
        x.low,

        Math.abs(
          x.high -
          previous
        ),

        Math.abs(
          x.low -
          previous
        )
      )
    );
  }


  return avg(values);
}


function unique(list) {

  return [
    ...new Set(
      (
        Array.isArray(list)
          ? list
          : []
      )
        .map(
          x =>
            String(x)
              .trim()
        )
        .filter(Boolean)
    )
  ];
}


function round(
  v,
  digits = 2
) {

  const n =
    Number(v);


  if (
    !Number.isFinite(n)
  ) {

    return null;
  }


  const p =
    10 ** digits;


  return (
    Math.round(
      (
        n +
        Number.EPSILON
      ) *
      p
    ) /
    p
  );
}


function clamp(
  v,
  min,
  max
) {

  return Math.min(
    max,
    Math.max(
      min,
      v
    )
  );
}


function formatPrice(v) {

  const n =
    Number(v);


  if (
    !Number.isFinite(n)
  ) {

    return "--";
  }


  if (n >= 1000) {

    return n.toFixed(0);
  }


  if (n >= 100) {

    return n.toFixed(1);
  }


  return n.toFixed(2);
}


/* =========================================================
   Test Mode
========================================================= */

function getTestMode(req) {

  try {

    const host =
      req.headers?.host ||
      "localhost";


    const protocol =
      req.headers?.[
        "x-forwarded-proto"
      ] ||
      "https";


    const url =
      new URL(
        req.url || "/",
        `${protocol}://${host}`
      );


    if (
      url.searchParams.get(
        "test"
      ) === "1"
    ) {

      return true;
    }

  } catch (_) {}


  const queryTest =
    req.query?.test;


  return (
    queryTest === "1" ||
    (
      Array.isArray(
        queryTest
      ) &&
      queryTest.includes(
        "1"
      )
    )
  );
}


/* =========================================================
   台北時間
========================================================= */

function taipeiParts() {

  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {

        timeZone:
          "Asia/Taipei",

        weekday:
          "short",

        hour:
          "2-digit",

        minute:
          "2-digit",

        hour12:
          false
      }
    )
      .formatToParts(
        new Date()
      );


  const get =
    type =>
      parts.find(
        p =>
          p.type === type
      )?.value;


  return {

    weekday:
      get("weekday"),

    hour:
      Number(
        get("hour")
      ),

    minute:
      Number(
        get("minute")
      )
  };
}


function isMarketTime() {

  const t =
    taipeiParts();


  if (
    ![
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri"
    ].includes(
      t.weekday
    )
  ) {

    return false;
  }


  const minutes =
    t.hour *
    60 +
    t.minute;


  return (
    minutes >=
      8 * 60 + 55 &&
    minutes <=
      13 * 60 + 40
  );
}


/* =========================================================
   MACD
========================================================= */

function getMACD(closes) {

  if (
    closes.length < 35
  ) {

    return {

      macd: 0,

      signal: 0,

      histogram: 0
    };
  }


  const fast =
    emaSeries(
      closes,
      12
    );


  const slow =
    emaSeries(
      closes,
      26
    );


  const macdSeries =
    closes.map(
      (_, i) =>
        (fast[i] || 0) -
        (slow[i] || 0)
    );


  const signalSeries =
    emaSeries(
      macdSeries,
      9
    );


  const macd =
    macdSeries[
      macdSeries.length - 1
    ] || 0;


  const signal =
    signalSeries[
      signalSeries.length - 1
    ] || 0;


  return {

    macd,

    signal,

    histogram:
      macd - signal
  };
}


/* =========================================================
   Swing
========================================================= */

function getSwings(
  rows,
  left = 2,
  right = 2
) {

  const highs = [];

  const lows = [];


  for (
    let i = left;
    i <
      rows.length -
      right;
    i++
  ) {

    let isHigh = true;

    let isLow = true;


    for (
      let j = 1;
      j <= left;
      j++
    ) {

      if (
        rows[i].high <=
        rows[
          i - j
        ].high
      ) {

        isHigh = false;
      }


      if (
        rows[i].low >=
        rows[
          i - j
        ].low
      ) {

        isLow = false;
      }
    }


    for (
      let j = 1;
      j <= right;
      j++
    ) {

      if (
        rows[i].high <=
        rows[
          i + j
        ].high
      ) {

        isHigh = false;
      }


      if (
        rows[i].low >=
        rows[
          i + j
        ].low
      ) {

        isLow = false;
      }
    }


    if (isHigh) {

      highs.push({

        index: i,

        price:
          rows[i].high,

        date:
          rows[i].date
      });
    }


    if (isLow) {

      lows.push({

        index: i,

        price:
          rows[i].low,

        date:
          rows[i].date
      });
    }
  }


  return {
    highs,
    lows
  };
}


/* =========================================================
   Entry / SL / TP
========================================================= */

function buildTradePlan(
  rows,
  price,
  A
) {

  const recent =
    rows.slice(-180);


  const closes =
    recent.map(
      x =>
        x.close
    );


  const m20 =
    sma(
      closes,
      20
    );


  const m60 =
    sma(
      closes,
      60
    );


  const swings =
    getSwings(
      recent,
      2,
      2
    );


  const supports = [];


  if (
    Number.isFinite(m20) &&
    m20 <=
      price * 1.005
  ) {

    supports.push({

      price: m20,

      type:
        "MA20 支撐",

      weight: 4
    });
  }


  if (
    Number.isFinite(m60) &&
    m60 <=
      price * 1.005
  ) {

    supports.push({

      price: m60,

      type:
        "MA60 支撐",

      weight: 3
    });
  }


  for (
    const s of
    swings.lows
  ) {

    if (
      s.price <=
        price * 1.005 &&
      s.price >=
        price * 0.88
    ) {

      supports.push({

        price:
          s.price,

        type:
          "波段低點支撐",

        weight: 5,

        date:
          s.date
      });
    }
  }


  /*
    前高突破後回測，
    可轉成支撐。
  */

  for (
    const h of
    swings.highs
  ) {

    if (
      h.price < price &&
      h.price >=
        price * 0.90
    ) {

      const broken =
        recent
          .slice(
            h.index + 1
          )
          .some(
            x =>
              x.close >
              h.price *
              1.005
          );


      if (broken) {

        supports.push({

          price:
            h.price,

          type:
            "前高突破回測",

          weight: 6,

          date:
            h.date
        });
      }
    }
  }


  const rankedSupports =
    supports

      .filter(
        x =>
          Number.isFinite(
            x.price
          ) &&
          x.price > 0
      )

      .map(
        x => ({

          ...x,

          distance:
            (
              price -
              x.price
            ) /
            price
        })
      )

      .filter(
        x =>
          x.distance >=
            -0.005 &&
          x.distance <=
            0.10
      )

      .sort(
        (a, b) => {

          const sa =
            a.weight -
            a.distance *
            25;


          const sb =
            b.weight -
            b.distance *
            25;


          return (
            sb - sa
          );
        }
      );


  const support1 =
    rankedSupports[0] ||
    null;


  let support2 =
    null;


  if (support1) {

    support2 =
      rankedSupports

        .filter(
          x =>
            x !==
              support1 &&
            x.price <
              support1.price -
              Math.max(
                A * 0.4,
                price *
                0.004
              )
        )

        .sort(
          (a, b) =>
            b.price -
            a.price
        )[0] ||
      null;
  }


  let entryLow = null;

  let entryHigh = null;

  let entryMid = null;

  let sl = null;


  if (support1) {

    const width =
      Math.max(
        A * 0.30,
        support1.price *
        0.003
      );


    entryLow =
      support1.price -
      width;


    entryHigh =
      support1.price +
      width;


    entryMid =
      (
        entryLow +
        entryHigh
      ) /
      2;


    const lowerSwing =
      swings.lows

        .filter(
          x =>
            x.price <
            support1.price
        )

        .sort(
          (a, b) =>
            b.price -
            a.price
        )[0] ||
      null;


    const invalidation =
      lowerSwing &&
      lowerSwing.price >=
        support1.price *
        0.94

        ? lowerSwing.price

        : support1.price;


    const buffer =
      Math.max(
        A * 0.35,
        price *
        0.004
      );


    sl =
      invalidation -
      buffer;


    if (
      sl >=
      entryLow
    ) {

      sl =
        entryLow -
        buffer;
    }
  }


  /* =======================================================
     上方歷史壓力
  ======================================================= */

  const resistances = [];


  for (
    const h of
    swings.highs
  ) {

    if (
      h.price >
      price * 1.003
    ) {

      resistances.push({

        price:
          h.price,

        type:
          "歷史波段高點",

        date:
          h.date
      });
    }
  }


  for (
    const length of
    [20, 60, 120]
  ) {

    const part =
      recent.slice(
        -length
      );


    if (!part.length) {

      continue;
    }


    const high =
      Math.max(
        ...part.map(
          x =>
            x.high
        )
      );


    if (
      high >
      price * 1.003
    ) {

      resistances.push({

        price:
          high,

        type:
          `${length} 日高點`
      });
    }
  }


  resistances.sort(
    (a, b) =>
      a.price -
      b.price
  );


  /*
    合併非常接近的壓力，
    但仍保持由近到遠。
  */

  const merged = [];


  for (
    const x of
    resistances
  ) {

    const last =
      merged[
        merged.length - 1
      ];


    if (
      last &&
      Math.abs(
        x.price -
        last.price
      ) <=
        Math.max(
          A * 0.45,
          price *
          0.005
        )
    ) {

      last.price =
        (
          last.price +
          x.price
        ) /
        2;


      last.type =
        "壓力共振";

    } else {

      merged.push({
        ...x
      });
    }
  }


  /*
    TP1 = 最近上方壓力
    TP2 = 第二壓力
    TP3 = 第三壓力
  */

  let tp1 =
    merged[0]?.price ??
    null;


  let tp2 =
    merged[1]?.price ??
    null;


  let tp3 =
    merged[2]?.price ??
    null;


  let tp1Source =
    merged[0]?.type ||
    "";


  let tp2Source =
    merged[1]?.type ||
    "";


  let tp3Source =
    merged[2]?.type ||
    "";


  /*
    真的沒有歷史壓力，
    才使用 ATR 延伸。
  */

  if (
    Number.isFinite(
      entryMid
    )
  ) {

    if (
      !Number.isFinite(
        tp1
      )
    ) {

      tp1 =
        Math.max(
          price +
            A * 2,

          entryMid +
            A * 2
        );


      tp1Source =
        "ATR 延伸";
    }


    if (
      !Number.isFinite(
        tp2
      )
    ) {

      tp2 =
        Math.max(
          tp1 +
            A * 1.5,

          entryMid +
            A * 3.5
        );


      tp2Source =
        "ATR 波段延伸";
    }


    if (
      !Number.isFinite(
        tp3
      )
    ) {

      tp3 =
        Math.max(
          tp2 +
            A * 1.5,

          entryMid +
            A * 5
        );


      tp3Source =
        "ATR 長波段延伸";
    }
  }


  let risk = null;

  let riskPct = null;

  let rr1 = null;

  let rr2 = null;

  let rr3 = null;


  if (
    Number.isFinite(
      entryMid
    ) &&
    Number.isFinite(
      sl
    ) &&
    entryMid > sl
  ) {

    risk =
      entryMid -
      sl;


    riskPct =
      risk /
      entryMid *
      100;


    if (
      Number.isFinite(
        tp1
      )
    ) {

      rr1 =
        (
          tp1 -
          entryMid
        ) /
        risk;
    }


    if (
      Number.isFinite(
        tp2
      )
    ) {

      rr2 =
        (
          tp2 -
          entryMid
        ) /
        risk;
    }


    if (
      Number.isFinite(
        tp3
      )
    ) {

      rr3 =
        (
          tp3 -
          entryMid
        ) /
        risk;
    }
  }


  let entryReady =
    false;


  if (
    Number.isFinite(
      entryLow
    ) &&
    Number.isFinite(
      entryHigh
    )
  ) {

    const tolerance =
      Math.max(
        A * 0.45,
        price *
        0.008
      );


    entryReady =
      price >=
        entryLow -
        tolerance &&
      price <=
        entryHigh +
        tolerance;
  }


  return {

    support1,

    support2,

    entryLow:
      round(
        entryLow
      ),

    entryHigh:
      round(
        entryHigh
      ),

    entryMid:
      round(
        entryMid
      ),

    sl:
      round(
        sl
      ),

    risk:
      round(
        risk
      ),

    riskPct:
      round(
        riskPct
      ),

    tp1:
      round(
        tp1
      ),

    tp2:
      round(
        tp2
      ),

    tp3:
      round(
        tp3
      ),

    tp1Source,

    tp2Source,

    tp3Source,

    rr1:
      round(
        rr1
      ),

    rr2:
      round(
        rr2
      ),

    rr3:
      round(
        rr3
      ),

    entryReady
  };
}


/* =========================================================
   技術面 0～20
========================================================= */

function scoreTechnical(
  rows,
  price
) {

  const closes =
    rows.map(
      x =>
        x.close
    );


  const ma20 =
    sma(
      closes,
      20
    );


  const ma60 =
    sma(
      closes,
      60
    );


  const ma20Prev =
    rows.length >= 25

      ? avg(
          closes.slice(
            -25,
            -5
          )
        )

      : ma20;


  const R =
    rsi(
      closes,
      14
    );


  const macd =
    getMACD(
      closes
    );


  const previous20 =
    rows.slice(
      -21,
      -1
    );


  const previousHigh20 =
    previous20.length

      ? Math.max(
          ...previous20.map(
            x =>
              x.high
          )
        )

      : null;


  let score = 0;

  const reasons = [];


  if (
    Number.isFinite(
      ma20
    ) &&
    price > ma20
  ) {

    score += 4;

    reasons.push(
      "股價站上 MA20"
    );
  }


  if (
    Number.isFinite(
      ma20
    ) &&
    Number.isFinite(
      ma60
    ) &&
    ma20 > ma60
  ) {

    score += 4;

    reasons.push(
      "MA20 高於 MA60"
    );
  }


  if (
    Number.isFinite(
      ma20
    ) &&
    Number.isFinite(
      ma20Prev
    ) &&
    ma20 > ma20Prev
  ) {

    score += 3;

    reasons.push(
      "MA20 趨勢向上"
    );
  }


  if (
    R >= 50 &&
    R <= 70
  ) {

    score += 3;

    reasons.push(
      "RSI 動能健康"
    );

  } else if (
    R > 45 &&
    R < 75
  ) {

    score += 1;
  }


  if (
    macd.macd >
    macd.signal
  ) {

    score += 3;

    reasons.push(
      "MACD 位於訊號線上方"
    );

  } else if (
    macd.histogram > 0
  ) {

    score += 2;
  }


  if (
    Number.isFinite(
      previousHigh20
    ) &&
    price >=
      previousHigh20 *
      0.985
  ) {

    score += 3;

    reasons.push(
      price >
        previousHigh20

        ? "突破近期高點"

        : "接近近期突破區"
    );
  }


  return {

    available:
      true,

    score:
      clamp(
        Math.round(
          score
        ),
        0,
        20
      ),

    ma20:
      round(
        ma20
      ),

    ma60:
      round(
        ma60
      ),

    rsi:
      round(
        R
      ),

    macd:
      round(
        macd.macd,
        4
      ),

    macdSignal:
      round(
        macd.signal,
        4
      ),

    previousHigh20:
      round(
        previousHigh20
      ),

    reasons
  };
}


/* =========================================================
   量價 0～20
========================================================= */

function scoreVolume(
  rows,
  price
) {

  if (
    rows.length < 22
  ) {

    return {

      available:
        false,

      score:
        null,

      reasons:
        []
    };
  }


  const last =
    rows[
      rows.length - 1
    ];


  const previous =
    rows[
      rows.length - 2
    ];


  const volumeAvg20 =
    avg(
      rows
        .slice(
          -21,
          -1
        )
        .map(
          x =>
            x.volume
        )
    );


  const volumeRatio =
    volumeAvg20 > 0

      ? last.volume /
        volumeAvg20

      : 0;


  const previous20 =
    rows.slice(
      -21,
      -1
    );


  const high20 =
    Math.max(
      ...previous20.map(
        x =>
          x.high
      )
    );


  const recent5Avg =
    avg(
      rows
        .slice(-5)
        .map(
          x =>
            x.volume
        )
    );


  const previous15Avg =
    avg(
      rows
        .slice(
          -20,
          -5
        )
        .map(
          x =>
            x.volume
        )
    );


  let score = 0;

  const reasons = [];


  if (
    volumeRatio >= 1.5
  ) {

    score += 6;

    reasons.push(
      "成交量明顯放大"
    );

  } else if (
    volumeRatio >= 1.15
  ) {

    score += 5;

    reasons.push(
      "成交量高於均量"
    );

  } else if (
    volumeRatio >= 0.8
  ) {

    score += 3;

  } else {

    score += 1;
  }


  if (
    price >
      previous.close &&
    volumeRatio >= 1
  ) {

    score += 5;

    reasons.push(
      "價漲量增"
    );
  }


  if (
    price >
      high20 &&
    volumeRatio >= 1.2
  ) {

    score += 5;

    reasons.push(
      "帶量突破近期高點"
    );

  } else if (
    price >=
      high20 *
      0.985 &&
    volumeRatio >= 1
  ) {

    score += 3;

    reasons.push(
      "接近突破且量能配合"
    );
  }


  if (
    recent5Avg > 0 &&
    previous15Avg > 0 &&
    recent5Avg <
      previous15Avg *
      0.8 &&
    price >=
      rows[
        Math.max(
          0,
          rows.length - 10
        )
      ].close *
      0.98
  ) {

    score += 4;

    reasons.push(
      "整理期間量縮"
    );
  }


  return {

    available:
      true,

    score:
      clamp(
        Math.round(
          score
        ),
        0,
        20
      ),

    volume:
      last.volume,

    volumeAvg20:
      round(
        volumeAvg20,
        0
      ),

    volumeRatio:
      round(
        volumeRatio
      ),

    reasons
  };
}


/* =========================================================
   法人籌碼 0～20
========================================================= */

function scoreInstitutional(
  i = {}
) {

  if (
    i?.available ===
    false
  ) {

    return {

      available:
        false,

      score:
        null,

      reasons:
        []
    };
  }


  const foreign5 =
    num(
      i?.foreign5
    );


  const foreign10 =
    num(
      i?.foreign10
    );


  const trust5 =
    num(
      i?.trust5
    );


  const trust10 =
    num(
      i?.trust10
    );


  const dealer5 =
    num(
      i?.dealer5
    );


  const total5 =
    num(
      i?.total5
    );


  const total10 =
    num(
      i?.total10
    );


  const foreignBuyDays5 =
    num(
      i?.foreignBuyDays5
    );


  const trustBuyDays5 =
    num(
      i?.trustBuyDays5
    );


  const totalBuyDays5 =
    num(
      i?.totalBuyDays5
    );


  const hasData =
    [
      foreign5,
      foreign10,
      trust5,
      trust10,
      dealer5,
      total5,
      total10
    ]
      .some(
        Number.isFinite
      );


  if (!hasData) {

    return {

      available:
        false,

      score:
        null,

      reasons:
        []
    };
  }


  let score = 8;

  const reasons = [];


  if (
    Number(
      foreign5
    ) > 0
  ) {

    score += 3;

    reasons.push(
      "外資近 5 日買超"
    );

  } else if (
    Number(
      foreign5
    ) < 0
  ) {

    score -= 2;
  }


  if (
    Number(
      trust5
    ) > 0
  ) {

    score += 3;

    reasons.push(
      "投信近 5 日買超"
    );

  } else if (
    Number(
      trust5
    ) < 0
  ) {

    score -= 2;
  }


  if (
    Number(
      total5
    ) > 0
  ) {

    score += 2;

    reasons.push(
      "三大法人近 5 日合計買超"
    );

  } else if (
    Number(
      total5
    ) < 0
  ) {

    score -= 2;
  }


  if (
    Number(
      foreign10
    ) > 0
  ) {

    score += 1;
  }


  if (
    Number(
      trust10
    ) > 0
  ) {

    score += 1;
  }


  if (
    Number(
      total10
    ) > 0
  ) {

    score += 1;
  }


  if (
    Number(
      foreignBuyDays5
    ) >= 3
  ) {

    score += 1;

    reasons.push(
      "外資買盤具連續性"
    );
  }


  if (
    Number(
      trustBuyDays5
    ) >= 3
  ) {

    score += 1;

    reasons.push(
      "投信買盤具連續性"
    );
  }


  if (
    Number(
      totalBuyDays5
    ) >= 3
  ) {

    score += 1;
  }


  if (
    Number(
      dealer5
    ) > 0
  ) {

    score += 0.5;
  }


  return {

    available:
      true,

    score:
      clamp(
        Math.round(
          score
        ),
        0,
        20
      ),

    foreign5,

    trust5,

    dealer5,

    total5,

    total10,

    reasons
  };
}


/* =========================================================
   基本面 0～20
========================================================= */

function scoreFundamental(
  data
) {

  const revenue =
    data?.revenue ||
    data?.fundamental?.revenue ||
    {};


  const financial =
    data?.financial ||
    data?.fundamental?.financial ||
    {};


  const revenueAvailable =
    revenue?.available !==
      false &&
    (
      Number.isFinite(
        num(
          revenue?.yoy
        )
      ) ||
      Number.isFinite(
        num(
          revenue?.mom
        )
      )
    );


  const financialAvailable =
    financial?.available !==
      false &&
    (
      Number.isFinite(
        num(
          financial?.eps
        )
      ) ||
      Number.isFinite(
        num(
          financial?.incomeAfterTaxes
        )
      ) ||
      typeof (
        financial?.profitable
      ) ===
        "boolean"
    );


  if (
    !revenueAvailable &&
    !financialAvailable
  ) {

    return {

      available:
        false,

      score:
        null,

      reasons:
        []
    };
  }


  let score = 0;

  let possible = 0;

  const reasons = [];


  if (
    revenueAvailable
  ) {

    possible += 8;


    const yoy =
      num(
        revenue?.yoy
      );


    const mom =
      num(
        revenue?.mom
      );


    if (
      Number.isFinite(
        yoy
      )
    ) {

      if (
        yoy >= 20
      ) {

        score += 5;

        reasons.push(
          "營收年增超過 20%"
        );

      } else if (
        yoy > 0
      ) {

        score += 4;

        reasons.push(
          "營收維持年增"
        );

      } else if (
        yoy > -5
      ) {

        score += 2;
      }
    }


    if (
      Number.isFinite(
        mom
      )
    ) {

      if (
        mom > 0
      ) {

        score += 3;

        reasons.push(
          "營收月增"
        );

      } else if (
        mom > -5
      ) {

        score += 1;
      }
    }
  }


  if (
    financialAvailable
  ) {

    possible += 12;


    const eps =
      num(
        financial?.eps
      );


    const epsGrowth =
      num(
        financial?.epsGrowth
      );


    const netIncomeGrowth =
      num(
        financial?.netIncomeGrowth
      );


    if (
      financial?.profitable ===
        true ||
      (
        Number.isFinite(
          eps
        ) &&
        eps > 0
      )
    ) {

      score += 4;

      reasons.push(
        "公司維持獲利"
      );
    }


    if (
      Number.isFinite(
        eps
      )
    ) {

      if (
        eps > 0
      ) {

        score += 2;
      }


      if (
        eps >= 2
      ) {

        score += 1;
      }
    }


    if (
      Number.isFinite(
        epsGrowth
      )
    ) {

      if (
        epsGrowth > 20
      ) {

        score += 3;

        reasons.push(
          "EPS 成長明顯"
        );

      } else if (
        epsGrowth > 0
      ) {

        score += 2;

        reasons.push(
          "EPS 成長"
        );
      }
    }


    if (
      Number.isFinite(
        netIncomeGrowth
      ) &&
      netIncomeGrowth > 0
    ) {

      score += 2;

      reasons.push(
        "稅後獲利成長"
      );
    }
  }


  return {

    available:
      possible > 0,

    score:
      possible > 0

        ? clamp(
            Math.round(
              (
                score /
                possible
              ) *
              20
            ),
            0,
            20
          )

        : null,

    reasons
  };
}


/* =========================================================
   新聞 0～20
========================================================= */

function scoreNews(
  news
) {

  if (
    !news ||
    news?.available ===
      false ||
    !Array.isArray(
      news?.news
    ) ||
    !news.news.length
  ) {

    return {

      available:
        false,

      score:
        null,

      overall:
        "資料不足",

      reasons:
        []
    };
  }


  const overall =
    clamp(
      Number(
        news?.overallScore ||
        0
      ),
      -10,
      10
    );


  return {

    available:
      true,

    score:
      clamp(
        Math.round(
          10 +
          overall
        ),
        0,
        20
      ),

    overall:
      news?.overall ||
      "中性",

    reasons: [

      overall >= 2

        ? "近期新聞偏正向"

        : overall <= -2

        ? "近期新聞偏負向"

        : "近期新聞影響中性"
    ]
  };
}


/* =========================================================
   五大類綜合分數
========================================================= */

function combineScores(
  sections
) {

  const available =
    sections.filter(
      x =>
        x?.available &&
        Number.isFinite(
          Number(
            x.score
          )
        )
    );


  if (
    !available.length
  ) {

    return {

      score: 0,

      completeness: 0
    };
  }


  const earned =
    available.reduce(
      (sum, x) =>
        sum +
        Number(
          x.score
        ),
      0
    );


  return {

    score:
      Math.round(
        (
          earned /
          (
            available.length *
            20
          )
        ) *
        100
      ),

    completeness:
      Math.round(
        (
          available.length /
          5
        ) *
        100
      )
  };
}


/* =========================================================
   完整分析
========================================================= */

function analyzeData(
  d,
  newsData = null
) {

  if (
    !Array.isArray(
      d?.rows
    ) ||
    d.rows.length < 60
  ) {

    return null;
  }


  const rows =
    d.rows

      .map(
        x => ({

          date:
            String(
              x.date ||
              ""
            ),

          open:
            Number(
              x.open
            ),

          high:
            Number(
              x.high
            ),

          low:
            Number(
              x.low
            ),

          close:
            Number(
              x.close
            ),

          volume:
            Number(
              x.volume ||
              0
            )
        })
      )

      .filter(
        x =>
          Number.isFinite(
            x.open
          ) &&
          Number.isFinite(
            x.high
          ) &&
          Number.isFinite(
            x.low
          ) &&
          Number.isFinite(
            x.close
          ) &&
          x.close > 0
      );


  if (
    rows.length < 60
  ) {

    return null;
  }


  let price =
    Number(
      d?.price
    );


  if (
    !Number.isFinite(
      price
    ) ||
    price <= 0
  ) {

    price =
      rows[
        rows.length - 1
      ].close;
  }


  const A =
    Math.max(
      atr(
        rows,
        14
      ),
      price *
      0.006
    );


  const technical =
    scoreTechnical(
      rows,
      price
    );


  const volume =
    scoreVolume(
      rows,
      price
    );


  const institutional =
    scoreInstitutional(
      d?.institutional
    );


  const fundamental =
    scoreFundamental(
      d
    );


  const news =
    scoreNews(
      newsData
    );


  const combined =
    combineScores([
      technical,
      volume,
      institutional,
      fundamental,
      news
    ]);


  const plan =
    buildTradePlan(
      rows,
      price,
      A
    );


  let classification =
    "偏弱／觀望";


  if (
    combined.score >= 80
  ) {

    classification =
      "偏多波段";

  } else if (
    combined.score >= 70
  ) {

    classification =
      "偏多觀察";

  } else if (
    combined.score >= 60
  ) {

    classification =
      "中性偏多";

  } else if (
    combined.score >= 45
  ) {

    classification =
      "中性";
  }


  return {

    symbol:
      String(
        d?.symbol ||
        ""
      ),

    name:
      d?.name ||
      d?.symbol ||
      "",

    price,

    score:
      combined.score,

    completeness:
      combined.completeness,

    classification,

    technical,

    volume,

    institutional,

    fundamental,

    news,

    ...plan
  };
}


/* =========================================================
   Push 條件
========================================================= */

function makeSignal(a) {

  if (!a) {

    return {

      signal: null,

      reason:
        "分析資料不足"
    };
  }


  if (
    a.score <
    MIN_SCORE
  ) {

    return {

      signal: null,

      reason:
        `綜合評分不足 ${a.score}/${MIN_SCORE}`
    };
  }


  if (
    a.completeness <
    MIN_COMPLETENESS
  ) {

    return {

      signal: null,

      reason:
        `資料完整度不足 ${a.completeness}%`
    };
  }


  if (
    !a.technical?.available ||
    a.technical.score <
      MIN_TECHNICAL
  ) {

    return {

      signal: null,

      reason:
        `技術面不足 ${a.technical?.score ?? "--"}/20`
    };
  }


  if (
    !a.volume?.available ||
    a.volume.score <
      MIN_VOLUME
  ) {

    return {

      signal: null,

      reason:
        `量價不足 ${a.volume?.score ?? "--"}/20`
    };
  }


  if (
    !a.entryReady
  ) {

    return {

      signal: null,

      reason:
        "尚未進入合理進場區"
    };
  }


  if (
    !Number.isFinite(
      Number(
        a.entryLow
      )
    ) ||
    !Number.isFinite(
      Number(
        a.entryHigh
      )
    ) ||
    !Number.isFinite(
      Number(
        a.sl
      )
    )
  ) {

    return {

      signal: null,

      reason:
        "交易計畫資料不足"
    };
  }


  if (
    Number(
      a.sl
    ) >=
    Number(
      a.entryLow
    )
  ) {

    return {

      signal: null,

      reason:
        "停損位置無效"
    };
  }


  if (
    !Number.isFinite(
      Number(
        a.tp1
      )
    ) ||
    Number(
      a.tp1
    ) <=
      Number(
        a.entryHigh
      )
  ) {

    return {

      signal: null,

      reason:
        "上方沒有足夠目標空間"
    };
  }


  if (
    !Number.isFinite(
      Number(
        a.rr1
      )
    ) ||
    Number(
      a.rr1
    ) <
      MIN_RR
  ) {

    return {

      signal: null,

      reason:
        `TP1 風報比不足 ${a.rr1 ?? "--"}R`
    };
  }


  const fingerprint =
    [

      a.symbol,

      Number(
        a.entryLow
      ).toFixed(2),

      Number(
        a.entryHigh
      ).toFixed(2),

      Number(
        a.sl
      ).toFixed(2),

      Math.floor(
        a.score /
        5
      ) *
      5

    ].join(":");


  return {

    signal: {

      ...a,

      fingerprint
    },

    reason:
      "符合正式進場通知條件"
  };
}


/* =========================================================
   Stock API
========================================================= */

async function fetchStock(
  origin,
  symbol
) {

  try {

    const response =
      await fetch(
        `${origin}/api/stock?symbol=${encodeURIComponent(symbol)}&t=${Date.now()}`,
        {

          cache:
            "no-store",

          headers: {

            "Cache-Control":
              "no-cache"
          }
        }
      );


    if (
      !response.ok
    ) {

      console.error(
        "stock api status:",
        symbol,
        response.status
      );


      return null;
    }


    const data =
      await response.json();


    if (
      !data?.ok
    ) {

      console.error(
        "stock api error:",
        symbol,
        data?.error
      );


      return null;
    }


    return data;

  } catch (error) {

    console.error(
      "fetch stock error:",
      symbol,
      error
    );


    return null;
  }
}


/* =========================================================
   News API
========================================================= */

async function fetchNews(
  origin,
  symbol
) {

  try {

    const response =
      await fetch(
        `${origin}/api/news?symbol=${encodeURIComponent(symbol)}&t=${Date.now()}`,
        {

          cache:
            "no-store",

          headers: {

            "Cache-Control":
              "no-cache"
          }
        }
      );


    if (
      !response.ok
    ) {

      return null;
    }


    const data =
      await response.json();


    return data?.ok
      ? data
      : null;

  } catch (error) {

    console.error(
      "fetch news error:",
      symbol,
      error
    );


    return null;
  }
}


/* =========================================================
   Radar API
========================================================= */

async function fetchRadar(
  origin
) {

  try {

    const response =
      await fetch(
        `${origin}/api/radar?t=${Date.now()}`,
        {

          cache:
            "no-store",

          headers: {

            "Cache-Control":
              "no-cache"
          }
        }
      );


    if (
      !response.ok
    ) {

      console.error(
        "radar api status:",
        response.status
      );


      return null;
    }


    const data =
      await response.json();


    if (
      !data?.ok
    ) {

      console.error(
        "radar api error:",
        data?.error
      );


      return null;
    }


    return data;

  } catch (error) {

    console.error(
      "fetch radar error:",
      error
    );


    return null;
  }
}


/* =========================================================
   是否值得再抓新聞
========================================================= */

function shouldFetchNews(a) {

  return !!(
    a &&

    a.completeness >= 60 &&

    a.score >= 65 &&

    (
      a.technical?.score ??
      0
    ) >= 10 &&

    (
      a.volume?.score ??
      0
    ) >= 8
  );
}


/* =========================================================
   Push Notification
========================================================= */

function buildNotification(
  signal
) {

  const entry =
    `${formatPrice(signal.entryLow)}～${formatPrice(signal.entryHigh)}`;


  const targets = [];


  if (
    Number.isFinite(
      Number(
        signal.tp1
      )
    )
  ) {

    targets.push(
      `TP1 ${formatPrice(signal.tp1)}`
    );
  }


  if (
    Number.isFinite(
      Number(
        signal.tp2
      )
    )
  ) {

    targets.push(
      `TP2 ${formatPrice(signal.tp2)}`
    );
  }


  if (
    Number.isFinite(
      Number(
        signal.tp3
      )
    )
  ) {

    targets.push(
      `TP3 ${formatPrice(signal.tp3)}`
    );
  }


  return {

    title:
      `📈 ${signal.name} ${signal.symbol}｜綜合 ${signal.score} 分`,

    body:
      [

        `現價 ${formatPrice(signal.price)}`,

        `進場 ${entry}`,

        `SL ${formatPrice(signal.sl)}`,

        targets.join("｜"),

        `RR ${Number(signal.rr1).toFixed(2)}R`,

        `完整度 ${signal.completeness}%`,

        `技術 ${signal.technical?.score ?? "--"}｜量價 ${signal.volume?.score ?? "--"}｜法人 ${signal.institutional?.score ?? "--"}｜基本 ${signal.fundamental?.score ?? "--"}｜新聞 ${signal.news?.score ?? "--"}`

      ]
        .filter(Boolean)
        .join("\n"),

    tag:
      `entry-${signal.symbol}`,

    url:
      `/?symbol=${encodeURIComponent(signal.symbol)}`
  };
}


async function sendPush(
  device,
  signal
) {

  const subscription =
    device.subscription ||
    device.pushSubscription;


  if (
    !subscription?.endpoint
  ) {

    throw new Error(
      "Push Subscription 格式錯誤"
    );
  }


  return webpush
    .sendNotification(
      subscription,

      JSON.stringify(
        buildNotification(
          signal
        )
      ),

      {
        TTL: 120
      }
    );
}


/* =========================================================
   Handler
========================================================= */

module.exports =
async function handler(
  req,
  res
) {

  const startedAt =
    Date.now();


  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );


  const testMode =
    getTestMode(req);


  /* =======================================================
     正式模式 CRON_SECRET
  ======================================================= */

  if (
    !testMode &&
    process.env.CRON_SECRET
  ) {

    const expected =
      `Bearer ${process.env.CRON_SECRET}`;


    if (
      req.headers.authorization !==
      expected
    ) {

      return res
        .status(401)
        .json({

          ok: false,

          engine:
            "Stock Analysis Monitor 7.0",

          testMode,

          error:
            "Unauthorized"
        });
    }
  }


  try {

    /* =====================================================
       VAPID
    ===================================================== */

    if (
      !VAPID_PUBLIC_KEY ||
      !VAPID_PRIVATE_KEY ||
      !VAPID_SUBJECT
    ) {

      throw new Error(
        "VAPID 環境變數尚未設定"
      );
    }


    webpush.setVapidDetails(
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );


    /* =====================================================
       正式市場時間
    ===================================================== */

    if (
      !testMode &&
      !isMarketTime()
    ) {

      return res
        .status(200)
        .json({

          ok: true,

          engine:
            "Stock Analysis Monitor 7.0",

          skipped:
            true,

          testMode:
            false,

          marketTime:
            false,

          reason:
            "非台股監控時段"
        });
    }


    /* =====================================================
       Push 裝置
    ===================================================== */

    const deviceIds =
      await redis([
        "SMEMBERS",
        "swing:push:devices"
      ]) || [];


    const devices = [];


    for (
      const deviceId of
      deviceIds
    ) {

      const raw =
        await redis([
          "GET",
          `swing:push:device:${deviceId}`
        ]);


      if (!raw) {

        await redis([
          "SREM",
          "swing:push:devices",
          deviceId
        ]);


        continue;
      }


      try {

        const device =
          typeof raw ===
            "string"

            ? JSON.parse(
                raw
              )

            : raw;


        const subscription =
          device.subscription ||
          device.pushSubscription;


        /*
          Monitor 7.0：
          即使這台裝置沒有自選股，
          只要 Push Subscription 正常，
          仍然可以收到全市場 Radar 訊號。
        */

        if (
          subscription?.endpoint
        ) {

          devices.push({

            ...device,

            deviceId:
              device.deviceId ||
              deviceId,

            subscription,

            symbols:
              unique(
                device.symbols ||
                []
              )
          });
        }

      } catch (error) {

        console.error(
          "device parse error:",
          deviceId,
          error
        );
      }
    }


    if (
      !devices.length
    ) {

      return res
        .status(200)
        .json({

          ok: true,

          engine:
            "Stock Analysis Monitor 7.0",

          testMode,

          marketTime:
            isMarketTime(),

          devices: 0,

          radarCandidates: 0,

          watchSymbols: 0,

          stocks: 0,

          signals: 0,

          sent: 0,

          failed: 0,

          removed: 0,

          deduped: 0,

          elapsedMs:
            Date.now() -
            startedAt
        });
    }


    /* =====================================================
       Origin
    ===================================================== */

    const host =
      req.headers[
        "x-forwarded-host"
      ] ||
      req.headers.host;


    const proto =
      req.headers[
        "x-forwarded-proto"
      ] ||
      "https";


    const origin =
      `${proto}://${host}`;


    /* =====================================================
       1. 所有裝置自選股
    ===================================================== */

    const watchSymbols =
      unique(
        devices.flatMap(
          d =>
            d.symbols
        )
      );


    /* =====================================================
       2. Radar 全市場候選
    ===================================================== */

    const radarData =
      await fetchRadar(
        origin
      );


    /*
      Radar 6.1 的 strategyReady
      已經是 120 深掃後的最終候選。

      Monitor 再取其中前 20 檔。

      fastScore >= 70 只是進完整分析門檻。
    */

    const radarList =
      Array.isArray(
        radarData?.strategyReady
      )

        ? radarData.strategyReady

        : Array.isArray(
            radarData?.longWatch
          )

        ? radarData.longWatch

        : [];


    const radarCandidates =
      radarList

        .filter(
          x =>
            /^\d{4}$/.test(
              String(
                x?.symbol ||
                ""
              )
            )
        )

        .filter(
          x =>
            Number(
              x?.fastScore ??
              x?.score ??
              0
            ) >=
            RADAR_PREFILTER_SCORE
        )

        .sort(
          (a, b) =>
            Number(
              b?.fastScore ??
              b?.score ??
              0
            ) -
            Number(
              a?.fastScore ??
              a?.score ??
              0
            )
        )

        .slice(
          0,
          RADAR_MONITOR_LIMIT
        );


    const radarSymbols =
      unique(
        radarCandidates.map(
          x =>
            x.symbol
        )
      );


    /* =====================================================
       3. Radar + 自選合併

       Radar 放前面，
       自選一定保留。
    ===================================================== */

    const symbols =
      unique([
        ...radarSymbols,
        ...watchSymbols
      ]);


    /*
      記錄來源，
      測試時可以直接看到股票為什麼被掃。
    */

    const radarSet =
      new Set(
        radarSymbols
      );


    const watchSet =
      new Set(
        watchSymbols
      );


    const radarScoreMap =
      new Map();


    for (
      const stock of
      radarCandidates
    ) {

      radarScoreMap.set(
        String(
          stock.symbol
        ),

        Number(
          stock.fastScore ??
          stock.score ??
          0
        )
      );
    }


    /* =====================================================
       4. Stock API

       每批 3 檔，
       避免一次把 FinMind 打爆。
    ===================================================== */

    const stockDataMap =
      new Map();


    for (
      let i = 0;
      i < symbols.length;
      i += STOCK_BATCH_SIZE
    ) {

      const batch =
        symbols.slice(
          i,
          i +
          STOCK_BATCH_SIZE
        );


      const results =
        await Promise.all(
          batch.map(
            symbol =>
              fetchStock(
                origin,
                symbol
              )
          )
        );


      for (
        let j = 0;
        j < batch.length;
        j++
      ) {

        const symbol =
          String(
            batch[j]
          );


        if (
          results[j]
        ) {

          stockDataMap.set(
            symbol,
            results[j]
          );
        }
      }
    }


    /* =====================================================
       5. 第一輪完整分析
       暫時不抓新聞
    ===================================================== */

    const preliminaryMap =
      new Map();


    const newsSymbols = [];


    for (
      const symbol of
      symbols
    ) {

      const data =
        stockDataMap.get(
          symbol
        );


      if (!data) {

        continue;
      }


      const preliminary =
        analyzeData(
          data,
          null
        );


      if (!preliminary) {

        continue;
      }


      preliminaryMap.set(
        symbol,
        preliminary
      );


      if (
        shouldFetchNews(
          preliminary
        )
      ) {

        newsSymbols.push(
          symbol
        );
      }
    }


    /* =====================================================
       6. 只替強勢候選抓新聞
    ===================================================== */

    const newsMap =
      new Map();


    for (
      let i = 0;
      i < newsSymbols.length;
      i += NEWS_BATCH_SIZE
    ) {

      const batch =
        newsSymbols.slice(
          i,
          i +
          NEWS_BATCH_SIZE
        );


      const results =
        await Promise.all(
          batch.map(
            symbol =>
              fetchNews(
                origin,
                symbol
              )
          )
        );


      for (
        let j = 0;
        j < batch.length;
        j++
      ) {

        if (
          results[j]
        ) {

          newsMap.set(
            String(
              batch[j]
            ),
            results[j]
          );
        }
      }
    }


    /* =====================================================
       7. 最終五大類分析
    ===================================================== */

    const signalMap =
      new Map();


    const checkedStocks = [];


    for (
      const symbol of
      symbols
    ) {

      const data =
        stockDataMap.get(
          symbol
        );


      if (!data) {

        checkedStocks.push({

          symbol,

          source:
            radarSet.has(
              symbol
            ) &&
            watchSet.has(
              symbol
            )

              ? "RADAR+WATCH"

              : radarSet.has(
                  symbol
                )

              ? "RADAR"

              : "WATCH",

          radarScore:
            radarScoreMap.get(
              symbol
            ) ??
            null,

          api: false,

          signal: false,

          reason:
            "股票資料取得失敗"
        });


        continue;
      }


      const analysis =
        analyzeData(
          data,
          newsMap.get(
            symbol
          ) ||
          null
        );


      if (!analysis) {

        checkedStocks.push({

          symbol,

          name:
            data?.name ||
            "",

          source:
            radarSet.has(
              symbol
            ) &&
            watchSet.has(
              symbol
            )

              ? "RADAR+WATCH"

              : radarSet.has(
                  symbol
                )

              ? "RADAR"

              : "WATCH",

          radarScore:
            radarScoreMap.get(
              symbol
            ) ??
            null,

          api: true,

          signal: false,

          reason:
            "歷史資料不足"
        });


        continue;
      }


      const result =
        makeSignal(
          analysis
        );


      const signal =
        result.signal;


      const source =
        radarSet.has(
          symbol
        ) &&
        watchSet.has(
          symbol
        )

          ? "RADAR+WATCH"

          : radarSet.has(
              symbol
            )

          ? "RADAR"

          : "WATCH";


      checkedStocks.push({

        symbol,

        name:
          analysis.name ||
          data.name ||
          "",

        source,

        radarScore:
          radarScoreMap.get(
            symbol
          ) ??
          null,

        api: true,

        price:
          analysis.price,

        score:
          analysis.score,

        completeness:
          analysis.completeness,

        classification:
          analysis.classification,

        technical:
          analysis.technical?.score ??
          null,

        volume:
          analysis.volume?.score ??
          null,

        institutional:
          analysis.institutional?.score ??
          null,

        fundamental:
          analysis.fundamental?.score ??
          null,

        news:
          analysis.news?.score ??
          null,

        entryReady:
          analysis.entryReady,

        entryLow:
          analysis.entryLow,

        entryHigh:
          analysis.entryHigh,

        sl:
          analysis.sl,

        tp1:
          analysis.tp1,

        tp2:
          analysis.tp2,

        tp3:
          analysis.tp3,

        rr1:
          analysis.rr1,

        signal:
          !!signal,

        reason:
          result.reason
      });


      if (
        signal
      ) {

        signalMap.set(
          symbol,
          signal
        );
      }
    }


    /* =====================================================
       8. Push

       Monitor 7.0：
       全市場 Radar Signal
       → 所有已開啟 Push 的裝置都收到。

       自選股 Signal
       → 當然也會收到。

       因為 signals 已經是：
       五大類 + Entry + SL + TP + RR
       全部通過後才進來。
    ===================================================== */

    let sent = 0;

    let failed = 0;

    let removed = 0;

    let deduped = 0;


    const pushResults = [];


    const deadDevices =
      new Set();


    for (
      const device of
      devices
    ) {

      if (
        deadDevices.has(
          device.deviceId
        )
      ) {

        continue;
      }


      for (
        const [
          symbol,
          signal
        ] of signalMap
      ) {

        if (
          deadDevices.has(
            device.deviceId
          )
        ) {

          break;
        }


        let dedupeKey =
          null;


        /*
          test=1 不做防重複。
          正式 Cron 才做 6 小時 dedupe。
        */

        if (
          !testMode
        ) {

          dedupeKey =
            `swing:push:sent:${device.deviceId}:${signal.fingerprint}`;


          const acquired =
            await redis([
              "SET",
              dedupeKey,
              "1",
              "NX",
              "EX",
              String(
                DEDUPE_SECONDS
              )
            ]);


          if (
            acquired !==
            "OK"
          ) {

            deduped++;

            continue;
          }
        }


        try {

          const response =
            await sendPush(
              device,
              signal
            );


          sent++;


          pushResults.push({

            deviceId:
              device.deviceId,

            symbol,

            source:
              radarSet.has(
                symbol
              ) &&
              watchSet.has(
                symbol
              )

                ? "RADAR+WATCH"

                : radarSet.has(
                    symbol
                  )

                ? "RADAR"

                : "WATCH",

            ok: true,

            statusCode:
              response?.statusCode ||
              201
          });


        } catch (error) {

          console.error(
            "push error:",
            device.deviceId,
            symbol,
            error
          );


          const statusCode =
            error?.statusCode ||
            null;


          const body =
            typeof error?.body ===
              "string"

              ? error.body

              : JSON.stringify(
                  error?.body ||
                  ""
                );


          const expired =
            statusCode === 404 ||
            statusCode === 410;


          const vapidMismatch =
            statusCode === 400 &&
            body.includes(
              "VapidPkHashMismatch"
            );


          let deleted =
            false;


          if (
            expired ||
            vapidMismatch
          ) {

            deleted =
              await deleteDevice(
                device.deviceId
              );


            if (
              deleted
            ) {

              removed++;

              deadDevices.add(
                device.deviceId
              );
            }

          } else {

            failed++;


            /*
              真正發送失敗時，
              刪除 dedupe，
              下一輪可以再試。
            */

            if (
              dedupeKey
            ) {

              try {

                await redis([
                  "DEL",
                  dedupeKey
                ]);

              } catch (_) {}
            }
          }


          pushResults.push({

            deviceId:
              device.deviceId,

            symbol,

            ok: false,

            statusCode,

            message:
              error?.message ||
              "Push 發送失敗",

            body,

            deleted
          });
        }
      }
    }


    /* =====================================================
       9. Result
    ===================================================== */

    const elapsedMs =
      Date.now() -
      startedAt;


    return res
      .status(200)
      .json({

        ok: true,

        engine:
          "Stock Analysis Monitor 7.0",

        architecture:
          "RADAR → FULL_ANALYSIS → TRADE_PLAN → PUSH",

        strategy:
          "技術＋量價＋法人＋基本面＋新聞",

        radarEngine:
          radarData?.engine ||
          null,

        radarScanned:
          radarData?.scanned ??
          null,

        radarDeepScanned:
          radarData?.strategyScannedCount ??
          null,

        radarReady:
          radarData?.strategyReadyCount ??
          null,

        radarCandidates:
          radarSymbols.length,

        watchSymbols:
          watchSymbols.length,

        totalAnalysisSymbols:
          symbols.length,

        newsChecked:
          newsMap.size,

        pushThreshold:
          MIN_SCORE,

        minimumCompleteness:
          MIN_COMPLETENESS,

        minimumTechnical:
          MIN_TECHNICAL,

        minimumVolume:
          MIN_VOLUME,

        minimumRR:
          MIN_RR,

        testMode,

        marketTime:
          isMarketTime(),

        devices:
          devices.length,

        signals:
          signalMap.size,

        sent,

        failed,

        removed,

        deduped,

        elapsedMs,

        /*
          正式 Cron 不回整包詳細資料，
          避免 response 太大。

          test=1 才完整顯示。
        */

        checkedStocks:
          testMode
            ? checkedStocks
            : undefined,

        pushResults:
          testMode
            ? pushResults
            : undefined
      });


  } catch (error) {

    console.error(
      "monitor error:",
      error
    );


    return res
      .status(500)
      .json({

        ok: false,

        engine:
          "Stock Analysis Monitor 7.0",

        testMode,

        elapsedMs:
          Date.now() -
          startedAt,

        error:
          error?.message ||
          "背景監控失敗"
      });
  }
};
