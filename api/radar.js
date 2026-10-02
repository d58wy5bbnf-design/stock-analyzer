// api/radar.js
// 波段分析 Radar 6.2 Redis Cache
//
// 全市場 Snapshot
// → Snapshot 高速初篩
// → Top 120 才抓日 K
// → 技術 + 量價二次篩選
// → Top 40 回傳首頁做完整分析
//
// 6.2：
// - Snapshot Redis Cache
// - Stock Info Redis Cache
// - Daily K Redis Cache
// - 與 stock.js 6.3 共用 price cache
// - FinMind 402 時使用 stale Redis

const SNAPSHOT_URL =
  "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot";

const DATA_URL =
  "https://api.finmindtrade.com/api/v4/data";


/* =========================================================
   設定
========================================================= */

const KLINE_SCAN_LIMIT = 120;
const KLINE_BATCH_SIZE = 12;
const DAILY_TIMEOUT_MS = 5000;
const FRONTEND_LIMIT = 40;


/*
  Redis Fresh TTL
*/

const CACHE_TTL = {
  snapshot: 60 * 1000,
  names: 24 * 60 * 60 * 1000,
  daily: 30 * 60 * 1000
};


/*
  Redis 實際保存時間（秒）
*/

const REDIS_EXPIRE = {
  snapshot: 6 * 60 * 60,
  names: 30 * 24 * 60 * 60,
  daily: 7 * 24 * 60 * 60
};


/* =========================================================
   Memory Cache
========================================================= */

const MEMORY =
  global.__RADAR_CACHE__ ||
  new Map();

global.__RADAR_CACHE__ =
  MEMORY;


/* =========================================================
   基本工具
========================================================= */

function num(v) {
  const n = Number(v);

  return Number.isFinite(n)
    ? n
    : 0;
}


function round(v, d = 2) {
  const n = Number(v);

  if (!Number.isFinite(n)) {
    return null;
  }

  const p = 10 ** d;

  return (
    Math.round(
      (n + Number.EPSILON) * p
    ) / p
  );
}


function clamp(v, min, max) {
  return Math.min(
    max,
    Math.max(min, v)
  );
}


function avg(arr) {
  const values =
    arr.filter(Number.isFinite);

  if (!values.length) {
    return 0;
  }

  return (
    values.reduce(
      (a, b) => a + b,
      0
    ) / values.length
  );
}


function isNormalTaiwanStock(id) {
  return /^\d{4}$/.test(
    String(id || "")
  );
}


function dateString(daysAgo = 0) {
  const d = new Date();

  d.setDate(
    d.getDate() - daysAgo
  );

  return d
    .toISOString()
    .slice(0, 10);
}


function getTaipeiTime() {
  return new Intl.DateTimeFormat(
    "zh-TW",
    {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }
  ).format(new Date());
}


/* =========================================================
   Redis
========================================================= */

function redisConfig() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    "";

  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    "";

  if (!url || !token) {
    return null;
  }

  return {
    url: url.replace(/\/+$/, ""),
    token
  };
}


async function redisCommand(command) {
  const config =
    redisConfig();

  if (!config) {
    throw new Error(
      "Redis 尚未設定"
    );
  }

  const response =
    await fetch(
      config.url,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${config.token}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(command)
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Redis HTTP ${response.status}`
    );
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      "Redis JSON 解析失敗"
    );
  }

  if (json?.error) {
    throw new Error(
      String(json.error)
    );
  }

  return json?.result ?? null;
}


async function redisGet(key) {
  try {
    const result =
      await redisCommand([
        "GET",
        key
      ]);

    if (
      result === null ||
      result === undefined
    ) {
      return null;
    }

    if (
      typeof result === "object"
    ) {
      return result;
    }

    return JSON.parse(result);

  } catch (error) {
    console.error(
      "Radar Redis GET:",
      key,
      error?.message
    );

    return null;
  }
}


async function redisSet(
  key,
  value,
  expireSeconds
) {
  try {
    await redisCommand([
      "SET",
      key,
      JSON.stringify(value),
      "EX",
      String(expireSeconds)
    ]);

    return true;

  } catch (error) {
    console.error(
      "Radar Redis SET:",
      key,
      error?.message
    );

    return false;
  }
}


/* =========================================================
   Smart Cache
========================================================= */

async function smartCache({
  key,
  freshMs,
  expireSeconds,
  loader
}) {
  const now =
    Date.now();

  const memory =
    MEMORY.get(key);

  if (
    memory &&
    memory.freshUntil > now
  ) {
    return memory.value;
  }


  const redis =
    await redisGet(key);

  if (
    redis &&
    redis.value !== undefined
  ) {
    const savedAt =
      Number(redis.savedAt) || 0;

    if (
      savedAt &&
      now - savedAt < freshMs
    ) {
      MEMORY.set(
        key,
        {
          value: redis.value,
          freshUntil:
            savedAt + freshMs
        }
      );

      return redis.value;
    }
  }


  try {
    const value =
      await loader();

    MEMORY.set(
      key,
      {
        value,
        freshUntil:
          now + freshMs
      }
    );

    await redisSet(
      key,
      {
        savedAt: Date.now(),
        value
      },
      expireSeconds
    );

    return value;

  } catch (error) {

    if (
      redis &&
      redis.value !== undefined
    ) {
      console.warn(
        "Radar use stale Redis:",
        key,
        error?.message
      );

      MEMORY.set(
        key,
        {
          value: redis.value,
          freshUntil:
            Date.now() +
            5 * 60 * 1000
        }
      );

      return redis.value;
    }


    if (
      memory &&
      memory.value !== undefined
    ) {
      return memory.value;
    }

    throw error;
  }
}


/* =========================================================
   FinMind Request
========================================================= */

async function finmindFetch(
  url,
  token,
  timeout = 7000
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeout
    );

  try {
    const response =
      await fetch(
        url,
        {
          headers: {
            Authorization:
              `Bearer ${token}`,

            Accept:
              "application/json"
          },

          signal:
            controller.signal
        }
      );

    let body;

    try {
      body =
        await response.json();
    } catch {
      throw new Error(
        `FinMind JSON 錯誤 HTTP ${response.status}`
      );
    }

    if (!response.ok) {
      if (response.status === 402) {
        throw new Error(
          "FinMind API 額度已達上限（HTTP 402）"
        );
      }

      throw new Error(
        body?.msg ||
        body?.message ||
        `FinMind HTTP ${response.status}`
      );
    }

    if (
      body?.status !== undefined &&
      Number(body.status) !== 200
    ) {
      throw new Error(
        body?.msg ||
        body?.message ||
        "FinMind API 錯誤"
      );
    }

    return body;

  } finally {
    clearTimeout(timer);
  }
}


/* =========================================================
   Snapshot
========================================================= */

async function fetchSnapshot(token) {
  return smartCache({
    key:
      "radar:v62:snapshot",

    freshMs:
      CACHE_TTL.snapshot,

    expireSeconds:
      REDIS_EXPIRE.snapshot,

    loader:
      async () => {
        const body =
          await finmindFetch(
            SNAPSHOT_URL,
            token,
            7000
          );

        return Array.isArray(
          body?.data
        )
          ? body.data
          : [];
      }
  });
}


/* =========================================================
   股票名稱
========================================================= */

async function fetchTaiwanStockNames(
  token
) {
  return smartCache({
    key:
      "radar:v62:stock-info",

    freshMs:
      CACHE_TTL.names,

    expireSeconds:
      REDIS_EXPIRE.names,

    loader:
      async () => {
        const body =
          await finmindFetch(
            `${DATA_URL}?dataset=TaiwanStockInfo`,
            token,
            7000
          );

        const names = {};

        for (
          const stock of
          body?.data || []
        ) {
          const id =
            String(
              stock?.stock_id ||
              ""
            );

          if (
            id &&
            stock?.stock_name
          ) {
            names[id] =
              String(
                stock.stock_name
              );
          }
        }

        return names;
      }
  });
}


/* =========================================================
   技術指標
========================================================= */

function SMA(arr, period) {
  if (
    !Array.isArray(arr) ||
    arr.length < period
  ) {
    return NaN;
  }

  return avg(
    arr
      .slice(-period)
      .map(Number)
  );
}


function EMA(arr, period) {
  if (
    !Array.isArray(arr) ||
    arr.length < period
  ) {
    return NaN;
  }

  let value =
    avg(
      arr
        .slice(0, period)
        .map(Number)
    );

  const k =
    2 / (period + 1);

  for (
    let i = period;
    i < arr.length;
    i++
  ) {
    value =
      Number(arr[i]) * k +
      value * (1 - k);
  }

  return value;
}


function RSI(arr, period = 14) {
  if (
    !Array.isArray(arr) ||
    arr.length <= period
  ) {
    return NaN;
  }

  const values =
    arr.slice(
      -(period + 1)
    );

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i < values.length;
    i++
  ) {
    const diff =
      Number(values[i]) -
      Number(values[i - 1]);

    if (diff > 0) {
      gain += diff;
    } else {
      loss += Math.abs(diff);
    }
  }

  gain /= period;
  loss /= period;

  if (loss === 0) {
    return 100;
  }

  const rs =
    gain / loss;

  return (
    100 -
    100 / (1 + rs)
  );
}


function ATR(rows, period = 14) {
  if (
    !Array.isArray(rows) ||
    rows.length <= period
  ) {
    return NaN;
  }

  const tr = [];

  for (
    let i = 1;
    i < rows.length;
    i++
  ) {
    const high =
      num(rows[i].high);

    const low =
      num(rows[i].low);

    const previousClose =
      num(
        rows[i - 1].close
      );

    tr.push(
      Math.max(
        high - low,
        Math.abs(
          high - previousClose
        ),
        Math.abs(
          low - previousClose
        )
      )
    );
  }

  return SMA(
    tr,
    period
  );
}


/* =========================================================
   Snapshot 第一階段評分
========================================================= */

function scoreSnapshot(x) {
  const symbol =
    String(
      x.stock_id || ""
    );

  const price =
    num(x.close);

  const open =
    num(x.open);

  const high =
    num(x.high);

  const low =
    num(x.low);

  if (
    !symbol ||
    price <= 0
  ) {
    return null;
  }

  const change =
    num(x.change_rate);

  const volumeRatio =
    num(x.volume_ratio);

  const totalVolume =
    num(x.total_volume);

  const buyVolume =
    num(x.buy_volume);

  const sellVolume =
    num(x.sell_volume);

  const range =
    high - low;

  const dayPosition =
    range > 0
      ? clamp(
          (price - low) / range,
          0,
          1
        )
      : 0.5;

  const orderTotal =
    buyVolume +
    sellVolume;

  const buyStrength =
    orderTotal > 0
      ? buyVolume / orderTotal
      : 0.5;

  let score = 0;


  if (
    change >= 0.5 &&
    change <= 4
  ) {
    score += 20;

  } else if (
    change > 4 &&
    change <= 6.5
  ) {
    score += 15;

  } else if (
    change >= -1
  ) {
    score += 9;

  } else if (
    change < -3
  ) {
    score -= 15;
  }


  if (
    volumeRatio >= 2
  ) {
    score += 25;

  } else if (
    volumeRatio >= 1.5
  ) {
    score += 20;

  } else if (
    volumeRatio >= 1.1
  ) {
    score += 14;

  } else if (
    volumeRatio >= 0.8
  ) {
    score += 7;
  }


  if (
    dayPosition >= 0.8
  ) {
    score += 18;

  } else if (
    dayPosition >= 0.6
  ) {
    score += 12;

  } else if (
    dayPosition >= 0.45
  ) {
    score += 5;
  }


  if (
    open > 0 &&
    price >= open
  ) {
    score += 7;
  }


  if (
    buyStrength >= 0.62
  ) {
    score += 10;

  } else if (
    buyStrength >= 0.52
  ) {
    score += 5;

  } else if (
    buyStrength <= 0.35
  ) {
    score -= 5;
  }


  if (
    totalVolume >= 5000
  ) {
    score += 10;

  } else if (
    totalVolume >= 1500
  ) {
    score += 7;

  } else if (
    totalVolume >= 500
  ) {
    score += 3;

  } else if (
    totalVolume < 200
  ) {
    score -= 20;
  }


  if (
    change > 7
  ) {
    score -= 25;
  }


  return {
    symbol,

    name: "",

    price:
      round(price),

    open:
      round(open),

    high:
      round(high),

    low:
      round(low),

    changePercent:
      round(change),

    volumeRatio:
      round(
        volumeRatio,
        2
      ),

    totalVolume,

    dayPosition:
      round(
        dayPosition * 100,
        1
      ),

    buyStrength:
      round(
        buyStrength * 100,
        1
      ),

    snapshotScore:
      clamp(
        Math.round(score),
        0,
        100
      )
  };
}


/* =========================================================
   日 K
   與 stock.js 6.3 共用：
   stock:v63:price:2330
========================================================= */

async function fetchDailyRows(
  token,
  symbol
) {
  const sharedKey =
    `stock:v63:price:${symbol}`;

  const memoryKey =
    `daily:${symbol}`;

  const now =
    Date.now();

  const memory =
    MEMORY.get(
      memoryKey
    );

  if (
    memory &&
    memory.freshUntil > now
  ) {
    return memory.value;
  }


  const redis =
    await redisGet(
      sharedKey
    );


  if (
    redis &&
    Array.isArray(
      redis.value
    )
  ) {
    const savedAt =
      Number(
        redis.savedAt
      ) || 0;

    if (
      savedAt &&
      now - savedAt <
      CACHE_TTL.daily
    ) {
      MEMORY.set(
        memoryKey,
        {
          value:
            redis.value,

          freshUntil:
            savedAt +
            CACHE_TTL.daily
        }
      );

      return redis.value;
    }
  }


  try {
    const url =
      `${DATA_URL}` +
      `?dataset=TaiwanStockPrice` +
      `&data_id=${encodeURIComponent(symbol)}` +
      `&start_date=${dateString(500)}`;


    const body =
      await finmindFetch(
        url,
        token,
        DAILY_TIMEOUT_MS
      );


    const rows =
      (body?.data || [])

        .map(
          x => ({
            date:
              String(
                x.date || ""
              ).slice(0, 10),

            open:
              num(x.open),

            high:
              num(
                x.max ??
                x.high
              ),

            low:
              num(
                x.min ??
                x.low
              ),

            close:
              num(x.close),

            volume:
              num(
                x.Trading_Volume ??
                x.volume
              )
          })
        )

        .filter(
          x =>
            x.date &&
            x.close > 0 &&
            x.high > 0 &&
            x.low > 0
        )

        .sort(
          (a, b) =>
            String(a.date)
              .localeCompare(
                String(b.date)
              )
        );


    if (
      rows.length >= 60
    ) {
      const payload = {
        savedAt:
          Date.now(),

        value:
          rows
      };


      await redisSet(
        sharedKey,
        payload,
        REDIS_EXPIRE.daily
      );


      MEMORY.set(
        memoryKey,
        {
          value: rows,

          freshUntil:
            Date.now() +
            CACHE_TTL.daily
        }
      );
    }


    return rows;


  } catch (error) {

    if (
      redis &&
      Array.isArray(
        redis.value
      ) &&
      redis.value.length >= 60
    ) {
      console.warn(
        "Radar daily stale:",
        symbol,
        error?.message
      );


      MEMORY.set(
        memoryKey,
        {
          value:
            redis.value,

          freshUntil:
            Date.now() +
            5 * 60 * 1000
        }
      );


      return redis.value;
    }


    throw error;
  }
}


/* =========================================================
   第二階段：
   技術 + 量價
========================================================= */

function analyzeKline(
  stock,
  rows
) {
  if (
    !Array.isArray(rows) ||
    rows.length < 65
  ) {
    return null;
  }

  const closes =
    rows.map(
      x => x.close
    );

  const price =
    stock.price > 0
      ? stock.price
      : closes[
          closes.length - 1
        ];

  const ma5 =
    SMA(closes, 5);

  const ma10 =
    SMA(closes, 10);

  const ma20 =
    SMA(closes, 20);

  const ma60 =
    SMA(closes, 60);

  const previousMA20 =
    SMA(
      closes.slice(
        0,
        -5
      ),
      20
    );

  const rsi =
    RSI(
      closes,
      14
    );

  const macd =
    EMA(
      closes.slice(-100),
      12
    ) -
    EMA(
      closes.slice(-100),
      26
    );

  let atr =
    ATR(
      rows,
      14
    );

  if (!(atr > 0)) {
    atr =
      Math.max(
        price * 0.015,
        0.01
      );
  }

  const previous20 =
    rows.slice(
      -21,
      -1
    );

  const resistance20 =
    Math.max(
      ...previous20.map(
        x => x.high
      )
    );

  const low20 =
    Math.min(
      ...rows
        .slice(-20)
        .map(
          x => x.low
        )
    );

  const avgVolume20 =
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

  const latestVolume =
    rows[
      rows.length - 1
    ].volume;

  const volumeRatio =
    stock.volumeRatio > 0
      ? stock.volumeRatio
      : avgVolume20 > 0
      ? latestVolume /
        avgVolume20
      : 0;


  let technical = 0;

  if (price > ma20) {
    technical += 4;
  }

  if (ma20 > ma60) {
    technical += 5;
  }

  if (
    price > ma5 &&
    ma5 >= ma10
  ) {
    technical += 3;
  }

  if (
    Number.isFinite(
      previousMA20
    ) &&
    ma20 > previousMA20
  ) {
    technical += 3;
  }

  if (
    rsi >= 45 &&
    rsi <= 72
  ) {
    technical += 3;
  }

  if (macd >= 0) {
    technical += 2;
  }


  let volumePrice = 0;

  if (
    volumeRatio >= 1.5
  ) {
    volumePrice += 7;

  } else if (
    volumeRatio >= 1.1
  ) {
    volumePrice += 5;

  } else if (
    volumeRatio >= 0.8
  ) {
    volumePrice += 2;
  }

  if (
    stock.changePercent >= 0 &&
    stock.changePercent <= 5
  ) {
    volumePrice += 4;

  } else if (
    stock.changePercent >= -1.5
  ) {
    volumePrice += 2;
  }

  if (
    stock.dayPosition >= 65
  ) {
    volumePrice += 4;

  } else if (
    stock.dayPosition >= 50
  ) {
    volumePrice += 2;
  }

  const breakoutDistance =
    (
      price -
      resistance20
    ) /
    atr;

  if (
    breakoutDistance >= -0.6 &&
    breakoutDistance <= 1.2
  ) {
    volumePrice += 3;
  }

  if (
    stock.buyStrength >= 52
  ) {
    volumePrice += 2;
  }


  technical =
    clamp(
      technical,
      0,
      20
    );

  volumePrice =
    clamp(
      volumePrice,
      0,
      20
    );


  const fastScore =
    Math.round(
      technical * 2.3 +
      volumePrice * 2.1 +
      stock.snapshotScore *
      0.12
    );


  const support =
    Math.max(
      low20,
      ma20 -
      atr * 0.7
    );


  const distanceMA20 =
    atr > 0
      ? (
          price -
          ma20
        ) /
        atr
      : 0;


  let adjustedScore =
    fastScore;


  if (
    distanceMA20 > 3
  ) {
    adjustedScore -= 10;
  }


  if (
    stock.changePercent > 6.5
  ) {
    adjustedScore -= 10;
  }


  adjustedScore =
    clamp(
      adjustedScore,
      0,
      100
    );


  let status =
    "等待";


  if (
    adjustedScore >= 70
  ) {
    status =
      "優先分析";

  } else if (
    adjustedScore >= 55
  ) {
    status =
      "值得觀察";
  }


  return {
    ...stock,

    score:
      adjustedScore,

    entryScore:
      adjustedScore,

    fastScore:
      adjustedScore,

    technicalScore:
      technical,

    volumePriceScore:
      volumePrice,

    ma5:
      round(ma5),

    ma10:
      round(ma10),

    ma20:
      round(ma20),

    ma60:
      round(ma60),

    rsi:
      round(rsi, 1),

    macd:
      round(macd, 2),

    atr:
      round(atr),

    support:
      round(support),

    resistance:
      round(
        resistance20
      ),

    volumeRatio:
      round(
        volumeRatio,
        2
      ),

    status,

    recommendedStrategy:
      "波段候選",

    strategyEmoji:
      "📊",

    strategyKey:
      "SWING",

    strategyGrade:
      adjustedScore >= 70
        ? "優先分析"
        : adjustedScore >= 55
        ? "值得觀察"
        : "等待",

    pullbackScore:
      adjustedScore,

    highRScore:
      adjustedScore,

    surgeScore:
      adjustedScore,

    structureLow:
      round(support),

    structureStop:
      round(
        support -
        atr * 0.35
      ),

    structureValid:
      price >
      support -
      atr * 0.35,

    entryLow:
      round(
        Math.max(
          support,
          ma20 -
          atr * 0.5
        )
      ),

    entryHigh:
      round(
        ma20 +
        atr * 0.5
      )
  };
}


/* =========================================================
   API
========================================================= */

export default async function handler(
  req,
  res
) {
  const startedAt =
    Date.now();

  try {
    if (
      req.method !== "GET"
    ) {
      return res
        .status(405)
        .json({
          ok: false,
          error:
            "Method Not Allowed"
        });
    }


    const token =
      process.env
        .FINMIND_TOKEN;


    if (!token) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Vercel 尚未設定 FINMIND_TOKEN"
        });
    }


    const [
      snapshots,
      stockNames
    ] =
      await Promise.all([
        fetchSnapshot(token),
        fetchTaiwanStockNames(
          token
        )
      ]);


    const stocks =
      snapshots

        .filter(
          x =>
            isNormalTaiwanStock(
              x.stock_id
            )
        )

        .map(
          scoreSnapshot
        )

        .filter(Boolean)

        .map(
          stock => ({
            ...stock,

            name:
              stockNames[
                stock.symbol
              ] ||
              ""
          })
        )

        .filter(
          stock =>
            stock.price > 3 &&
            stock.totalVolume >= 200
        );


    /* =====================================================
       第一階段：
       全市場初掃 → Top 120
    ===================================================== */

    const candidatePool =
      [...stocks]

        .filter(
          stock =>
            stock.changePercent >
              -3.5 &&

            stock.changePercent <=
              7.5 &&

            (
              stock.snapshotScore >=
                25 ||

              stock.volumeRatio >=
                1
            )
        )

        .sort(
          (a, b) => {
            const liquidityA =
              Math.min(
                Math.log10(
                  Math.max(
                    a.totalVolume,
                    1
                  )
                ) * 2,
                10
              );

            const liquidityB =
              Math.min(
                Math.log10(
                  Math.max(
                    b.totalVolume,
                    1
                  )
                ) * 2,
                10
              );

            const aRank =
              a.snapshotScore +
              liquidityA;

            const bRank =
              b.snapshotScore +
              liquidityB;

            return (
              bRank -
              aRank
            );
          }
        )

        .slice(
          0,
          KLINE_SCAN_LIMIT
        );


    /* =====================================================
       第二階段：
       Top 120 日 K
    ===================================================== */

    const analyzed = [];


    for (
      let i = 0;
      i < candidatePool.length;
      i += KLINE_BATCH_SIZE
    ) {
      const batch =
        candidatePool.slice(
          i,
          i +
          KLINE_BATCH_SIZE
        );


      const results =
        await Promise.allSettled(
          batch.map(
            async stock => {
              const rows =
                await fetchDailyRows(
                  token,
                  stock.symbol
                );


              if (
                rows.length < 65
              ) {
                return null;
              }


              return analyzeKline(
                stock,
                rows
              );
            }
          )
        );


      for (
        const result of results
      ) {
        if (
          result.status ===
            "fulfilled" &&
          result.value
        ) {
          analyzed.push(
            result.value
          );
        }
      }
    }


    /* =====================================================
       Top 40
    ===================================================== */

    const strategyReady =
      [...analyzed]

        .filter(
          stock =>
            stock.fastScore >=
            45
        )

        .sort(
          (a, b) =>
            b.fastScore -
            a.fastScore
        )

        .slice(
          0,
          FRONTEND_LIMIT
        );


    const finalCandidates =
      strategyReady.length
        ? strategyReady
        : [...analyzed]

            .sort(
              (a, b) =>
                b.fastScore -
                a.fastScore
            )

            .slice(
              0,
              Math.min(
                20,
                FRONTEND_LIMIT
              )
            );


    const radar =
      [...stocks]

        .sort(
          (a, b) =>
            b.snapshotScore -
            a.snapshotScore
        )

        .slice(
          0,
          30
        )

        .map(
          stock => ({
            ...stock,

            score:
              stock.snapshotScore,

            longStatus:
              stock.snapshotScore >=
                55
                ? "優先觀察"
                : "等待確認"
          })
        );


    const longWatch =
      finalCandidates
        .slice(0, 30);


    const volumeLeaders =
      [...stocks]

        .filter(
          x =>
            x.volumeRatio > 0
        )

        .sort(
          (a, b) =>
            b.volumeRatio -
            a.volumeRatio
        )

        .slice(0, 15);


    const momentumLeaders =
      [...stocks]

        .filter(
          x =>
            x.changePercent > 0
        )

        .sort(
          (a, b) =>
            b.changePercent -
            a.changePercent
        )

        .slice(0, 15);


    const elapsedMs =
      Date.now() -
      startedAt;


    res.setHeader(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=180"
    );


    return res
      .status(200)
      .json({
        ok: true,

        platform:
          "波段分析 Radar 6.2",

        engine:
          "FAST_TWO_STAGE_120_REDIS",

        market:
          "TW",

        source:
          "FinMind + Upstash Redis",

        updatedAt:
          new Date()
            .toISOString(),

        taipeiTime:
          getTaipeiTime(),

        elapsedMs,

        scanned:
          stocks.length,

        strategyCandidateCount:
          candidatePool.length,

        strategyScannedCount:
          analyzed.length,

        strategyReadyCount:
          finalCandidates.length,

        found:
          radar.length,

        longWatchCount:
          longWatch.length,

        strategyReady:
          finalCandidates,

        radar,

        longWatch,

        volumeLeaders,

        momentumLeaders,

        notice:
          "Radar 6.2：全市場 Snapshot → Top 120 日 K → Top 40；Snapshot、股票名稱與日 K 已加入 Upstash Redis，日 K與 Stock API 6.3 共用快取。"
      });


  } catch (error) {
    console.error(
      "Radar server error:",
      error
    );


    res.setHeader(
      "Cache-Control",
      "no-store"
    );


    return res
      .status(500)
      .json({
        ok: false,

        platform:
          "波段分析 Radar 6.2",

        engine:
          "FAST_TWO_STAGE_120_REDIS",

        error:
          error?.name ===
          "AbortError"
            ? "FinMind 連線逾時，請重新掃描"
            : error?.message ||
              "Radar server error"
      });
  }
}
