const webpush = require("web-push");

/* =========================================================
   波段分析 Monitor 8.0

   核心交易流程：

   現價
   ↓
   現價附近最佳限價 Entry
   ↓
   結構失效 SL
   ↓
   關鍵突破位
   ↓
   TP1 = 突破後第一有效壓力
   ↓
   TP2
   ↓
   TP3
   ↓
   R:R

   正式 Push：

   綜合評分 >= 75
   資料完整度 >= 60%
   技術面 >= 12/20
   量價 >= 10/20
   必須進入最佳 Entry 區
   SL 必須有效
   TP1 必須存在
   TP1 >= 1.3R
========================================================= */

const DEFAULT_SYMBOLS = [
  "2330",
  "2317",
  "2454",
  "2308",
  "2382",
  "3231",
  "2881",
  "2882",
  "2891",
  "2886",
  "2603",
  "2615"
];

const DEVICE_SET_KEY =
  "swing:push:devices";


/* =========================================================
   ENV
========================================================= */

function env(name, ...fallbacks) {

  for (
    const key
    of [
      name,
      ...fallbacks
    ]
  ) {

    const value =
      process.env[key];

    if (value) {
      return value;
    }

  }

  return "";

}


const REDIS_URL = () =>
  env(
    "UPSTASH_REDIS_REST_URL",
    "KV_REST_API_URL"
  );


const REDIS_TOKEN = () =>
  env(
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_TOKEN"
  );


/* =========================================================
   RESPONSE
========================================================= */

function send(
  res,
  status,
  data
) {

  res.statusCode =
    status;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.end(
    JSON.stringify(data)
  );

}


/* =========================================================
   REDIS
========================================================= */

async function redis(command) {

  const url =
    REDIS_URL();

  const token =
    REDIS_TOKEN();

  if (
    !url ||
    !token
  ) {

    throw new Error(
      "Redis 環境變數不存在"
    );

  }

  const response =
    await fetch(
      url,
      {
        method:
          "POST",

        headers: {

          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json"

        },

        body:
          JSON.stringify(command)
      }
    );


  const json =
    await response
      .json()
      .catch(
        () => ({})
      );


  if (
    !response.ok ||
    json.error
  ) {

    throw new Error(
      json.error ||
      `Redis HTTP ${response.status}`
    );

  }


  return json.result;

}


async function getDeviceIds() {

  const result =
    await redis([
      "SMEMBERS",
      DEVICE_SET_KEY
    ]);

  return Array.isArray(result)
    ?
    result
    :
    [];

}


async function getDevice(
  deviceId
) {

  const raw =
    await redis([
      "GET",
      `swing:push:device:${deviceId}`
    ]);

  if (!raw) {
    return null;
  }

  try {

    return JSON.parse(raw);

  }
  catch {

    return null;

  }

}


async function removeDevice(
  deviceId
) {

  await Promise.allSettled([

    redis([
      "DEL",
      `swing:push:device:${deviceId}`
    ]),

    redis([
      "SREM",
      DEVICE_SET_KEY,
      deviceId
    ])

  ]);

}


/* =========================================================
   PUSH CONFIG
========================================================= */

function configurePush() {

  const publicKey =
    String(
      process.env.VAPID_PUBLIC_KEY ||
      ""
    ).trim();


  const privateKey =
    String(
      process.env.VAPID_PRIVATE_KEY ||
      ""
    ).trim();


  let subject =
    String(
      process.env.VAPID_SUBJECT ||
      ""
    ).trim();


  if (!publicKey) {

    throw new Error(
      "缺少 VAPID_PUBLIC_KEY"
    );

  }


  if (!privateKey) {

    throw new Error(
      "缺少 VAPID_PRIVATE_KEY"
    );

  }


  if (!subject) {

    throw new Error(
      "缺少 VAPID_SUBJECT"
    );

  }


  if (
    !subject
      .toLowerCase()
      .startsWith("mailto:")
    &&
    !/^https?:\/\//i
      .test(subject)
  ) {

    subject =
      `mailto:${subject}`;

  }


  webpush.setVapidDetails(
    subject,
    publicKey,
    privateKey
  );

}


/* =========================================================
   TEST MODE
========================================================= */

function getTestMode(req) {

  const header =
    String(
      req.headers?.["x-monitor-test"] ||
      ""
    ) === "1";


  let urlTest =
    false;

  try {

    const host =
      req.headers?.host ||
      "localhost";

    const url =
      new URL(
        req.url,
        `https://${host}`
      );

    urlTest =
      url.searchParams.get("test")
      ===
      "1";

  }
  catch {}


  const queryTest =
    String(
      req.query?.test ||
      ""
    ) === "1";


  return (
    header ||
    urlTest ||
    queryTest
  );

}


/* =========================================================
   TAIPEI TIME
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

        hourCycle:
          "h23"
      }
    )
    .formatToParts(
      new Date()
    );


  const get =
    type =>
      parts.find(
        x =>
          x.type === type
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


function isMarketMonitoringTime() {

  const {
    weekday,
    hour,
    minute
  } =
    taipeiParts();


  if (
    weekday === "Sat" ||
    weekday === "Sun"
  ) {

    return false;

  }


  const now =
    hour * 60 +
    minute;


  return (
    now >=
    8 * 60 + 55
    &&
    now <=
    13 * 60 + 40
  );

}


/* =========================================================
   MATH
========================================================= */

function num(v) {

  const n =
    Number(v);

  return Number.isFinite(n)
    ?
    n
    :
    0;

}


function avg(arr) {

  if (!arr.length) {
    return 0;
  }

  return (
    arr.reduce(
      (sum, x) =>
        sum + num(x),
      0
    )
    /
    arr.length
  );

}


function sma(
  values,
  period
) {

  if (
    values.length <
    period
  ) {

    return avg(values);

  }

  return avg(
    values.slice(-period)
  );

}


function ema(
  values,
  period
) {

  if (!values.length) {
    return 0;
  }


  let result =
    num(values[0]);


  const k =
    2 /
    (
      period + 1
    );


  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    result =
      num(values[i]) * k +
      result * (1 - k);

  }


  return result;

}


function rsi(
  values,
  period = 14
) {

  if (
    values.length <=
    period
  ) {

    return 50;

  }


  let gains = 0;
  let losses = 0;


  for (
    let i =
      values.length - period;
    i < values.length;
    i++
  ) {

    const diff =
      num(values[i]) -
      num(values[i - 1]);


    if (diff > 0) {

      gains += diff;

    }
    else {

      losses -= diff;

    }

  }


  if (
    losses === 0
  ) {

    return 100;

  }


  return (
    100 -
    100 /
    (
      1 +
      (gains / period) /
      (losses / period)
    )
  );

}


function atr(
  rows,
  period = 14
) {

  const values = [];


  for (
    let i =
      Math.max(
        1,
        rows.length - period
      );
    i < rows.length;
    i++
  ) {

    const row =
      rows[i];

    const prevClose =
      num(
        rows[i - 1].close
      );


    values.push(
      Math.max(

        num(row.high) -
        num(row.low),

        Math.abs(
          num(row.high) -
          prevClose
        ),

        Math.abs(
          num(row.low) -
          prevClose
        )

      )
    );

  }


  return avg(values);

}


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


function fmtPrice(value) {

  const n =
    Number(value);


  if (
    !Number.isFinite(n)
  ) {

    return "-";

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
   PIVOTS
========================================================= */

function pivots(
  rows,
  left = 3,
  right = 3
) {

  const lows = [];
  const highs = [];


  for (
    let i = left;
    i <
    rows.length - right;
    i++
  ) {

    let isLow = true;
    let isHigh = true;


    for (
      let j = 1;
      j <= left;
      j++
    ) {

      if (
        num(rows[i].low) >
        num(rows[i - j].low)
      ) {

        isLow = false;

      }


      if (
        num(rows[i].high) <
        num(rows[i - j].high)
      ) {

        isHigh = false;

      }

    }


    for (
      let j = 1;
      j <= right;
      j++
    ) {

      if (
        num(rows[i].low) >
        num(rows[i + j].low)
      ) {

        isLow = false;

      }


      if (
        num(rows[i].high) <
        num(rows[i + j].high)
      ) {

        isHigh = false;

      }

    }


    if (isLow) {

      lows.push({

        i,

        value:
          num(rows[i].low)

      });

    }


    if (isHigh) {

      highs.push({

        i,

        value:
          num(rows[i].high)

      });

    }

  }


  return {
    lows,
    highs
  };

}


/* =========================================================
   CLUSTER
========================================================= */

function clusterLevels(
  items,
  distance
) {

  const sorted =
    items
      .filter(
        x =>
          Number.isFinite(
            Number(x.value)
          )
          &&
          Number(x.value) > 0
      )
      .sort(
        (a, b) =>
          Number(a.value) -
          Number(b.value)
      );


  const groups = [];


  for (
    const item
    of sorted
  ) {

    const last =
      groups[
        groups.length - 1
      ];


    if (
      last
      &&
      Math.abs(
        Number(item.value) -
        last.value
      )
      <=
      distance
    ) {

      last.values.push(
        Number(item.value)
      );


      last.value =
        avg(
          last.values
        );


      last.count++;


      last.latest =
        Math.max(
          last.latest,
          Number(item.i) || 0
        );

    }
    else {

      groups.push({

        value:
          Number(item.value),

        values: [
          Number(item.value)
        ],

        count: 1,

        latest:
          Number(item.i) || 0

      });

    }

  }


  return groups;

}


/* =========================================================
   TRADE PLAN 8.0
========================================================= */

function buildTradePlan(
  rows,
  price,
  A,
  m20,
  m60
) {

  const recent =
    rows.slice(-240);


  const P =
    pivots(
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
     SUPPORT
  ======================================================= */

  const supportRaw = [];


  for (
    const x
    of P.lows
  ) {

    if (
      x.value <=
      price * 1.012
      &&
      x.value >=
      price * 0.82
    ) {

      supportRaw.push({

        value:
          x.value,

        i:
          x.i

      });

    }

  }


  if (
    Number.isFinite(m20)
    &&
    m20 <=
    price * 1.012
    &&
    m20 >=
    price * 0.82
  ) {

    supportRaw.push({

      value:
        m20,

      i:
        recent.length + 5

    });

  }


  if (
    Number.isFinite(m60)
    &&
    m60 <=
    price * 1.012
    &&
    m60 >=
    price * 0.82
  ) {

    supportRaw.push({

      value:
        m60,

      i:
        recent.length + 4

    });

  }


  for (
    const period
    of [
      10,
      20,
      60
    ]
  ) {

    const part =
      rows.slice(-period);


    if (!part.length) {
      continue;
    }


    const low =
      Math.min(
        ...part.map(
          x =>
            num(x.low)
        )
      );


    if (
      low <=
      price * 1.012
      &&
      low >=
      price * 0.82
    ) {

      supportRaw.push({

        value:
          low,

        i:
          recent.length +
          period

      });

    }

  }


  /*
    已經突破過的前高，
    也可作為支撐候選。
  */

  for (
    const x
    of P.highs
  ) {

    if (
      x.value >=
      price * 0.88
      &&
      x.value <
      price
    ) {

      const after =
        recent.slice(
          x.i + 1
        );


      const broken =
        after.some(
          row =>
            num(row.close) >
            x.value * 1.004
        );


      if (broken) {

        supportRaw.push({

          value:
            x.value,

          i:
            x.i

        });

      }

    }

  }


  const supportGroups =
    clusterLevels(
      supportRaw,
      mergeDistance
    )
    .filter(
      x =>
        x.value <=
        price * 1.012
        &&
        x.value >=
        price * 0.82
    )
    .sort(
      (a, b) =>
        b.value -
        a.value
    );


  const support1 =
    supportGroups[0]
      ?
      supportGroups[0].value
      :
      null;


  const support2 =
    support1
      ?
      supportGroups.find(
        x =>
          x.value <
          support1 -
          mergeDistance * 0.75
      )?.value
      ||
      null
      :
      null;


  /* =======================================================
     BEST ENTRY SUPPORT

     只接受現價附近約 4.5% 內的有效支撐。
  ======================================================= */

  const MAX_ENTRY_DISTANCE =
    0.045;


  const nearbySupports =
    supportGroups.filter(
      x => {

        const distance =
          (
            price -
            x.value
          )
          /
          price;


        return (
          distance >=
          -0.012
          &&
          distance <=
          MAX_ENTRY_DISTANCE
        );

      }
    );


  let bestSupport = null;
  let bestSupportScore =
    -Infinity;


  for (
    const x
    of nearbySupports
  ) {

    const distance =
      Math.max(
        0,
        (
          price -
          x.value
        )
        /
        price
      );


    const distanceScore =
      Math.max(
        0,
        1 -
        distance /
        MAX_ENTRY_DISTANCE
      )
      *
      45;


    const clusterScore =
      Math.min(
        x.count,
        4
      )
      *
      10;


    const recentScore =
      recent.length
        ?
        (
          x.latest /
          recent.length
        )
        *
        15
        :
        0;


    const score =
      distanceScore +
      clusterScore +
      recentScore;


    if (
      score >
      bestSupportScore
    ) {

      bestSupportScore =
        score;

      bestSupport =
        x;

    }

  }


  /* =======================================================
     RESISTANCE

     保留現價上下的歷史壓力，
     避免突破後原壓力直接消失。
  ======================================================= */

  const pressureRaw = [];


  for (
    const x
    of P.highs
  ) {

    if (
      x.value >=
      price * 0.90
      &&
      x.value <=
      price * 1.35
    ) {

      pressureRaw.push({

        value:
          x.value,

        i:
          x.i

      });

    }

  }


  for (
    let end = 20;
    end <= recent.length;
    end += 10
  ) {

    const block =
      recent.slice(
        Math.max(
          0,
          end - 20
        ),
        end
      );


    if (!block.length) {
      continue;
    }


    const high =
      Math.max(
        ...block.map(
          x =>
            num(x.high)
        )
      );


    if (
      high >=
      price * 0.90
      &&
      high <=
      price * 1.35
    ) {

      pressureRaw.push({

        value:
          high,

        i:
          end

      });

    }

  }


  const allPressureGroups =
    clusterLevels(
      pressureRaw,
      mergeDistance
    )
    .filter(
      x =>
        x.value >=
        price * 0.90
        &&
        x.value <=
        price * 1.35
    )
    .sort(
      (a, b) =>
        a.value -
        b.value
    );


  const abovePressures =
    allPressureGroups
      .filter(
        x =>
          x.value >
          price +
          mergeDistance * 0.15
      );


  const recentlyCrossed =
    allPressureGroups
      .filter(
        x =>
          x.value <=
          price
          &&
          x.value >=
          price * 0.98
      )
      .sort(
        (a, b) =>
          b.value -
          a.value
      );


  const nextResistance =
    abovePressures[0]
      ?
      abovePressures[0].value
      :
      null;


  const crossedResistance =
    recentlyCrossed[0]
      ?
      recentlyCrossed[0].value
      :
      null;


  let breakout =
    nextResistance;


  let breakoutState =
    "BELOW";


  if (
    crossedResistance
  ) {

    const crossedDistance =
      (
        price -
        crossedResistance
      )
      /
      price;


    if (
      crossedDistance <=
      0.02
    ) {

      breakout =
        crossedResistance;

      breakoutState =
        "BROKEN";

    }

  }


  /* =======================================================
     ENTRY
  ======================================================= */

  let planType =
    "WAIT";

  let entryLow =
    null;

  let entryHigh =
    null;

  let entryMid =
    null;

  let sl =
    null;

  let entryReady =
    false;


  if (
    bestSupport
  ) {

    planType =
      "LIMIT";


    const base =
      bestSupport.value;


    entryLow =
      base -
      Math.max(
        A * 0.18,
        price * 0.002
      );


    entryHigh =
      base +
      Math.max(
        A * 0.30,
        price * 0.0035
      );


    entryHigh =
      Math.min(
        entryHigh,
        price * 1.006
      );


    entryMid =
      (
        entryLow +
        entryHigh
      )
      /
      2;


    /* =====================================================
       SL
    ===================================================== */

    const lowerStructures =
      [
        ...P.lows.map(
          x =>
            x.value
        ),

        ...supportGroups.map(
          x =>
            x.value
        )
      ]
      .filter(
        value =>
          value <
          base -
          mergeDistance * 0.20
          &&
          value >=
          base * 0.90
      )
      .sort(
        (a, b) =>
          b - a
      );


    const invalidation =
      lowerStructures[0]
      ||
      support2
      ||
      (
        base -
        A * 0.80
      );


    sl =
      invalidation -
      Math.max(
        A * 0.25,
        price * 0.003
      );


    if (
      sl >=
      entryLow
    ) {

      sl =
        entryLow -
        Math.max(
          A * 0.45,
          price * 0.005
        );

    }


    const readyTolerance =
      Math.max(
        A * 0.25,
        price * 0.0035
      );


    entryReady =
      price >=
      entryLow -
      readyTolerance
      &&
      price <=
      entryHigh +
      readyTolerance;

  }


  /* =======================================================
     TARGET

     breakout 本身不是 TP1。

     TP1 =
     breakout 上方第一個有效歷史壓力。
  ======================================================= */

  let tp1 =
    null;

  let tp2 =
    null;

  let tp3 =
    null;

  let tp3Source =
    "";


  if (
    Number.isFinite(entryMid)
    &&
    breakout
  ) {

    const targetPressures =
      allPressureGroups
        .map(
          x =>
            x.value
        )
        .filter(
          value =>
            value >
            breakout +
            mergeDistance * 0.55
        )
        .sort(
          (a, b) =>
            a - b
        );


    const cleanTargets = [];


    for (
      const value
      of targetPressures
    ) {

      const last =
        cleanTargets[
          cleanTargets.length - 1
        ];


      if (
        !last
        ||
        value -
        last >
        mergeDistance * 0.75
      ) {

        cleanTargets.push(
          value
        );

      }

    }


    tp1 =
      cleanTargets[0]
      ||
      null;


    tp2 =
      tp1
        ?
        cleanTargets.find(
          value =>
            value >
            tp1 +
            mergeDistance
        )
        ||
        null
        :
        null;


    tp3 =
      tp2
        ?
        cleanTargets.find(
          value =>
            value >
            tp2 +
            mergeDistance
        )
        ||
        null
        :
        null;


    if (tp3) {

      tp3Source =
        "第三層歷史壓力";

    }


    /*
      只有 TP1、TP2 已經存在，
      TP3 才允許使用延伸。
    */

    if (
      !tp3
      &&
      tp1
      &&
      tp2
    ) {

      const extensionBase =
        support2
        ||
        support1
        ||
        entryMid;


      tp3 =
        tp2 +
        Math.max(
          tp2 -
          extensionBase,
          A * 3
        )
        *
        0.618;


      tp3Source =
        "歷史壓力不足，Fib 0.618 延伸";

    }

  }


  /* =======================================================
     RISK / RR
  ======================================================= */

  const risk =
    Number.isFinite(entryMid)
    &&
    Number.isFinite(sl)
    &&
    entryMid > sl
      ?
      entryMid -
      sl
      :
      null;


  const riskPct =
    risk
      ?
      risk /
      entryMid *
      100
      :
      null;


  function rr(target) {

    if (
      !Number.isFinite(target)
      ||
      !risk
      ||
      risk <= 0
    ) {

      return null;

    }


    return (
      target -
      entryMid
    )
    /
    risk;

  }


  const rr1 =
    rr(tp1);

  const rr2 =
    rr(tp2);

  const rr3 =
    rr(tp3);


  const entryDistance =
    bestSupport
      ?
      (
        price -
        bestSupport.value
      )
      /
      price *
      100
      :
      null;


  const breakoutDistance =
    breakout
      ?
      (
        breakout -
        price
      )
      /
      price *
      100
      :
      null;


  const validPlan =
    planType ===
    "LIMIT"
    &&
    Number.isFinite(
      entryLow
    )
    &&
    Number.isFinite(
      entryHigh
    )
    &&
    Number.isFinite(
      sl
    )
    &&
    sl <
    entryLow
    &&
    Number.isFinite(
      breakout
    )
    &&
    Number.isFinite(
      tp1
    )
    &&
    tp1 >
    breakout;


  return {

    support1,
    support2,

    bestSupport:
      bestSupport
        ?
        bestSupport.value
        :
        null,

    bestSupportStrength:
      bestSupport
        ?
        bestSupport.count
        :
        0,

    breakout,
    breakoutState,

    nextResistance,
    crossedResistance,

    planType,

    entryLow,
    entryHigh,
    entryMid,

    sl,

    risk,
    riskPct,

    tp1,
    tp2,
    tp3,

    tp3Source,

    rr1,
    rr2,
    rr3,

    entryReady,
    validPlan,

    entryDistance,
    breakoutDistance,

    pressureCount:
      allPressureGroups.length

  };

}


/* =========================================================
   FIVE CATEGORY ANALYSIS
========================================================= */

function analyzeStock(
  data,
  newsData = null
) {

  const rows =
    Array.isArray(
      data.rows
    )
      ?
      data.rows
        .map(
          x => ({

            date:
              x.date || "",

            open:
              num(x.open),

            high:
              num(x.high),

            low:
              num(x.low),

            close:
              num(x.close),

            volume:
              num(x.volume)

          })
        )
        .filter(
          x =>
            x.close > 0
            &&
            x.high > 0
            &&
            x.low > 0
        )
      :
      [];


  if (
    rows.length <
    60
  ) {

    return {

      eligible:
        false,

      reason:
        "歷史資料不足"

    };

  }


  let price =
    num(
      data.price
    );


  if (!price) {

    price =
      rows[
        rows.length - 1
      ].close;

  }


  const closes =
    rows.map(
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


  const m120 =
    sma(
      closes,
      120
    );


  const A =
    Math.max(
      atr(
        rows,
        14
      ),
      price * 0.006
    );


  const R =
    rsi(
      closes,
      14
    );


  const macd =
    ema(
      closes.slice(-120),
      12
    )
    -
    ema(
      closes.slice(-120),
      26
    );


  const macdSeries =
    closes
      .slice(-120)
      .map(
        (_, i, arr) => {

          const part =
            arr.slice(
              0,
              i + 1
            );

          return (
            ema(
              part,
              12
            )
            -
            ema(
              part,
              26
            )
          );

        }
      );


  const signal =
    ema(
      macdSeries,
      9
    );


  const currentVolume =
    num(
      data.volume
    )
    ||
    rows[
      rows.length - 1
    ].volume;


  const volumeAverage =
    avg(
      rows
        .slice(-21, -1)
        .map(
          x =>
            x.volume
        )
        .filter(
          x =>
            x > 0
        )
    );


  const vr =
    volumeAverage
      ?
      currentVolume /
      volumeAverage
      :
      0;


  const high20 =
    Math.max(
      ...rows
        .slice(-20)
        .map(
          x =>
            x.high
        )
    );


  /* =======================================================
     TECHNICAL 20
  ======================================================= */

  let technical = 0;


  if (
    price >=
    m20
  ) {

    technical += 4;

  }


  if (
    m20 >
    m60
  ) {

    technical += 5;

  }


  if (
    m60 >=
    m120 * 0.985
  ) {

    technical += 3;

  }


  if (
    R >= 45
    &&
    R <= 75
  ) {

    technical += 3;

  }


  if (
    macd >=
    signal
  ) {

    technical += 3;

  }


  if (
    price >=
    high20 * 0.96
  ) {

    technical += 2;

  }


  technical =
    clamp(
      technical,
      0,
      20
    );


  /* =======================================================
     VOLUME PRICE 20
  ======================================================= */

  let volumeScore = 0;


  if (
    vr >= 1
  ) {

    volumeScore += 6;

  }
  else if (
    vr >= 0.8
  ) {

    volumeScore += 4;

  }
  else if (
    vr >= 0.6
  ) {

    volumeScore += 2;

  }


  const changePercent =
    num(
      data.changePercent
    );


  if (
    changePercent > 0
    &&
    vr >= 1
  ) {

    volumeScore += 5;

  }
  else if (
    changePercent >= 0
  ) {

    volumeScore += 3;

  }


  let upVolumeDays = 0;


  const last10 =
    rows.slice(-10);


  for (
    let i = 1;
    i < last10.length;
    i++
  ) {

    if (
      last10[i].close >
      last10[i - 1].close
      &&
      last10[i].volume >=
      volumeAverage * 0.8
    ) {

      upVolumeDays++;

    }

  }


  volumeScore +=
    clamp(
      upVolumeDays,
      0,
      5
    );


  if (
    price >=
    high20 * 0.98
    &&
    vr >=
    1.1
  ) {

    volumeScore += 4;

  }


  volumeScore =
    clamp(
      volumeScore,
      0,
      20
    );


  /* =======================================================
     INSTITUTIONAL 20
  ======================================================= */

  let chipScore = 0;


  const inst =
    data.institutional ||
    {};


  if (
    num(inst.total5) > 0
  ) {

    chipScore += 5;

  }


  if (
    num(inst.foreign5) > 0
  ) {

    chipScore += 4;

  }


  if (
    num(inst.trust5) > 0
  ) {

    chipScore += 4;

  }


  if (
    num(inst.total10) > 0
  ) {

    chipScore += 3;

  }


  if (
    num(
      inst.totalBuyDays5
    ) >= 3
  ) {

    chipScore += 2;

  }


  if (
    num(
      inst.foreignBuyDays5
    ) >= 3
  ) {

    chipScore += 2;

  }


  chipScore =
    clamp(
      chipScore,
      0,
      20
    );


  /* =======================================================
     FUNDAMENTAL 20
  ======================================================= */

  const fundamental =
    data.fundamental ||
    {};


  const revenue =
    fundamental.revenue ||
    {};


  const financial =
    fundamental.financial ||
    {};


  const fundAvailable =
    !!(
      revenue.available
      ||
      financial.available
    );


  let fundScore =
    null;


  if (
    fundAvailable
  ) {

    fundScore = 0;


    if (
      financial.profitable ===
      true
    ) {

      fundScore += 6;

    }
    else if (
      financial.profitable ===
      undefined
      ||
      financial.profitable ===
      null
    ) {

      fundScore += 3;

    }


    if (
      Number.isFinite(
        Number(
          financial.eps
        )
      )
      &&
      Number(
        financial.eps
      ) > 0
    ) {

      fundScore += 4;

    }


    if (
      Number.isFinite(
        Number(
          financial.epsGrowth
        )
      )
      &&
      Number(
        financial.epsGrowth
      ) > 0
    ) {

      fundScore += 3;

    }


    if (
      Number.isFinite(
        Number(
          revenue.yoy
        )
      )
    ) {

      if (
        Number(
          revenue.yoy
        ) > 10
      ) {

        fundScore += 4;

      }
      else if (
        Number(
          revenue.yoy
        ) > 0
      ) {

        fundScore += 3;

      }

    }


    if (
      Number.isFinite(
        Number(
          revenue.mom
        )
      )
      &&
      Number(
        revenue.mom
      ) > 0
    ) {

      fundScore += 3;

    }


    fundScore =
      clamp(
        fundScore,
        0,
        20
      );

  }


  /* =======================================================
     NEWS 20
  ======================================================= */

  let newsScore =
    null;


  if (
    newsData?.available
  ) {

    newsScore =
      clamp(
        Math.round(
          10 +
          Number(
            newsData.overallScore ||
            0
          )
        ),
        0,
        20
      );

  }


  /* =======================================================
     NORMALIZED SCORE
  ======================================================= */

  const availableScores =
    [
      technical,
      volumeScore,
      chipScore,
      fundScore,
      newsScore
    ]
    .filter(
      x =>
        x !== null
        &&
        Number.isFinite(
          Number(x)
        )
    );


  const completeness =
    availableScores.length
      /
      5
      *
      100;


  const score =
    availableScores.length
      ?
      clamp(
        Math.round(
          availableScores.reduce(
            (sum, x) =>
              sum +
              Number(x),
            0
          )
          /
          (
            availableScores.length *
            20
          )
          *
          100
        ),
        0,
        100
      )
      :
      0;


  /* =======================================================
     TRADE PLAN
  ======================================================= */

  const plan =
    buildTradePlan(
      rows,
      price,
      A,
      m20,
      m60
    );


  /* =======================================================
     FORMAL PUSH CONDITIONS
  ======================================================= */

  let eligible =
    true;


  let reason =
    "符合正式進場條件";


  if (
    score <
    75
  ) {

    eligible =
      false;

    reason =
      `綜合評分 ${score}，未達 75`;

  }
  else if (
    completeness <
    60
  ) {

    eligible =
      false;

    reason =
      `資料完整度 ${completeness.toFixed(0)}%，不足 60%`;

  }
  else if (
    technical <
    12
  ) {

    eligible =
      false;

    reason =
      `技術面 ${technical}/20，未達 12`;

  }
  else if (
    volumeScore <
    10
  ) {

    eligible =
      false;

    reason =
      `量價 ${volumeScore}/20，未達 10`;

  }
  else if (
    plan.planType !==
    "LIMIT"
  ) {

    eligible =
      false;

    reason =
      "現價附近沒有合理限價 Entry";

  }
  else if (
    !plan.entryReady
  ) {

    eligible =
      false;

    reason =
      "交易計畫成立，但目前尚未進入最佳 Entry 區";

  }
  else if (
    !plan.validPlan
  ) {

    eligible =
      false;

    reason =
      "Entry / SL / 突破位 / TP1 尚未形成完整交易計畫";

  }
  else if (
    !Number.isFinite(
      plan.riskPct
    )
  ) {

    eligible =
      false;

    reason =
      "無法計算停損風險";

  }
  else if (
    plan.riskPct >
    5
  ) {

    eligible =
      false;

    reason =
      `停損風險 ${plan.riskPct.toFixed(2)}%，超過 5%`;

  }
  else if (
    !Number.isFinite(
      plan.rr1
    )
    ||
    plan.rr1 <
    1.3
  ) {

    eligible =
      false;

    reason =
      "TP1 風報比未達 1.3R";

  }


  return {

    eligible,
    reason,

    symbol:
      String(
        data.symbol ||
        ""
      ),

    name:
      data.name
      ||
      data.symbol
      ||
      "台股",

    price,

    score,
    completeness,

    technical,
    volumeScore,
    chipScore,
    fundScore,
    newsScore,

    m20,
    m60,
    m120,

    RSI:
      R,

    ATR:
      A,

    volumeRatio:
      vr,

    ...plan

  };

}


/* =========================================================
   ORIGIN
========================================================= */

function getOrigin(req) {

  const host =
    req.headers[
      "x-forwarded-host"
    ]
    ||
    req.headers.host;


  const proto =
    req.headers[
      "x-forwarded-proto"
    ]
    ||
    "https";


  return (
    `${proto}://${host}`
  );

}


/* =========================================================
   FETCH STOCK
========================================================= */

async function fetchStock(
  origin,
  symbol
) {

  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      22000
    );


  try {

    const response =
      await fetch(
        `${origin}/api/stock?symbol=${encodeURIComponent(symbol)}&t=${Date.now()}`,
        {
          cache:
            "no-store",

          signal:
            controller.signal
        }
      );


    if (
      !response.ok
    ) {

      throw new Error(
        `stock ${symbol} HTTP ${response.status}`
      );

    }


    const json =
      await response.json();


    if (
      !json ||
      json.ok === false
    ) {

      throw new Error(
        json?.error ||
        `stock ${symbol} failed`
      );

    }


    return json;

  }
  finally {

    clearTimeout(
      timer
    );

  }

}


/* =========================================================
   FETCH NEWS
========================================================= */

async function fetchNews(
  origin,
  symbol
) {

  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      10000
    );


  try {

    const response =
      await fetch(
        `${origin}/api/news?symbol=${encodeURIComponent(symbol)}&t=${Date.now()}`,
        {
          cache:
            "no-store",

          signal:
            controller.signal
        }
      );


    if (
      !response.ok
    ) {

      return {
        available:
          false
      };

    }


    const json =
      await response.json();


    if (
      !json ||
      json.ok === false
    ) {

      return {
        available:
          false
      };

    }


    return json;

  }
  catch {

    return {
      available:
        false
    };

  }
  finally {

    clearTimeout(
      timer
    );

  }

}


/* =========================================================
   CONCURRENCY
========================================================= */

async function mapLimit(
  items,
  limit,
  worker
) {

  const result =
    new Array(
      items.length
    );


  let cursor = 0;


  async function runner() {

    while (true) {

      const index =
        cursor++;


      if (
        index >=
        items.length
      ) {

        break;

      }


      try {

        result[index] =
          await worker(
            items[index],
            index
          );

      }
      catch (error) {

        result[index] = {

          error:
            error?.message ||
            String(error)

        };

      }

    }

  }


  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          )
      },
      () =>
        runner()
    )
  );


  return result;

}


/* =========================================================
   DEVICE SYMBOLS
========================================================= */

function normalizeSymbols(
  symbols
) {

  const list =
    Array.isArray(symbols)
      ?
      symbols
      :
      [];


  return [
    ...new Set(
      list
        .map(
          x =>
            String(x)
              .trim()
        )
        .filter(
          x =>
            /^\d{4,6}$/
              .test(x)
        )
    )
  ];

}


function symbolsForDevice(
  device
) {

  const saved =
    normalizeSymbols(
      device?.symbols
    );


  return [
    ...new Set([
      ...DEFAULT_SYMBOLS,
      ...saved
    ])
  ];

}


/* =========================================================
   DEDUPE
========================================================= */

function setupFingerprint(
  symbol,
  analysis
) {

  return [

    symbol,

    fmtPrice(
      analysis.bestSupport
    ),

    fmtPrice(
      analysis.entryLow
    ),

    fmtPrice(
      analysis.entryHigh
    ),

    fmtPrice(
      analysis.breakout
    ),

    fmtPrice(
      analysis.tp1
    )

  ].join(":");

}


async function acquireNotificationLock(
  deviceId,
  symbol,
  analysis,
  testMode = false
) {

  /*
    測試模式不做 6 小時去重。
  */

  if (
    testMode
  ) {

    return true;

  }


  const fingerprint =
    setupFingerprint(
      symbol,
      analysis
    );


  const safeFingerprint =
    fingerprint.replace(
      /[^a-zA-Z0-9:._-]/g,
      "_"
    );


  const key =
    `swing:push:sent:${deviceId}:${safeFingerprint}`;


  const result =
    await redis([
      "SET",
      key,
      "1",
      "NX",
      "EX",
      "21600"
    ]);


  return (
    result ===
    "OK"
  );

}


/* =========================================================
   PAYLOAD
========================================================= */

function buildPayload(
  stock,
  analysis
) {

  const title =
    `📈 ${analysis.name} ${stock.symbol} 最佳進場區`;


  const parts = [

    `評分 ${analysis.score}/100`,

    `現價 ${fmtPrice(analysis.price)}`,

    `Entry ${fmtPrice(analysis.entryLow)}～${fmtPrice(analysis.entryHigh)}`,

    `SL ${fmtPrice(analysis.sl)}`,

    `突破 ${fmtPrice(analysis.breakout)}`,

    `TP1 ${fmtPrice(analysis.tp1)}`,

    `${analysis.rr1.toFixed(2)}R`

  ];


  if (
    analysis.tp2
  ) {

    parts.push(
      `TP2 ${fmtPrice(analysis.tp2)}`
    );

  }


  if (
    analysis.tp3
  ) {

    parts.push(
      `TP3 ${fmtPrice(analysis.tp3)}`
    );

  }


  return JSON.stringify({

    title,

    body:
      parts.join("｜"),

    tag:
      `entry-${stock.symbol}`,

    url:
      `/?symbol=${encodeURIComponent(stock.symbol)}`,

    symbol:
      stock.symbol

  });

}


/* =========================================================
   SEND PUSH
========================================================= */

async function sendPush(
  deviceId,
  device,
  stock,
  analysis,
  testMode = false
) {

  if (
    !device?.subscription
  ) {

    return {

      ok:
        false,

      reason:
        "device 沒有 subscription"

    };

  }


  const locked =
    await acquireNotificationLock(
      deviceId,
      stock.symbol,
      analysis,
      testMode
    );


  if (
    !locked
  ) {

    return {

      ok:
        false,

      duplicate:
        true,

      reason:
        "同一訊號已通知"

    };

  }


  const payload =
    buildPayload(
      stock,
      analysis
    );


  try {

    await webpush
      .sendNotification(
        device.subscription,
        payload,
        {
          TTL:
            120,

          urgency:
            "high"
        }
      );


    return {
      ok:
        true
    };

  }
  catch (error) {

    const status =
      error?.statusCode
      ||
      error?.status;


    if (
      status === 404
      ||
      status === 410
    ) {

      await removeDevice(
        deviceId
      );

    }


    throw error;

  }

}


/* =========================================================
   AUTH
========================================================= */

function authorized(
  req,
  testMode
) {

  const secret =
    process.env.CRON_SECRET;


  if (!secret) {

    return false;

  }


  const auth =
    req.headers.authorization
    ||
    "";


  /*
    monitor-test bridge
    一樣會帶 Authorization。

    正式 cron 也使用同一組 CRON_SECRET。
  */

  return (
    auth ===
    `Bearer ${secret}`
  );

}


/* =========================================================
   MAIN
========================================================= */

module.exports =
async function handler(
  req,
  res
) {

  if (
    req.method !==
    "GET"
  ) {

    res.setHeader(
      "Allow",
      "GET"
    );


    return send(
      res,
      405,
      {
        ok:
          false,

        error:
          "Method Not Allowed"
      }
    );

  }


  const testMode =
    getTestMode(req);


  if (
    !authorized(
      req,
      testMode
    )
  ) {

    return send(
      res,
      401,
      {
        ok:
          false,

        error:
          "Unauthorized"
      }
    );

  }


  try {

    configurePush();


    /* =====================================================
       MARKET TIME

       正式模式：
       08:55～13:40

       test=1：
       可跳過時間限制。
    ===================================================== */

    if (
      !testMode
      &&
      !isMarketMonitoringTime()
    ) {

      return send(
        res,
        200,
        {

          ok:
            true,

          engine:
            "Stock Analysis Monitor 8.0",

          skipped:
            true,

          reason:
            "目前非台股監控時段",

          marketWindow:
            "Asia/Taipei 08:55-13:40"

        }
      );

    }


    /* =====================================================
       DEVICES
    ===================================================== */

    const deviceIds =
      await getDeviceIds();


    if (
      !deviceIds.length
    ) {

      return send(
        res,
        200,
        {

          ok:
            true,

          engine:
            "Stock Analysis Monitor 8.0",

          skipped:
            true,

          reason:
            "目前沒有 Push 訂閱裝置"

        }
      );

    }


    const devicesRaw =
      await mapLimit(
        deviceIds,
        5,
        async deviceId => ({

          deviceId,

          device:
            await getDevice(
              deviceId
            )

        })
      );


    const devices =
      devicesRaw.filter(
        x =>
          x
          &&
          !x.error
          &&
          x.device
          &&
          x.device.subscription
      );


    if (
      !devices.length
    ) {

      return send(
        res,
        200,
        {

          ok:
            true,

          engine:
            "Stock Analysis Monitor 8.0",

          skipped:
            true,

          reason:
            "沒有有效 Push subscription"

        }
      );

    }


    /* =====================================================
       SYMBOLS

       仍然只有：
       DEFAULT 12 + 使用者自選

       不把全市場 Radar 全塞進 Push。
    ===================================================== */

    const allSymbols =
      [
        ...new Set(
          devices.flatMap(
            x =>
              symbolsForDevice(
                x.device
              )
          )
        )
      ];


    const origin =
      getOrigin(req);


    /* =====================================================
       STOCK ANALYSIS

       第一階段：
       先抓 Stock。

       只有初步條件不差的股票，
       才抓新聞。
    ===================================================== */

    const stockResults =
      await mapLimit(
        allSymbols,
        3,
        async symbol => {

          const data =
            await fetchStock(
              origin,
              symbol
            );


          /*
            先不帶新聞分析一次。
          */

          const preliminary =
            analyzeStock(
              data,
              null
            );


          /*
            新聞不是每一檔都硬抓。

            初步：
            技術 >= 10
            量價 >= 8
            才補新聞。
          */

          let newsData =
            null;


          if (
            preliminary.technical >=
            10
            &&
            preliminary.volumeScore >=
            8
          ) {

            newsData =
              await fetchNews(
                origin,
                symbol
              );

          }


          const analysis =
            analyzeStock(
              data,
              newsData
            );


          return {

            symbol,
            data,
            analysis

          };

        }
      );


    const stockMap =
      new Map();


    for (
      let i = 0;
      i < allSymbols.length;
      i++
    ) {

      const result =
        stockResults[i];


      if (
        result
        &&
        !result.error
      ) {

        stockMap.set(
          allSymbols[i],
          result
        );

      }

    }


    /* =====================================================
       PUSH
    ===================================================== */

    let eligibleCount = 0;
    let pushSent = 0;
    let duplicateCount = 0;
    let pushErrors = 0;


    const signals = [];


    const checkedStocks = [];


    /*
      測試模式時，
      回傳分析結果，
      方便直接看 Monitor 到底算了什麼。
    */

    for (
      const symbol
      of allSymbols
    ) {

      const stock =
        stockMap.get(
          symbol
        );


      if (!stock) {

        checkedStocks.push({

          symbol,

          ok:
            false,

          reason:
            "股票資料取得失敗"

        });

        continue;

      }


      const a =
        stock.analysis;


      checkedStocks.push({

        symbol,

        name:
          a.name,

        price:
          a.price,

        score:
          a.score,

        completeness:
          a.completeness,

        technical:
          a.technical,

        volumeScore:
          a.volumeScore,

        chipScore:
          a.chipScore,

        fundScore:
          a.fundScore,

        newsScore:
          a.newsScore,

        planType:
          a.planType,

        support1:
          a.support1,

        support2:
          a.support2,

        bestSupport:
          a.bestSupport,

        entryLow:
          a.entryLow,

        entryHigh:
          a.entryHigh,

        entryReady:
          a.entryReady,

        sl:
          a.sl,

        breakout:
          a.breakout,

        breakoutState:
          a.breakoutState,

        tp1:
          a.tp1,

        tp2:
          a.tp2,

        tp3:
          a.tp3,

        rr1:
          a.rr1,

        riskPct:
          a.riskPct,

        eligible:
          a.eligible,

        reason:
          a.reason

      });

    }


    for (
      const item
      of devices
    ) {

      const symbols =
        symbolsForDevice(
          item.device
        );


      for (
        const symbol
        of symbols
      ) {

        const stock =
          stockMap.get(
            symbol
          );


        if (!stock) {
          continue;
        }


        const analysis =
          stock.analysis;


        if (
          !analysis?.eligible
        ) {

          continue;

        }


        eligibleCount++;


        signals.push({

          symbol,

          name:
            analysis.name,

          score:
            analysis.score,

          price:
            analysis.price,

          bestSupport:
            analysis.bestSupport,

          entryLow:
            analysis.entryLow,

          entryHigh:
            analysis.entryHigh,

          sl:
            analysis.sl,

          breakout:
            analysis.breakout,

          tp1:
            analysis.tp1,

          tp2:
            analysis.tp2,

          tp3:
            analysis.tp3,

          rr1:
            analysis.rr1

        });


        try {

          const result =
            await sendPush(
              item.deviceId,
              item.device,
              {
                ...stock.data,
                symbol
              },
              analysis,
              testMode
            );


          if (
            result.ok
          ) {

            pushSent++;

          }
          else if (
            result.duplicate
          ) {

            duplicateCount++;

          }

        }
        catch (error) {

          pushErrors++;


          console.error(
            `push ${symbol} error:`,
            error?.message ||
            error
          );

        }

      }

    }


    /* =====================================================
       FAILED STOCKS
    ===================================================== */

    const failedStocks =
      stockResults
        .map(
          (x, i) =>
            x?.error
              ?
              {

                symbol:
                  allSymbols[i],

                error:
                  x.error

              }
              :
              null
        )
        .filter(Boolean);


    /* =====================================================
       RESPONSE
    ===================================================== */

    return send(
      res,
      200,
      {

        ok:
          true,

        engine:
          "Stock Analysis Monitor 8.0",

        strategy:
          "NEAR_PRICE_LIMIT_ENTRY",

        marketWindow:
          "Asia/Taipei 08:55-13:40",

        testMode,

        monitoredDevices:
          devices.length,

        monitoredSymbols:
          allSymbols.length,

        eligibleSignals:
          eligibleCount,

        pushSent,

        duplicateCount,

        pushErrors,

        failedStocks,

        signals,

        checkedStocks:
          testMode
            ?
            checkedStocks
            :
            undefined

      }
    );

  }
  catch (error) {

    console.error(
      "monitor error:",
      error
    );


    return send(
      res,
      500,
      {

        ok:
          false,

        engine:
          "Stock Analysis Monitor 8.0",

        error:
          error?.message ||
          "Monitor failed"

      }
    );

  }

};
