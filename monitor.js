/* =========================================================
   api/monitor.js
   Stock Analysis Monitor 7.0

   交易模式：
   1. PULLBACK 回檔型
   2. BREAKOUT 突破型
   3. WAIT 等待

   正式 Push 條件：
   1. 綜合評分 >= 75
   2. 資料完整度 >= 60%
   3. 技術面 >= 12 / 20
   4. 量價 >= 10 / 20
   5. 已真正進入合理進場區
   6. 有有效 SL / TP1
   7. TP1 RR >= 1.3

   支援：
   - iPhone / iPad 多裝置
   - Redis
   - Vercel Cron
   - 正式監控 08:55～13:40
   - 6 小時同 Setup 防重複
   - 失效 Push 自動清除
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
   設定
========================================================= */

const MIN_SCORE = 75;
const MIN_COMPLETENESS = 60;
const MIN_TECHNICAL = 12;
const MIN_VOLUME = 10;
const MIN_RR = 1.3;

const DEDUPE_SECONDS = 21600;


/* =========================================================
   Redis
========================================================= */

async function redis(command) {

  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("Redis 環境變數尚未設定");
  }

  const controller = new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
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
            JSON.stringify(command),

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


async function deleteDevice(deviceId) {

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

  const n = Number(v);

  return Number.isFinite(n)
    ? n
    : null;
}


function avg(a) {

  const values =
    (Array.isArray(a) ? a : [])
      .map(Number)
      .filter(Number.isFinite);

  if (!values.length) {
    return 0;
  }

  return (
    values.reduce(
      (x, y) => x + y,
      0
    ) /
    values.length
  );
}


function sma(a, n) {

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


function emaSeries(values, period) {

  if (
    !Array.isArray(values) ||
    !values.length
  ) {
    return [];
  }

  const k =
    2 / (period + 1);

  const result = [];

  let e =
    Number(values[0]);

  result.push(e);

  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    e =
      Number(values[i]) *
      k +
      e *
      (1 - k);

    result.push(e);
  }

  return result;
}


function rsi(values, n = 14) {

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
      Number(values[i]) -
      Number(values[i - 1]);

    if (d > 0) {
      gain += d;
    } else {
      loss += Math.abs(d);
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


function atr(rows, n = 14) {

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
      rows[i - 1].close;

    values.push(
      Math.max(
        x.high - x.low,
        Math.abs(
          x.high - previous
        ),
        Math.abs(
          x.low - previous
        )
      )
    );
  }

  return avg(values);
}


function unique(list) {

  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map(
          x =>
            String(x).trim()
        )
        .filter(Boolean)
    )
  ];
}


function round(v, digits = 2) {

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
      n * p
    ) / p
  );
}


function clamp(v, min, max) {

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
   TEST MODE
========================================================= */

function getTestMode(req) {

  if (
    String(
      req.headers?.[
        "x-monitor-test"
      ] || ""
    ) === "1"
  ) {
    return true;
  }

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

  } catch (error) {

    console.error(
      "URL parse error:",
      error
    );
  }

  const queryTest =
    req.query?.test;

  if (
    queryTest === "1"
  ) {
    return true;
  }

  if (
    Array.isArray(queryTest) &&
    queryTest.includes("1")
  ) {
    return true;
  }

  return false;
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
    t.hour * 60 +
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
   Swing High / Low
========================================================= */

function getSwings(
  rows,
  left = 3,
  right = 3
) {

  const highs = [];
  const lows = [];

  for (
    let i = left;
    i < rows.length - right;
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
        rows[i].high >
        rows[i - j].high
      ) {
        isHigh = false;
      }

      if (
        rows[i].low <
        rows[i - j].low
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
        rows[i].high >
        rows[i + j].high
      ) {
        isHigh = false;
      }

      if (
        rows[i].low <
        rows[i + j].low
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
   壓力／支撐合併
========================================================= */

function clusterLevels(
  items,
  distance
) {

  const sorted =
    (items || [])
      .filter(
        x =>
          Number.isFinite(
            Number(x.price)
          ) &&
          Number(x.price) > 0
      )
      .sort(
        (a, b) =>
          Number(a.price) -
          Number(b.price)
      );

  const groups = [];

  for (
    const item of
    sorted
  ) {

    const last =
      groups[
        groups.length - 1
      ];

    if (
      last &&
      Math.abs(
        Number(item.price) -
        last.price
      ) <= distance
    ) {

      last.values.push(
        Number(item.price)
      );

      last.price =
        avg(
          last.values
        );

      last.count += 1;

    } else {

      groups.push({
        price:
          Number(item.price),

        values: [
          Number(item.price)
        ],

        count: 1
      });
    }
  }

  return groups;
}


/* =========================================================
   Entry / SL / TP 7.0

   PULLBACK：
   現價接近有效支撐

   BREAKOUT：
   現價已離支撐太遠，
   但距上方壓力不遠

   WAIT：
   不硬給 Entry
========================================================= */

function buildTradePlan(
  rows,
  price,
  A
) {

  const recent =
    rows.slice(-240);

  const closes =
    recent.map(
      x => x.close
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
      3,
      3
    );

  const mergeDistance =
    Math.max(
      A * 0.45,
      price * 0.005
    );


  /* =======================================================
     支撐
  ======================================================= */

  const supportRaw = [];


  for (
    const x of
    swings.lows
  ) {

    if (
      x.price <=
        price * 1.01 &&
      x.price >=
        price * 0.75
    ) {

      supportRaw.push({
        price:
          x.price
      });
    }
  }


  if (
    Number.isFinite(m20) &&
    m20 <=
      price * 1.01 &&
    m20 >=
      price * 0.75
  ) {

    supportRaw.push({
      price: m20
    });
  }


  if (
    Number.isFinite(m60) &&
    m60 <=
      price * 1.01 &&
    m60 >=
      price * 0.75
  ) {

    supportRaw.push({
      price: m60
    });
  }


  const low20 =
    Math.min(
      ...rows
        .slice(-20)
        .map(
          x => x.low
        )
    );


  const low60 =
    Math.min(
      ...rows
        .slice(-60)
        .map(
          x => x.low
        )
    );


  supportRaw.push({
    price: low20
  });


  supportRaw.push({
    price: low60
  });


  const supportGroups =
    clusterLevels(
      supportRaw,
      mergeDistance
    )
      .filter(
        x =>
          x.price <=
            price * 1.01 &&
          x.price >=
            price * 0.75
      )
      .sort(
        (a, b) =>
          b.price -
          a.price
      );


  const support1 =
    supportGroups[0]
      ?.price ??
    (
      Number.isFinite(m20)
        ? Math.min(
            price,
            m20
          )
        : price - A
    );


  const support2 =
    supportGroups.find(
      x =>
        x.price <
        support1 -
        mergeDistance
    )?.price ??
    (
      Number.isFinite(m60) &&
      m60 < support1
        ? m60
        : null
    );


  /* =======================================================
     壓力
  ======================================================= */

  const pressureRaw = [];


  for (
    const x of
    swings.highs
  ) {

    if (
      x.price >
      price +
        mergeDistance *
        0.20
    ) {

      pressureRaw.push({
        price:
          x.price
      });
    }
  }


  for (
    let i = 20;
    i < recent.length;
    i += 10
  ) {

    const block =
      recent.slice(
        Math.max(
          0,
          i - 20
        ),
        i + 1
      );


    if (!block.length) {
      continue;
    }


    const high =
      Math.max(
        ...block.map(
          x => x.high
        )
      );


    if (
      high >
      price +
        mergeDistance *
        0.20
    ) {

      pressureRaw.push({
        price: high
      });
    }
  }


  const pressureGroups =
    clusterLevels(
      pressureRaw,
      mergeDistance
    )
      .filter(
        x =>
          x.price >
          price +
            mergeDistance *
            0.20
      )
      .sort(
        (a, b) =>
          a.price -
          b.price
      );


  const breakout =
    pressureGroups[0]
      ?.price ??
    null;


  /* =======================================================
     判斷模式
  ======================================================= */

  const supportDistance =
    support1 > 0
      ? (
          price -
          support1
        ) /
        price
      : 999;


  const breakoutDistance =
    breakout
      ? (
          breakout -
          price
        ) /
        price
      : 999;


  let planType =
    "WAIT";


  /*
    現價離第一支撐 5% 內：
    回檔型
  */

  if (
    supportDistance >=
      -0.01 &&
    supportDistance <=
      0.05
  ) {

    planType =
      "PULLBACK";
  }


  /*
    已離支撐超過 5%，
    但距上方突破位 <= 3.5%
  */

  else if (
    breakout &&
    breakoutDistance >= 0 &&
    breakoutDistance <=
      0.035 &&
    supportDistance >
      0.05
  ) {

    planType =
      "BREAKOUT";
  }


  /* =======================================================
     Entry / SL
  ======================================================= */

  let entryLow = null;
  let entryHigh = null;
  let entryMid = null;

  let sl = null;


  /* =======================================================
     PULLBACK
  ======================================================= */

  if (
    planType ===
    "PULLBACK"
  ) {

    entryLow =
      support1 -
      Math.max(
        A * 0.20,
        price * 0.0025
      );


    entryHigh =
      support1 +
      Math.max(
        A * 0.35,
        price * 0.004
      );


    entryMid =
      (
        entryLow +
        entryHigh
      ) / 2;


    const structuralLows =
      swings.lows
        .map(
          x => x.price
        )
        .filter(
          x =>
            x <
              support1 -
              mergeDistance *
              0.20 &&
            x >=
              entryMid *
              0.90
        )
        .sort(
          (a, b) =>
            b - a
        );


    const invalidation =
      structuralLows[0] ||
      support2 ||
      (
        support1 -
        A * 0.8
      );


    sl =
      invalidation -
      Math.max(
        A * 0.25,
        price * 0.003
      );


    if (
      sl >= entryLow
    ) {

      sl =
        entryLow -
        Math.max(
          A * 0.40,
          price * 0.0045
        );
    }
  }


  /* =======================================================
     BREAKOUT
  ======================================================= */

  else if (
    planType ===
    "BREAKOUT"
  ) {

    /*
      Entry 直接改成突破位附近。

      例如：
      現價 1215
      壓力 1230

      不會再叫它等 1020。
    */

    entryLow =
      breakout -
      Math.max(
        A * 0.18,
        breakout * 0.002
      );


    entryHigh =
      breakout +
      Math.max(
        A * 0.35,
        breakout * 0.004
      );


    entryMid =
      (
        entryLow +
        entryHigh
      ) / 2;


    /*
      突破型 SL：
      放突破失敗區。

      不使用很遠的舊支撐。
    */

    sl =
      breakout -
      Math.max(
        A * 0.75,
        breakout * 0.012
      );


    if (
      sl >= entryLow
    ) {

      sl =
        entryLow -
        Math.max(
          A * 0.40,
          price * 0.005
        );
    }
  }


  /* =======================================================
     Risk
  ======================================================= */

  let risk = null;
  let riskPct = null;


  if (
    Number.isFinite(
      entryMid
    ) &&
    Number.isFinite(sl) &&
    entryMid > sl
  ) {

    risk =
      entryMid -
      sl;


    riskPct =
      risk /
      entryMid *
      100;
  }


  /* =======================================================
     TP

     PULLBACK：
     第一個高於 Entry 的真實壓力即可當 TP1。

     BREAKOUT：
     breakout 本身就是 Entry 依據，
     所以 TP1 必須在 breakout 上方。
  ======================================================= */

  const targetBase =
    Number.isFinite(
      entryHigh
    )
      ? entryHigh
      : price;


  const targets =
    pressureGroups
      .map(
        x => x.price
      )
      .filter(
        value =>
          value >
          targetBase +
            mergeDistance *
            0.25
      );


  let tp1 =
    targets[0] ??
    null;


  let tp2 =
    tp1
      ? (
          targets.find(
            value =>
              value >
              tp1 +
              mergeDistance
          ) ??
          null
        )
      : null;


  let tp3 =
    tp2
      ? (
          targets.find(
            value =>
              value >
              tp2 +
              mergeDistance
          ) ??
          null
        )
      : null;


  let tp1Source =
    tp1
      ? "歷史壓力"
      : "";


  let tp2Source =
    tp2
      ? "更高歷史壓力"
      : "";


  let tp3Source =
    tp3
      ? "更高一層歷史壓力"
      : "";


  /*
    只有已經找到 TP1、TP2，
    但缺 TP3 時，
    才允許 TP3 做延伸。

    不硬生 ATR TP1。
  */

  if (
    !tp3 &&
    tp2 &&
    tp1
  ) {

    const base =
      support2 ||
      support1;


    tp3 =
      tp2 +
      Math.max(
        tp2 - base,
        A * 3
      ) *
      0.618;


    tp3Source =
      "歷史壓力不足，Fib 0.618 延伸";
  }


  /* =======================================================
     RR
  ======================================================= */

  function getRR(target) {

    if (
      !Number.isFinite(
        target
      ) ||
      !Number.isFinite(
        risk
      ) ||
      risk <= 0
    ) {
      return null;
    }


    return (
      target -
      entryMid
    ) /
    risk;
  }


  const rr1 =
    getRR(tp1);


  const rr2 =
    getRR(tp2);


  const rr3 =
    getRR(tp3);


  /* =======================================================
     Entry Ready
  ======================================================= */

  let entryReady =
    false;


  /*
    回檔型：
    現價真的靠近 Entry。
  */

  if (
    planType ===
    "PULLBACK" &&
    Number.isFinite(
      entryLow
    ) &&
    Number.isFinite(
      entryHigh
    )
  ) {

    entryReady =
      price >=
        entryLow -
        Math.max(
          A * 0.25,
          price * 0.004
        )
      &&
      price <=
        entryHigh +
        Math.max(
          A * 0.35,
          price * 0.006
        );
  }


  /*
    突破型：

    靠近突破位不算。

    必須：
    現價 >= breakout

    才允許正式 Push。
  */

  if (
    planType ===
      "BREAKOUT" &&
    Number.isFinite(
      breakout
    ) &&
    Number.isFinite(
      entryHigh
    )
  ) {

    entryReady =
      price >= breakout &&
      price <=
        entryHigh +
        Math.max(
          A * 0.20,
          price * 0.003
        );
  }


  return {

    planType,

    support1:
      round(
        support1
      ),

    support2:
      round(
        support2
      ),

    breakout:
      round(
        breakout
      ),

    supportDistance:
      supportDistance === 999
        ? null
        : round(
            supportDistance *
            100
          ),

    breakoutDistance:
      breakoutDistance === 999
        ? null
        : round(
            breakoutDistance *
            100
          ),

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
      round(sl),

    risk:
      round(risk),

    riskPct:
      round(
        riskPct
      ),

    tp1:
      round(tp1),

    tp2:
      round(tp2),

    tp3:
      round(tp3),

    tp1Source,

    tp2Source,

    tp3Source,

    rr1:
      round(rr1),

    rr2:
      round(rr2),

    rr3:
      round(rr3),

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
      x => x.close
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
            x => x.high
          )
        )
      : null;


  let score = 0;

  const reasons = [];


  if (
    Number.isFinite(ma20) &&
    price > ma20
  ) {

    score += 4;

    reasons.push(
      "股價站上 MA20"
    );
  }


  if (
    Number.isFinite(ma20) &&
    Number.isFinite(ma60) &&
    ma20 > ma60
  ) {

    score += 4;

    reasons.push(
      "MA20 高於 MA60"
    );
  }


  if (
    Number.isFinite(ma20) &&
    Number.isFinite(ma20Prev) &&
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
        Math.round(score),
        0,
        20
      ),

    ma20:
      round(ma20),

    ma60:
      round(ma60),

    rsi:
      round(R),

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
          x => x.volume
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
        x => x.high
      )
    );


  const recent5Avg =
    avg(
      rows
        .slice(-5)
        .map(
          x => x.volume
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
          x => x.volume
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
    price > high20 &&
    volumeRatio >= 1.2
  ) {

    score += 5;

    reasons.push(
      "帶量突破近期高點"
    );

  } else if (
    price >=
      high20 * 0.985 &&
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
      previous15Avg * 0.8 &&
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
        Math.round(score),
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
      available: false,
      score: null,
      reasons: []
    };
  }


  const foreign5 =
    num(i?.foreign5);

  const foreign10 =
    num(i?.foreign10);

  const trust5 =
    num(i?.trust5);

  const trust10 =
    num(i?.trust10);

  const dealer5 =
    num(i?.dealer5);

  const total5 =
    num(i?.total5);

  const total10 =
    num(i?.total10);

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
    ].some(
      Number.isFinite
    );


  if (!hasData) {

    return {
      available: false,
      score: null,
      reasons: []
    };
  }


  let score = 8;

  const reasons = [];


  if (
    Number(foreign5) > 0
  ) {

    score += 3;

    reasons.push(
      "外資近 5 日買超"
    );

  } else if (
    Number(foreign5) < 0
  ) {

    score -= 2;
  }


  if (
    Number(trust5) > 0
  ) {

    score += 3;

    reasons.push(
      "投信近 5 日買超"
    );

  } else if (
    Number(trust5) < 0
  ) {

    score -= 2;
  }


  if (
    Number(total5) > 0
  ) {

    score += 2;

    reasons.push(
      "三大法人近 5 日合計買超"
    );

  } else if (
    Number(total5) < 0
  ) {

    score -= 2;
  }


  if (
    Number(foreign10) > 0
  ) {
    score += 1;
  }


  if (
    Number(trust10) > 0
  ) {
    score += 1;
  }


  if (
    Number(total10) > 0
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
    Number(dealer5) > 0
  ) {
    score += 0.5;
  }


  return {

    available:
      true,

    score:
      clamp(
        Math.round(score),
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
      typeof financial?.profitable ===
        "boolean"
    );


  if (
    !revenueAvailable &&
    !financialAvailable
  ) {

    return {
      available: false,
      score: null,
      reasons: []
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
      Number.isFinite(yoy)
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
      Number.isFinite(mom)
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
        Number.isFinite(eps) &&
        eps > 0
      )
    ) {

      score += 4;

      reasons.push(
        "公司維持獲利"
      );
    }


    if (
      Number.isFinite(eps)
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

function scoreNews(news) {

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
      available: false,
      score: null,
      overall:
        "資料不足",
      reasons: []
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
          10 + overall
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
   綜合評分
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
   股票完整分析
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
    !Number.isFinite(price) ||
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
      price * 0.006
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
   正式 Push 判斷
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


  /*
    WAIT 永遠不 Push
  */

  if (
    a.planType ===
    "WAIT"
  ) {

    return {
      signal: null,
      reason:
        "目前沒有合理進場位置"
    };
  }


  /*
    BREAKOUT：
    沒有真的突破不能 Push。
  */

  if (
    a.planType ===
      "BREAKOUT" &&
    Number(a.price) <
      Number(a.breakout)
  ) {

    return {
      signal: null,
      reason:
        `等待突破 ${formatPrice(a.breakout)}`
    };
  }


  if (
    !a.entryReady
  ) {

    return {
      signal: null,

      reason:
        a.planType ===
        "BREAKOUT"

          ? "尚未完成突破確認"

          : "尚未進入回檔進場區"
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
    Number(a.sl) >=
    Number(a.entryLow)
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
        "上方沒有足夠歷史目標空間"
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

      a.planType,

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
        a.score / 5
      ) * 5
    ].join(":");


  return {

    signal: {
      ...a,
      fingerprint
    },

    reason:
      a.planType ===
      "BREAKOUT"

        ? "符合突破型正式進場通知條件"

        : "符合回檔型正式進場通知條件"
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


    return (
      data?.ok
        ? data
        : null
    );

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
   新聞只抓候選股票
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


  const mode =
    signal.planType ===
    "BREAKOUT"

      ? "突破進場"

      : "回檔進場";


  return {

    title:
      `📈 ${signal.name} ${signal.symbol}｜${mode}｜${signal.score} 分`,

    body:
      [
        `現價 ${formatPrice(signal.price)}`,

        signal.planType ===
        "BREAKOUT"
          ? `突破位 ${formatPrice(signal.breakout)}`
          : `支撐 ${formatPrice(signal.support1)}`,

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
      `entry-${signal.symbol}-${signal.planType}`,

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

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );


  const testMode =
    getTestMode(req);


  const internalTest =
    String(
      req.headers?.[
        "x-monitor-test"
      ] || ""
    ) === "1";


  if (
    process.env.CRON_SECRET &&
    !(
      testMode &&
      !internalTest
    )
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

          internalTest,

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
       正式模式 08:55～13:40
       Test Mode 跳過
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
       裝置
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
            ? JSON.parse(raw)
            : raw;


        const subscription =
          device.subscription ||
          device.pushSubscription;


        if (
          subscription?.endpoint &&
          Array.isArray(
            device.symbols
          ) &&
          device.symbols.length
        ) {

          devices.push({
            ...device,

            deviceId:
              device.deviceId ||
              deviceId,

            subscription,

            symbols:
              unique(
                device.symbols
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


    /* =====================================================
       沒裝置
    ===================================================== */

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
          stocks: 0,
          signals: 0,
          sent: 0,
          failed: 0,
          removed: 0,
          deduped: 0,

          checkedStocks:
            testMode
              ? []
              : undefined,

          pushResults:
            testMode
              ? []
              : undefined
        });
    }


    /* =====================================================
       所有裝置股票合併
    ===================================================== */

    const symbols =
      unique(
        devices.flatMap(
          d =>
            d.symbols
        )
      );


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


    const signalMap =
      new Map();


    const checkedStocks =
      [];


    /* =====================================================
       每批 3 檔
    ===================================================== */

    const batchSize = 3;


    for (
      let i = 0;
      i < symbols.length;
      i += batchSize
    ) {

      const batch =
        symbols.slice(
          i,
          i + batchSize
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
        j < results.length;
        j++
      ) {

        const symbol =
          String(
            batch[j]
          );


        const data =
          results[j];


        if (!data) {

          checkedStocks.push({
            symbol,
            api: false,
            signal: false,
            reason:
              "股票資料取得失敗"
          });

          continue;
        }


        /* =================================================
           第一階段：不抓新聞
        ================================================= */

        const preliminary =
          analyzeData(
            data,
            null
          );


        if (
          !preliminary
        ) {

          checkedStocks.push({
            symbol,

            name:
              data.name ||
              "",

            api:
              true,

            signal:
              false,

            reason:
              "歷史資料不足"
          });

          continue;
        }


        /* =================================================
           候選才抓新聞
        ================================================= */

        let newsData =
          null;


        if (
          shouldFetchNews(
            preliminary
          )
        ) {

          newsData =
            await fetchNews(
              origin,
              symbol
            );
        }


        /* =================================================
           最終分析
        ================================================= */

        const analysis =
          analyzeData(
            data,
            newsData
          );


        const result =
          makeSignal(
            analysis
          );


        const signal =
          result.signal;


        checkedStocks.push({
          symbol,

          name:
            analysis?.name ||
            data.name ||
            "",

          api:
            true,

          price:
            analysis?.price ??
            null,

          score:
            analysis?.score ??
            null,

          completeness:
            analysis?.completeness ??
            null,

          classification:
            analysis?.classification ??
            null,

          technical:
            analysis?.technical?.score ??
            null,

          volume:
            analysis?.volume?.score ??
            null,

          institutional:
            analysis?.institutional?.score ??
            null,

          fundamental:
            analysis?.fundamental?.score ??
            null,

          news:
            analysis?.news?.score ??
            null,

          planType:
            analysis?.planType ??
            "WAIT",

          support1:
            analysis?.support1 ??
            null,

          support2:
            analysis?.support2 ??
            null,

          breakout:
            analysis?.breakout ??
            null,

          supportDistance:
            analysis?.supportDistance ??
            null,

          breakoutDistance:
            analysis?.breakoutDistance ??
            null,

          entryReady:
            analysis?.entryReady ??
            false,

          entryLow:
            analysis?.entryLow ??
            null,

          entryHigh:
            analysis?.entryHigh ??
            null,

          sl:
            analysis?.sl ??
            null,

          tp1:
            analysis?.tp1 ??
            null,

          tp2:
            analysis?.tp2 ??
            null,

          tp3:
            analysis?.tp3 ??
            null,

          rr1:
            analysis?.rr1 ??
            null,

          signal:
            !!signal,

          reason:
            result.reason
        });


        if (signal) {

          signalMap.set(
            symbol,
            signal
          );
        }
      }
    }


    /* =====================================================
       Push
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
        const rawSymbol of
        device.symbols
      ) {

        if (
          deadDevices.has(
            device.deviceId
          )
        ) {
          break;
        }


        const symbol =
          String(
            rawSymbol
          );


        const signal =
          signalMap.get(
            symbol
          );


        if (!signal) {
          continue;
        }


        let dedupeKey =
          null;


        /*
          Test：
          不防重複

          正式：
          6 小時同 Setup 防重複
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

            planType:
              signal.planType,

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


            if (deleted) {

              removed++;

              deadDevices.add(
                device.deviceId
              );
            }

          } else {

            failed++;


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

            planType:
              signal.planType,

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
       RESULT
    ===================================================== */

    return res
      .status(200)
      .json({
        ok: true,

        engine:
          "Stock Analysis Monitor 7.0",

        tradePlan:
          "PULLBACK / BREAKOUT / WAIT",

        strategy:
          "技術＋量價＋法人＋基本面＋新聞",

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

        internalTest,

        marketTime:
          isMarketTime(),

        devices:
          devices.length,

        stocks:
          symbols.length,

        signals:
          signalMap.size,

        sent,

        failed,

        removed,

        deduped,

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

        error:
          error?.message ||
          "背景監控失敗"
      });
  }
};
