const webpush = require("web-push");

/* =========================================================
   台股背景進場訊號監控
   - 給 cron-job.org 呼叫
   - FinMind 資料由 /api/stock 取得
   - Redis / Upstash 儲存 Push 訂閱
   - 7/8、8/8 才有資格通知
   - 6/8 不推播
   - 必須接近真實結構支撐才通知
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
  const names = [name, ...fallbacks];

  for (const key of names) {
    const value = process.env[key];
    if (value) return value;
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
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

/* =========================================================
   Redis REST
   ========================================================= */

async function redis(command) {
  const url = REDIS_URL();
  const token = REDIS_TOKEN();

  if (!url || !token) {
    throw new Error("Redis 環境變數不存在");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok || json.error) {
    throw new Error(
      json.error ||
      `Redis HTTP ${response.status}`
    );
  }

  return json.result;
}

async function getDeviceIds() {
  const result = await redis([
    "SMEMBERS",
    DEVICE_SET_KEY
  ]);

  return Array.isArray(result) ? result : [];
}

async function getDevice(deviceId) {
  const raw = await redis([
    "GET",
    `swing:push:device:${deviceId}`
  ]);

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
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
      process.env.VAPID_PUBLIC_KEY || ""
    ).trim();

  const privateKey =
    String(
      process.env.VAPID_PRIVATE_KEY || ""
    ).trim();

  let subject =
    String(
      process.env.VAPID_SUBJECT || ""
    ).trim();

  if (!publicKey) {
    throw new Error("缺少 VAPID_PUBLIC_KEY");
  }

  if (!privateKey) {
    throw new Error("缺少 VAPID_PRIVATE_KEY");
  }

  if (!subject) {
    throw new Error("缺少 VAPID_SUBJECT");
  }

  /*
    web-push 規定 VAPID subject 必須是：
    mailto:xxx@example.com
    或合法 https:// URL

    如果 Vercel 裡只有 Email，
    這裡自動補 mailto:
  */

  if (
    !subject.toLowerCase().startsWith("mailto:") &&
    !/^https?:\/\//i.test(subject)
  ) {
    subject = `mailto:${subject}`;
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
  const parts = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: "Asia/Taipei",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }
  ).formatToParts(new Date());

  const get = type =>
    parts.find(x => x.type === type)?.value;

  return {
    weekday: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute"))
  };
}

function isMarketMonitoringTime() {
  const { weekday, hour, minute } = taipeiParts();

  if (weekday === "Sat" || weekday === "Sun") {
    return false;
  }

  const now = hour * 60 + minute;

  // 台股監控時間 08:55 ～ 13:40
  return (
    now >= 8 * 60 + 55 &&
    now <= 13 * 60 + 40
  );
}

/* =========================================================
   Math
   ========================================================= */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function avg(arr) {
  if (!arr.length) return 0;

  return (
    arr.reduce(
      (sum, x) => sum + num(x),
      0
    ) / arr.length
  );
}

function sma(values, period) {
  if (values.length < period) return 0;

  return avg(
    values.slice(-period)
  );
}

function ema(values, period) {
  if (!values.length) return 0;

  const k = 2 / (period + 1);

  let result = num(values[0]);

  for (let i = 1; i < values.length; i++) {
    result =
      num(values[i]) * k +
      result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  const start = values.length - period;

  for (let i = start; i < values.length; i++) {
    const diff =
      num(values[i]) -
      num(values[i - 1]);

    if (diff > 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function atr(rows, period = 14) {
  if (rows.length < period + 1) return 0;

  const trs = [];

  for (
    let i = rows.length - period;
    i < rows.length;
    i++
  ) {
    const row = rows[i];
    const prev = rows[i - 1];

    const high = num(row.high);
    const low = num(row.low);
    const prevClose = num(prev.close);

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );
  }

  return avg(trs);
}

function fmtPrice(value) {
  const n = num(value);

  if (!n) return "-";

  if (n >= 1000) {
    return n.toFixed(0);
  }

  if (n >= 100) {
    return n.toFixed(1);
  }

  return n.toFixed(2);
}

/* =========================================================
   Swing structure
   ========================================================= */

function findSwingLows(rows, lookback = 3) {
  const result = [];

  for (
    let i = lookback;
    i < rows.length - lookback;
    i++
  ) {
    const low = num(rows[i].low);

    let valid = true;

    for (
      let j = i - lookback;
      j <= i + lookback;
      j++
    ) {
      if (j === i) continue;

      if (num(rows[j].low) < low) {
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

function findSwingHighs(rows, lookback = 3) {
  const result = [];

  for (
    let i = lookback;
    i < rows.length - lookback;
    i++
  ) {
    const high = num(rows[i].high);

    let valid = true;

    for (
      let j = i - lookback;
      j <= i + lookback;
      j++
    ) {
      if (j === i) continue;

      if (num(rows[j].high) > high) {
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
   SMC Demand / Bullish OB
   ========================================================= */

function findBullishOrderBlocks(
  rows,
  currentPrice,
  A
) {
  const zones = [];

  const start = Math.max(
    2,
    rows.length - 90
  );

  for (
    let i = start;
    i < rows.length - 2;
    i++
  ) {
    const candle = rows[i];

    const open = num(candle.open);
    const close = num(candle.close);
    const high = num(candle.high);
    const low = num(candle.low);

    if (!(close < open)) continue;

    const next1 = rows[i + 1];
    const next2 = rows[i + 2];

    const n1Close = num(next1.close);
    const n2Close = num(next2.close);

    const displacement =
      Math.max(n1Close, n2Close) - high;

    if (
      displacement <=
      Math.max(
        A * 0.35,
        high * 0.004
      )
    ) {
      continue;
    }

    const zoneLow = low;
    const zoneHigh = Math.max(open, close);

    let invalidated = false;

    for (
      let j = i + 1;
      j < rows.length;
      j++
    ) {
      if (
        num(rows[j].close) <
        zoneLow - A * 0.12
      ) {
        invalidated = true;
        break;
      }
    }

    if (invalidated) continue;

    if (zoneLow > currentPrice * 1.02) {
      continue;
    }

    let score = 3;

    const move =
      displacement /
      Math.max(A, 0.0001);

    score += Math.min(3, move);

    const age =
      rows.length - 1 - i;

    if (age <= 20) {
      score += 1;
    } else if (age <= 45) {
      score += 0.5;
    }

    zones.push({
      type: "Bullish OB",
      low: zoneLow,
      high: zoneHigh,
      index: i,
      score
    });
  }

  return zones;
}

/* =========================================================
   Bullish FVG
   ========================================================= */

function findBullishFVG(
  rows,
  currentPrice,
  A
) {
  const zones = [];

  const start = Math.max(
    2,
    rows.length - 90
  );

  for (
    let i = start;
    i < rows.length;
    i++
  ) {
    const left = rows[i - 2];
    const right = rows[i];

    const leftHigh = num(left.high);
    const rightLow = num(right.low);

    if (rightLow <= leftHigh) continue;

    const gap =
      rightLow - leftHigh;

    if (
      gap <
      Math.max(
        A * 0.12,
        currentPrice * 0.0015
      )
    ) {
      continue;
    }

    const zoneLow = leftHigh;
    const zoneHigh = rightLow;

    let fullyBroken = false;

    for (
      let j = i + 1;
      j < rows.length;
      j++
    ) {
      if (
        num(rows[j].close) <
        zoneLow - A * 0.1
      ) {
        fullyBroken = true;
        break;
      }
    }

    if (fullyBroken) continue;

    if (zoneLow > currentPrice * 1.02) {
      continue;
    }

    zones.push({
      type: "Bullish FVG",
      low: zoneLow,
      high: zoneHigh,
      index: i,
      score:
        3 +
        Math.min(
          2,
          gap /
          Math.max(A, 0.0001)
        )
    });
  }

  return zones;
}

/* =========================================================
   Liquidity sweep
   ========================================================= */

function findBullishSweeps(
  rows,
  currentPrice,
  A
) {
  const zones = [];

  const start = Math.max(
    10,
    rows.length - 70
  );

  for (
    let i = start;
    i < rows.length;
    i++
  ) {
    const previous = rows.slice(
      Math.max(0, i - 10),
      i
    );

    if (!previous.length) continue;

    const previousLow =
      Math.min(
        ...previous.map(
          x => num(x.low)
        )
      );

    const row = rows[i];

    const low = num(row.low);
    const close = num(row.close);
    const open = num(row.open);

    if (
      low < previousLow &&
      close > previousLow &&
      close >= open
    ) {
      const zoneLow = low;
      const zoneHigh = previousLow;

      let invalidated = false;

      for (
        let j = i + 1;
        j < rows.length;
        j++
      ) {
        if (
          num(rows[j].close) <
          zoneLow - A * 0.1
        ) {
          invalidated = true;
          break;
        }
      }

      if (invalidated) continue;

      if (zoneLow > currentPrice * 1.02) {
        continue;
      }

      zones.push({
        type: "Liquidity Sweep",
        low: zoneLow,
        high: zoneHigh,
        index: i,
        score: 5
      });
    }
  }

  return zones;
}

/* =========================================================
   BOS / Breaker support
   ========================================================= */

function findBreakerSupports(
  rows,
  currentPrice,
  A
) {
  const highs =
    findSwingHighs(rows, 3);

  const zones = [];

  for (const swing of highs) {
    let breakIndex = -1;

    const buffer =
      Math.max(
        A * 0.08,
        swing.price * 0.001
      );

    for (
      let j = swing.index + 1;
      j < rows.length;
      j++
    ) {
      if (
        num(rows[j].close) >
        swing.price + buffer
      ) {
        breakIndex = j;
        break;
      }
    }

    if (breakIndex < 0) continue;

    let failed = false;

    for (
      let j = breakIndex + 1;
      j < rows.length;
      j++
    ) {
      if (
        num(rows[j].close) <
        swing.price - A * 0.22
      ) {
        failed = true;
        break;
      }
    }

    if (failed) continue;

    const zoneLow =
      swing.price - A * 0.18;

    const zoneHigh =
      swing.price + A * 0.12;

    if (zoneLow > currentPrice * 1.02) {
      continue;
    }

    zones.push({
      type: "BOS / Breaker",
      low: zoneLow,
      high: zoneHigh,
      index: breakIndex,
      score: 5.5
    });
  }

  return zones;
}

/* =========================================================
   最佳真實支撐
   ========================================================= */

function findBestSupport(
  rows,
  price,
  A
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
    )
  ];

  if (!zones.length) return null;

  const valid = zones
    .filter(zone => {
      if (
        !Number.isFinite(zone.low) ||
        !Number.isFinite(zone.high)
      ) {
        return false;
      }

      if (
        zone.low <= 0 ||
        zone.high <= 0
      ) {
        return false;
      }

      return (
        zone.low <=
        price * 1.02
      );
    })
    .map(zone => {
      const distance =
        Math.max(
          0,
          price - zone.high
        );

      const distanceATR =
        distance /
        Math.max(
          A,
          price * 0.005
        );

      const proximityScore =
        Math.max(
          0,
          4 - distanceATR
        );

      return {
        ...zone,
        finalScore:
          zone.score +
          proximityScore
      };
    })
    .sort(
      (a, b) =>
        b.finalScore -
        a.finalScore
    );

  return valid[0] || null;
}

/* =========================================================
   上方 Liquidity / TP
   ========================================================= */

function findLiquidityTargets(
  rows,
  price,
  A
) {
  const highs =
    findSwingHighs(rows, 2);

  const levels = highs
    .map(x => x.price)
    .filter(
      x =>
        x >
        price +
        Math.max(
          A * 0.15,
          price * 0.002
        )
    )
    .sort((a, b) => a - b);

  const unique = [];

  for (const level of levels) {
    if (
      !unique.some(
        x =>
          Math.abs(x - level) <=
          Math.max(
            A * 0.2,
            price * 0.002
          )
      )
    ) {
      unique.push(level);
    }
  }

  return unique.slice(0, 3);
}

/* =========================================================
   Institutional bias
   ========================================================= */

function institutionalBias(institutional) {
  if (!institutional) {
    return {
      score: 0,
      text: "法人資料中性"
    };
  }

  const candidates = [
    institutional.foreign5,
    institutional.foreign5d,
    institutional.foreign,
    institutional.investmentTrust5,
    institutional.trust5,
    institutional.dealer5
  ];

  let total = 0;

  for (const value of candidates) {
    if (
      Number.isFinite(
        Number(value)
      )
    ) {
      total += Number(value);
    }
  }

  if (total > 0) {
    return {
      score: 0.5,
      text: "法人偏多"
    };
  }

  if (total < 0) {
    return {
      score: -0.25,
      text: "法人偏空"
    };
  }

  return {
    score: 0,
    text: "法人中性"
  };
}

/* =========================================================
   原本 8 條策略條件
   ========================================================= */

function analyzeStock(data) {
  const rows =
    Array.isArray(data.rows)
      ? data.rows
          .map(x => ({
            open: num(x.open),
            high: num(x.high),
            low: num(x.low),
            close: num(x.close),
            volume: num(x.volume)
          }))
          .filter(
            x =>
              x.open > 0 &&
              x.high > 0 &&
              x.low > 0 &&
              x.close > 0
          )
      : [];

  if (rows.length < 60) {
    return {
      eligible: false,
      reason: "歷史資料不足"
    };
  }

  const price =
    num(data.price) ||
    num(
      rows[
        rows.length - 1
      ].close
    );

  if (!price) {
    return {
      eligible: false,
      reason: "無目前價格"
    };
  }

  const closes =
    rows.map(x => x.close);

  const volumes =
    rows.map(x => x.volume);

  const MA20 =
    sma(closes, 20);

  const MA60 =
    sma(closes, 60);

  const A =
    atr(rows, 14);

  if (!A) {
    return {
      eligible: false,
      reason: "ATR 無法計算"
    };
  }

  const RSI =
    rsi(closes, 14);

  const EMA12 =
    ema(
      closes.slice(-80),
      12
    );

  const EMA26 =
    ema(
      closes.slice(-80),
      26
    );

  const support20 =
    Math.min(
      ...rows
        .slice(-20)
        .map(x => x.low)
    );

  const resistance20 =
    Math.max(
      ...rows
        .slice(-20)
        .map(x => x.high)
    );

  const high60 =
    Math.max(
      ...rows
        .slice(-60)
        .map(x => x.high)
    );

  const currentVolume =
    num(data.volume) ||
    volumes[
      volumes.length - 1
    ];

  const avgVolume20 =
    avg(
      volumes
        .slice(-21, -1)
        .filter(x => x > 0)
    );

  const volumeRatio =
    avgVolume20 > 0
      ? currentVolume /
        avgVolume20
      : 0;

  const conditions = [
    {
      name: "MA20 > MA60",
      pass: MA20 > MA60
    },
    {
      name: "股價守 MA60",
      pass:
        price >=
        MA60 * 0.985
    },
    {
      name: "距 MA20 不過遠",
      pass:
        Math.abs(
          price - MA20
        ) <=
        A * 2.2
    },
    {
      name: "守住 20 日支撐",
      pass:
        price >=
        support20 * 0.99
    },
    {
      name: "RSI 45～72",
      pass:
        RSI >= 45 &&
        RSI <= 72
    },
    {
      name: "EMA 動能",
      pass:
        EMA12 - EMA26 >=
        -A * 0.05
    },
    {
      name: "量能",
      pass:
        volumeRatio >= 0.8
    },
    {
      name: "上方仍有空間",
      pass:
        Math.max(
          resistance20,
          high60
        ) >
        price * 1.025
    }
  ];

  const passed =
    conditions.filter(
      x => x.pass
    ).length;

  if (passed < 7) {
    return {
      eligible: false,
      passed,
      conditions,
      reason:
        `${passed}/8，未達正式策略成立`
    };
  }

  const support =
    findBestSupport(
      rows,
      price,
      A
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

  const allowedDistance =
    Math.max(
      A * 0.65,
      price * 0.012
    );

  const distanceAbove =
    price > support.high
      ? price - support.high
      : 0;

  const belowInvalidation =
    price <
    support.low -
    A * 0.15;

  const nearEntry =
    !belowInvalidation &&
    distanceAbove <=
    allowedDistance;

  if (!nearEntry) {
    return {
      eligible: false,
      passed,
      conditions,
      support,
      reason:
        "策略成立，但目前不在好的進場位置"
    };
  }

  const entryLow =
    support.low;

  const entryHigh =
    Math.max(
      support.high,
      Math.min(
        price,
        support.high +
        A * 0.2
      )
    );

  const stopLoss =
    support.low -
    Math.max(
      A * 0.28,
      price * 0.003
    );

  const targets =
    findLiquidityTargets(
      rows,
      price,
      A
    );

  if (!targets.length) {
    return {
      eligible: false,
      passed,
      conditions,
      support,
      reason:
        "上方沒有有效流動性目標"
    };
  }

  const inst =
    institutionalBias(
      data.institutional
    );

  if (volumeRatio < 0.8) {
    return {
      eligible: false,
      passed,
      conditions,
      reason: "量能不足"
    };
  }

  const tp1 =
    targets[0] || null;

  const tp2 =
    targets[1] || null;

  const tp3 =
    targets[2] || null;

  const risk =
    price - stopLoss;

  const reward =
    tp1
      ? tp1 - price
      : 0;

  if (
    risk <= 0 ||
    reward <= 0 ||
    reward / risk < 0.8
  ) {
    return {
      eligible: false,
      passed,
      conditions,
      reason:
        "目前風報比不足"
    };
  }

  return {
    eligible: true,

    symbol:
      String(
        data.symbol || ""
      ),

    name:
      data.name ||
      data.symbol ||
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

    entryLow,
    entryHigh,
    stopLoss,

    tp1,
    tp2,
    tp3,

    institutional: inst
  };
}

/* =========================================================
   股票 API
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

  return `${proto}://${host}`;
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
  } finally {
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
    new Array(items.length);

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
      } catch (error) {
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

function normalizeSymbols(symbols) {
  const list =
    Array.isArray(symbols)
      ? symbols
      : [];

  return [
    ...new Set(
      list
        .map(
          x =>
            String(x).trim()
        )
        .filter(
          x =>
            /^\d{4,6}$/.test(x)
        )
    )
  ];
}

function symbolsForDevice(device) {
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

  return [
    symbol,
    analysis.support.type,
    low,
    high,
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

  return result === "OK";
}

/* =========================================================
   Notification payload
   ========================================================= */

function buildPayload(
  stock,
  analysis
) {
  const title =
    `📈 ${analysis.name} ${stock.symbol} 進場訊號`;

  const parts = [
    `${analysis.passed}/8 策略成立`,
    `現價 ${fmtPrice(analysis.price)}`,
    `進場 ${fmtPrice(analysis.entryLow)}～${fmtPrice(analysis.entryHigh)}`,
    `停損 ${fmtPrice(analysis.stopLoss)}`
  ];

  if (analysis.tp1) {
    parts.push(
      `TP1 ${fmtPrice(analysis.tp1)}`
    );
  }

  if (analysis.tp2) {
    parts.push(
      `TP2 ${fmtPrice(analysis.tp2)}`
    );
  }

  if (analysis.tp3) {
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
   Send push
   ========================================================= */

async function sendPush(
  deviceId,
  device,
  stock,
  analysis
) {
  if (!device?.subscription) {
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
    await webpush.sendNotification(
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
  } catch (error) {
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
    process.env.CRON_SECRET;

  if (!secret) return false;

  const auth =
    req.headers.authorization ||
    "";

  return (
    auth ===
    `Bearer ${secret}`
  );
}

/* =========================================================
   Main handler
   ========================================================= */

module.exports =
  async function handler(
    req,
    res
  ) {
    if (req.method !== "GET") {
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

    if (!authorized(req)) {
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

      const deviceIds =
        await getDeviceIds();

      if (!deviceIds.length) {
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
            x &&
            !x.error &&
            x.device &&
            x.device.subscription
        );

      if (!devices.length) {
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
              analyzeStock(data);

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

      let eligibleCount = 0;
      let pushSent = 0;
      let duplicateCount = 0;
      let pushErrors = 0;

      const signals = [];

      for (
        const item of devices
      ) {
        const symbols =
          symbolsForDevice(
            item.device
          );

        for (
          const symbol of symbols
        ) {
          const stock =
            stockMap.get(symbol);

          if (!stock) continue;

          if (
            !stock.analysis?.eligible
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
            support:
              stock.analysis.support.type,
            price:
              stock.analysis.price
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

            if (result.ok) {
              pushSent++;
            } else if (
              result.duplicate
            ) {
              duplicateCount++;
            }
          } catch (error) {
            pushErrors++;

            console.error(
              `push ${symbol} error:`,
              error?.message ||
              error
            );
          }
        }
      }

      const failedStocks =
        stockResults
          .map(
            (x, i) =>
              x?.error
                ? {
                    symbol:
                      allSymbols[i],
                    error:
                      x.error
                  }
                : null
          )
          .filter(Boolean);

      return send(
        res,
        200,
        {
          ok: true,

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
    } catch (error) {
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
