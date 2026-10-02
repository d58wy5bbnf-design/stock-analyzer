const webpush = require("web-push");

/*
  ==========================================================
  波段分析 Monitor 8.1

  正式背景監控：
  DEFAULT 12 + 使用者自選股
  → Stock API 資料
  → 五大類評分
  → 最佳 Entry
  → 結構失效 SL
  → 關鍵突破位
  → TP1 / TP2 / TP3
  → RR
  → 符合條件才 Push

  五大類：
  1. 技術 / 趨勢        20
  2. 量價               20
  3. 法人 / 籌碼        20
  4. 基本面             20
  5. 新聞 / 事件        20

  缺資料：
  - 不直接給 0 分
  - 依實際可用類別重新換算總分
  - completeness 顯示完整度

  正式 Push：
  - score >= 75
  - completeness >= 60
  - technical >= 12
  - volumePrice >= 10
  - 必須進入最佳 Entry 區
  - 結構必須有效
  - 單筆風險 <= 5%
  - TP1 RR >= 1.3
  - 同股票 6 小時去重

  測試模式：
  - ?test=1
  - 或 x-monitor-test: 1
  - 可略過台股交易時段限制
  - 不修改正式 Cron

  強制 Push 測試：
  - testMode + forcePush=1
  - 如果沒有正式 eligible 訊號
  - 強制挑一檔有效交易計畫測 Push
  - 不修改正式 eligibility
  - 不寫正式 dedupe
  - 正式 Cron 不受影響

  注意：
  - 無 SMC
  - 不要求先突破才進場
  - Breakout 是關鍵突破位，不是 TP1
  ==========================================================
*/


/* =========================================================
   CONFIG
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

const WATCHLIST_PREFIX =
  "swing:watchlist:";

const PUSH_DEDUPE_PREFIX =
  "swing:push:dedupe:v8:";

const PUSH_DEDUPE_SECONDS =
  6 * 60 * 60;

const MAX_SYMBOLS =
  40;

const STOCK_BATCH_SIZE =
  4;

const SCORE_LIMIT =
  75;

const COMPLETENESS_LIMIT =
  60;

const TECHNICAL_LIMIT =
  12;

const VOLUME_LIMIT =
  10;

const MAX_RISK_PERCENT =
  5;

const MIN_RR1 =
  1.3;


/* =========================================================
   ENV
========================================================= */

function env(
  name,
  ...fallbacks
) {

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


/* =========================================================
   BASIC HELPERS
========================================================= */

function finite(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;

}


function num(
  value,
  fallback = 0
) {

  const n =
    finite(value);

  return n === null
    ? fallback
    : n;

}


function round(
  value,
  digits = 2
) {

  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  const p =
    10 ** digits;

  return (
    Math.round(
      (n + Number.EPSILON) * p
    ) / p
  );

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


function avg(values) {

  const rows =
    values
      .map(Number)
      .filter(Number.isFinite);

  if (!rows.length) {
    return 0;
  }

  return (
    rows.reduce(
      (a, b) => a + b,
      0
    ) /
    rows.length
  );

}


function unique(values) {

  return [
    ...new Set(
      values
        .map(
          x =>
            String(x || "")
              .trim()
              .toUpperCase()
        )
        .filter(Boolean)
    )
  ];

}


function validSymbol(symbol) {

  return /^[0-9A-Z]{4,10}$/.test(
    String(symbol || "")
  );

}


/* =========================================================
   RESPONSE
========================================================= */

function send(
  res,
  status,
  body
) {

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  return res
    .status(status)
    .json(body);

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

        second:
          "2-digit",

        hour12:
          false
      }
    )
      .formatToParts(
        new Date()
      );

  const result = {};

  for (const part of parts) {
    result[part.type] =
      part.value;
  }

  return result;

}


function taipeiString() {

  return new Date()
    .toLocaleString(
      "zh-TW",
      {
        timeZone:
          "Asia/Taipei",

        hour12:
          false
      }
    );

}


function marketOpenNow() {

  const p =
    taipeiParts();

  const weekday =
    p.weekday;

  if (
    weekday === "Sat" ||
    weekday === "Sun"
  ) {
    return false;
  }

  const hour =
    Number(p.hour);

  const minute =
    Number(p.minute);

  const total =
    hour * 60 +
    minute;

  return (
    total >=
      8 * 60 + 55 &&
    total <=
      13 * 60 + 40
  );

}


/* =========================================================
   TEST MODE
========================================================= */

function isTestMode(req) {

  const queryTest =
    String(
      req?.query?.test ||
      ""
    ) === "1";

  const headerTest =
    String(
      req?.headers?.[
        "x-monitor-test"
      ] ||
      ""
    ) === "1";

  return (
    queryTest ||
    headerTest
  );

}


/* =========================================================
   AUTH
========================================================= */

function authorized(
  req,
  testMode
) {

  const secret =
    env("CRON_SECRET");

  if (!secret) {
    return false;
  }

  const authorization =
    String(
      req?.headers
        ?.authorization ||
      ""
    );

  const bearer =
    authorization.startsWith(
      "Bearer "
    )
      ? authorization.slice(7)
      : "";

  if (bearer === secret) {
    return true;
  }

  const cronHeader =
    String(
      req?.headers?.[
        "x-vercel-cron"
      ] ||
      ""
    );

  if (
    !testMode &&
    cronHeader
  ) {
    return true;
  }

  return false;

}


/* =========================================================
   REDIS
========================================================= */

function redisConfig() {

  const url =
    env(
      "UPSTASH_REDIS_REST_URL",
      "KV_REST_API_URL"
    );

  const token =
    env(
      "UPSTASH_REDIS_REST_TOKEN",
      "KV_REST_API_TOKEN"
    );

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
          JSON.stringify(command)
      }
    );

  const text =
    await response.text();

  if (!response.ok) {

    throw new Error(
      `Redis HTTP ${response.status}: ${text.slice(0, 120)}`
    );

  }

  let json;

  try {

    json =
      JSON.parse(text);

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

  return json?.result ??
    null;

}


async function redisGet(key) {

  try {

    return await redisCommand(
      [
        "GET",
        key
      ]
    );

  } catch (error) {

    console.error(
      "Redis GET:",
      key,
      error?.message
    );

    return null;

  }

}


async function redisSet(
  key,
  value,
  seconds
) {

  try {

    await redisCommand(
      [
        "SET",
        key,
        String(value),
        "EX",
        String(
          Math.max(
            60,
            Math.floor(
              Number(seconds) ||
              3600
            )
          )
        )
      ]
    );

    return true;

  } catch (error) {

    console.error(
      "Redis SET:",
      key,
      error?.message
    );

    return false;

  }

}


async function redisSMembers(key) {

  try {

    const result =
      await redisCommand(
        [
          "SMEMBERS",
          key
        ]
      );

    return Array.isArray(result)
      ? result
      : [];

  } catch (error) {

    console.error(
      "Redis SMEMBERS:",
      key,
      error?.message
    );

    return [];

  }

}


/* =========================================================
   PUSH CONFIG
========================================================= */

function configureWebPush() {

  const subject =
    env("VAPID_SUBJECT");

  const publicKey =
    env("VAPID_PUBLIC_KEY");

  const privateKey =
    env("VAPID_PRIVATE_KEY");

  if (
    !subject ||
    !publicKey ||
    !privateKey
  ) {

    throw new Error(
      "VAPID 環境變數尚未完整設定"
    );

  }

  webpush.setVapidDetails(
    subject,
    publicKey,
    privateKey
  );

}


/* =========================================================
   DEVICE
========================================================= */

function parseJSON(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  if (
    typeof value ===
    "object"
  ) {
    return value;
  }

  try {

    return JSON.parse(
      String(value)
    );

  } catch {

    return null;

  }

}


function normalizeWatchlist(value) {

  if (Array.isArray(value)) {

    return unique(value)
      .filter(validSymbol);

  }

  if (
    typeof value ===
    "string"
  ) {

    const parsed =
      parseJSON(value);

    if (Array.isArray(parsed)) {

      return unique(parsed)
        .filter(validSymbol);

    }

    return unique(
      value.split(",")
    )
      .filter(validSymbol);

  }

  return [];

}


async function loadDevices() {

  const members =
    await redisSMembers(
      DEVICE_SET_KEY
    );

  const devices = [];

  for (const item of members) {

    const parsed =
      parseJSON(item);

    if (
      parsed?.endpoint &&
      parsed?.keys?.p256dh &&
      parsed?.keys?.auth
    ) {

      devices.push(
        {
          subscription:
            parsed,

          deviceKey:
            "",

          watchlist:
            []
        }
      );

      continue;

    }

    const deviceKey =
      String(
        item || ""
      );

    if (!deviceKey) {
      continue;
    }

    const possibleKeys = [
      `swing:push:device:${deviceKey}`,
      `push:device:${deviceKey}`,
      deviceKey
    ];

    let device =
      null;

    for (const key of possibleKeys) {

      const raw =
        await redisGet(key);

      const parsedDevice =
        parseJSON(raw);

      if (
        parsedDevice &&
        (
          parsedDevice.subscription ||
          parsedDevice.endpoint
        )
      ) {

        device =
          parsedDevice;

        break;

      }

    }

    if (!device) {
      continue;
    }

    const subscription =
      device.subscription ||
      device;

    if (
      !subscription?.endpoint ||
      !subscription?.keys?.p256dh ||
      !subscription?.keys?.auth
    ) {
      continue;
    }

    devices.push(
      {
        subscription,

        deviceKey,

        watchlist:
          normalizeWatchlist(
            device.watchlist
          )
      }
    );

  }

  return devices;

}


/* =========================================================
   WATCHLIST
========================================================= */

async function loadWatchlists(
  devices
) {

  const symbols = [];

  for (const device of devices) {

    symbols.push(
      ...device.watchlist
    );

    if (!device.deviceKey) {
      continue;
    }

    const possibleKeys = [
      `${WATCHLIST_PREFIX}${device.deviceKey}`,
      `watchlist:${device.deviceKey}`,
      `swing:watchlist:${device.deviceKey}`
    ];

    for (const key of possibleKeys) {

      const raw =
        await redisGet(key);

      const parsed =
        parseJSON(raw);

      if (Array.isArray(parsed)) {

        symbols.push(
          ...parsed
        );

        break;

      }

      if (
        typeof raw ===
        "string" &&
        raw
      ) {

        symbols.push(
          ...raw.split(",")
        );

        break;

      }

    }

  }

  return unique(symbols)
    .filter(validSymbol);

}


/* =========================================================
   INTERNAL API
========================================================= */

function baseURL(req) {

  const proto =
    String(
      req?.headers?.[
        "x-forwarded-proto"
      ] ||
      "https"
    )
      .split(",")[0]
      .trim();

  const host =
    String(
      req?.headers?.host ||
      process.env.VERCEL_URL ||
      ""
    );

  if (!host) {
    throw new Error(
      "無法取得網站 Host"
    );
  }

  if (
    host.startsWith(
      "http://"
    ) ||
    host.startsWith(
      "https://"
    )
  ) {
    return host;
  }

  return `${proto}://${host}`;

}


async function fetchJSON(
  url,
  timeout = 25000
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
            Accept:
              "application/json"
          },

          signal:
            controller.signal
        }
      );

    const text =
      await response.text();

    let json;

    try {

      json =
        JSON.parse(text);

    } catch {

      throw new Error(
        `JSON 解析失敗 HTTP ${response.status}`
      );

    }

    if (!response.ok) {

      throw new Error(
        json?.error ||
        json?.message ||
        `HTTP ${response.status}`
      );

    }

    return json;

  } finally {

    clearTimeout(timer);

  }

}


/* =========================================================
   STOCK DATA
========================================================= */

async function getStock(
  req,
  symbol
) {

  const url =
    `${baseURL(req)}` +
    `/api/stock?symbol=` +
    encodeURIComponent(symbol);

  const json =
    await fetchJSON(
      url,
      30000
    );

  if (!json?.ok) {

    throw new Error(
      json?.error ||
      `${symbol} Stock API 失敗`
    );

  }

  return json;

}


/* =========================================================
   NEWS
========================================================= */

async function getNews(
  req,
  symbol
) {

  const url =
    `${baseURL(req)}` +
    `/api/news?symbol=` +
    encodeURIComponent(symbol);

  try {

    return await fetchJSON(
      url,
      10000
    );

  } catch (error) {

    console.error(
      "news:",
      symbol,
      error?.message
    );

    return null;

  }

}


/* =========================================================
   INDICATORS
========================================================= */

function SMA(
  values,
  period
) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return NaN;
  }

  return avg(
    values
      .slice(-period)
      .map(Number)
  );

}


function EMA(
  values,
  period
) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return NaN;
  }

  let value =
    avg(
      values
        .slice(0, period)
        .map(Number)
    );

  const k =
    2 /
    (
      period + 1
    );

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    value =
      Number(values[i]) *
      k +
      value *
      (
        1 - k
      );

  }

  return value;

}


function RSI(
  values,
  period = 14
) {

  if (
    !Array.isArray(values) ||
    values.length <= period
  ) {
    return NaN;
  }

  const rows =
    values.slice(
      -(period + 1)
    );

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i < rows.length;
    i++
  ) {

    const diff =
      Number(rows[i]) -
      Number(rows[i - 1]);

    if (diff > 0) {

      gain += diff;

    } else {

      loss +=
        Math.abs(diff);

    }

  }

  gain /=
    period;

  loss /=
    period;

  if (loss === 0) {
    return 100;
  }

  const rs =
    gain / loss;

  return (
    100 -
    100 /
    (
      1 + rs
    )
  );

}


function ATR(
  rows,
  period = 14
) {

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
   TECHNICAL SCORE 20
========================================================= */

function scoreTechnical(stock) {

  const rows =
    stock.rows || [];

  if (rows.length < 65) {

    return {
      available:
        false,

      score:
        0
    };

  }

  const closes =
    rows.map(
      x =>
        num(x.close)
    );

  const price =
    num(
      stock.price,
      closes[
        closes.length - 1
      ]
    );

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
    RSI(closes, 14);

  const macd =
    EMA(
      closes.slice(-100),
      12
    ) -
    EMA(
      closes.slice(-100),
      26
    );

  let score = 0;

  if (price > ma20) {
    score += 4;
  }

  if (ma20 > ma60) {
    score += 5;
  }

  if (
    price > ma5 &&
    ma5 >= ma10
  ) {
    score += 3;
  }

  if (
    Number.isFinite(
      previousMA20
    ) &&
    ma20 >
      previousMA20
  ) {
    score += 3;
  }

  if (
    rsi >= 45 &&
    rsi <= 72
  ) {
    score += 3;
  }

  if (macd >= 0) {
    score += 2;
  }

  return {

    available:
      true,

    score:
      clamp(
        score,
        0,
        20
      ),

    ma5:
      round(ma5),

    ma10:
      round(ma10),

    ma20:
      round(ma20),

    ma60:
      round(ma60),

    rsi:
      round(
        rsi,
        1
      ),

    macd:
      round(macd)

  };

}


/* =========================================================
   VOLUME / PRICE SCORE 20
========================================================= */

function scoreVolumePrice(stock) {

  const rows =
    stock.rows || [];

  if (rows.length < 21) {

    return {
      available:
        false,

      score:
        0
    };

  }

  const latest =
    rows[
      rows.length - 1
    ];

  const previous =
    rows.slice(
      -21,
      -1
    );

  const avgVolume20 =
    avg(
      previous.map(
        x =>
          num(x.volume)
      )
    );

  const currentVolume =
    num(
      stock.volume,
      latest.volume
    );

  const volumeRatio =
    avgVolume20 > 0
      ? currentVolume /
        avgVolume20
      : 0;

  const price =
    num(
      stock.price,
      latest.close
    );

  const open =
    num(
      stock.open,
      latest.open
    );

  const high =
    num(
      stock.high,
      latest.high
    );

  const low =
    num(
      stock.low,
      latest.low
    );

  const changePercent =
    num(
      stock.changePercent
    );

  const range =
    high - low;

  const dayPosition =
    range > 0
      ? clamp(
          (
            price - low
          ) /
          range,
          0,
          1
        )
      : 0.5;

  let score = 0;

  if (
    volumeRatio >= 1.5
  ) {

    score += 7;

  } else if (
    volumeRatio >= 1.1
  ) {

    score += 5;

  } else if (
    volumeRatio >= 0.8
  ) {

    score += 2;

  }

  if (
    changePercent >= 0 &&
    changePercent <= 5
  ) {

    score += 4;

  } else if (
    changePercent >= -1.5
  ) {

    score += 2;

  }

  if (
    dayPosition >= 0.65
  ) {

    score += 4;

  } else if (
    dayPosition >= 0.5
  ) {

    score += 2;

  }

  if (price >= open) {
    score += 2;
  }

  const previousHigh20 =
    Math.max(
      ...previous.map(
        x =>
          num(x.high)
      )
    );

  const atr =
    ATR(
      rows,
      14
    );

  if (
    Number.isFinite(atr) &&
    atr > 0
  ) {

    const distance =
      (
        price -
        previousHigh20
      ) /
      atr;

    if (
      distance >= -0.6 &&
      distance <= 1.2
    ) {

      score += 3;

    }

  }

  return {

    available:
      true,

    score:
      clamp(
        score,
        0,
        20
      ),

    volumeRatio:
      round(
        volumeRatio,
        2
      ),

    dayPosition:
      round(
        dayPosition * 100,
        1
      )

  };

}


/* =========================================================
   INSTITUTIONAL SCORE 20
========================================================= */

function scoreInstitutional(stock) {

  const x =
    stock.institutional;

  if (!x?.available) {

    return {
      available:
        false,

      score:
        0
    };

  }

  let score = 0;

  const foreign5 =
    num(x.foreign5);

  const trust5 =
    num(x.trust5);

  const dealer5 =
    num(x.dealer5);

  const total5 =
    num(x.total5);

  const total10 =
    num(x.total10);

  const foreignDays =
    num(
      x.foreignBuyDays5
    );

  const trustDays =
    num(
      x.trustBuyDays5
    );

  const totalDays =
    num(
      x.totalBuyDays5
    );

  if (total5 > 0) {
    score += 5;
  }

  if (total10 > 0) {
    score += 3;
  }

  if (foreign5 > 0) {
    score += 4;
  }

  if (trust5 > 0) {
    score += 3;
  }

  if (dealer5 > 0) {
    score += 1;
  }

  if (foreignDays >= 3) {
    score += 2;
  }

  if (trustDays >= 2) {
    score += 1;
  }

  if (totalDays >= 3) {
    score += 1;
  }

  return {

    available:
      true,

    score:
      clamp(
        score,
        0,
        20
      ),

    foreign5,

    trust5,

    dealer5,

    total5,

    total10

  };

}


/* =========================================================
   FUNDAMENTAL SCORE 20
========================================================= */

function scoreFundamental(stock) {

  const revenue =
    stock?.revenue ||
    stock?.fundamental
      ?.revenue;

  const financial =
    stock?.financial ||
    stock?.fundamental
      ?.financial;

  const available =
    Boolean(
      revenue?.available ||
      financial?.available
    );

  if (!available) {

    return {
      available:
        false,

      score:
        0
    };

  }

  let score = 0;

  if (revenue?.available) {

    const yoy =
      finite(
        revenue.yoy
      );

    const mom =
      finite(
        revenue.mom
      );

    if (yoy !== null) {

      if (yoy >= 20) {

        score += 6;

      } else if (
        yoy >= 10
      ) {

        score += 5;

      } else if (
        yoy > 0
      ) {

        score += 3;

      } else if (
        yoy < -10
      ) {

        score -= 2;

      }

    }

    if (mom !== null) {

      if (mom >= 10) {

        score += 3;

      } else if (
        mom > 0
      ) {

        score += 2;

      }

    }

  }

  if (financial?.available) {

    const eps =
      finite(
        financial.eps
      );

    const epsGrowth =
      finite(
        financial.epsGrowth
      );

    const netIncomeGrowth =
      finite(
        financial.netIncomeGrowth
      );

    if (
      eps !== null &&
      eps > 0
    ) {
      score += 4;
    }

    if (
      epsGrowth !== null
    ) {

      if (
        epsGrowth >= 20
      ) {

        score += 4;

      } else if (
        epsGrowth > 0
      ) {

        score += 2;

      }

    }

    if (
      netIncomeGrowth !== null &&
      netIncomeGrowth > 0
    ) {
      score += 2;
    }

    if (
      financial.profitable ===
      true
    ) {
      score += 1;
    }

  }

  return {

    available:
      true,

    score:
      clamp(
        score,
        0,
        20
      ),

    yoy:
      revenue?.yoy ??
      null,

    mom:
      revenue?.mom ??
      null,

    eps:
      financial?.eps ??
      null,

    epsGrowth:
      financial?.epsGrowth ??
      null

  };

}


/* =========================================================
   NEWS SCORE 20
========================================================= */

function scoreNews(news) {

  if (!news) {

    return {
      available:
        false,

      score:
        0
    };

  }

  let raw =
    finite(
      news.overallScore
    );

  if (raw === null) {

    raw =
      finite(
        news.score
      );

  }

  const hasArticles =
    Array.isArray(
      news.news
    )
      ? news.news.length > 0
      : Array.isArray(
          news.items
        )
      ? news.items.length > 0
      : raw !== null;

  if (!hasArticles) {

    return {
      available:
        false,

      score:
        0
    };

  }

  if (raw === null) {
    raw = 0;
  }

  return {

    available:
      true,

    score:
      clamp(
        round(
          raw + 10,
          0
        ),
        0,
        20
      ),

    raw:
      round(
        raw,
        1
      )

  };

}


/* =========================================================
   TOTAL SCORE
========================================================= */

function buildScore(categories) {

  const rows = [
    categories.technical,
    categories.volumePrice,
    categories.institutional,
    categories.fundamental,
    categories.news
  ];

  const available =
    rows.filter(
      x =>
        x?.available
    );

  const availableCount =
    available.length;

  const completeness =
    availableCount /
    5 *
    100;

  if (!availableCount) {

    return {
      score:
        0,

      completeness:
        0,

      availableCount:
        0
    };

  }

  const raw =
    available.reduce(
      (
        total,
        x
      ) =>
        total +
        num(x.score),
      0
    );

  const maxAvailable =
    availableCount *
    20;

  const score =
    maxAvailable > 0
      ? raw /
        maxAvailable *
        100
      : 0;

  return {

    score:
      clamp(
        round(
          score,
          0
        ),
        0,
        100
      ),

    completeness:
      round(
        completeness,
        0
      ),

    availableCount

  };

}


/* =========================================================
   TRADE PLAN 8.1
========================================================= */

function buildTradePlan(stock) {

  const rows =
    Array.isArray(
      stock.rows
    )
      ? stock.rows
      : [];

  if (rows.length < 65) {

    return {
      valid:
        false,

      reason:
        "K 線不足"
    };

  }

  const latest =
    rows[
      rows.length - 1
    ];

  const price =
    num(
      stock.price,
      latest.close
    );

  if (price <= 0) {

    return {
      valid:
        false,

      reason:
        "現價無效"
    };

  }

  const closes =
    rows.map(
      x =>
        num(x.close)
    );

  const ma10 =
    SMA(closes, 10);

  const ma20 =
    SMA(closes, 20);

  const ma60 =
    SMA(closes, 60);

  let atr =
    ATR(
      rows,
      14
    );

  if (
    !Number.isFinite(atr) ||
    atr <= 0
  ) {

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

  const previous40 =
    rows.slice(
      -41,
      -1
    );

  const previous60 =
    rows.slice(
      -61,
      -1
    );

  const low10 =
    Math.min(
      ...rows
        .slice(-10)
        .map(
          x =>
            num(
              x.low,
              price
            )
        )
    );

  const low20 =
    Math.min(
      ...rows
        .slice(-20)
        .map(
          x =>
            num(
              x.low,
              price
            )
        )
    );

  const supportCandidates =
    [
      low10,
      low20,
      ma20 -
        atr * 0.5,
      ma10 -
        atr * 0.8
    ]
      .filter(
        x =>
          Number.isFinite(x) &&
          x > 0 &&
          x <=
            price +
            atr * 0.8
      );

  if (
    !supportCandidates.length
  ) {

    return {
      valid:
        false,

      reason:
        "找不到有效支撐"
    };

  }

  supportCandidates.sort(
    (a, b) =>
      Math.abs(
        price - a
      ) -
      Math.abs(
        price - b
      )
  );

  const support =
    supportCandidates[0];

  let entryLow =
    support -
    atr * 0.18;

  let entryHigh =
    support +
    atr * 0.55;

  entryHigh =
    Math.min(
      entryHigh,
      price +
      atr * 0.2
    );

  entryLow =
    Math.max(
      0.01,
      entryLow
    );

  if (
    entryHigh <
    entryLow
  ) {

    entryHigh =
      entryLow +
      atr * 0.35;

  }

  const structureLow =
    Math.min(
      low10,
      support
    );

  const stop =
    structureLow -
    atr * 0.35;

  const resistance20 =
    Math.max(
      ...previous20.map(
        x =>
          num(x.high)
      )
    );

  let breakout =
    resistance20;

  if (
    breakout <=
    price
  ) {

    const higher =
      previous40
        .map(
          x =>
            num(x.high)
        )
        .filter(
          x =>
            x >
            price +
            atr * 0.15
        )
        .sort(
          (a, b) =>
            a - b
        );

    if (higher.length) {

      breakout =
        higher[0];

    } else {

      breakout =
        price +
        atr * 0.8;

    }

  }

  const resistancePool =
    previous60
      .map(
        x =>
          num(x.high)
      )
      .filter(
        x =>
          x >
          breakout +
          atr * 0.2
      )
      .sort(
        (a, b) =>
          a - b
      );

  let tp1 =
    resistancePool.length
      ? resistancePool[0]
      : breakout +
        atr * 1.2;

  if (
    tp1 <= breakout
  ) {

    tp1 =
      breakout +
      atr * 1.2;

  }

  const tp2 =
    Math.max(
      tp1 +
      atr * 1.2,
      breakout +
      atr * 2.2
    );

  const tp3 =
    Math.max(
      tp2 +
      atr * 1.5,
      breakout +
      atr * 3.8
    );

  const entryMid =
    (
      entryLow +
      entryHigh
    ) /
    2;

  const risk =
    entryMid -
    stop;

  if (risk <= 0) {

    return {
      valid:
        false,

      reason:
        "風險距離無效"
    };

  }

  const rr1 =
    (
      tp1 -
      entryMid
    ) /
    risk;

  const rr2 =
    (
      tp2 -
      entryMid
    ) /
    risk;

  const rr3 =
    (
      tp3 -
      entryMid
    ) /
    risk;

  const riskPercent =
    (
      risk /
      entryMid
    ) *
    100;

  const entryTolerance =
    atr * 0.15;

  const entryReady =
    price >=
      entryLow -
      entryTolerance &&
    price <=
      entryHigh +
      entryTolerance;

  const structureValid =
    price >
    stop;

  return {

    valid:
      true,

    price:
      round(price),

    atr:
      round(atr),

    ma10:
      round(ma10),

    ma20:
      round(ma20),

    ma60:
      round(ma60),

    support:
      round(support),

    entryLow:
      round(entryLow),

    entryHigh:
      round(entryHigh),

    entryMid:
      round(entryMid),

    stop:
      round(stop),

    structureLow:
      round(
        structureLow
      ),

    breakout:
      round(
        breakout
      ),

    tp1:
      round(tp1),

    tp2:
      round(tp2),

    tp3:
      round(tp3),

    rr1:
      round(
        rr1,
        2
      ),

    rr2:
      round(
        rr2,
        2
      ),

    rr3:
      round(
        rr3,
        2
      ),

    riskPercent:
      round(
        riskPercent,
        2
      ),

    entryReady,

    structureValid

  };

}


/* =========================================================
   ANALYZE ONE STOCK
========================================================= */

async function analyzeStock(
  req,
  symbol
) {

  const stock =
    await getStock(
      req,
      symbol
    );

  const news =
    await getNews(
      req,
      symbol
    );

  const categories = {

    technical:
      scoreTechnical(
        stock
      ),

    volumePrice:
      scoreVolumePrice(
        stock
      ),

    institutional:
      scoreInstitutional(
        stock
      ),

    fundamental:
      scoreFundamental(
        stock
      ),

    news:
      scoreNews(
        news
      )

  };

  const total =
    buildScore(
      categories
    );

  const plan =
    buildTradePlan(
      stock
    );

  const eligible =
    Boolean(

      total.score >=
        SCORE_LIMIT &&

      total.completeness >=
        COMPLETENESS_LIMIT &&

      categories
        .technical
        .available &&

      categories
        .technical
        .score >=
        TECHNICAL_LIMIT &&

      categories
        .volumePrice
        .available &&

      categories
        .volumePrice
        .score >=
        VOLUME_LIMIT &&

      plan.valid &&

      plan.entryReady &&

      plan.structureValid &&

      plan.riskPercent <=
        MAX_RISK_PERCENT &&

      plan.rr1 >=
        MIN_RR1
    );

  return {

    symbol,

    name:
      stock.name ||
      symbol,

    price:
      stock.price,

    changePercent:
      stock.changePercent,

    score:
      total.score,

    completeness:
      total.completeness,

    availableCategories:
      total.availableCount,

    categories,

    plan,

    eligible,

    degraded:
      Boolean(
        stock.degraded
      ),

    stockErrors:
      stock.errors ||
      {},

    newsAvailable:
      categories
        .news
        .available

  };

}


/* =========================================================
   DEDUPE
========================================================= */

async function isDuplicate(
  signal
) {

  const key =
    `${PUSH_DEDUPE_PREFIX}${signal.symbol}`;

  const exists =
    await redisGet(key);

  return Boolean(exists);

}


async function markDuplicate(
  signal
) {

  const key =
    `${PUSH_DEDUPE_PREFIX}${signal.symbol}`;

  return redisSet(
    key,
    JSON.stringify(
      {
        symbol:
          signal.symbol,

        price:
          signal.price,

        score:
          signal.score,

        sentAt:
          Date.now()
      }
    ),
    PUSH_DEDUPE_SECONDS
  );

}


/* =========================================================
   PUSH MESSAGE
========================================================= */

function pushPayload(
  signal,
  testMode,
  forcePush = false
) {

  const p =
    signal.plan;

  const prefix =
    forcePush
      ? "🧪 強制測試｜"
      : testMode
      ? "🧪 測試｜"
      : "";

  const title =
    `${prefix}${signal.name} ${signal.symbol}｜進入波段進場區`;

  const body =
    [
      `現價 ${round(signal.price)}`,
      `評分 ${signal.score}｜完整度 ${signal.completeness}%`,
      `Entry ${p.entryLow}～${p.entryHigh}`,
      `SL ${p.stop}`,
      `突破 ${p.breakout}`,
      `TP1 ${p.tp1}｜RR ${p.rr1}`,
      `TP2 ${p.tp2}｜TP3 ${p.tp3}`
    ]
      .join("\n");

  return JSON.stringify(
    {
      title,

      body,

      icon:
        "/icons/icon-192.png",

      badge:
        "/icons/icon-192.png",

      tag:
        `swing-${signal.symbol}`,

      renotify:
        true,

      data: {
        url:
          `/?symbol=${encodeURIComponent(signal.symbol)}`,

        symbol:
          signal.symbol,

        score:
          signal.score,

        testMode:
          Boolean(testMode),

        forcePush:
          Boolean(forcePush),

        entryLow:
          p.entryLow,

        entryHigh:
          p.entryHigh,

        stop:
          p.stop,

        breakout:
          p.breakout,

        tp1:
          p.tp1,

        tp2:
          p.tp2,

        tp3:
          p.tp3,

        rr1:
          p.rr1
      }
    }
  );

}


/* =========================================================
   SEND PUSH
========================================================= */

async function sendSignal(
  devices,
  signal,
  testMode,
  forcePush = false
) {

  const payload =
    pushPayload(
      signal,
      testMode,
      forcePush
    );

  let sent = 0;

  const errors = [];

  for (const device of devices) {

    try {

      await webpush
        .sendNotification(
          device.subscription,
          payload,
          {
            TTL:
              300
          }
        );

      sent += 1;

    } catch (error) {

      errors.push(
        {
          endpoint:
            String(
              device
                .subscription
                ?.endpoint ||
              ""
            )
              .slice(
                0,
                80
              ),

          statusCode:
            error?.statusCode ||
            null,

          message:
            error?.message ||
            "Push failed"
        }
      );

    }

  }

  return {
    sent,
    errors
  };

}


/* =========================================================
   MAIN
========================================================= */

module.exports =
async function handler(
  req,
  res
) {

  const startedAt =
    Date.now();

  const testMode =
    isTestMode(
      req
    );

  /*
    forcePush 只有 testMode 才能啟動。

    所以即使正式 /api/monitor
    被加上 ?forcePush=1，
    只要不是 testMode，
    就完全不會強制推播。
  */

  const forcePush =
    testMode &&
    String(
      req?.query?.forcePush ||
      ""
    ) === "1";

  try {

    /* =====================================================
       AUTH
    ===================================================== */

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

          engine:
            "Monitor 8.1",

          error:
            "Unauthorized"
        }
      );

    }


    /* =====================================================
       MARKET HOURS
    ===================================================== */

    if (
      !testMode &&
      !marketOpenNow()
    ) {

      return send(
        res,
        200,
        {
          ok:
            true,

          engine:
            "Monitor 8.1",

          skipped:
            true,

          reason:
            "台股目前非監控時段",

          taipeiTime:
            taipeiString(),

          marketWindow:
            "08:55-13:40",

          testMode:
            false,

          forcePush:
            false
        }
      );

    }


    /* =====================================================
       PUSH
    ===================================================== */

    configureWebPush();


    /* =====================================================
       DEVICES
    ===================================================== */

    const devices =
      await loadDevices();

    if (!devices.length) {

      return send(
        res,
        200,
        {
          ok:
            true,

          engine:
            "Monitor 8.1",

          skipped:
            true,

          reason:
            "目前沒有 Push 訂閱裝置",

          taipeiTime:
            taipeiString(),

          testMode,

          forcePush
        }
      );

    }


    /* =====================================================
       SYMBOL UNIVERSE

       正式：
       DEFAULT 12 + Watchlist

       Radar 不擴大 Push Universe
    ===================================================== */

    const watchlist =
      await loadWatchlists(
        devices
      );

    const allSymbols =
      unique(
        [
          ...DEFAULT_SYMBOLS,
          ...watchlist
        ]
      )
        .filter(
          validSymbol
        )
        .slice(
          0,
          MAX_SYMBOLS
        );


    /* =====================================================
       ANALYZE
    ===================================================== */

    const signals = [];

    const failedStocks = [];

    for (
      let i = 0;
      i < allSymbols.length;
      i += STOCK_BATCH_SIZE
    ) {

      const batch =
        allSymbols.slice(
          i,
          i +
          STOCK_BATCH_SIZE
        );

      const results =
        await Promise.allSettled(
          batch.map(
            symbol =>
              analyzeStock(
                req,
                symbol
              )
          )
        );

      for (
        let j = 0;
        j < results.length;
        j++
      ) {

        const result =
          results[j];

        const symbol =
          batch[j];

        if (
          result.status ===
          "fulfilled"
        ) {

          signals.push(
            result.value
          );

        } else {

          failedStocks.push(
            {
              symbol,

              error:
                result.reason
                  ?.message ||
                "分析失敗"
            }
          );

        }

      }

    }


    /* =====================================================
       SORT
    ===================================================== */

    signals.sort(
      (a, b) =>
        b.score -
        a.score
    );

    const eligibleSignals =
      signals.filter(
        x =>
          x.eligible
      );


    /* =====================================================
       FORCE PUSH TEST

       正常：
       只推 eligibleSignals。

       forcePush=1：
       若目前沒有正式 eligible，
       挑一檔有效交易計畫測試 Push。

       優先：
       1. plan valid
       2. structure valid
       3. 分數最高

       不會把 signal.eligible 改成 true。
    ===================================================== */

    let pushSignals =
      eligibleSignals;

    let forcedTestSymbol =
      null;

    if (
      forcePush &&
      pushSignals.length === 0
    ) {

      const testSignal =
        signals.find(
          x =>
            x?.plan?.valid &&
            x?.plan?.structureValid
        );

      if (testSignal) {

        pushSignals = [
          testSignal
        ];

        forcedTestSymbol =
          testSignal.symbol;

      }

    }


    /* =====================================================
       PUSH
    ===================================================== */

    let pushSent = 0;

    let duplicateCount = 0;

    const pushErrors = [];

    const pushedSymbols = [];

    for (
      const signal of
      pushSignals
    ) {

      /*
        正式模式：
        檢查 6 小時 dedupe。

        所有 testMode：
        不檢查正式 dedupe，
        也不寫入正式 dedupe。
      */

      if (!testMode) {

        const duplicate =
          await isDuplicate(
            signal
          );

        if (duplicate) {

          duplicateCount += 1;

          continue;

        }

      }

      const isForcedSignal =
        forcePush &&
        forcedTestSymbol ===
          signal.symbol;

      const result =
        await sendSignal(
          devices,
          signal,
          testMode,
          isForcedSignal
        );

      pushSent +=
        result.sent;

      pushedSymbols.push(
        signal.symbol
      );

      if (
        result.errors.length
      ) {

        pushErrors.push(
          ...result.errors.map(
            error => ({
              symbol:
                signal.symbol,

              ...error
            })
          )
        );

      }

      if (
        !testMode &&
        result.sent > 0
      ) {

        await markDuplicate(
          signal
        );

      }

    }


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
          "Monitor 8.1",

        platform:
          "波段分析",

        strategy:
          "Swing Entry 8.1",

        testMode,

        forcePush,

        forcedTestSymbol,

        marketOpen:
          marketOpenNow(),

        taipeiTime:
          taipeiString(),

        elapsedMs:
          Date.now() -
          startedAt,

        devices:
          devices.length,

        defaultSymbols:
          DEFAULT_SYMBOLS.length,

        watchlistSymbols:
          watchlist.length,

        monitoredSymbols:
          allSymbols.length,

        analyzedStocks:
          signals.length,

        eligibleSignals:
          eligibleSignals.length,

        pushCandidates:
          pushSignals.length,

        pushSent,

        pushedSymbols,

        duplicateCount,

        pushErrors,

        failedStocks,

        rules: {

          score:
            SCORE_LIMIT,

          completeness:
            COMPLETENESS_LIMIT,

          technical:
            TECHNICAL_LIMIT,

          volumePrice:
            VOLUME_LIMIT,

          maxRiskPercent:
            MAX_RISK_PERCENT,

          minRR1:
            MIN_RR1,

          entryRequired:
            true,

          breakoutRequired:
            false,

          smcRequired:
            false,

          forcePushOnlyInTestMode:
            true

        },

        signals:
          signals.map(
            signal => ({

              symbol:
                signal.symbol,

              name:
                signal.name,

              price:
                signal.price,

              score:
                signal.score,

              completeness:
                signal.completeness,

              technical:
                signal
                  .categories
                  .technical
                  .score,

              volumePrice:
                signal
                  .categories
                  .volumePrice
                  .score,

              institutional:
                signal
                  .categories
                  .institutional
                  .available
                  ? signal
                      .categories
                      .institutional
                      .score
                  : null,

              fundamental:
                signal
                  .categories
                  .fundamental
                  .available
                  ? signal
                      .categories
                      .fundamental
                      .score
                  : null,

              news:
                signal
                  .categories
                  .news
                  .available
                  ? signal
                      .categories
                      .news
                      .score
                  : null,

              eligible:
                signal.eligible,

              entryReady:
                Boolean(
                  signal.plan
                    ?.entryReady
                ),

              plan:
                signal.plan

            })
          )

      }
    );

  } catch (error) {

    console.error(
      "Monitor 8.1 error:",
      error
    );

    return send(
      res,
      500,
      {

        ok:
          false,

        engine:
          "Monitor 8.1",

        testMode,

        forcePush,

        taipeiTime:
          taipeiString(),

        error:
          error?.name ===
          "AbortError"
            ? "Monitor API 連線逾時"
            : error?.message ||
              "Monitor failed"

      }
    );

  }

};
