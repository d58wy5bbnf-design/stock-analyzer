const webpush = require("web-push");

/* =========================================================
   妖子平台｜台股背景波段進場監控

   核心：
   SMC 支撐
   → Entry
   → 結構 SL
   → 關鍵突破
   → TP1
   → TP2
   → TP3

   正式 Push：
   - 7/8、8/8
   - 必須有有效 SMC 支撐
   - 必須接近 Entry
   - TP1 至少 1.5R
   - 關鍵突破位不等於 TP
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

const DEVICE_SET_KEY = "swing:push:devices";


/* =========================================================
   Environment
========================================================= */

function env(name, ...fallbacks) {

  const names = [
    name,
    ...fallbacks
  ];

  for (const key of names) {

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
   Response
========================================================= */

function send(res, status, data) {

  res.statusCode = status;

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
   Redis
========================================================= */

async function redis(command) {

  const url =
    REDIS_URL();

  const token =
    REDIS_TOKEN();

  if (!url || !token) {

    throw new Error(
      "Redis 環境變數不存在"
    );

  }

  const response =
    await fetch(
      url,
      {
        method: "POST",

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
      .catch(() => ({}));

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
    ? result
    : [];

}

async function getDevice(deviceId) {

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

async function removeDevice(deviceId) {

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
   Push
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
    !/^https?:\/\//i.test(subject)
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
        x => x.type === type
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
   Math
========================================================= */

function num(v) {

  const n =
    Number(v);

  return Number.isFinite(n)
    ? n
    : 0;

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
    ) /
    arr.length
  );

}

function sma(values, period) {

  if (
    values.length <
    period
  ) {
    return 0;
  }

  return avg(
    values.slice(-period)
  );

}

function ema(values, period) {

  if (!values.length) {
    return 0;
  }

  const k =
    2 /
    (period + 1);

  let result =
    num(values[0]);

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

  const start =
    values.length -
    period;

  for (
    let i = start;
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

      losses +=
        Math.abs(diff);

    }

  }

  const avgGain =
    gains / period;

  const avgLoss =
    losses / period;

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain /
    avgLoss;

  return (
    100 -
    100 /
    (1 + rs)
  );

}

function atr(
  rows,
  period = 14
) {

  if (
    rows.length <
    period + 1
  ) {

    return 0;

  }

  const trs = [];

  for (
    let i =
      rows.length - period;
    i < rows.length;
    i++
  ) {

    const row =
      rows[i];

    const prev =
      rows[i - 1];

    const high =
      num(row.high);

    const low =
      num(row.low);

    const prevClose =
      num(prev.close);

    trs.push(
      Math.max(
        high - low,
        Math.abs(
          high - prevClose
        ),
        Math.abs(
          low - prevClose
        )
      )
    );

  }

  return avg(trs);

}

function fmtPrice(value) {

  const n =
    num(value);

  if (!n) {
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
   Swing
========================================================= */

function findSwingLows(
  rows,
  lookback = 2
) {

  const result = [];

  for (
    let i = lookback;
    i <
    rows.length - lookback;
    i++
  ) {

    const low =
      num(rows[i].low);

    let valid = true;

    for (
      let j =
        i - lookback;
      j <=
      i + lookback;
      j++
    ) {

      if (j === i) {
        continue;
      }

      if (
        num(rows[j].low) <
        low
      ) {

        valid = false;
        break;

      }

    }

    if (valid) {

      result.push({

        index: i,
        price: low,
        row: rows[i]

      });

    }

  }

  return result;

}

function findSwingHighs(
  rows,
  lookback = 2
) {

  const result = [];

  for (
    let i = lookback;
    i <
    rows.length - lookback;
    i++
  ) {

    const high =
      num(rows[i].high);

    let valid = true;

    for (
      let j =
        i - lookback;
      j <=
      i + lookback;
      j++
    ) {

      if (j === i) {
        continue;
      }

      if (
        num(rows[j].high) >
        high
      ) {

        valid = false;
        break;

      }

    }

    if (valid) {

      result.push({

        index: i,
        price: high,
        row: rows[i]

      });

    }

  }

  return result;

}


/* =========================================================
   Bullish Order Block
========================================================= */

function findBullishOrderBlocks(
  rows,
  price,
  A
) {

  const zones = [];

  const start =
    Math.max(
      2,
      rows.length - 120
    );

  for (
    let i = start;
    i < rows.length - 2;
    i++
  ) {

    const candle =
      rows[i];

    const open =
      num(candle.open);

    const close =
      num(candle.close);

    const high =
      num(candle.high);

    const low =
      num(candle.low);

    if (!(close < open)) {
      continue;
    }

    const n1 =
      rows[i + 1];

    const n2 =
      rows[i + 2];

    const displacement =
      Math.max(
        num(n1.close),
        num(n2.close)
      ) -
      high;

    if (
      displacement <=
      Math.max(
        A * 0.35,
        price * 0.004
      )
    ) {

      continue;

    }

    const zone = {

      type:
        "Bullish OB",

      low,

      high:
        Math.max(
          open,
          close
        ),

      index: i,

      score: 5

    };

    let invalid = false;

    for (
      let j = i + 1;
      j < rows.length;
      j++
    ) {

      if (
        num(rows[j].close) <
        zone.low
      ) {

        invalid = true;
        break;

      }

    }

    if (
      !invalid &&
      zone.low <
      price
    ) {

      zones.push(zone);

    }

  }

  return zones;

}


/* =========================================================
   Bullish FVG
========================================================= */

function findBullishFVG(
  rows,
  price,
  A
) {

  const zones = [];

  for (
    let i = 1;
    i < rows.length - 1;
    i++
  ) {

    const left =
      rows[i - 1];

    const right =
      rows[i + 1];

    if (
      num(right.low) <=
      num(left.high)
    ) {

      continue;

    }

    const gap =
      num(right.low) -
      num(left.high);

    if (
      gap <
      Math.max(
        A * 0.12,
        price * 0.0015
      )
    ) {

      continue;

    }

    const zone = {

      type:
        "Bullish FVG",

      low:
        num(left.high),

      high:
        num(right.low),

      index: i,

      score: 3.5

    };

    let invalid = false;

    for (
      let j = i + 1;
      j < rows.length;
      j++
    ) {

      if (
        num(rows[j].close) <
        zone.low
      ) {

        invalid = true;
        break;

      }

    }

    if (
      !invalid &&
      zone.low <
      price
    ) {

      zones.push(zone);

    }

  }

  return zones;

}


/* =========================================================
   Liquidity Sweep
========================================================= */

function findBullishSweeps(
  rows,
  price,
  A
) {

  const zones = [];

  const start =
    Math.max(
      8,
      rows.length - 100
    );

  for (
    let i = start;
    i < rows.length;
    i++
  ) {

    const previous =
      rows.slice(
        Math.max(
          0,
          i - 8
        ),
        i
      );

    if (!previous.length) {
      continue;
    }

    const previousLow =
      Math.min(
        ...previous.map(
          x => num(x.low)
        )
      );

    const row =
      rows[i];

    if (
      num(row.low) <
      previousLow
      &&
      num(row.close) >
      previousLow
    ) {

      const zone = {

        type:
          "Liquidity Sweep",

        low:
          num(row.low),

        high:
          previousLow,

        index: i,

        score: 5.5

      };

      let invalid = false;

      for (
        let j = i + 1;
        j < rows.length;
        j++
      ) {

        if (
          num(rows[j].close) <
          zone.low
        ) {

          invalid = true;
          break;

        }

      }

      if (
        !invalid &&
        zone.low <
        price
      ) {

        zones.push(zone);

      }

    }

  }

  return zones;

}


/* =========================================================
   Breaker
========================================================= */

function findBreakerSupports(
  rows,
  price,
  A
) {

  const highs =
    findSwingHighs(
      rows,
      2
    );

  const zones = [];

  for (const swing of highs) {

    let breakIndex = -1;

    const buffer =
      Math.max(
        A * 0.12,
        swing.price * 0.0025
      );

    for (
      let j =
        swing.index + 1;
      j < rows.length;
      j++
    ) {

      if (
        num(rows[j].close) >
        swing.price +
        buffer
      ) {

        breakIndex = j;
        break;

      }

    }

    if (breakIndex < 0) {
      continue;
    }

    let failed = false;

    for (
      let j =
        breakIndex + 1;
      j < rows.length;
      j++
    ) {

      if (
        num(rows[j].close) <
        swing.price -
        A * 0.25
      ) {

        failed = true;
        break;

      }

    }

    if (failed) {
      continue;
    }

    const zone = {

      type:
        "BOS / Breaker",

      low:
        swing.price -
        A * 0.15,

      high:
        swing.price +
        A * 0.15,

      index:
        breakIndex,

      score:
        6

    };

    if (
      zone.low <
      price
    ) {

      zones.push(zone);

    }

  }

  return zones;

}


/* =========================================================
   Swing Demand
========================================================= */

function findSwingDemand(
  rows,
  price,
  A
) {

  return findSwingLows(
    rows,
    2
  )
  .filter(
    x =>
      x.price <
      price
  )
  .map(
    x => ({

      type:
        "Swing Demand",

      low:
        x.price -
        A * 0.10,

      high:
        x.price +
        A * 0.12,

      index:
        x.index,

      score:
        3.8

    })
  );

}


/* =========================================================
   Best Support
========================================================= */

function findBestSupport(
  rows,
  price,
  A,
  institutional
) {

  const zones = [

    ...findBullishOrderBlocks(
      rows,
      price,
      A
    ),

    ...findBullishFVG(
      rows,
      price,
      A
    ),

    ...findBullishSweeps(
      rows,
      price,
      A
    ),

    ...findBreakerSupports(
      rows,
      price,
      A
    ),

    ...findSwingDemand(
      rows,
      price,
      A
    )

  ];

  if (!zones.length) {
    return null;
  }

  const volumeBase =
    avg(
      rows
      .slice(-21, -1)
      .map(
        x => num(x.volume)
      )
    );

  const chip =
    institutional || {};

  const total5 =
    num(
      chip.total5
    );

  const foreign5 =
    num(
      chip.foreign5
    );

  const trust5 =
    num(
      chip.trust5
    );

  const valid =
    zones
    .filter(
      z =>
        Number.isFinite(z.low)
        &&
        Number.isFinite(z.high)
        &&
        z.low > 0
        &&
        z.high > 0
        &&
        z.high <=
        price * 1.012
    )
    .map(
      z => {

        let score =
          num(z.score);

        const row =
          rows[z.index];

        if (
          row &&
          volumeBase > 0 &&
          num(row.volume) >=
          volumeBase * 1.35
        ) {

          score += 1.5;

        }

        if (total5 > 0) {
          score += 0.7;
        }

        if (foreign5 > 0) {
          score += 0.3;
        }

        if (trust5 > 0) {
          score += 0.3;
        }

        const distance =
          Math.max(
            0,
            price - z.high
          );

        const distancePct =
          distance /
          price;

        score -=
          distancePct * 12;

        return {

          ...z,

          finalScore:
            score

        };

      }
    )
    .filter(
      z =>
        (
          price -
          z.high
        ) /
        price <=
        0.10
    )
    .sort(
      (a, b) =>
        b.finalScore -
        a.finalScore
    );

  return valid[0] || null;

}


/* =========================================================
   上方市場結構

   這裡不再直接把最近 Swing High 當 TP。

   先建立：
   - 關鍵突破位
   - 後續獨立壓力
========================================================= */

function buildResistanceLevels(
  rows,
  price,
  A
) {

  const raw = [];

  const highs =
    findSwingHighs(
      rows,
      2
    );

  for (const h of highs) {

    if (
      h.price >
      price +
      Math.max(
        A * 0.12,
        price * 0.0015
      )
    ) {

      raw.push({

        price:
          h.price,

        type:
          "Swing High / Liquidity",

        score:
          4.5,

        index:
          h.index

      });

    }

  }


  /*
    Bearish OB / Supply
  */

  for (
    let i = 2;
    i < rows.length - 2;
    i++
  ) {

    const x =
      rows[i];

    const n2 =
      rows[i + 2];

    const open =
      num(x.open);

    const close =
      num(x.close);

    const high =
      num(x.high);

    const low =
      num(x.low);

    const displacementDown =
      num(n2.close) <
      low -
      Math.max(
        A * 0.35,
        price * 0.004
      );

    if (
      close > open &&
      displacementDown
    ) {

      const level =
        Math.min(
          open,
          close
        );

      if (
        level >
        price +
        Math.max(
          A * 0.12,
          price * 0.0015
        )
      ) {

        raw.push({

          price:
            level,

          high,

          type:
            "Bearish OB / Supply",

          score:
            5,

          index:
            i

        });

      }

    }

  }


  /*
    Bearish FVG
  */

  for (
    let i = 1;
    i < rows.length - 1;
    i++
  ) {

    const left =
      rows[i - 1];

    const right =
      rows[i + 1];

    if (
      num(right.high) <
      num(left.low)
    ) {

      const level =
        num(right.high);

      if (
        level >
        price +
        Math.max(
          A * 0.12,
          price * 0.0015
        )
      ) {

        raw.push({

          price:
            level,

          high:
            num(left.low),

          type:
            "Bearish FVG",

          score:
            3.5,

          index:
            i

        });

      }

    }

  }


  /*
    合併過度接近的壓力，
    避免 100、100.2、100.4
    被當成三個 TP。
  */

  raw.sort(
    (a, b) =>
      a.price -
      b.price
  );

  const groups = [];

  const mergeDistance =
    Math.max(
      A * 0.35,
      price * 0.004
    );

  for (const level of raw) {

    const last =
      groups[
        groups.length - 1
      ];

    if (
      last &&
      Math.abs(
        level.price -
        last.price
      ) <=
      mergeDistance
    ) {

      if (
        level.score >
        last.score
      ) {

        last.type =
          level.type;

      }

      last.score =
        Math.max(
          last.score,
          level.score
        ) + 0.4;

      last.price =
        (
          last.price +
          level.price
        ) /
        2;

      continue;

    }

    groups.push({
      ...level
    });

  }

  return groups;

}


/* =========================================================
   波段目標引擎
========================================================= */

function buildTradePlan(
  rows,
  price,
  A,
  support
) {

  if (!support) {
    return null;
  }


  /* ==============================
     Entry
  ============================== */

  const entryLow =
    support.low;

  const entryHigh =
    support.high;

  const entryMid =
    (
      entryLow +
      entryHigh
    ) /
    2;


  /* ==============================
     SL

     跟前端統一：
     0.70 ATR 或 0.8%
  ============================== */

  const slBuffer =
    Math.max(
      A * 0.70,
      price * 0.008
    );

  let stopLoss =
    support.low -
    slBuffer;

  if (
    stopLoss >=
    entryLow
  ) {

    stopLoss =
      entryLow -
      Math.max(
        A * 0.50,
        price * 0.007
      );

  }

  const risk =
    entryMid -
    stopLoss;

  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {

    return null;

  }

  const riskPct =
    risk /
    entryMid *
    100;


  /* ==============================
     Entry Ready
  ============================== */

  const entryTolerance =
    Math.max(
      A * 0.60,
      price * 0.012
    );

  const entryReady =
    price >=
    entryLow -
    Math.max(
      A * 0.15,
      price * 0.003
    )
    &&
    price <=
    entryHigh +
    entryTolerance;


  /* ==============================
     上方壓力
  ============================== */

  const resistance =
    buildResistanceLevels(
      rows.slice(-160),
      price,
      A
    );


  /*
    第一層是關鍵突破位。

    注意：
    它不是 TP1。
  */

  const breakout =
    resistance.find(
      x =>
        x.price >
        Math.max(
          price,
          entryHigh
        ) +
        Math.max(
          A * 0.15,
          price * 0.002
        )
    )
    ||
    null;


  /*
    TP 必須在突破位上方，
    不把突破位本身拿來止盈。
  */

  const breakoutPrice =
    breakout
      ? breakout.price
      : Math.max(
          price,
          entryHigh
        );


  /* ==============================
     R 倍數最低目標
  ============================== */

  const target15R =
    entryMid +
    risk * 1.5;

  const target25R =
    entryMid +
    risk * 2.5;

  const target35R =
    entryMid +
    risk * 3.5;


  /* ==============================
     ATR 波段目標
  ============================== */

  const atrTP1 =
    entryMid +
    A * 2;

  const atrTP2 =
    entryMid +
    A * 3.5;

  const atrTP3 =
    entryMid +
    A * 5;


  /* ==============================
     Swing Range / Fibonacci
  ============================== */

  const swingLows =
    findSwingLows(
      rows.slice(-160),
      2
    )
    .filter(
      x =>
        x.price <
        entryMid
    );

  let swingLow =
    entryLow;

  if (swingLows.length) {

    const candidate =
      swingLows[
        swingLows.length - 1
      ];

    if (
      candidate &&
      Number.isFinite(
        candidate.price
      )
    ) {

      swingLow =
        candidate.price;

    }

  }

  const swingHighs =
    findSwingHighs(
      rows.slice(-160),
      2
    )
    .filter(
      x =>
        x.price >
        swingLow
    );

  let swingHigh =
    Math.max(
      price,
      breakoutPrice
    );

  for (
    let i =
      swingHighs.length - 1;
    i >= 0;
    i--
  ) {

    if (
      Number.isFinite(
        swingHighs[i].price
      )
      &&
      swingHighs[i].price >
      swingLow
    ) {

      swingHigh =
        Math.max(
          swingHigh,
          swingHighs[i].price
        );

      break;

    }

  }

  let swingRange =
    swingHigh -
    swingLow;

  if (
    !Number.isFinite(
      swingRange
    )
    ||
    swingRange <= 0
  ) {

    swingRange =
      Math.max(
        A * 3,
        risk * 2
      );

  }

  const fib1272 =
    swingLow +
    swingRange * 1.272;

  const fib1618 =
    swingLow +
    swingRange * 1.618;


  /* ==============================
     TP1
  ============================== */

  const minTP1 =
    Math.max(
      target15R,
      atrTP1,
      breakoutPrice +
      Math.max(
        A * 0.35,
        price * 0.004
      )
    );

  const structureTP1 =
    resistance.find(
      x =>
        x.price >=
        minTP1
    );

  let tp1;
  let tp1Source;

  if (structureTP1) {

    tp1 =
      structureTP1.price;

    tp1Source =
      `${structureTP1.type} / SMC`;

  }
  else {

    tp1 =
      minTP1;

    tp1Source =
      "1.5R / 2ATR 波段延伸";

  }


  /* ==============================
     TP2
  ============================== */

  const minTP2 =
    Math.max(
      target25R,
      atrTP2,
      fib1272,
      tp1 +
      Math.max(
        risk,
        A
      )
    );

  const structureTP2 =
    resistance.find(
      x =>
        x.price >=
        minTP2
        &&
        x.price >
        tp1 +
        Math.max(
          A * 0.35,
          price * 0.004
        )
    );

  let tp2;
  let tp2Source;

  if (structureTP2) {

    tp2 =
      structureTP2.price;

    tp2Source =
      `${structureTP2.type} / SMC 波段壓力`;

  }
  else {

    tp2 =
      minTP2;

    tp2Source =
      "2.5R / Fib 1.272";

  }


  /* ==============================
     TP3
  ============================== */

  const minTP3 =
    Math.max(
      target35R,
      atrTP3,
      fib1618,
      tp2 +
      Math.max(
        risk,
        A * 1.25
      )
    );

  const structureTP3 =
    resistance.find(
      x =>
        x.price >=
        minTP3
        &&
        x.price >
        tp2 +
        Math.max(
          A * 0.40,
          price * 0.004
        )
    );

  let tp3;
  let tp3Source;

  if (structureTP3) {

    tp3 =
      structureTP3.price;

    tp3Source =
      `${structureTP3.type} / 高階 SMC 壓力`;

  }
  else {

    tp3 =
      minTP3;

    tp3Source =
      "3.5R / Fib 1.618 波段延伸";

  }


  /* ==============================
     真實 RR
  ============================== */

  const reward1 =
    tp1 -
    entryMid;

  const rr1 =
    reward1 /
    risk;


  return {

    entryLow,
    entryHigh,
    entryMid,

    stopLoss,

    risk,
    riskPct,

    entryReady,

    breakout:
      breakout
        ? breakout.price
        : null,

    breakoutType:
      breakout
        ? breakout.type
        : "無明確突破位",

    tp1,
    tp2,
    tp3,

    tp1Source,
    tp2Source,
    tp3Source,

    rr1

  };

}


/* =========================================================
   Institutional
========================================================= */

function institutionalBias(
  institutional
) {

  if (!institutional) {

    return {
      score: 0,
      text:
        "法人資料中性"
    };

  }

  const total5 =
    num(
      institutional.total5
    );

  const foreign5 =
    num(
      institutional.foreign5
    );

  const trust5 =
    num(
      institutional.trust5
    );

  const dealer5 =
    num(
      institutional.dealer5
    );

  const total =
    total5 ||
    (
      foreign5 +
      trust5 +
      dealer5
    );

  if (total > 0) {

    return {
      score: 0.5,
      text:
        "法人偏多"
    };

  }

  if (total < 0) {

    return {
      score: -0.25,
      text:
        "法人偏空"
    };

  }

  return {
    score: 0,
    text:
      "法人中性"
  };

}


/* =========================================================
   8 條策略 + 新波段價位
========================================================= */

function analyzeStock(data) {

  const rows =
    Array.isArray(data.rows)
      ?
      data.rows
      .map(
        x => ({

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
          x.open > 0
          &&
          x.high > 0
          &&
          x.low > 0
          &&
          x.close > 0
      )
      :
      [];

  if (
    rows.length <
    60
  ) {

    return {

      eligible: false,

      reason:
        "歷史資料不足"

    };

  }

  const price =
    num(data.price)
    ||
    num(
      rows[
        rows.length - 1
      ].close
    );

  if (!price) {

    return {

      eligible: false,

      reason:
        "無目前價格"

    };

  }

  const closes =
    rows.map(
      x => x.close
    );

  const volumes =
    rows.map(
      x => x.volume
    );

  const MA20 =
    sma(
      closes,
      20
    );

  const MA60 =
    sma(
      closes,
      60
    );

  const A =
    Math.max(
      atr(
        rows,
        14
      ),
      price * 0.006
    );

  const RSI =
    rsi(
      closes,
      14
    );

  const EMA12 =
    ema(
      closes.slice(-100),
      12
    );

  const EMA26 =
    ema(
      closes.slice(-100),
      26
    );

  const support20 =
    Math.min(
      ...rows
      .slice(-20)
      .map(
        x => x.low
      )
    );

  const resistance20 =
    Math.max(
      ...rows
      .slice(-20)
      .map(
        x => x.high
      )
    );

  const high60 =
    Math.max(
      ...rows
      .slice(-60)
      .map(
        x => x.high
      )
    );

  const currentVolume =
    num(data.volume)
    ||
    volumes[
      volumes.length - 1
    ];

  const avgVolume20 =
    avg(
      volumes
      .slice(-21, -1)
      .filter(
        x => x > 0
      )
    );

  const volumeRatio =
    avgVolume20 > 0
      ?
      currentVolume /
      avgVolume20
      :
      0;


  /* ==============================
     8 條策略
  ============================== */

  const conditions = [

    {
      name:
        "MA20 > MA60",

      pass:
        MA20 > MA60
    },

    {
      name:
        "股價守 MA60",

      pass:
        price >=
        MA60 * 0.985
    },

    {
      name:
        "距 MA20 不過遠",

      pass:
        Math.abs(
          price -
          MA20
        ) <=
        A * 2.2
    },

    {
      name:
        "守住 20 日支撐",

      pass:
        price >=
        support20 * 0.99
    },

    {
      name:
        "RSI 45～72",

      pass:
        RSI >= 45
        &&
        RSI <= 72
    },

    {
      name:
        "EMA 動能",

      pass:
        EMA12 -
        EMA26 >=
        -A * 0.05
    },

    {
      name:
        "量能",

      pass:
        volumeRatio >=
        0.8
    },

    {
      name:
        "上方仍有空間",

      pass:
        Math.max(
          resistance20,
          high60
        ) >
        price * 1.025
    }

  ];

  const passed =
    conditions
    .filter(
      x => x.pass
    )
    .length;


  /*
    正式 Push：
    7/8、8/8
  */

  if (
    passed < 7
  ) {

    return {

      eligible: false,

      passed,

      conditions,

      reason:
        `${passed}/8，未達正式 Push 條件`

    };

  }


  /* ==============================
     SMC 支撐
  ============================== */

  const support =
    findBestSupport(
      rows.slice(-160),
      price,
      A,
      data.institutional
    );

  if (!support) {

    return {

      eligible: false,

      passed,

      conditions,

      reason:
        "沒有有效 SMC 支撐結構"

    };

  }


  /* ==============================
     Trade Plan
  ============================== */

  const plan =
    buildTradePlan(
      rows,
      price,
      A,
      support
    );

  if (!plan) {

    return {

      eligible: false,

      passed,

      conditions,

      support,

      reason:
        "無法建立有效波段交易計畫"

    };

  }


  /*
    必須接近 Entry。
  */

  if (
    !plan.entryReady
  ) {

    return {

      eligible: false,

      passed,

      conditions,

      support,

      plan,

      reason:
        "策略成立，但目前不在好的進場位置"

    };

  }


  /*
    SL 風險過大：
    不推播。

    不會把 SL 硬拉到 5%，
    而是等待更好的 Entry。
  */

  if (
    plan.riskPct >
    5
  ) {

    return {

      eligible: false,

      passed,

      conditions,

      support,

      plan,

      reason:
        `結構停損距離 ${plan.riskPct.toFixed(2)}%，風險偏大`

    };

  }


  /*
    TP1 必須至少 1.5R。
  */

  if (
    !Number.isFinite(
      plan.rr1
    )
    ||
    plan.rr1 <
    1.5
  ) {

    return {

      eligible: false,

      passed,

      conditions,

      support,

      plan,

      reason:
        "第一波段目標風報比不足"

    };

  }


  const inst =
    institutionalBias(
      data.institutional
    );


  return {

    eligible: true,

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

    passed,

    ATR: A,
    RSI,
    MA20,
    MA60,

    volumeRatio,

    conditions,

    support,

    entryLow:
      plan.entryLow,

    entryHigh:
      plan.entryHigh,

    stopLoss:
      plan.stopLoss,

    riskPct:
      plan.riskPct,

    breakout:
      plan.breakout,

    breakoutType:
      plan.breakoutType,

    tp1:
      plan.tp1,

    tp2:
      plan.tp2,

    tp3:
      plan.tp3,

    tp1Source:
      plan.tp1Source,

    tp2Source:
      plan.tp2Source,

    tp3Source:
      plan.tp3Source,

    rr1:
      plan.rr1,

    institutional:
      inst

  };

}


/* =========================================================
   Stock API
========================================================= */

function getOrigin(req) {

  const forwarded =
    req.headers[
      "x-forwarded-host"
    ];

  const host =
    forwarded ||
    req.headers.host;

  const protoHeader =
    req.headers[
      "x-forwarded-proto"
    ];

  const proto =
    protoHeader ||
    "https";

  return (
    `${proto}://${host}`
  );

}

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
        `${origin}/api/stock?symbol=${encodeURIComponent(symbol)}`,
        {
          headers: {

            "Cache-Control":
              "no-cache"

          },

          signal:
            controller.signal
        }
      );

    if (!response.ok) {

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

    clearTimeout(timer);

  }

}


/* =========================================================
   Concurrency
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
      () => runner()
    )
  );

  return result;

}


/* =========================================================
   Device symbols
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
          /^\d{4,6}$/.test(x)
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
   Dedupe
========================================================= */

function setupFingerprint(
  symbol,
  analysis
) {

  const low =
    fmtPrice(
      analysis.support.low
    );

  const high =
    fmtPrice(
      analysis.support.high
    );

  const breakout =
    fmtPrice(
      analysis.breakout
    );

  return [

    symbol,

    analysis.support.type,

    low,

    high,

    breakout,

    analysis.passed

  ].join(":");

}

async function acquireNotificationLock(
  deviceId,
  symbol,
  analysis
) {

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
    result === "OK"
  );

}


/* =========================================================
   Notification
========================================================= */

function buildPayload(
  stock,
  analysis
) {

  const title =
    `📈 ${analysis.name} ${stock.symbol} 波段進場訊號`;

  const parts = [

    `${analysis.passed}/8 強勢成立`,

    `現價 ${fmtPrice(analysis.price)}`,

    `進場 ${fmtPrice(analysis.entryLow)}～${fmtPrice(analysis.entryHigh)}`,

    `SL ${fmtPrice(analysis.stopLoss)}`

  ];

  if (
    analysis.breakout
  ) {

    parts.push(
      `突破 ${fmtPrice(analysis.breakout)}`
    );

  }

  if (
    analysis.tp1
  ) {

    parts.push(
      `TP1 ${fmtPrice(analysis.tp1)}`
    );

  }

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

  parts.push(
    analysis.support.type
  );

  if (
    analysis.institutional?.text
  ) {

    parts.push(
      analysis.institutional.text
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
   Send Push
========================================================= */

async function sendPush(
  deviceId,
  device,
  stock,
  analysis
) {

  if (
    !device?.subscription
  ) {

    return {

      ok: false,

      reason:
        "device 沒有 subscription"

    };

  }

  const locked =
    await acquireNotificationLock(
      deviceId,
      stock.symbol,
      analysis
    );

  if (!locked) {

    return {

      ok: false,

      duplicate: true,

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
          TTL: 120,
          urgency: "high"
        }
      );

    return {
      ok: true
    };

  }
  catch (error) {

    const status =
      error?.statusCode ||
      error?.status;

    if (
      status === 404 ||
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
   Authorization
========================================================= */

function authorized(req) {

  const secret =
    process.env
      .CRON_SECRET;

  if (!secret) {
    return false;
  }

  const auth =
    req.headers
      .authorization ||
    "";

  return (
    auth ===
    `Bearer ${secret}`
  );

}


/* =========================================================
   Main
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
        ok: false,
        error:
          "Method Not Allowed"
      }
    );

  }

  if (
    !authorized(req)
  ) {

    return send(
      res,
      401,
      {
        ok: false,
        error:
          "Unauthorized"
      }
    );

  }

  try {

    configurePush();


    /* ==============================
       Market time
    ============================== */

    if (
      !isMarketMonitoringTime()
    ) {

      return send(
        res,
        200,
        {

          ok: true,

          skipped: true,

          reason:
            "目前非台股監控時段",

          marketWindow:
            "Asia/Taipei 08:55-13:40"

        }
      );

    }


    /* ==============================
       Devices
    ============================== */

    const deviceIds =
      await getDeviceIds();

    if (
      !deviceIds.length
    ) {

      return send(
        res,
        200,
        {

          ok: true,

          skipped: true,

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

          ok: true,

          skipped: true,

          reason:
            "沒有有效 Push subscription"

        }
      );

    }


    /* ==============================
       Symbols
    ============================== */

    const allSymbols = [

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


    /* ==============================
       Analyze
    ============================== */

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

          const analysis =
            analyzeStock(
              data
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
        result &&
        !result.error
      ) {

        stockMap.set(
          allSymbols[i],
          result
        );

      }

    }


    /* ==============================
       Push
    ============================== */

    let eligibleCount = 0;
    let pushSent = 0;
    let duplicateCount = 0;
    let pushErrors = 0;

    const signals = [];

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

        if (
          !stock.analysis
            ?.eligible
        ) {

          continue;

        }

        eligibleCount++;

        signals.push({

          symbol,

          name:
            stock.analysis.name,

          passed:
            stock.analysis.passed,

          price:
            stock.analysis.price,

          support:
            stock.analysis
              .support.type,

          entryLow:
            stock.analysis
              .entryLow,

          entryHigh:
            stock.analysis
              .entryHigh,

          stopLoss:
            stock.analysis
              .stopLoss,

          breakout:
            stock.analysis
              .breakout,

          tp1:
            stock.analysis
              .tp1,

          tp2:
            stock.analysis
              .tp2,

          tp3:
            stock.analysis
              .tp3,

          rr1:
            stock.analysis
              .rr1

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
              stock.analysis
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


    /* ==============================
       Failed stocks
    ============================== */

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


    /* ==============================
       Response
    ============================== */

    return send(
      res,
      200,
      {

        ok: true,

        engine:
          "SMC Swing Target 2.0",

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

        signals

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

        ok: false,

        error:
          error?.message ||
          "Monitor failed"

      }
    );

  }

};
