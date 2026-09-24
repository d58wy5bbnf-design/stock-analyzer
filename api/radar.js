// api/radar.js
// 妖子平台 4.5
// 台股即時雷達 + 策略掃描 + 365交易日歷史回測

const SNAPSHOT_URL =
  "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot";

const DATA_URL =
  "https://api.finmindtrade.com/api/v4/data";

/*
  平板效能雖然夠，
  但這裡真正限制是 FinMind / Vercel API，
  所以不能一次對幾百檔各打 5 年日 K。

  先用即時 Snapshot 篩選，
  再對最值得看的股票做完整策略＋回測。
*/

const STRATEGY_SCAN_LIMIT = 24;
const STRATEGY_BATCH_SIZE = 4;
const DAILY_TIMEOUT_MS = 6500;

const BACKTEST_DAYS = 365;
const MIN_SAMPLE = 20;
const TARGET_WINRATE = 70;

/* =========================
   BASIC
========================= */

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

  return Math.round(
    (n + Number.EPSILON) * p
  ) / p;
}

function clamp(v, min, max) {
  return Math.min(
    max,
    Math.max(min, v)
  );
}

function isNormalTaiwanStock(symbol) {
  return /^\d{4}$/.test(
    String(symbol || "")
  );
}

function dateString(date) {
  return date
    .toISOString()
    .slice(0, 10);
}

function getStartDate() {
  const d = new Date();

  d.setFullYear(
    d.getFullYear() - 5
  );

  return dateString(d);
}

function getTaipeiTime() {
  return new Date().toLocaleString(
    "zh-TW",
    {
      timeZone: "Asia/Taipei",
      hour12: false
    }
  );
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

  for (
    let i = p;
    i < arr.length;
    i++
  ) {
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

  const data =
    arr.slice(-(p + 1));

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i < data.length;
    i++
  ) {
    const d =
      num(data[i]) -
      num(data[i - 1]);

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

  const tr = [];

  for (
    let i = 1;
    i < rows.length;
    i++
  ) {
    const h = num(rows[i].high);
    const l = num(rows[i].low);
    const pc =
      num(rows[i - 1].close);

    tr.push(
      Math.max(
        h - l,
        Math.abs(h - pc),
        Math.abs(l - pc)
      )
    );
  }

  return SMA(tr, p);
}

/* =========================
   STRUCTURE
========================= */

function findHTFSwingStructure(rows) {
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

    const isPivot =
      low <
        num(data[i - 1].low) &&
      low <
        num(data[i - 2].low) &&
      low <
        num(data[i - 3].low) &&
      low <=
        num(data[i + 1].low) &&
      low <=
        num(data[i + 2].low) &&
      low <=
        num(data[i + 3].low);

    if (!isPivot) {
      continue;
    }

    const before =
      data.slice(
        Math.max(0, i - 20),
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
      date: data[i].date,
      confirmed:
        afterHigh >
        priorHigh
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
      low: last.low,
      date: last.date,
      type: "SWING_LOW"
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
    type: "FALLBACK"
  };
}

/* =========================
   STOCK NAME
========================= */

async function fetchTaiwanStockNames(
  token
) {
  try {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        5000
      );

    const q =
      new URLSearchParams({
        dataset:
          "TaiwanStockInfo"
      });

    const r =
      await fetch(
        `${DATA_URL}?${q}`,
        {
          headers: {
            Authorization:
              `Bearer ${token}`,
            Accept:
              "application/json"
          },
          signal:
            controller.signal,
          cache:
            "no-store"
        }
      );

    clearTimeout(timer);

    const j =
      await r.json();

    if (!r.ok) {
      return {};
    }

    const map = {};

    for (
      const x
      of Array.isArray(j.data)
        ? j.data
        : []
    ) {
      const id =
        String(
          x.stock_id || ""
        );

      if (id) {
        map[id] =
          x.stock_name ||
          id;
      }
    }

    return map;

  } catch (e) {
    return {};
  }
}

/* =========================
   SNAPSHOT SCORE
========================= */

function scoreStock(x) {
  const price =
    num(
      x.close ??
      x.price ??
      x.last_price
    );

  const open =
    num(x.open);

  const high =
    num(x.high);

  const low =
    num(x.low);

  const changePercent =
    num(
      x.change_rate ??
      x.change_percent
    );

  const volumeRatio =
    num(
      x.volume_ratio
    );

  const totalVolume =
    num(
      x.total_volume ??
      x.volume
    );

  const buyVolume =
    num(
      x.buy_volume
    );

  const sellVolume =
    num(
      x.sell_volume
    );

  let dayPosition = 50;

  if (high > low) {
    dayPosition =
      (
        (price - low) /
        (high - low)
      ) * 100;
  }

  dayPosition =
    clamp(
      dayPosition,
      0,
      100
    );

  let score = 0;

  const reasons = [];
  const warnings = [];

  /*
    漲幅
  */

  if (
    changePercent >= 1 &&
    changePercent <= 3
  ) {
    score += 15;
    reasons.push(
      "漲幅進入強勢區"
    );
  } else if (
    changePercent > 3 &&
    changePercent <= 5
  ) {
    score += 20;
    reasons.push(
      "價格明顯轉強"
    );
  } else if (
    changePercent > 5 &&
    changePercent <= 7
  ) {
    score += 15;
    reasons.push(
      "強勢上漲"
    );
  } else if (
    changePercent > 7
  ) {
    score += 5;
    warnings.push(
      "短線漲幅偏大"
    );
  }

  /*
    量比
  */

  if (
    volumeRatio >= 2
  ) {
    score += 25;
    reasons.push(
      "成交量異常放大"
    );
  } else if (
    volumeRatio >= 1.5
  ) {
    score += 20;
    reasons.push(
      "成交量明顯放大"
    );
  } else if (
    volumeRatio >= 1.2
  ) {
    score += 12;
    reasons.push(
      "成交量溫和增加"
    );
  }

  /*
    當日位置
  */

  if (dayPosition >= 80) {
    score += 15;
    reasons.push(
      "價格接近日高"
    );
  } else if (
    dayPosition >= 65
  ) {
    score += 10;
  }

  /*
    買賣量
  */

  if (
    buyVolume > 0 &&
    sellVolume > 0
  ) {
    const ratio =
      buyVolume /
      sellVolume;

    if (ratio >= 1.3) {
      score += 10;
      reasons.push(
        "買方量能較強"
      );
    }
  }

  /*
    成交量最低過濾
  */

  if (totalVolume >= 1000) {
    score += 8;
  } else if (
    totalVolume >= 500
  ) {
    score += 5;
  }

  let longStatus =
    "等待確認";

  if (
    score >= 65 &&
    changePercent > 0 &&
    changePercent <= 7 &&
    volumeRatio >= 1.2
  ) {
    longStatus =
      "優先觀察";
  } else if (
    score < 38
  ) {
    longStatus =
      "一般觀察";
  }

  let level =
    "一般異動";

  if (score >= 70) {
    level =
      "強勢異動";
  } else if (
    score >= 50
  ) {
    level =
      "明顯異動";
  }

  return {
    symbol:
      String(
        x.stock_id ||
        x.symbol ||
        ""
      ),

    score:
      Math.round(score),

    price:
      round(price),

    open:
      round(open),

    high:
      round(high),

    low:
      round(low),

    changePercent:
      round(
        changePercent,
        2
      ),

    volumeRatio:
      round(
        volumeRatio,
        2
      ),

    totalVolume:
      round(
        totalVolume,
        0
      ),

    dayPosition:
      round(
        dayPosition,
        1
      ),

    longStatus,
    level,
    reasons,
    warnings
  };
}

/* =========================
   DAILY PRICE
========================= */

async function fetchDailyRows(
  token,
  symbol
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      DAILY_TIMEOUT_MS
    );

  try {
    const q =
      new URLSearchParams({
        dataset:
          "TaiwanStockPrice",
        data_id:
          symbol,
        start_date:
          getStartDate()
      });

    const r =
      await fetch(
        `${DATA_URL}?${q}`,
        {
          headers: {
            Authorization:
              `Bearer ${token}`,
            Accept:
              "application/json"
          },
          signal:
            controller.signal,
          cache:
            "no-store"
        }
      );

    const j =
      await r.json();

    if (!r.ok) {
      throw new Error(
        j?.msg ||
        "日 K 取得失敗"
      );
    }

    const rows =
      (
        Array.isArray(j.data)
          ? j.data
          : []
      )
        .map(
          x => ({
            date: x.date,
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
            x.close > 0 &&
            x.high > 0 &&
            x.low > 0
        )
        .sort(
          (a, b) =>
            new Date(
              a.date
            ).getTime() -
            new Date(
              b.date
            ).getTime()
        );

    return rows;

  } finally {
    clearTimeout(timer);
  }
}

/* =========================
   HISTORICAL VOLUME
========================= */

function historicalVolumeRatio(
  rows,
  index
) {
  if (index < 20) {
    return 1;
  }

  const previous =
    rows
      .slice(
        Math.max(
          0,
          index - 20
        ),
        index
      )
      .map(
        x => num(x.volume)
      )
      .filter(
        x => x > 0
      );

  if (!previous.length) {
    return 1;
  }

  const avg =
    previous.reduce(
      (a, b) => a + b,
      0
    ) /
    previous.length;

  if (!(avg > 0)) {
    return 1;
  }

  return (
    num(
      rows[index].volume
    ) / avg
  );
}

/* =========================
   STRATEGY ENGINE
========================= */

function calculateStrategyState(
  rows,
  price,
  currentVolumeRatio
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

  const breakoutDistance =
    (
      price -
      resistance
    ) / atr;

  const aboveMA20 =
    (
      price -
      ma20
    ) / atr;

  /*
    PULLBACK
  */

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

  const pullCenter =
    (
      entryLow +
      entryHigh
    ) / 2;

  const pullStop =
    Math.min(
      support -
        atr * 0.5,
      entryLow -
        atr
    );

  const pullRisk =
    Math.max(
      pullCenter -
        pullStop,
      atr * 0.5
    );

  const pullQualified =
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
    currentVolumeRatio <= 2.2;

  /*
    HIGH R
  */

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

  const highQualified =
    price > ma20 &&
    ma20 > ma60 &&
    m20up &&
    macd > 0 &&
    rsi >= 54 &&
    rsi <= 70 &&
    breakout &&
    breakoutDistance >= 0 &&
    breakoutDistance <= 0.8 &&
    aboveMA20 <= 2.5 &&
    structureValid &&
    currentVolumeRatio >= 1.2;

  /*
    SURGE
  */

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

  const surgeQualified =
    price > ma20 &&
    ma20 > ma60 &&
    m20up &&
    m60up &&
    macd > 0 &&
    rsi >= 58 &&
    rsi <= 73 &&
    breakout &&
    breakoutDistance >= 0.1 &&
    breakoutDistance <= 0.9 &&
    aboveMA20 <= 2.6 &&
    structureValid &&
    currentVolumeRatio >= 1.5;

  return {
    ma20,
    ma60,
    rsi,
    macd,
    atr,
    resistance,
    support,
    recent3Low,
    structureLow,
    structureValid,

    PULLBACK: {
      qualified:
        pullQualified,

      entryLow,
      entryHigh,

      entry:
        pullCenter,

      stop:
        pullStop,

      risk:
        pullRisk,

      tp1:
        pullCenter +
        pullRisk * 1.5,

      tp2:
        pullCenter +
        pullRisk * 2.5,

      tp3:
        pullCenter +
        pullRisk * 4
    },

    HIGH_R: {
      qualified:
        highQualified,

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
        surgeQualified,

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
   STRATEGY SCORE
========================= */

function strategyScores(
  stock,
  state
) {
  let pull = 0;
  let high = 0;
  let surge = 0;

  const price =
    num(stock.price);

  const change =
    num(
      stock.changePercent
    );

  const vr =
    num(
      stock.volumeRatio
    );

  const {
    ma20,
    ma60,
    rsi,
    macd,
    atr,
    resistance,
    structureValid
  } = state;

  const closesAbove =
    price > ma20;

  const bd =
    (
      price -
      resistance
    ) / atr;

  const above =
    (
      price -
      ma20
    ) / atr;

  /*
    PULLBACK SCORE
  */

  if (price > ma60) {
    pull += 10;
  }

  if (ma20 > ma60) {
    pull += 20;
  }

  if (macd >= 0) {
    pull += 10;
  }

  if (
    rsi >= 42 &&
    rsi <= 68
  ) {
    pull += 10;
  }

  if (
    price >=
      state.PULLBACK
        .entryLow -
        atr * 0.15 &&
    price <=
      state.PULLBACK
        .entryHigh +
        atr * 0.15
  ) {
    pull += 25;
  }

  if (structureValid) {
    pull += 10;
  }

  if (
    change >= -1 &&
    change <= 4
  ) {
    pull += 5;
  }

  if (vr <= 1.2) {
    pull += 10;
  }

  /*
    HIGH R SCORE
  */

  if (
    price > ma20 &&
    ma20 > ma60
  ) {
    high += 20;
  }

  if (macd > 0) {
    high += 10;
  }

  if (
    rsi >= 54 &&
    rsi <= 70
  ) {
    high += 10;
  }

  if (
    bd >= 0 &&
    bd <= 0.8
  ) {
    high += 20;
  }

  if (
    price >=
    resistance
  ) {
    high += 10;
  }

  if (
    above <= 2.5
  ) {
    high += 5;
  }

  if (structureValid) {
    high += 10;
  }

  if (vr >= 1.2) {
    high += 15;
  }

  /*
    SURGE SCORE
  */

  if (
    price > ma20 &&
    ma20 > ma60
  ) {
    surge += 20;
  }

  if (macd > 0) {
    surge += 10;
  }

  if (
    rsi >= 58 &&
    rsi <= 73
  ) {
    surge += 10;
  }

  if (
    bd >= 0.1 &&
    bd <= 0.9
  ) {
    surge += 15;
  }

  if (vr >= 1.5) {
    surge += 20;
  } else if (
    vr >= 1.2
  ) {
    surge += 8;
  }

  if (
    stock.dayPosition >= 70
  ) {
    surge += 10;
  }

  if (structureValid) {
    surge += 10;
  }

  if (change > 7) {
    surge -= 20;
  }

  if (closesAbove) {
    surge += 5;
  }

  return {
    PULLBACK:
      clamp(
        Math.round(pull),
        0,
        100
      ),

    HIGH_R:
      clamp(
        Math.round(high),
        0,
        100
      ),

    SURGE:
      clamp(
        Math.round(surge),
        0,
        100
      )
  };
}

/* =========================
   SIMULATE
========================= */

function simulateTrade(
  future,
  setup,
  maxBars = 20
) {
  const entry =
    num(setup.entry);

  const stop =
    num(setup.stop);

  const risk =
    num(setup.risk);

  if (
    !(entry > 0) ||
    !(stop > 0) ||
    !(risk > 0)
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
      同一根 K 同時碰到：
      保守計算先停損。
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
            : -1
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
          ) / risk
      };
    }
  }

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
      tp2
        ? (
            setup.tp2 -
            entry
          ) / risk
        : tp1
        ? (
            setup.tp1 -
            entry
          ) / risk
        : endR
  };
}

/* =========================
   BACKTEST
========================= */

function finalizeBacktest(
  key,
  trades
) {
  const samples =
    trades.length;

  if (!samples) {
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
      targetReached: false
    };
  }

  const wins =
    trades.filter(
      x => x.win
    ).length;

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

  let streak = 0;
  let maxStreak = 0;

  for (const t of trades) {
    if (t.win) {
      streak = 0;
    } else {
      streak++;

      maxStreak =
        Math.max(
          maxStreak,
          streak
        );
    }
  }

  const winRate =
    wins /
    samples *
    100;

  return {
    key,

    samples,

    wins,

    losses:
      samples - wins,

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
        trades.reduce(
          (a, b) =>
            a + num(b.r),
          0
        ) / samples,
        2
      ),

    maxLosingStreak:
      maxStreak,

    enoughSamples:
      samples >=
      MIN_SAMPLE,

    targetReached:
      samples >=
        MIN_SAMPLE &&
      winRate >=
        TARGET_WINRATE
  };
}

function backtestStrategies(
  rows
) {
  const trades = {
    PULLBACK: [],
    HIGH_R: [],
    SURGE: []
  };

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
    const history =
      rows.slice(
        0,
        i + 1
      );

    const price =
      num(
        rows[i].close
      );

    const vr =
      historicalVolumeRatio(
        rows,
        i
      );

    const state =
      calculateStrategyState(
        history,
        price,
        vr
      );

    if (!state) {
      continue;
    }

    const future =
      rows.slice(
        i + 1,
        i + 21
      );

    for (
      const key
      of [
        "PULLBACK",
        "HIGH_R",
        "SURGE"
      ]
    ) {
      if (
        !state[key]
          ?.qualified
      ) {
        continue;
      }

      const result =
        simulateTrade(
          future,
          state[key],
          20
        );

      if (result) {
        trades[key].push(
          result
        );
      }
    }
  }

  return {
    PULLBACK:
      finalizeBacktest(
        "PULLBACK",
        trades.PULLBACK
      ),

    HIGH_R:
      finalizeBacktest(
        "HIGH_R",
        trades.HIGH_R
      ),

    SURGE:
      finalizeBacktest(
        "SURGE",
        trades.SURGE
      )
  };
}

/* =========================
   ONE STOCK STRATEGY SCAN
========================= */

async function scanStrategyStock(
  token,
  stock
) {
  try {
    const rows =
      await fetchDailyRows(
        token,
        stock.symbol
      );

    if (
      rows.length < 120
    ) {
      return null;
    }

    const state =
      calculateStrategyState(
        rows,
        stock.price,
        stock.volumeRatio ||
          1
      );

    if (!state) {
      return null;
    }

    const scores =
      strategyScores(
        stock,
        state
      );

    const backtest =
      backtestStrategies(
        rows
      );

    const strategyNames = {
      PULLBACK:
        "支撐回踩",
      HIGH_R:
        "高 R",
      SURGE:
        "強勢續攻"
    };

    const strategyEmoji = {
      PULLBACK:
        "🟢",
      HIGH_R:
        "🟣",
      SURGE:
        "🔥"
    };

    const qualified =
      [
        "PULLBACK",
        "HIGH_R",
        "SURGE"
      ]
        .filter(
          key =>
            state[key]
              .qualified
        )
        .map(
          key => ({
            key,
            name:
              strategyNames[key],
            emoji:
              strategyEmoji[key],
            score:
              scores[key],
            historical:
              backtest[key],
            setup:
              state[key]
          })
        )
        .sort(
          (a, b) => {
            const aw =
              a.historical
                ?.winRate ||
              0;

            const bw =
              b.historical
                ?.winRate ||
              0;

            if (bw !== aw) {
              return bw - aw;
            }

            return (
              b.score -
              a.score
            );
          }
        );

    /*
      顯示用最佳策略：
      如果現在真的有符合，
      優先取符合者。
      否則取分數最高者。
    */

    let best;

    if (qualified.length) {
      best =
        qualified[0];
    } else {
      const key =
        Object.keys(scores)
          .sort(
            (a, b) =>
              scores[b] -
              scores[a]
          )[0];

      best = {
        key,
        name:
          strategyNames[key],
        emoji:
          strategyEmoji[key],
        score:
          scores[key],
        historical:
          backtest[key],
        setup:
          state[key]
      };
    }

    /*
      嚴格通知：
      1. 異動
      2. 成交量異常
      3. 現在策略符合
      4. 樣本 >= 20
      5. 勝率 >= 70
      6. 多策略只留歷史勝率最高
    */

    const meaningfulMove =
      Math.abs(
        stock.changePercent
      ) >= 1;

    const abnormalVolume =
      stock.volumeRatio >=
      1.5;

    const alertCandidates =
      qualified
        .filter(
          x =>
            x.historical
              ?.samples >=
              MIN_SAMPLE &&
            x.historical
              ?.winRate >=
              TARGET_WINRATE
        )
        .sort(
          (a, b) =>
            (
              b.historical
                .winRate -
              a.historical
                .winRate
            )
        );

    const alertBest =
      alertCandidates[0] ||
      null;

    const alertQualified =
      !!(
        meaningfulMove &&
        abnormalVolume &&
        alertBest
      );

    return {
      ...stock,

      entryScore:
        best.score,

      recommendedStrategy:
        best.name,

      strategyEmoji:
        best.emoji,

      strategyKey:
        best.key,

      strategyGrade:
        best.score >= 80
          ? "A"
          : best.score >= 70
          ? "B"
          : best.score >= 60
          ? "C"
          : "觀察",

      pullbackScore:
        scores.PULLBACK,

      highRScore:
        scores.HIGH_R,

      surgeScore:
        scores.SURGE,

      strategyQualified:
        qualified.map(
          x => x.key
        ),

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

      support:
        round(
          state.support
        ),

      resistance:
        round(
          state.resistance
        ),

      structureLow:
        round(
          state.structureLow
        ),

      structureValid:
        state.structureValid,

      entryLow:
        round(
          best.setup
            .entryLow
        ),

      entryHigh:
        round(
          best.setup
            .entryHigh
        ),

      stop:
        round(
          best.setup.stop
        ),

      tp1:
        round(
          best.setup.tp1
        ),

      tp2:
        round(
          best.setup.tp2
        ),

      tp3:
        round(
          best.setup.tp3
        ),

      historical:
        best.historical,

      backtest,

      alertQualified,

      alert:
        alertQualified
          ? {
              strategy:
                alertBest.name,

              strategyKey:
                alertBest.key,

              winRate:
                alertBest
                  .historical
                  .winRate,

              samples:
                alertBest
                  .historical
                  .samples,

              entryLow:
                round(
                  alertBest
                    .setup
                    .entryLow
                ),

              entryHigh:
                round(
                  alertBest
                    .setup
                    .entryHigh
                ),

              tp1:
                round(
                  alertBest
                    .setup
                    .tp1
                ),

              tp2:
                round(
                  alertBest
                    .setup
                    .tp2
                ),

              tp3:
                round(
                  alertBest
                    .setup
                    .tp3
                ),

              stop:
                round(
                  alertBest
                    .setup
                    .stop
                )
            }
          : null
    };

  } catch (e) {
    return null;
  }
}

/* =========================
   BATCH
========================= */

async function scanInBatches(
  token,
  stocks
) {
  const result = [];

  for (
    let i = 0;
    i < stocks.length;
    i +=
      STRATEGY_BATCH_SIZE
  ) {
    const batch =
      stocks.slice(
        i,
        i +
          STRATEGY_BATCH_SIZE
      );

    const settled =
      await Promise.allSettled(
        batch.map(
          stock =>
            scanStrategyStock(
              token,
              stock
            )
        )
      );

    for (const x of settled) {
      if (
        x.status ===
          "fulfilled" &&
        x.value
      ) {
        result.push(
          x.value
        );
      }
    }
  }

  return result;
}

/* =========================
   API
========================= */

export default async function handler(
  req,
  res
) {
  if (req.method !== "GET") {
    return res
      .status(405)
      .json({
        ok: false,
        error:
          "Method Not Allowed"
      });
  }

  try {
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

    /*
      SNAPSHOT
    */

    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        7000
      );

    let response;

    try {
      response =
        await fetch(
          SNAPSHOT_URL,
          {
            headers: {
              Authorization:
                `Bearer ${token}`,
              Accept:
                "application/json"
            },
            signal:
              controller.signal,
            cache:
              "no-store"
          }
        );
    } finally {
      clearTimeout(timer);
    }

    const json =
      await response.json();

    if (!response.ok) {
      throw new Error(
        json?.msg ||
        json?.message ||
        "Snapshot 取得失敗"
      );
    }

    const raw =
      Array.isArray(json.data)
        ? json.data
        : [];

    /*
      名稱
    */

    const names =
      await fetchTaiwanStockNames(
        token
      );

    /*
      全市場先用即時資料算分
    */

    const stocks =
      raw
        .map(scoreStock)
        .filter(
          x =>
            isNormalTaiwanStock(
              x.symbol
            ) &&
            x.price > 0
        )
        .map(
          x => ({
            ...x,
            name:
              names[x.symbol] ||
              x.symbol
          })
        );

    /*
      異動雷達
    */

    let radar =
      stocks
        .filter(
          x =>
            x.score >= 38
        )
        .sort(
          (a, b) =>
            b.score -
            a.score
        )
        .slice(0, 40);

    if (!radar.length) {
      radar =
        [...stocks]
          .sort(
            (a, b) =>
              b.score -
              a.score
          )
          .slice(0, 20);
    }

    /*
      做多觀察
    */

    const longWatch =
      stocks
        .filter(
          x =>
            x.longStatus ===
              "優先觀察" ||
            x.longStatus ===
              "等待確認"
        )
        .sort(
          (a, b) =>
            b.score -
            a.score
        )
        .slice(0, 30);

    /*
      要做完整 5 年資料分析的候選池。

      優先：
      - 有成交量
      - 有異動
      - 有放量
      - 分數高
    */

    const candidatePool =
      stocks
        .filter(
          x =>
            x.totalVolume >=
              500 &&
            x.changePercent >
              -3 &&
            x.changePercent <=
              7 &&
            (
              x.score >= 38 ||
              x.volumeRatio >=
                1.2
            )
        )
        .sort(
          (a, b) => {
            const as =
              a.score +
              Math.min(
                a.volumeRatio *
                  10,
                30
              );

            const bs =
              b.score +
              Math.min(
                b.volumeRatio *
                  10,
                30
              );

            return bs - as;
          }
        )
        .slice(
          0,
          STRATEGY_SCAN_LIMIT
        );

    /*
      完整策略 + 365 回測
    */

    const strategyScanned =
      await scanInBatches(
        token,
        candidatePool
      );

    /*
      符合策略區
    */

    const strategyReady =
      strategyScanned
        .filter(
          x =>
            x.strategyQualified
              ?.length > 0 &&
            x.structureValid
        )
        .sort(
          (a, b) => {
            const aw =
              a.historical
                ?.winRate ||
              0;

            const bw =
              b.historical
                ?.winRate ||
              0;

            if (bw !== aw) {
              return bw - aw;
            }

            return (
              b.entryScore -
              a.entryScore
            );
          }
        )
        .slice(0, 24);

    /*
      嚴格通知候選

      這裡不是所有符合策略都通知。
      必須：
      - 價格有異動
      - 量比 >= 1.5
      - 當下符合策略
      - 365 回測樣本 >= 20
      - 歷史勝率 >= 70%
    */

    const alerts =
      strategyScanned
        .filter(
          x =>
            x.alertQualified &&
            x.alert
        )
        .sort(
          (a, b) => {
            const wr =
              b.alert.winRate -
              a.alert.winRate;

            if (wr !== 0) {
              return wr;
            }

            return (
              b.score -
              a.score
            );
          }
        );

    /*
      爆量排行
    */

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
        .slice(0, 20);

    /*
      動能排行
    */

    const momentumLeaders =
      [...stocks]
        .sort(
          (a, b) =>
            b.changePercent -
            a.changePercent
        )
        .slice(0, 20);

    /*
      把做過完整策略分析的資料
      合併回 radar / longWatch，
      前端點查看更多時可以看到更多資訊。
    */

    const strategyMap =
      new Map(
        strategyScanned.map(
          x => [
            String(x.symbol),
            x
          ]
        )
      );

    radar =
      radar.map(
        x =>
          strategyMap.get(
            String(x.symbol)
          ) || x
      );

    const enrichedLongWatch =
      longWatch.map(
        x =>
          strategyMap.get(
            String(x.symbol)
          ) || x
      );

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=45, stale-while-revalidate=90"
    );

    return res
      .status(200)
      .json({
        ok: true,

        platform:
          "妖子平台 4.5",

        market: "TW",

        marketName:
          "台股",

        marketEmoji:
          "🇹🇼",

        source:
          "FinMind",

        updatedAt:
          new Date()
            .toISOString(),

        taipeiTime:
          getTaipeiTime(),

        scanned:
          stocks.length,

        found:
          radar.length,

        longWatchCount:
          enrichedLongWatch
            .length,

        strategyReadyCount:
          strategyReady.length,

        alertCount:
          alerts.length,

        strategyScannedCount:
          strategyScanned
            .length,

        backtestDays:
          BACKTEST_DAYS,

        minimumSamples:
          MIN_SAMPLE,

        targetWinRate:
          TARGET_WINRATE,

        /*
          🎯 符合策略
        */

        strategyReady,

        /*
          🚀 做多觀察
        */

        longWatch:
          enrichedLongWatch,

        /*
          🔥 異動雷達
        */

        radar,

        /*
          🔔 真正可通知
        */

        alerts,

        /*
          📊 額外排行榜
        */

        volumeLeaders,

        momentumLeaders,

        notice:
          "策略掃描使用當下量價條件；歷史勝率使用最近 365 個交易日逐日回測，訊號建立不使用未來資料。同棒同時碰停損與停利時採保守停損。"
      });

  } catch (error) {
    console.error(
      "Radar error:",
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
          error?.name ===
          "AbortError"
            ? "雷達資料取得逾時，請稍後重新掃描"
            : error?.message ||
              "Radar 伺服器錯誤"
      });
  }
}
