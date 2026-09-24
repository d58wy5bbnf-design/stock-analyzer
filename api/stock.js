const API_URL =
  "https://api.finmindtrade.com/api/v4/data";

const SNAPSHOT_URL =
  "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot";

const BACKTEST_DAYS = 365;
const MIN_SAMPLE = 20;
const TARGET_WINRATE = 70;

let twInfoCache = {
  data: null,
  expiresAt: 0
};

let usInfoCache = {
  data: null,
  expiresAt: 0
};

const INFO_CACHE_MS =
  6 * 60 * 60 * 1000;

/* =========================
   BASIC
========================= */

function normalizeInput(v) {
  return String(v || "").trim();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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

function isTaiwanCode(v) {
  return /^\d{4,6}$/.test(v);
}

function isUSSymbol(v) {
  return /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(v);
}

/* =========================
   INDICATORS
========================= */

function SMA(arr, p) {
  if (arr.length < p) {
    return NaN;
  }

  return (
    arr
      .slice(-p)
      .reduce(
        (a, b) => a + num(b),
        0
      ) / p
  );
}

function EMA(arr, p) {
  if (arr.length < p) {
    return NaN;
  }

  let e =
    arr
      .slice(0, p)
      .reduce(
        (a, b) => a + num(b),
        0
      ) / p;

  const k = 2 / (p + 1);

  for (let i = p; i < arr.length; i++) {
    e =
      num(arr[i]) * k +
      e * (1 - k);
  }

  return e;
}

function RSI(arr, p = 14) {
  if (arr.length <= p) {
    return NaN;
  }

  const r =
    arr.slice(-(p + 1));

  let gain = 0;
  let loss = 0;

  for (let i = 1; i < r.length; i++) {
    const d =
      num(r[i]) -
      num(r[i - 1]);

    if (d > 0) {
      gain += d;
    } else {
      loss += Math.abs(d);
    }
  }

  gain /= p;
  loss /= p;

  if (loss === 0) {
    return 100;
  }

  return (
    100 -
    100 /
      (1 + gain / loss)
  );
}

function ATR(rows, p = 14) {
  if (rows.length <= p) {
    return NaN;
  }

  const values = [];

  for (let i = 1; i < rows.length; i++) {
    const h = num(rows[i].high);
    const l = num(rows[i].low);
    const pc = num(rows[i - 1].close);

    values.push(
      Math.max(
        h - l,
        Math.abs(h - pc),
        Math.abs(l - pc)
      )
    );
  }

  return SMA(values, p);
}

/* =========================
   FINMIND
========================= */

async function finmindRequest(
  params,
  token
) {
  const query =
    new URLSearchParams(params);

  const response =
    await fetch(
      `${API_URL}?${query.toString()}`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,
          Accept:
            "application/json"
        },
        cache:
          "no-store"
      }
    );

  const json =
    await response.json();

  if (!response.ok) {
    throw new Error(
      json?.msg ||
      json?.message ||
      "FinMind API request failed"
    );
  }

  return json;
}

/* =========================
   STOCK INFO
========================= */

async function getTaiwanStockInfo(token) {
  if (
    twInfoCache.data &&
    Date.now() <
      twInfoCache.expiresAt
  ) {
    return twInfoCache.data;
  }

  const result =
    await finmindRequest(
      {
        dataset:
          "TaiwanStockInfo"
      },
      token
    );

  const list =
    Array.isArray(result.data)
      ? result.data
      : [];

  twInfoCache = {
    data: list,
    expiresAt:
      Date.now() +
      INFO_CACHE_MS
  };

  return list;
}

function findTaiwanStock(
  input,
  list
) {
  const keyword =
    String(input || "").trim();

  if (!keyword) {
    return null;
  }

  let found =
    list.find(
      x =>
        String(
          x.stock_id || ""
        ) === keyword
    );

  if (found) {
    return found;
  }

  found =
    list.find(
      x =>
        String(
          x.stock_name || ""
        ).trim() === keyword
    );

  if (found) {
    return found;
  }

  const matches =
    list.filter(
      x =>
        String(
          x.stock_name || ""
        )
          .trim()
          .includes(keyword)
    );

  return matches[0] || null;
}

async function getUSStockList(token) {
  if (
    usInfoCache.data &&
    Date.now() <
      usInfoCache.expiresAt
  ) {
    return usInfoCache.data;
  }

  const result =
    await finmindRequest(
      {
        dataset:
          "USStockInfo"
      },
      token
    );

  const list =
    Array.isArray(result.data)
      ? result.data
      : [];

  usInfoCache = {
    data: list,
    expiresAt:
      Date.now() +
      INFO_CACHE_MS
  };

  return list;
}

async function getUSStockInfo(
  symbol,
  token
) {
  const list =
    await getUSStockList(token);

  return (
    list.find(
      x =>
        String(
          x.stock_id || ""
        ).toUpperCase() ===
        symbol.toUpperCase()
    ) || null
  );
}

/* =========================
   DATE
========================= */

function dateString(date) {
  return date
    .toISOString()
    .slice(0, 10);
}

function getStartDate() {
  const date =
    new Date();

  date.setFullYear(
    date.getFullYear() - 5
  );

  return dateString(date);
}

/* =========================
   PRICE
========================= */

async function getTaiwanPrice(
  symbol,
  token
) {
  const result =
    await finmindRequest(
      {
        dataset:
          "TaiwanStockPrice",
        data_id:
          symbol,
        start_date:
          getStartDate()
      },
      token
    );

  const rows =
    Array.isArray(result.data)
      ? result.data
      : [];

  return rows
    .map(
      x => ({
        date: x.date,
        open: num(x.open),
        high: num(
          x.max ?? x.high
        ),
        low: num(
          x.min ?? x.low
        ),
        close: num(x.close),
        volume: num(
          x.Trading_Volume ??
          x.volume
        )
      })
    )
    .filter(
      x =>
        x.close > 0 &&
        x.high > 0 &&
        x.low > 0
    );
}

async function getUSPrice(
  symbol,
  token
) {
  const result =
    await finmindRequest(
      {
        dataset:
          "USStockPrice",
        data_id:
          symbol,
        start_date:
          getStartDate()
      },
      token
    );

  const rows =
    Array.isArray(result.data)
      ? result.data
      : [];

  return rows
    .map(
      x => ({
        date:
          x.date ??
          x.Date,
        open:
          num(
            x.Open ??
            x.open
          ),
        high:
          num(
            x.High ??
            x.high
          ),
        low:
          num(
            x.Low ??
            x.low
          ),
        close:
          num(
            x.Close ??
            x.close
          ),
        volume:
          num(
            x.Volume ??
            x.volume
          )
      })
    )
    .filter(
      x =>
        x.close > 0 &&
        x.high > 0 &&
        x.low > 0
    );
}

/* =========================
   SNAPSHOT
========================= */

async function getTaiwanSnapshot(
  symbol,
  token
) {
  try {
    const response =
      await fetch(
        SNAPSHOT_URL,
        {
          headers: {
            Authorization:
              `Bearer ${token}`,
            Accept:
              "application/json"
          },
          cache:
            "no-store"
        }
      );

    const json =
      await response.json();

    if (!response.ok) {
      return null;
    }

    const list =
      Array.isArray(json.data)
        ? json.data
        : [];

    const item =
      list.find(
        x =>
          String(
            x.stock_id ||
            x.symbol ||
            x.code ||
            ""
          ) ===
          String(symbol)
      );

    if (!item) {
      return null;
    }

    const price =
      num(
        item.price ??
        item.close ??
        item.last_price ??
        item.lastPrice
      );

    if (!(price > 0)) {
      return null;
    }

    return {
      price,
      open:
        num(
          item.open ??
          item.open_price
        ),
      high:
        num(
          item.high ??
          item.high_price
        ),
      low:
        num(
          item.low ??
          item.low_price
        ),
      volume:
        num(
          item.total_volume ??
          item.volume ??
          item.Trading_Volume
        ),
      volumeRatio:
        num(
          item.volume_ratio
        ),
      changePercent:
        num(
          item.change_rate ??
          item.change_percent ??
          item.changePercent
        ),
      time:
        item.time ||
        item.timestamp ||
        item.date ||
        null
    };
  } catch (e) {
    return null;
  }
}

/* =========================
   VOLUME ANALYSIS
========================= */

function historicalVolumeRatio(
  rows,
  index
) {
  if (index < 20) {
    return 1;
  }

  const history =
    rows
      .slice(
        Math.max(0, index - 20),
        index
      )
      .map(x => num(x.volume))
      .filter(x => x > 0);

  if (!history.length) {
    return 1;
  }

  const avg =
    history.reduce(
      (a, b) => a + b,
      0
    ) / history.length;

  if (!(avg > 0)) {
    return 1;
  }

  return (
    num(rows[index].volume) /
    avg
  );
}

function getTaipeiMinutes() {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "Asia/Taipei",
        hour:
          "2-digit",
        minute:
          "2-digit",
        hour12:
          false
      }
    ).formatToParts(
      new Date()
    );

  const obj = {};

  for (const p of parts) {
    obj[p.type] =
      p.value;
  }

  return (
    num(obj.hour) * 60 +
    num(obj.minute)
  );
}

function currentVolumeAnalysis(
  market,
  rows,
  currentVolume,
  snapshotRatio
) {
  const previous =
    rows.slice(-21, -1);

  const volumes =
    previous
      .map(x => num(x.volume))
      .filter(x => x > 0);

  const avg20 =
    volumes.length
      ? volumes.reduce(
          (a, b) => a + b,
          0
        ) / volumes.length
      : 0;

  let ratio = 1;
  let normalized = false;

  if (
    market === "TW" &&
    currentVolume > 0 &&
    avg20 > 0
  ) {
    const minutes =
      getTaipeiMinutes();

    const start = 9 * 60;
    const end =
      13 * 60 + 30;

    let progress =
      (minutes - start) /
      (end - start);

    progress =
      clamp(
        progress,
        0.12,
        1
      );

    ratio =
      currentVolume /
      (avg20 * progress);

    normalized = true;

    if (
      snapshotRatio > 0 &&
      !Number.isFinite(ratio)
    ) {
      ratio =
        snapshotRatio;
    }
  } else if (
    currentVolume > 0 &&
    avg20 > 0
  ) {
    ratio =
      currentVolume /
      avg20;
  }

  let level =
    "正常量";

  if (ratio >= 2) {
    level =
      "異常爆量";
  } else if (
    ratio >= 1.5
  ) {
    level =
      "明顯放量";
  } else if (
    ratio >= 1.2
  ) {
    level =
      "溫和放量";
  } else if (
    ratio <= 0.7
  ) {
    level =
      "量縮";
  }

  return {
    ratio:
      round(ratio, 2),
    average20:
      round(avg20, 0),
    current:
      round(
        currentVolume,
        0
      ),
    level,
    abnormal:
      ratio >= 1.5,
    expanded:
      ratio >= 1.2,
    normalized,
    label:
      market === "TW"
        ? "盤中時間標準化量比"
        : "最新日成交量比"
  };
}

/* =========================
   STRUCTURE
========================= */

function findHTFSwingStructure(
  rows
) {
  const data =
    rows.slice(-120);

  if (data.length < 30) {
    return {
      low: NaN,
      type: "NONE"
    };
  }

  const pivots = [];

  for (
    let i = 3;
    i < data.length - 3;
    i++
  ) {
    const low =
      num(data[i].low);

    const pivot =
      low <
        num(
          data[i - 1].low
        ) &&
      low <
        num(
          data[i - 2].low
        ) &&
      low <
        num(
          data[i - 3].low
        ) &&
      low <=
        num(
          data[i + 1].low
        ) &&
      low <=
        num(
          data[i + 2].low
        ) &&
      low <=
        num(
          data[i + 3].low
        );

    if (!pivot) {
      continue;
    }

    const before =
      data.slice(
        Math.max(
          0,
          i - 20
        ),
        i
      );

    const after =
      data.slice(
        i + 1,
        Math.min(
          data.length,
          i + 25
        )
      );

    if (
      !before.length ||
      !after.length
    ) {
      continue;
    }

    const priorHigh =
      Math.max(
        ...before.map(
          x => num(x.high)
        )
      );

    const afterHigh =
      Math.max(
        ...after.map(
          x => num(x.high)
        )
      );

    pivots.push({
      low,
      confirmed:
        afterHigh >
        priorHigh,
      date:
        data[i].date
    });
  }

  const confirmed =
    pivots.filter(
      x => x.confirmed
    );

  if (confirmed.length) {
    const last =
      confirmed[
        confirmed.length - 1
      ];

    return {
      low:
        last.low,
      type:
        "SWING_LOW",
      date:
        last.date
    };
  }

  return {
    low:
      Math.min(
        ...data
          .slice(-20)
          .map(
            x => num(x.low)
          )
      ),
    type:
      "FALLBACK"
  };
}

/* =========================
   STRATEGY STATE
========================= */

function strategyState(
  rows,
  price,
  volumeRatio = 1
) {
  if (rows.length < 70) {
    return null;
  }

  const closes =
    rows.map(
      x => num(x.close)
    );

  const ma20 =
    SMA(closes, 20);

  const ma60 =
    SMA(closes, 60);

  const old20 =
    SMA(
      closes.slice(0, -5),
      20
    );

  const old60 =
    SMA(
      closes.slice(0, -10),
      60
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

  let atr =
    ATR(rows, 14);

  if (!(atr > 0)) {
    atr =
      Math.max(
        price * 0.02,
        0.01
      );
  }

  const resistance =
    Math.max(
      ...rows
        .slice(-21, -1)
        .map(
          x => num(x.high)
        )
    );

  const low10 =
    Math.min(
      ...rows
        .slice(-10)
        .map(
          x => num(x.low)
        )
    );

  const recent3Low =
    Math.min(
      ...rows
        .slice(-3)
        .map(
          x => num(x.low)
        )
    );

  const structure =
    findHTFSwingStructure(
      rows
    );

  const structureLow =
    num(structure.low);

  const structureStop =
    structureLow -
    atr * 0.15;

  const structureValid =
    structureLow > 0 &&
    price >
      structureStop;

  const m20up =
    Number.isFinite(old20) &&
    ma20 > old20;

  const m60up =
    Number.isFinite(old60) &&
    ma60 > old60;

  const breakout =
    price >
    resistance;

  const bd =
    (price -
      resistance) /
    atr;

  const above =
    (price -
      ma20) /
    atr;

  const support =
    Math.max(
      low10,
      Math.min(
        ma20,
        price
      ) -
        atr * 0.5
    );

  let entryLow =
    Math.max(
      support,
      ma20 -
        atr * 0.5
    );

  let entryHigh =
    ma20 +
    atr * 0.35;

  if (
    entryLow >
    entryHigh
  ) {
    [
      entryLow,
      entryHigh
    ] = [
      entryHigh,
      entryLow
    ];
  }

  const center =
    (
      entryLow +
      entryHigh
    ) / 2;

  const stop =
    Math.min(
      support -
        atr * 0.5,
      entryLow -
        atr
    );

  const pullR =
    Math.max(
      center - stop,
      atr * 0.5
    );

  const highEntryLow =
    resistance -
    atr * 0.25;

  const highEntryHigh =
    resistance +
    atr * 0.35;

  const highCenter =
    (
      highEntryLow +
      highEntryHigh
    ) / 2;

  const highStop =
    structureLow -
    atr * 0.15;

  let highRisk =
    highCenter -
    highStop;

  if (!(highRisk > 0)) {
    highRisk =
      atr * 2;
  }

  const surgeEntryLow =
    price -
    atr * 0.2;

  const surgeEntryHigh =
    price +
    atr * 0.15;

  const surgeCenter =
    (
      surgeEntryLow +
      surgeEntryHigh
    ) / 2;

  const surgeStop =
    structureLow -
    atr * 0.15;

  let surgeRisk =
    surgeCenter -
    surgeStop;

  if (!(surgeRisk > 0)) {
    surgeRisk =
      atr * 2;
  }

  /*
    支撐回踩：
    趨勢仍向上，
    回到 MA20 / 支撐區，
    成交量不可失控爆量下殺。
  */

  const pullback =
    price > ma60 &&
    ma20 > ma60 &&
    m20up &&
    macd >= 0 &&
    rsi >= 42 &&
    rsi <= 68 &&
    price >=
      entryLow -
        atr * 0.15 &&
    price <=
      entryHigh +
        atr * 0.15 &&
    structureValid &&
    volumeRatio <= 2.2;

  /*
    高 R：
    嚴格突破。
    TP1 = 2R。
  */

  const highR =
    price > ma20 &&
    ma20 > ma60 &&
    m20up &&
    macd > 0 &&
    rsi >= 54 &&
    rsi <= 70 &&
    breakout &&
    bd >= 0 &&
    bd <= 0.8 &&
    above <= 2.5 &&
    structureValid &&
    volumeRatio >= 1.2;

  /*
    強勢續攻：
    趨勢＋突破＋放量。
    TP1 = 1.5R。
  */

  const surge =
    price > ma20 &&
    ma20 > ma60 &&
    m20up &&
    m60up &&
    macd > 0 &&
    rsi >= 58 &&
    rsi <= 73 &&
    breakout &&
    bd >= 0.1 &&
    bd <= 0.9 &&
    above <= 2.6 &&
    structureValid &&
    volumeRatio >= 1.5;

  return {
    ma20,
    ma60,
    rsi,
    macd,
    atr,
    resistance,
    support,
    low10,
    recent3Low,
    structureLow,
    structureStop,
    structureValid,
    volumeRatio,

    PULLBACK: {
      qualified:
        pullback,
      entryLow,
      entryHigh,
      entry:
        center,
      stop,
      risk:
        pullR,
      tp1:
        center +
        pullR * 1.5,
      tp2:
        center +
        pullR * 2.5,
      tp3:
        center +
        pullR * 4
    },

    HIGH_R: {
      qualified:
        highR,
      entryLow:
        highEntryLow,
      entryHigh:
        highEntryHigh,
      entry:
        highCenter,
      stop:
        highStop,
      risk:
        highRisk,
      tp1:
        highCenter +
        highRisk * 2,
      tp2:
        highCenter +
        highRisk * 3,
      tp3:
        highCenter +
        highRisk * 5
    },

    SURGE: {
      qualified:
        surge,
      entryLow:
        surgeEntryLow,
      entryHigh:
        surgeEntryHigh,
      entry:
        surgeCenter,
      stop:
        surgeStop,
      risk:
        surgeRisk,
      tp1:
        surgeCenter +
        surgeRisk * 1.5,
      tp2:
        surgeCenter +
        surgeRisk * 2.5,
      tp3:
        surgeCenter +
        surgeRisk * 4
    }
  };
}

/* =========================
   TRADE SIMULATION

   同一天同時碰停損與停利：
   採保守原則，先算停損。
========================= */

function simulateTrade(
  future,
  setup,
  maxBars = 20
) {
  const stop =
    num(setup.stop);

  const entry =
    num(setup.entry);

  const risk =
    num(setup.risk);

  if (
    !(entry > 0) ||
    !(risk > 0) ||
    !(stop > 0)
  ) {
    return null;
  }

  let tp1 = false;
  let tp2 = false;
  let tp3 = false;

  const limit =
    Math.min(
      future.length,
      maxBars
    );

  for (
    let i = 0;
    i < limit;
    i++
  ) {
    const bar =
      future[i];

    const low =
      num(bar.low);

    const high =
      num(bar.high);

    /*
      保守：
      同棒碰 SL + TP
      先視為 SL。
    */

    if (low <= stop) {
      return {
        win: tp1,
        stopped: true,
        tp1,
        tp2,
        tp3,
        r:
          tp3
            ? 4
            : tp2
            ? 2.5
            : tp1
            ? 1.5
            : -1,
        bars:
          i + 1
      };
    }

    if (
      high >=
      setup.tp1
    ) {
      tp1 = true;
    }

    if (
      high >=
      setup.tp2
    ) {
      tp2 = true;
    }

    if (
      high >=
      setup.tp3
    ) {
      tp3 = true;

      return {
        win: true,
        stopped: false,
        tp1: true,
        tp2: true,
        tp3: true,
        r:
          (
            setup.tp3 -
            entry
          ) / risk,
        bars:
          i + 1
      };
    }
  }

  /*
    20 根後仍未 TP1，
    以最後收盤 R 判斷，
    但不算 TP1 勝利。
  */

  const last =
    future[
      Math.max(
        0,
        limit - 1
      )
    ];

  const endR =
    last
      ? (
          num(last.close) -
          entry
        ) / risk
      : 0;

  return {
    win: tp1,
    stopped: false,
    tp1,
    tp2,
    tp3,
    r:
      tp3
        ? (
            setup.tp3 -
            entry
          ) / risk
        : tp2
        ? (
            setup.tp2 -
            entry
          ) / risk
        : tp1
        ? (
            setup.tp1 -
            entry
          ) / risk
        : endR,
    bars:
      limit
  };
}

/* =========================
   BACKTEST
========================= */

function emptyStats(key) {
  return {
    key,
    samples: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    tp1Rate: 0,
    tp2Rate: 0,
    tp3Rate: 0,
    stopRate: 0,
    averageR: 0,
    maxLosingStreak: 0,
    enoughSamples: false,
    targetReached: false,
    quality:
      "樣本不足"
  };
}

function finalizeStats(
  key,
  trades
) {
  if (!trades.length) {
    return emptyStats(key);
  }

  const samples =
    trades.length;

  const wins =
    trades.filter(
      x => x.win
    ).length;

  const losses =
    samples - wins;

  const tp1 =
    trades.filter(
      x => x.tp1
    ).length;

  const tp2 =
    trades.filter(
      x => x.tp2
    ).length;

  const tp3 =
    trades.filter(
      x => x.tp3
    ).length;

  const stopped =
    trades.filter(
      x => x.stopped
    ).length;

  const avgR =
    trades.reduce(
      (a, b) =>
        a + num(b.r),
      0
    ) / samples;

  let streak = 0;
  let maxStreak = 0;

  for (const t of trades) {
    if (!t.win) {
      streak++;

      maxStreak =
        Math.max(
          maxStreak,
          streak
        );
    } else {
      streak = 0;
    }
  }

  const winRate =
    wins /
    samples *
    100;

  const enoughSamples =
    samples >=
    MIN_SAMPLE;

  const targetReached =
    enoughSamples &&
    winRate >=
      TARGET_WINRATE;

  let quality =
    "樣本不足";

  if (enoughSamples) {
    if (winRate >= 70) {
      quality =
        "歷史表現達標";
    } else if (
      winRate >= 60
    ) {
      quality =
        "接近目標";
    } else {
      quality =
        "需要改善";
    }
  }

  return {
    key,
    samples,
    wins,
    losses,
    winRate:
      round(
        winRate,
        1
      ),
    tp1Rate:
      round(
        tp1 /
        samples *
        100,
        1
      ),
    tp2Rate:
      round(
        tp2 /
        samples *
        100,
        1
      ),
    tp3Rate:
      round(
        tp3 /
        samples *
        100,
        1
      ),
    stopRate:
      round(
        stopped /
        samples *
        100,
        1
      ),
    averageR:
      round(
        avgR,
        2
      ),
    maxLosingStreak:
      maxStreak,
    enoughSamples,
    targetReached,
    quality
  };
}

function backtest365(rows) {
  const keys = [
    "PULLBACK",
    "HIGH_R",
    "SURGE"
  ];

  const trades = {
    PULLBACK: [],
    HIGH_R: [],
    SURGE: []
  };

  /*
    需要至少 100 根暖機。
    最後留未來 20 根，
    避免沒有足夠追蹤區間。
  */

  const first =
    Math.max(
      100,
      rows.length -
        BACKTEST_DAYS -
        20
    );

  const last =
    rows.length - 20;

  for (
    let i = first;
    i < last;
    i++
  ) {
    /*
      只使用當天及以前資料，
      不偷看未來。
    */

    const history =
      rows.slice(0, i + 1);

    const price =
      num(rows[i].close);

    const volumeRatio =
      historicalVolumeRatio(
        rows,
        i
      );

    const state =
      strategyState(
        history,
        price,
        volumeRatio
      );

    if (!state) {
      continue;
    }

    const future =
      rows.slice(
        i + 1,
        i + 21
      );

    for (const key of keys) {
      const setup =
        state[key];

      if (
        !setup?.qualified
      ) {
        continue;
      }

      const result =
        simulateTrade(
          future,
          setup,
          20
        );

      if (result) {
        trades[key].push({
          ...result,
          signalDate:
            rows[i].date,
          volumeRatio:
            round(
              volumeRatio,
              2
            )
        });
      }
    }
  }

  return {
    window:
      `${BACKTEST_DAYS}個交易日`,
    minimumSamples:
      MIN_SAMPLE,
    targetWinRate:
      TARGET_WINRATE,

    PULLBACK:
      finalizeStats(
        "PULLBACK",
        trades.PULLBACK
      ),

    HIGH_R:
      finalizeStats(
        "HIGH_R",
        trades.HIGH_R
      ),

    SURGE:
      finalizeStats(
        "SURGE",
        trades.SURGE
      )
  };
}

/* =========================
   DEFECT DIAGNOSIS
========================= */

function diagnoseBacktest(
  bt
) {
  const names = {
    PULLBACK:
      "支撐回踩",
    HIGH_R:
      "高 R",
    SURGE:
      "強勢續攻"
  };

  const defects = [];

  const good = [];

  for (
    const key
    of [
      "PULLBACK",
      "HIGH_R",
      "SURGE"
    ]
  ) {
    const s =
      bt[key];

    if (
      s.samples <
      MIN_SAMPLE
    ) {
      defects.push(
        `${names[key]}只有 ${s.samples} 筆訊號，樣本不足，不能只看勝率。`
      );

      continue;
    }

    if (
      s.winRate <
      55
    ) {
      defects.push(
        `${names[key]}近 365 個交易日勝率 ${s.winRate}%，條件辨識力偏弱。`
      );
    }

    if (
      s.stopRate >= 45
    ) {
      defects.push(
        `${names[key]}停損率 ${s.stopRate}% 偏高，需留意假突破或進場過早。`
      );
    }

    if (
      s.averageR <= 0
    ) {
      defects.push(
        `${names[key]}平均 R 為 ${s.averageR}，目前歷史期望值不足。`
      );
    }

    if (
      s.maxLosingStreak >= 5
    ) {
      defects.push(
        `${names[key]}曾連續失敗 ${s.maxLosingStreak} 次，需注意策略失效期。`
      );
    }

    if (
      s.targetReached
    ) {
      good.push(
        `${names[key]}樣本 ${s.samples} 筆，歷史勝率 ${s.winRate}%，達到目前 70% 篩選門檻。`
      );
    }
  }

  /*
    這裡只診斷，
    不讓系統因單一股票
    自動亂改核心參數。

    避免過度擬合。
  */

  let recommendation =
    "維持目前參數";

  if (defects.length) {
    recommendation =
      "偵測到歷史缺陷；先降低通知優先度，不自動放寬條件。後續版本比較必須使用不同歷史區段驗證，避免過度擬合。";
  }

  return {
    defects,
    strengths:
      good,
    recommendation
  };
}

/* =========================
   CURRENT STRATEGIES
========================= */

function currentStrategies(
  rows,
  livePrice,
  volumeRatio
) {
  const state =
    strategyState(
      rows,
      livePrice,
      volumeRatio
    );

  if (!state) {
    return null;
  }

  return {
    indicators: {
      ma20:
        round(
          state.ma20
        ),
      ma60:
        round(
          state.ma60
        ),
      rsi:
        round(
          state.rsi,
          1
        ),
      macd:
        round(
          state.macd,
          2
        ),
      atr:
        round(
          state.atr
        ),
      resistance:
        round(
          state.resistance
        ),
      support:
        round(
          state.support
        ),
      structureLow:
        round(
          state.structureLow
        ),
      structureValid:
        state.structureValid
    },

    PULLBACK:
      serializeSetup(
        state.PULLBACK
      ),

    HIGH_R:
      serializeSetup(
        state.HIGH_R
      ),

    SURGE:
      serializeSetup(
        state.SURGE
      )
  };
}

function serializeSetup(s) {
  return {
    qualified:
      !!s.qualified,
    entryLow:
      round(s.entryLow),
    entryHigh:
      round(s.entryHigh),
    entry:
      round(s.entry),
    stop:
      round(s.stop),
    risk:
      round(s.risk),
    tp1:
      round(s.tp1),
    tp2:
      round(s.tp2),
    tp3:
      round(s.tp3)
  };
}

/* =========================
   API
========================= */

export default async function handler(
  req,
  res
) {
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
            "FINMIND_TOKEN 尚未設定"
        });
    }

    const rawInput =
      normalizeInput(
        req.query.symbol ||
        req.query.q
      );

    if (!rawInput) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "請輸入股票代號或名稱"
        });
    }

    let market = "";
    let symbol = "";
    let info = null;

    if (
      isTaiwanCode(
        rawInput
      )
    ) {
      market = "TW";
      symbol = rawInput;

      const list =
        await getTaiwanStockInfo(
          token
        );

      info =
        findTaiwanStock(
          symbol,
          list
        );

      if (!info) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              `找不到台股 ${rawInput}`
          });
      }
    } else if (
      isUSSymbol(
        rawInput
      ) &&
      /^[A-Za-z]/.test(
        rawInput
      )
    ) {
      market = "US";

      symbol =
        rawInput.toUpperCase();

      info =
        await getUSStockInfo(
          symbol,
          token
        );

      if (!info) {
        const list =
          await getTaiwanStockInfo(
            token
          );

        const tw =
          findTaiwanStock(
            rawInput,
            list
          );

        if (tw) {
          market = "TW";
          symbol =
            String(
              tw.stock_id
            );
          info = tw;
        }
      }

      if (!info) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              `找不到 ${rawInput}`
          });
      }
    } else {
      const list =
        await getTaiwanStockInfo(
          token
        );

      info =
        findTaiwanStock(
          rawInput,
          list
        );

      if (!info) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              `找不到「${rawInput}」`
          });
      }

      market = "TW";

      symbol =
        String(
          info.stock_id
        );
    }

    let rows = [];
    let snapshot = null;

    if (market === "TW") {
      [
        rows,
        snapshot
      ] =
        await Promise.all([
          getTaiwanPrice(
            symbol,
            token
          ),
          getTaiwanSnapshot(
            symbol,
            token
          )
        ]);
    } else {
      rows =
        await getUSPrice(
          symbol,
          token
        );
    }

    if (!rows.length) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "找不到歷史行情"
        });
    }

    rows.sort(
      (a, b) =>
        new Date(
          a.date
        ).getTime() -
        new Date(
          b.date
        ).getTime()
    );

    const latest =
      rows[
        rows.length - 1
      ];

    const previous =
      rows.length >= 2
        ? rows[
            rows.length - 2
          ]
        : null;

    const dailyClose =
      num(latest.close);

    const previousClose =
      previous
        ? num(
            previous.close
          )
        : dailyClose;

    let livePrice =
      dailyClose;

    let isRealtime =
      false;

    let liveSource =
      market === "TW"
        ? "FinMind 台股最新日行情"
        : "FinMind 美股最新日行情";

    let liveTime =
      null;

    if (
      market === "TW" &&
      snapshot?.price > 0
    ) {
      livePrice =
        snapshot.price;

      isRealtime = true;

      liveSource =
        "FinMind 台股即時 Snapshot";

      liveTime =
        snapshot.time ||
        new Date()
          .toISOString();
    }

    const change =
      livePrice -
      previousClose;

    const changePercent =
      previousClose
        ? change /
          previousClose *
          100
        : 0;

    const name =
      market === "TW"
        ? (
            info.stock_name ||
            symbol
          )
        : (
            info.stock_name ||
            info.name ||
            symbol
          );

    const industry =
      info.industry_category ||
      info.industry ||
      "";

    const exchange =
      info.exchange ||
      info.type ||
      "";

    const dayOpen =
      snapshot?.open > 0
        ? snapshot.open
        : num(
            latest.open
          );

    const dayHigh =
      snapshot?.high > 0
        ? snapshot.high
        : num(
            latest.high
          );

    const dayLow =
      snapshot?.low > 0
        ? snapshot.low
        : num(
            latest.low
          );

    const volume =
      snapshot?.volume > 0
        ? snapshot.volume
        : num(
            latest.volume
          );

    /*
      即時成交量分析
    */

    const volumeAnalysis =
      currentVolumeAnalysis(
        market,
        rows,
        volume,
        snapshot?.volumeRatio ||
          0
      );

    /*
      現在策略狀態
    */

    const strategies =
      currentStrategies(
        rows,
        livePrice,
        volumeAnalysis.ratio ||
          1
      );

    /*
      365 個交易日回測
    */

    const backtest =
      backtest365(rows);

    const diagnosis =
      diagnoseBacktest(
        backtest
      );

    /*
      找目前符合策略中
      歷史勝率最高的一套。
    */

    const names = {
      PULLBACK:
        "支撐回踩",
      HIGH_R:
        "高 R",
      SURGE:
        "強勢續攻"
    };

    let bestQualifiedStrategy =
      null;

    if (strategies) {
      const candidates =
        [
          "PULLBACK",
          "HIGH_R",
          "SURGE"
        ]
          .filter(
            key =>
              strategies[key]
                ?.qualified
          )
          .map(
            key => ({
              key,
              name:
                names[key],
              current:
                strategies[key],
              historical:
                backtest[key]
            })
          )
          .sort(
            (a, b) =>
              (
                b.historical
                  ?.winRate ||
                0
              ) -
              (
                a.historical
                  ?.winRate ||
                0
              )
          );

      bestQualifiedStrategy =
        candidates[0] ||
        null;
    }

    const strictAlertQualified =
      !!(
        bestQualifiedStrategy &&
        bestQualifiedStrategy
          .historical
          ?.samples >=
          MIN_SAMPLE &&
        bestQualifiedStrategy
          .historical
          ?.winRate >=
          TARGET_WINRATE &&
        volumeAnalysis
          .abnormal &&
        Math.abs(
          changePercent
        ) >= 1
      );

    const history = {
      startDate:
        rows[0]?.date ||
        null,
      endDate:
        latest?.date ||
        null,
      tradingDays:
        rows.length,
      requestedYears:
        5,
      backtestWindow:
        BACKTEST_DAYS
    };

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    return res
      .status(200)
      .json({
        ok: true,

        platform:
          "妖子平台 4.5",

        query:
          rawInput,

        market,

        marketName:
          market === "TW"
            ? "台股"
            : "美股",

        marketEmoji:
          market === "TW"
            ? "🇹🇼"
            : "🇺🇸",

        symbol,
        name,
        industry,
        exchange,

        currency:
          market === "TW"
            ? "TWD"
            : "USD",

        price:
          dailyClose,

        livePrice,

        previousClose,

        change,

        changePercent,

        dayOpen,
        dayHigh,
        dayLow,
        volume,

        latestDate:
          latest.date,

        liveTime,
        liveSource,
        isRealtime,

        volumeAnalysis,

        strategies,

        backtest,

        diagnosis,

        bestQualifiedStrategy,

        strictAlertQualified,

        rows,

        history,

        notice:
          market === "TW"
            ? "台股盤中每次重新取得資料時，會依最新價格與時間標準化成交量重新分析；365 個交易日回測不使用未來資料。"
            : "美股目前使用 FinMind 最新可取得日行情與日成交量；365 個交易日回測不使用未來資料。"
      });

  } catch (error) {
    console.error(
      "Stock API error:",
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
        error:
          error?.message ||
          "伺服器錯誤"
      });
  }
}
