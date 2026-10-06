// api/radar.js
// 波段分析 Radar 6.4 Unified
//
// 目標：
// 1. 不同手機取得相同的 Radar 候選與排序
// 2. 全市場 Snapshot 使用伺服器共用 Redis 快照
// 3. Radar 最終結果也存入 Redis，共用同一份結果
// 4. 成交金額 / 量比 / 流動性優先
// 5. Top 160 抓日 K
// 6. 技術 + 量價二次篩選
// 7. Top 60 給首頁
//
// Radar 搜尋權重：
// - 成交金額 30%
// - 量比 20%
// - Snapshot 市場強度 25%
// - 買盤強度 15%
// - 價格動能 10%
//
// 注意：
// 不修改 Stock 6.3
// 不修改 Monitor 8.1
// 不修改 Push
// 不修改個股頁五大分析評分
//
// 6.4 Unified：
// 最終 Radar 結果寫入 Redis。
// 所有手機在快照有效期間讀取完全相同結果。

const SNAPSHOT_URL =
  "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot";

const DATA_URL =
  "https://api.finmindtrade.com/api/v4/data";


/* =========================================================
   設定
========================================================= */

const KLINE_SCAN_LIMIT = 160;

const KLINE_BATCH_SIZE = 20;

const DAILY_TIMEOUT_MS = 5000;

const FRONTEND_LIMIT = 60;


/*
  Snapshot 更新速度
*/

const CACHE_TTL = {

  snapshot:
    60 * 1000,

  names:
    24 * 60 * 60 * 1000,

  daily:
    30 * 60 * 1000,

  final:
    2 * 60 * 1000

};


/*
  Redis 實際保存時間
*/

const REDIS_EXPIRE = {

  snapshot:
    6 * 60 * 60,

  names:
    30 * 24 * 60 * 60,

  daily:
    7 * 24 * 60 * 60,

  final:
    6 * 60 * 60

};


const FINAL_RESULT_KEY =
  "radar:v64:unified-result";

const BUILD_LOCK_KEY =
  "radar:v64:build-lock";


/* =========================================================
   Memory Cache
========================================================= */

const MEMORY =
  global.__RADAR_V64_CACHE__ ||
  new Map();

global.__RADAR_V64_CACHE__ =
  MEMORY;


/* =========================================================
   基本工具
========================================================= */

function num(v) {

  const n =
    Number(v);

  return Number.isFinite(n)
    ? n
    : 0;

}


function round(v, d = 2) {

  const n =
    Number(v);

  if (!Number.isFinite(n)) {

    return null;

  }

  const p =
    10 ** d;

  return (
    Math.round(
      (n + Number.EPSILON) * p
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


function avg(arr) {

  const values =
    (arr || [])
      .map(Number)
      .filter(Number.isFinite);

  if (!values.length) {

    return 0;

  }

  return (
    values.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    values.length
  );

}


function isNormalTaiwanStock(id) {

  return /^\d{4}$/.test(
    String(id || "")
  );

}


function dateString(daysAgo = 0) {

  const d =
    new Date();

  d.setDate(
    d.getDate() -
    daysAgo
  );

  return d
    .toISOString()
    .slice(0, 10);

}


function getTaipeiTime() {

  return new Intl.DateTimeFormat(
    "zh-TW",
    {
      timeZone:
        "Asia/Taipei",

      year:
        "numeric",

      month:
        "2-digit",

      day:
        "2-digit",

      hour:
        "2-digit",

      minute:
        "2-digit",

      second:
        "2-digit",

      hour12:
        false
    }
  ).format(
    new Date()
  );

}


function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );

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

  if (
    !url ||
    !token
  ) {

    return null;

  }

  return {

    url:
      url.replace(
        /\/+$/,
        ""
      ),

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
        method:
          "POST",

        headers: {

          Authorization:
            `Bearer ${config.token}`,

          "Content-Type":
            "application/json"

        },

        body:
          JSON.stringify(
            command
          )

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

    json =
      JSON.parse(
        text
      );

  }
  catch {

    throw new Error(
      "Redis JSON 解析失敗"
    );

  }

  if (json?.error) {

    throw new Error(
      String(
        json.error
      )
    );

  }

  return (
    json?.result ??
    null
  );

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
      typeof result ===
      "object"
    ) {

      return result;

    }

    return JSON.parse(
      result
    );

  }
  catch (error) {

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
      JSON.stringify(
        value
      ),
      "EX",
      String(
        expireSeconds
      )
    ]);

    return true;

  }
  catch (error) {

    console.error(
      "Radar Redis SET:",
      key,
      error?.message
    );

    return false;

  }

}


async function redisSetNX(
  key,
  value,
  expireSeconds
) {

  try {

    const result =
      await redisCommand([
        "SET",
        key,
        String(value),
        "EX",
        String(
          expireSeconds
        ),
        "NX"
      ]);

    return (
      result === "OK"
    );

  }
  catch (error) {

    console.warn(
      "Radar Redis LOCK:",
      error?.message
    );

    return false;

  }

}


async function redisDel(key) {

  try {

    await redisCommand([
      "DEL",
      key
    ]);

  }
  catch (error) {

    console.warn(
      "Radar Redis DEL:",
      error?.message
    );

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
    MEMORY.get(
      key
    );

  if (
    memory &&
    memory.freshUntil >
      now
  ) {

    return memory.value;

  }

  const redis =
    await redisGet(
      key
    );

  if (
    redis &&
    redis.value !==
      undefined
  ) {

    const savedAt =
      Number(
        redis.savedAt
      ) || 0;

    if (
      savedAt &&
      now - savedAt <
        freshMs
    ) {

      MEMORY.set(
        key,
        {
          value:
            redis.value,

          freshUntil:
            savedAt +
            freshMs
        }
      );

      return redis.value;

    }

  }

  try {

    const value =
      await loader();

    const savedAt =
      Date.now();

    MEMORY.set(
      key,
      {
        value,

        freshUntil:
          savedAt +
          freshMs
      }
    );

    await redisSet(
      key,
      {
        savedAt,
        value
      },
      expireSeconds
    );

    return value;

  }
  catch (error) {

    if (
      redis &&
      redis.value !==
        undefined
    ) {

      console.warn(
        "Radar use stale Redis:",
        key,
        error?.message
      );

      MEMORY.set(
        key,
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

    if (
      memory &&
      memory.value !==
        undefined
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
      () =>
        controller.abort(),
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

    }
    catch {

      throw new Error(
        `FinMind JSON 錯誤 HTTP ${response.status}`
      );

    }

    if (!response.ok) {

      if (
        response.status ===
        402
      ) {

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
      body?.status !==
        undefined &&
      Number(
        body.status
      ) !== 200
    ) {

      throw new Error(
        body?.msg ||
        body?.message ||
        "FinMind API 錯誤"
      );

    }

    return body;

  }
  finally {

    clearTimeout(
      timer
    );

  }

}


/* =========================================================
   Snapshot
========================================================= */

async function fetchSnapshot(
  token
) {

  return smartCache({

    key:
      "radar:v64:snapshot",

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
      "radar:v64:stock-info",

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

function SMA(
  arr,
  period
) {

  if (
    !Array.isArray(arr) ||
    arr.length <
      period
  ) {

    return NaN;

  }

  return avg(
    arr
      .slice(
        -period
      )
      .map(Number)
  );

}


function EMA(
  arr,
  period
) {

  if (
    !Array.isArray(arr) ||
    arr.length <
      period
  ) {

    return NaN;

  }

  let value =
    avg(
      arr
        .slice(
          0,
          period
        )
        .map(Number)
    );

  const k =
    2 /
    (period + 1);

  for (
    let i = period;
    i < arr.length;
    i++
  ) {

    value =
      Number(
        arr[i]
      ) *
      k +
      value *
      (1 - k);

  }

  return value;

}


function RSI(
  arr,
  period = 14
) {

  if (
    !Array.isArray(arr) ||
    arr.length <=
      period
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
      Number(
        values[i]
      ) -
      Number(
        values[i - 1]
      );

    if (
      diff > 0
    ) {

      gain +=
        diff;

    }
    else {

      loss +=
        Math.abs(
          diff
        );

    }

  }

  gain /=
    period;

  loss /=
    period;

  if (
    loss === 0
  ) {

    return 100;

  }

  const rs =
    gain /
    loss;

  return (
    100 -
    100 /
    (1 + rs)
  );

}


function ATR(
  rows,
  period = 14
) {

  if (
    !Array.isArray(rows) ||
    rows.length <=
      period
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
      num(
        rows[i].high
      );

    const low =
      num(
        rows[i].low
      );

    const previousClose =
      num(
        rows[i - 1]
          .close
      );

    tr.push(
      Math.max(
        high - low,

        Math.abs(
          high -
          previousClose
        ),

        Math.abs(
          low -
          previousClose
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
      x.stock_id ||
      ""
    );

  const price =
    num(
      x.close
    );

  const open =
    num(
      x.open
    );

  const high =
    num(
      x.high
    );

  const low =
    num(
      x.low
    );

  if (
    !symbol ||
    price <= 0
  ) {

    return null;

  }


  /*
    Snapshot change_rate

    FinMind Snapshot 若提供 change_rate，
    Radar 使用同一份 Redis Snapshot，
    所有手機會取得相同值。

    這裡不在前端重新計算，
    避免各裝置時間差。
  */

  const change =
    num(
      x.change_rate
    );

  const volumeRatio =
    num(
      x.volume_ratio
    );

  const totalVolume =
    num(
      x.total_volume
    );


  /*
    成交金額
  */

  const snapshotTradingValue =
    num(
      x.total_amount ??
      x.trading_value ??
      x.Trading_money ??
      x.Trading_Value
    );

  const tradingValue =
    snapshotTradingValue >
      0
      ? snapshotTradingValue
      : price *
        totalVolume;


  const buyVolume =
    num(
      x.buy_volume
    );

  const sellVolume =
    num(
      x.sell_volume
    );

  const range =
    high -
    low;

  const dayPosition =
    range > 0
      ? clamp(
          (
            price -
            low
          ) /
          range,
          0,
          1
        )
      : 0.5;

  const orderTotal =
    buyVolume +
    sellVolume;

  const buyStrength =
    orderTotal > 0
      ? buyVolume /
        orderTotal
      : 0.5;

  let score = 0;


  /*
    漲跌動能
  */

  if (
    change >= 0.5 &&
    change <= 4
  ) {

    score += 20;

  }
  else if (
    change > 4 &&
    change <= 6.5
  ) {

    score += 15;

  }
  else if (
    change >= -1
  ) {

    score += 9;

  }
  else if (
    change < -3
  ) {

    score -= 15;

  }


  /*
    量比
  */

  if (
    volumeRatio >= 2
  ) {

    score += 25;

  }
  else if (
    volumeRatio >= 1.5
  ) {

    score += 20;

  }
  else if (
    volumeRatio >= 1.1
  ) {

    score += 14;

  }
  else if (
    volumeRatio >= 0.8
  ) {

    score += 7;

  }


  /*
    當日位置
  */

  if (
    dayPosition >= 0.8
  ) {

    score += 18;

  }
  else if (
    dayPosition >= 0.6
  ) {

    score += 12;

  }
  else if (
    dayPosition >= 0.45
  ) {

    score += 5;

  }


  /*
    收盤相對開盤
  */

  if (
    open > 0 &&
    price >= open
  ) {

    score += 7;

  }


  /*
    買盤
  */

  if (
    buyStrength >= 0.62
  ) {

    score += 10;

  }
  else if (
    buyStrength >= 0.52
  ) {

    score += 5;

  }
  else if (
    buyStrength <= 0.35
  ) {

    score -= 5;

  }


  /*
    流動性
  */

  if (
    totalVolume >= 5000
  ) {

    score += 10;

  }
  else if (
    totalVolume >= 1500
  ) {

    score += 7;

  }
  else if (
    totalVolume >= 500
  ) {

    score += 3;

  }
  else if (
    totalVolume < 200
  ) {

    score -= 20;

  }


  /*
    過度追高
  */

  if (
    change > 7
  ) {

    score -= 25;

  }


  return {

    symbol,

    name:
      "",

    price:
      round(
        price
      ),

    open:
      round(
        open
      ),

    high:
      round(
        high
      ),

    low:
      round(
        low
      ),

    changePercent:
      round(
        change
      ),

    volumeRatio:
      round(
        volumeRatio,
        2
      ),

    totalVolume,

    tradingValue:
      round(
        tradingValue,
        0
      ),

    dayPosition:
      round(
        dayPosition *
        100,
        1
      ),

    buyStrength:
      round(
        buyStrength *
        100,
        1
      ),

    snapshotScore:
      clamp(
        Math.round(
          score
        ),
        0,
        100
      )

  };

}


/* =========================================================
   Radar 流動性優先排名

   成交金額   30
   量比       20
   市場強度   25
   買盤       15
   動能       10
========================================================= */

function liquidityRank(
  stock
) {

  const tradingValue =
    Math.max(
      num(
        stock.tradingValue
      ),
      0
    );

  const volumeRatio =
    Math.max(
      num(
        stock.volumeRatio
      ),
      0
    );

  const snapshotScore =
    clamp(
      num(
        stock.snapshotScore
      ),
      0,
      100
    );

  const buyStrength =
    clamp(
      num(
        stock.buyStrength
      ),
      0,
      100
    );

  const changePercent =
    num(
      stock.changePercent
    );


  /*
    成交金額 30
  */

  let moneyScore = 0;

  if (
    tradingValue >=
    3000000000
  ) {

    moneyScore = 30;

  }
  else if (
    tradingValue >=
    1000000000
  ) {

    moneyScore = 27;

  }
  else if (
    tradingValue >=
    500000000
  ) {

    moneyScore = 23;

  }
  else if (
    tradingValue >=
    200000000
  ) {

    moneyScore = 18;

  }
  else if (
    tradingValue >=
    100000000
  ) {

    moneyScore = 14;

  }
  else if (
    tradingValue >=
    50000000
  ) {

    moneyScore = 9;

  }
  else if (
    tradingValue >=
    20000000
  ) {

    moneyScore = 5;

  }


  /*
    量比 20
  */

  let volumeScore = 0;

  if (
    volumeRatio >= 3
  ) {

    volumeScore = 20;

  }
  else if (
    volumeRatio >= 2
  ) {

    volumeScore = 18;

  }
  else if (
    volumeRatio >= 1.5
  ) {

    volumeScore = 15;

  }
  else if (
    volumeRatio >= 1.2
  ) {

    volumeScore = 12;

  }
  else if (
    volumeRatio >= 1
  ) {

    volumeScore = 9;

  }
  else if (
    volumeRatio >= 0.8
  ) {

    volumeScore = 5;

  }


  /*
    市場強度 25
  */

  const strengthScore =
    snapshotScore /
    100 *
    25;


  /*
    買盤 15
  */

  let buyScore = 0;

  if (
    buyStrength >= 65
  ) {

    buyScore = 15;

  }
  else if (
    buyStrength >= 58
  ) {

    buyScore = 12;

  }
  else if (
    buyStrength >= 52
  ) {

    buyScore = 9;

  }
  else if (
    buyStrength >= 48
  ) {

    buyScore = 6;

  }
  else if (
    buyStrength >= 40
  ) {

    buyScore = 3;

  }


  /*
    動能 10
  */

  let momentumScore = 0;

  if (
    changePercent >= 1 &&
    changePercent <= 4
  ) {

    momentumScore = 10;

  }
  else if (
    changePercent > 4 &&
    changePercent <= 6
  ) {

    momentumScore = 7;

  }
  else if (
    changePercent >= 0
  ) {

    momentumScore = 6;

  }
  else if (
    changePercent >= -1
  ) {

    momentumScore = 4;

  }
  else if (
    changePercent >= -2
  ) {

    momentumScore = 2;

  }


  const score =
    moneyScore +
    volumeScore +
    strengthScore +
    buyScore +
    momentumScore;


  return round(
    clamp(
      score,
      0,
      100
    ),
    2
  );

}


/* =========================================================
   日 K
   共用 Stock 6.3 Redis
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
    memory.freshUntil >
      now
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
              ).slice(
                0,
                10
              ),

            open:
              num(
                x.open
              ),

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
              num(
                x.close
              ),

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
            String(
              a.date
            )
              .localeCompare(
                String(
                  b.date
                )
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

          value:
            rows,

          freshUntil:
            Date.now() +
            CACHE_TTL.daily

        }
      );

    }


    return rows;

  }
  catch (error) {

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
      x =>
        x.close
    );


  const price =
    stock.price > 0
      ? stock.price
      : closes[
          closes.length -
          1
        ];


  const ma5 =
    SMA(
      closes,
      5
    );

  const ma10 =
    SMA(
      closes,
      10
    );

  const ma20 =
    SMA(
      closes,
      20
    );

  const ma60 =
    SMA(
      closes,
      60
    );


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
      closes.slice(
        -100
      ),
      12
    ) -
    EMA(
      closes.slice(
        -100
      ),
      26
    );


  let atr =
    ATR(
      rows,
      14
    );

  if (
    !(atr > 0)
  ) {

    atr =
      Math.max(
        price *
        0.015,
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
        x =>
          x.high
      )
    );


  const low20 =
    Math.min(
      ...rows
        .slice(
          -20
        )
        .map(
          x =>
            x.low
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
          x =>
            x.volume
        )
    );


  const latestVolume =
    rows[
      rows.length -
      1
    ].volume;


  const volumeRatio =
    stock.volumeRatio > 0
      ? stock.volumeRatio
      : avgVolume20 > 0
      ? latestVolume /
        avgVolume20
      : 0;


  let technical = 0;


  if (
    price > ma20
  ) {

    technical += 4;

  }


  if (
    ma20 > ma60
  ) {

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
    ma20 >
      previousMA20
  ) {

    technical += 3;

  }


  if (
    rsi >= 45 &&
    rsi <= 72
  ) {

    technical += 3;

  }


  if (
    macd >= 0
  ) {

    technical += 2;

  }


  let volumePrice = 0;


  if (
    volumeRatio >= 1.5
  ) {

    volumePrice += 7;

  }
  else if (
    volumeRatio >= 1.1
  ) {

    volumePrice += 5;

  }
  else if (
    volumeRatio >= 0.8
  ) {

    volumePrice += 2;

  }


  if (
    stock.changePercent >= 0 &&
    stock.changePercent <= 5
  ) {

    volumePrice += 4;

  }
  else if (
    stock.changePercent >= -1.5
  ) {

    volumePrice += 2;

  }


  if (
    stock.dayPosition >= 65
  ) {

    volumePrice += 4;

  }
  else if (
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


  const radarRank =
    Number.isFinite(
      +stock.radarRank
    )
      ? +stock.radarRank
      : liquidityRank(
          stock
        );


  /*
    技術最高 40
    量價最高 40
    流動性最高 20
  */

  const fastScore =
    Math.round(
      technical *
      2 +
      volumePrice *
      2 +
      radarRank *
      0.20
    );


  const support =
    Math.max(
      low20,
      ma20 -
      atr *
      0.7
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
    stock.changePercent >
      6.5
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

  }
  else if (
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

    radarRank:
      round(
        radarRank,
        2
      ),

    technicalScore:
      technical,

    volumePriceScore:
      volumePrice,

    ma5:
      round(
        ma5
      ),

    ma10:
      round(
        ma10
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
        rsi,
        1
      ),

    macd:
      round(
        macd,
        2
      ),

    atr:
      round(
        atr
      ),

    support:
      round(
        support
      ),

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
      round(
        support
      ),

    structureStop:
      round(
        support -
        atr *
        0.35
      ),

    structureValid:
      price >
      support -
      atr *
      0.35,

    entryLow:
      round(
        Math.max(
          support,
          ma20 -
          atr *
          0.5
        )
      ),

    entryHigh:
      round(
        ma20 +
        atr *
        0.5
      )

  };

}


/* =========================================================
   建立固定 Radar 結果
========================================================= */

async function buildRadarResult(
  token
) {

  const startedAt =
    Date.now();


  const [
    snapshots,
    stockNames
  ] =
    await Promise.all([

      fetchSnapshot(
        token
      ),

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
          stock.totalVolume >=
            200
      );


  /* =====================================================
     第一階段
     全市場 → Top 160
  ===================================================== */

  const candidatePool =
    [...stocks]

      .filter(
        stock =>

          stock.changePercent >
            -3.5 &&

          stock.changePercent <=
            7.5 &&

          stock.price >
            3 &&

          (
            stock.tradingValue >=
              20000000 ||

            stock.volumeRatio >=
              1.2
          )
      )

      .map(
        stock => ({

          ...stock,

          radarRank:
            liquidityRank(
              stock
            )

        })
      )

      .sort(
        (a, b) => {

          if (
            b.radarRank !==
            a.radarRank
          ) {

            return (
              b.radarRank -
              a.radarRank
            );

          }

          if (
            b.tradingValue !==
            a.tradingValue
          ) {

            return (
              b.tradingValue -
              a.tradingValue
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

      .slice(
        0,
        KLINE_SCAN_LIMIT
      );


  /* =====================================================
     第二階段
     Top 160 日 K
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
      const result of
      results
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
     Top 60

     排序固定：
     1. fastScore
     2. 分數差 < 3 時成交金額
     3. radarRank
     4. 股票代號

     加股票代號作最後 tie-break，
     保證不同執行環境排序一致。
  ===================================================== */

  function strategySort(
    a,
    b
  ) {

    const scoreDiff =
      b.fastScore -
      a.fastScore;

    if (
      Math.abs(
        scoreDiff
      ) >= 3
    ) {

      return scoreDiff;

    }


    if (
      b.tradingValue !==
      a.tradingValue
    ) {

      return (
        b.tradingValue -
        a.tradingValue
      );

    }


    if (
      b.radarRank !==
      a.radarRank
    ) {

      return (
        b.radarRank -
        a.radarRank
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


  const strategyReady =
    [...analyzed]

      .filter(
        stock =>
          stock.fastScore >=
            45
      )

      .sort(
        strategySort
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
            strategySort
          )

          .slice(
            0,
            Math.min(
              30,
              FRONTEND_LIMIT
            )
          );


  /* =====================================================
     Radar 首頁流動性榜
  ===================================================== */

  const radar =
    [...stocks]

      .map(
        stock => ({

          ...stock,

          radarRank:
            liquidityRank(
              stock
            )

        })
      )

      .sort(
        (a, b) => {

          if (
            b.radarRank !==
            a.radarRank
          ) {

            return (
              b.radarRank -
              a.radarRank
            );

          }

          if (
            b.tradingValue !==
            a.tradingValue
          ) {

            return (
              b.tradingValue -
              a.tradingValue
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

      .slice(
        0,
        50
      )

      .map(
        stock => ({

          ...stock,

          score:
            stock.snapshotScore,

          longStatus:
            stock.radarRank >=
              55
              ? "優先觀察"
              : "等待確認"

        })
      );


  /* =====================================================
     Long Watch
  ===================================================== */

  const longWatch =
    finalCandidates
      .slice(
        0,
        50
      );


  /* =====================================================
     量比榜
  ===================================================== */

  const volumeLeaders =
    [...stocks]

      .filter(
        x =>
          x.volumeRatio > 0
      )

      .sort(
        (a, b) => {

          const ratioDiff =
            b.volumeRatio -
            a.volumeRatio;

          if (
            Math.abs(
              ratioDiff
            ) >= 0.2
          ) {

            return ratioDiff;

          }

          if (
            b.tradingValue !==
            a.tradingValue
          ) {

            return (
              b.tradingValue -
              a.tradingValue
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

      .slice(
        0,
        30
      );


  /* =====================================================
     動能榜
  ===================================================== */

  const momentumLeaders =
    [...stocks]

      .filter(
        x =>
          x.changePercent >
          0
      )

      .sort(
        (a, b) => {

          const changeDiff =
            b.changePercent -
            a.changePercent;

          if (
            Math.abs(
              changeDiff
            ) >= 0.5
          ) {

            return changeDiff;

          }

          if (
            b.tradingValue !==
            a.tradingValue
          ) {

            return (
              b.tradingValue -
              a.tradingValue
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

      .slice(
        0,
        30
      );


  /* =====================================================
     成交金額榜
  ===================================================== */

  const valueLeaders =
    [...stocks]

      .filter(
        x =>
          x.tradingValue >
          0
      )

      .sort(
        (a, b) => {

          if (
            b.tradingValue !==
            a.tradingValue
          ) {

            return (
              b.tradingValue -
              a.tradingValue
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

      .slice(
        0,
        30
      );


  const generatedAt =
    Date.now();


  return {

    ok:
      true,

    platform:
      "波段分析 Radar 6.4 Unified",

    engine:
      "UNIFIED_LIQUIDITY_160_REDIS",

    market:
      "TW",

    source:
      "FinMind + Upstash Redis",

    unified:
      true,

    generatedAt,

    updatedAt:
      new Date(
        generatedAt
      ).toISOString(),

    taipeiTime:
      getTaipeiTime(),

    buildElapsedMs:
      Date.now() -
      startedAt,

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

    valueLeaders,

    momentumLeaders,

    rankingWeights: {

      tradingValue:
        30,

      volumeRatio:
        20,

      marketStrength:
        25,

      buyStrength:
        15,

      momentum:
        10

    },

    notice:
      "Radar 6.4 Unified：全裝置共用同一份 Redis Radar 結果；全市場先以成交金額、量比與流動性搜尋，再做技術與量價二次篩選。"

  };

}


/* =========================================================
   讀取最終共用結果
========================================================= */

async function getUnifiedResult() {

  const cached =
    await redisGet(
      FINAL_RESULT_KEY
    );

  if (
    !cached ||
    !cached.value ||
    !cached.savedAt
  ) {

    return null;

  }

  return {

    savedAt:
      Number(
        cached.savedAt
      ) || 0,

    value:
      cached.value

  };

}


/* =========================================================
   API
========================================================= */

export default async function handler(
  req,
  res
) {

  const requestStartedAt =
    Date.now();


  try {

    if (
      req.method !==
      "GET"
    ) {

      return res
        .status(405)
        .json({

          ok:
            false,

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

          ok:
            false,

          error:
            "Vercel 尚未設定 FINMIND_TOKEN"

        });

    }


    /* =====================================================
       1. 優先讀 Redis 最終結果

       這是跨手機一致的核心。
    ===================================================== */

    const cached =
      await getUnifiedResult();


    if (
      cached &&
      cached.value
    ) {

      const age =
        Date.now() -
        cached.savedAt;


      if (
        age <
        CACHE_TTL.final
      ) {

        res.setHeader(
          "Cache-Control",
          "public, s-maxage=30, stale-while-revalidate=120"
        );


        return res
          .status(200)
          .json({

            ...cached.value,

            ok:
              true,

            cache:
              "HIT",

            unified:
              true,

            resultAgeMs:
              age,

            elapsedMs:
              Date.now() -
              requestStartedAt

          });

      }

    }


    /* =====================================================
       2. 嘗試取得建置鎖

       同時間多台手機打開：
       只有一個 request 重建 Radar。
       其他 request 等待 Redis 新結果。
    ===================================================== */

    const lockId =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;


    const hasLock =
      await redisSetNX(
        BUILD_LOCK_KEY,
        lockId,
        90
      );


    /* =====================================================
       3. 沒搶到鎖

       等其他 request 建完。
    ===================================================== */

    if (!hasLock) {

      for (
        let attempt = 0;
        attempt < 20;
        attempt++
      ) {

        await sleep(
          500
        );


        const waitingResult =
          await getUnifiedResult();


        if (
          waitingResult &&
          waitingResult.value &&
          waitingResult.savedAt >
            (
              cached?.savedAt ||
              0
            )
        ) {

          res.setHeader(
            "Cache-Control",
            "public, s-maxage=30, stale-while-revalidate=120"
          );


          return res
            .status(200)
            .json({

              ...waitingResult.value,

              ok:
                true,

              cache:
                "WAIT-HIT",

              unified:
                true,

              resultAgeMs:
                Date.now() -
                waitingResult.savedAt,

              elapsedMs:
                Date.now() -
                requestStartedAt

            });

        }

      }


      /*
        如果另一個 request 還沒完成，
        但我們手上有舊結果，
        先回舊結果。

        這樣不同手機仍然看到同一份舊榜單，
        不會各自重建。
      */

      if (
        cached &&
        cached.value
      ) {

        res.setHeader(
          "Cache-Control",
          "public, s-maxage=15, stale-while-revalidate=60"
        );


        return res
          .status(200)
          .json({

            ...cached.value,

            ok:
              true,

            cache:
              "STALE-WAIT",

            unified:
              true,

            resultAgeMs:
              Date.now() -
              cached.savedAt,

            elapsedMs:
              Date.now() -
              requestStartedAt

          });

      }


      /*
        第一次部署、Redis 完全沒有結果時，
        如果鎖被其他 request 拿走但等待超時，
        再稍等一次。
      */

      await sleep(
        1000
      );


      const lastTry =
        await getUnifiedResult();


      if (
        lastTry &&
        lastTry.value
      ) {

        return res
          .status(200)
          .json({

            ...lastTry.value,

            ok:
              true,

            cache:
              "LAST-HIT",

            unified:
              true,

            resultAgeMs:
              Date.now() -
              lastTry.savedAt,

            elapsedMs:
              Date.now() -
              requestStartedAt

          });

      }


      return res
        .status(503)
        .json({

          ok:
            false,

          platform:
            "波段分析 Radar 6.4 Unified",

          engine:
            "UNIFIED_LIQUIDITY_160_REDIS",

          error:
            "Radar 正在建立第一份共用榜單，請稍後重新整理"

        });

    }


    /* =====================================================
       4. 我們取得鎖
       → 建立唯一結果
    ===================================================== */

    try {

      const result =
        await buildRadarResult(
          token
        );


      const savedAt =
        Date.now();


      await redisSet(
        FINAL_RESULT_KEY,
        {

          savedAt,

          value:
            result

        },
        REDIS_EXPIRE.final
      );


      /*
        Memory 也同步。
      */

      MEMORY.set(
        FINAL_RESULT_KEY,
        {

          value:
            result,

          freshUntil:
            savedAt +
            CACHE_TTL.final

        }
      );


      res.setHeader(
        "Cache-Control",
        "public, s-maxage=30, stale-while-revalidate=120"
      );


      return res
        .status(200)
        .json({

          ...result,

          ok:
            true,

          cache:
            "MISS-BUILT",

          unified:
            true,

          resultAgeMs:
            0,

          elapsedMs:
            Date.now() -
            requestStartedAt

        });

    }
    catch (buildError) {

      /*
        建置失敗時，如果有舊共用結果，
        寧願回舊結果，也不要每台手機各跑各的。
      */

      if (
        cached &&
        cached.value
      ) {

        console.warn(
          "Radar rebuild failed, use stale unified result:",
          buildError?.message
        );


        res.setHeader(
          "Cache-Control",
          "public, s-maxage=15, stale-while-revalidate=60"
        );


        return res
          .status(200)
          .json({

            ...cached.value,

            ok:
              true,

            cache:
              "STALE-FALLBACK",

            unified:
              true,

            degraded:
              true,

            rebuildError:
              buildError?.message ||
              "Radar rebuild failed",

            resultAgeMs:
              Date.now() -
              cached.savedAt,

            elapsedMs:
              Date.now() -
              requestStartedAt

          });

      }


      throw buildError;

    }
    finally {

      /*
        鎖 TTL 本身也會自動消失。
        正常完成後直接刪掉。
      */

      await redisDel(
        BUILD_LOCK_KEY
      );

    }

  }
  catch (error) {

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

        ok:
          false,

        platform:
          "波段分析 Radar 6.4 Unified",

        engine:
          "UNIFIED_LIQUIDITY_160_REDIS",

        unified:
          true,

        error:
          error?.name ===
          "AbortError"
            ? "FinMind 連線逾時，請重新掃描"
            : error?.message ||
              "Radar server error"

      });

  }

}
