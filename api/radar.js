// api/radar.js
// 妖子平台 4.5
// FinMind Sponsor 即時異動 + 波段策略掃描
// 穩定版：避免策略日K掃描拖死整個 Radar API

const SNAPSHOT_URL =
  "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot";

const DATA_URL =
  "https://api.finmindtrade.com/api/v4/data";

/*
  穩定性設定

  不改策略邏輯，
  只控制策略掃描負載。

  原本：
  24 支股票
  每批 6 支

  現在：
  最多 12 支
  每批 3 支
  每支日K最多等待 4.5 秒

  即使某支 FinMind 日K失敗，
  也不會拖死整個 /api/radar。
*/

const STRATEGY_SCAN_LIMIT = 12;
const STRATEGY_BATCH_SIZE = 3;
const DAILY_TIMEOUT_MS = 4500;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, d = 2) {
  const p = 10 ** d;

  return Math.round(
    (num(v) + Number.EPSILON) * p
  ) / p;
}

function clamp(v, min, max) {
  return Math.min(
    max,
    Math.max(min, v)
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

/* =========================
   指標
========================= */

function SMA(arr, p) {
  if (arr.length < p) {
    return NaN;
  }

  return (
    arr
      .slice(-p)
      .reduce(
        (a, b) =>
          a + Number(b),
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
        (a, b) =>
          a + Number(b),
        0
      ) / p;

  const k =
    2 / (p + 1);

  for (
    let i = p;
    i < arr.length;
    i++
  ) {
    e =
      Number(arr[i]) * k +
      e * (1 - k);
  }

  return e;
}

function RSI(arr, p = 14) {
  if (arr.length <= p) {
    return NaN;
  }

  const r =
    arr.slice(
      -(p + 1)
    );

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i < r.length;
    i++
  ) {
    const d =
      Number(r[i]) -
      Number(r[i - 1]);

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

  for (
    let i = 1;
    i < rows.length;
    i++
  ) {
    const h =
      num(rows[i].high);

    const l =
      num(rows[i].low);

    const pc =
      num(
        rows[i - 1].close
      );

    values.push(
      Math.max(
        h - l,
        Math.abs(h - pc),
        Math.abs(l - pc)
      )
    );
  }

  return SMA(
    values,
    p
  );
}

/* =========================
   日K結構
========================= */

function findHTFSwingStructure(rows) {
  const data =
    rows.slice(-120);

  const pivots = [];

  if (data.length < 30) {
    return {
      low: NaN,
      type: "NONE"
    };
  }

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
        data[i].date || ""
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

    const previous =
      confirmed.length > 1
        ? confirmed[
            confirmed.length - 2
          ]
        : null;

    return {
      low: last.low,

      type:
        previous &&
        last.low >
          previous.low
          ? "HL"
          : "SWING_LOW",

      date:
        last.date
    };
  }

  if (pivots.length) {
    const last =
      pivots[
        pivots.length - 1
      ];

    return {
      low: last.low,
      type: "SWING_LOW",
      date: last.date
    };
  }

  return {
    low:
      Math.min(
        ...data
          .slice(-20)
          .map(
            x =>
              num(x.low)
          )
      ),

    type: "FALLBACK"
  };
}

/* =========================
   股票名稱
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
        4500
      );

    try {
      const response =
        await fetch(
          `${DATA_URL}?dataset=TaiwanStockInfo`,
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

      if (!response.ok) {
        return {};
      }

      const body =
        await response.json();

      if (
        !Array.isArray(
          body?.data
        )
      ) {
        return {};
      }

      const names = {};

      for (
        const stock
        of body.data
      ) {
        if (
          stock?.stock_id &&
          stock?.stock_name
        ) {
          names[
            String(
              stock.stock_id
            )
          ] =
            String(
              stock.stock_name
            );
        }
      }

      return names;

    } finally {
      clearTimeout(timer);
    }

  } catch (e) {
    return {};
  }
}

/* =========================
   即時異動分數
========================= */

function scoreStock(x) {
  const price =
    num(x.close);

  const open =
    num(x.open);

  const high =
    num(x.high);

  const low =
    num(x.low);

  if (price <= 0) {
    return null;
  }

  const changeRate =
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

  const buyVolume =
    num(
      x.buy_volume
    );

  const sellVolume =
    num(
      x.sell_volume
    );

  let score = 0;

  const reasons = [];
  const warnings = [];

  if (
    changeRate >= 1 &&
    changeRate <= 3
  ) {
    score += 12;

    reasons.push(
      "價格開始轉強"
    );

  } else if (
    changeRate > 3 &&
    changeRate <= 5
  ) {
    score += 18;

    reasons.push(
      "漲幅明顯加速"
    );

  } else if (
    changeRate > 5 &&
    changeRate <= 7
  ) {
    score += 12;

    reasons.push(
      "強勢上漲"
    );

  } else if (
    changeRate > 7
  ) {
    score += 3;

    warnings.push(
      "今日漲幅偏大"
    );

  } else if (
    changeRate < -2
  ) {
    score -= 15;
  }

  if (
    volumeRatio >= 3
  ) {
    score += 30;

    reasons.push(
      `爆量 ${round(
        volumeRatio,
        1
      )}x`
    );

  } else if (
    volumeRatio >= 2
  ) {
    score += 25;

  } else if (
    volumeRatio >= 1.5
  ) {
    score += 20;

  } else if (
    volumeRatio >= 1.2
  ) {
    score += 10;
  }

  const range =
    high - low;

  const position =
    range > 0
      ? clamp(
          (price - low) /
            range,
          0,
          1
        )
      : 0.5;

  if (
    position >= 0.9
  ) {
    score += 20;

  } else if (
    position >= 0.75
  ) {
    score += 14;
  }

  if (
    open > 0 &&
    price > open
  ) {
    score += 8;
  }

  const orderTotal =
    buyVolume +
    sellVolume;

  if (orderTotal > 0) {
    const buyStrength =
      buyVolume /
      orderTotal;

    if (
      buyStrength >= 0.65
    ) {
      score += 12;

    } else if (
      buyStrength <= 0.35
    ) {
      score -= 6;
    }
  }

  if (
    totalVolume >= 5000
  ) {
    score += 5;

  } else if (
    totalVolume > 0 &&
    totalVolume < 300
  ) {
    score -= 12;
  }

  score =
    clamp(
      Math.round(score),
      0,
      100
    );

  let longStatus =
    "暫不列入";

  if (
    score >= 70 &&
    volumeRatio >= 1.5 &&
    changeRate >= 1 &&
    changeRate <= 6.5 &&
    price >= open &&
    position >= 0.75
  ) {
    longStatus =
      "優先觀察";

  } else if (
    score >= 50 &&
    volumeRatio >= 1.2 &&
    changeRate > 0 &&
    position >= 0.75
  ) {
    longStatus =
      "等待確認";
  }

  if (
    changeRate > 7
  ) {
    longStatus =
      "漲幅偏大不追";
  }

  return {
    symbol:
      String(
        x.stock_id
      ),

    name: "",

    score,

    price:
      round(price),

    open:
      round(open),

    high:
      round(high),

    low:
      round(low),

    changePercent:
      round(changeRate),

    volumeRatio:
      round(
        volumeRatio,
        2
      ),

    totalVolume,

    dayPosition:
      round(
        position * 100,
        1
      ),

    longStatus,

    reasons:
      reasons.slice(
        0,
        5
      ),

    warnings:
      warnings.slice(
        0,
        3
      )
  };
}

/* =========================
   取得單一股票日K
   新增：
   AbortController 逾時保護
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
    const url =
      `${DATA_URL}` +
      `?dataset=TaiwanStockPrice` +
      `&data_id=${encodeURIComponent(
        symbol
      )}` +
      `&start_date=${dateString(
        260
      )}`;

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

    if (!response.ok) {
      return [];
    }

    const body =
      await response.json();

    if (
      !Array.isArray(
        body?.data
      )
    ) {
      return [];
    }

    return body.data
      .map(
        x => ({
          date:
            x.date,

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
          String(a.date)
            .localeCompare(
              String(b.date)
            )
      );

  } catch (e) {
    /*
      某一支股票抓不到，
      直接略過。

      不讓整個 Radar API
      因為一支股票失敗。
    */

    return [];

  } finally {
    clearTimeout(timer);
  }
}

/* =========================
   三套策略入場分數
========================= */

function calculateStrategyScores(
  stock,
  rows
) {
  if (
    !Array.isArray(rows) ||
    rows.length < 70
  ) {
    return null;
  }

  const closes =
    rows.map(
      x =>
        num(x.close)
    );

  const price =
    stock.price > 0
      ? stock.price
      : closes[
          closes.length - 1
        ];

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

  const old20 =
    SMA(
      closes.slice(
        0,
        -5
      ),
      20
    );

  const old60 =
    SMA(
      closes.slice(
        0,
        -10
      ),
      60
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
        price * 0.02,
        0.01
      );
  }

  const previous20 =
    rows.slice(
      -21,
      -1
    );

  if (
    !previous20.length
  ) {
    return null;
  }

  const resistance =
    Math.max(
      ...previous20.map(
        x =>
          num(x.high)
      )
    );

  const low10 =
    Math.min(
      ...rows
        .slice(-10)
        .map(
          x =>
            num(x.low)
        )
    );

  const support =
    Math.max(
      low10,

      Math.min(
        ma20,
        price
      ) -
        atr * 0.5
    );

  const structure =
    findHTFSwingStructure(
      rows
    );

  const structureLow =
    num(
      structure.low
    );

  const structureStop =
    structureLow -
    atr * 0.15;

  const structureValid =
    structureLow > 0 &&
    price >
      structureStop;

  const ma20Up =
    Number.isFinite(
      old20
    ) &&
    ma20 > old20;

  const ma60Up =
    Number.isFinite(
      old60
    ) &&
    ma60 > old60;

  const breakoutDistance =
    (price -
      resistance) /
    atr;

  const aboveMA20 =
    (price -
      ma20) /
    atr;

  const entryLow =
    Math.max(
      support,
      ma20 -
        atr * 0.5
    );

  const entryHigh =
    ma20 +
    atr * 0.35;

  /* -------------------------
     支撐回踩
  ------------------------- */

  let pullback = 0;

  if (
    price > ma60
  ) {
    pullback += 10;
  }

  if (
    ma20 > ma60
  ) {
    pullback += 20;
  }

  if (ma20Up) {
    pullback += 10;
  }

  if (
    macd >= 0
  ) {
    pullback += 10;
  }

  if (
    rsi >= 42 &&
    rsi <= 68
  ) {
    pullback += 10;
  }

  if (
    price >=
      entryLow -
        atr * 0.15 &&
    price <=
      entryHigh +
        atr * 0.15
  ) {
    pullback += 25;
  }

  if (
    structureValid
  ) {
    pullback += 10;
  }

  if (
    stock.changePercent >=
      -1 &&
    stock.changePercent <=
      4
  ) {
    pullback += 5;
  }

  /* -------------------------
     高 R
  ------------------------- */

  let highR = 0;

  if (
    price > ma20 &&
    ma20 > ma60
  ) {
    highR += 20;
  }

  if (ma20Up) {
    highR += 10;
  }

  if (
    macd > 0
  ) {
    highR += 10;
  }

  if (
    rsi >= 52 &&
    rsi <= 72
  ) {
    highR += 10;
  }

  if (
    breakoutDistance >=
      -0.15 &&
    breakoutDistance <=
      0.8
  ) {
    highR += 20;
  }

  if (
    price >=
      resistance
  ) {
    highR += 10;
  }

  if (
    aboveMA20 <= 2.5
  ) {
    highR += 5;
  }

  if (
    structureValid
  ) {
    highR += 10;
  }

  if (
    stock.volumeRatio >=
      1.2
  ) {
    highR += 5;
  }

  /* -------------------------
     強勢續攻
  ------------------------- */

  let surge = 0;

  if (
    price > ma20 &&
    ma20 > ma60
  ) {
    surge += 20;
  }

  if (
    ma20Up &&
    ma60Up
  ) {
    surge += 15;
  }

  if (
    macd > 0
  ) {
    surge += 10;
  }

  if (
    rsi >= 56 &&
    rsi <= 74
  ) {
    surge += 10;
  }

  if (
    breakoutDistance >= 0 &&
    breakoutDistance <= 0.9
  ) {
    surge += 15;
  }

  if (
    stock.volumeRatio >=
      1.5
  ) {
    surge += 15;

  } else if (
    stock.volumeRatio >=
      1.2
  ) {
    surge += 8;
  }

  if (
    stock.dayPosition >=
      70
  ) {
    surge += 10;
  }

  if (
    structureValid
  ) {
    surge += 5;
  }

  if (
    stock.changePercent >
      7
  ) {
    surge -= 20;
  }

  pullback =
    clamp(
      Math.round(
        pullback
      ),
      0,
      100
    );

  highR =
    clamp(
      Math.round(
        highR
      ),
      0,
      100
    );

  surge =
    clamp(
      Math.round(
        surge
      ),
      0,
      100
    );

  const strategies = [
    {
      key:
        "PULLBACK",

      name:
        "支撐回踩",

      emoji:
        "🟢",

      score:
        pullback
    },

    {
      key:
        "HIGH_R",

      name:
        "高 R",

      emoji:
        "🟣",

      score:
        highR
    },

    {
      key:
        "SURGE",

      name:
        "強勢續攻",

      emoji:
        "🔥",

      score:
        surge
    }
  ].sort(
    (a, b) =>
      b.score -
      a.score
  );

  const best =
    strategies[0];

  let grade =
    "條件偏低";

  if (
    best.score >= 85
  ) {
    grade =
      "高符合";

  } else if (
    best.score >= 75
  ) {
    grade =
      "條件符合";

  } else if (
    best.score >= 65
  ) {
    grade =
      "接近條件";
  }

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
      grade,

    pullbackScore:
      pullback,

    highRScore:
      highR,

    surgeScore:
      surge,

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
      round(
        macd,
        2
      ),

    atr:
      round(atr),

    resistance:
      round(
        resistance
      ),

    support:
      round(
        support
      ),

    structureLow:
      round(
        structureLow
      ),

    structureStop:
      round(
        structureStop
      ),

    structureValid,

    entryLow:
      round(
        entryLow
      ),

    entryHigh:
      round(
        entryHigh
      )
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
            "Vercel 尚未設定 FINMIND_TOKEN"
        });
    }

    /*
      Snapshot 是首頁最重要資料。

      這個請求不應該被
      後面的策略掃描拖死。
    */

    const snapshotController =
      new AbortController();

    const snapshotTimer =
      setTimeout(
        () =>
          snapshotController.abort(),
        6000
      );

    let snapshotResponse;

    try {
      snapshotResponse =
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
              snapshotController.signal
          }
        );

    } finally {
      clearTimeout(
        snapshotTimer
      );
    }

    const body =
      await snapshotResponse
        .json();

    if (
      !snapshotResponse.ok ||
      body?.status !== 200
    ) {
      return res
        .status(
          snapshotResponse
            .status ||
            502
        )
        .json({
          ok: false,

          error:
            body?.msg ||
            "FinMind 即時行情錯誤"
        });
    }

    /*
      股票名稱不是核心資料。

      名稱 API 失敗，
      Radar 仍然照常工作。
    */

    const stockNames =
      await fetchTaiwanStockNames(
        token
      );

    const snapshots =
      Array.isArray(
        body.data
      )
        ? body.data
        : [];

    const stocks =
      snapshots
        .filter(
          x =>
            isNormalTaiwanStock(
              x.stock_id
            )
        )
        .map(
          scoreStock
        )
        .filter(Boolean)
        .map(
          stock => ({
            ...stock,

            name:
              stockNames[
                stock.symbol
              ] || ""
          })
        )
        .filter(
          x =>
            x.price > 0
        );

    /* =========================
       原異動雷達
    ========================= */

    const radar =
      [...stocks]
        .filter(
          x =>
            x.score >= 38
        )
        .sort(
          (a, b) =>
            b.score -
            a.score
        )
        .slice(
          0,
          20
        );

    const finalRadar =
      radar.length
        ? radar
        : [...stocks]
            .sort(
              (a, b) =>
                b.score -
                a.score
            )
            .slice(
              0,
              10
            );

    /* =========================
       原做多觀察
    ========================= */

    const longWatch =
      [...stocks]
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
        .slice(
          0,
          12
        );

    /* =========================
       策略候選池

       保留原本篩選邏輯，
       只把 24 支改成最多 12 支。

       先從 Snapshot 選出
       最值得做日K計算的股票，
       避免大量 FinMind Request。
    ========================= */

    const candidatePool =
      [...stocks]
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
            const aa =
              a.score +
              Math.min(
                a.volumeRatio *
                  8,
                25
              );

            const bb =
              b.score +
              Math.min(
                b.volumeRatio *
                  8,
                25
              );

            return bb - aa;
          }
        )
        .slice(
          0,
          STRATEGY_SCAN_LIMIT
        );

    /* =========================
       策略掃描

       每次只同時抓 3 支。
       某支失敗直接略過。

       不會因為一支股票
       讓整個首頁卡住。
    ========================= */

    const strategyStocks =
      [];

    for (
      let i = 0;
      i <
        candidatePool.length;
      i +=
        STRATEGY_BATCH_SIZE
    ) {
      const batch =
        candidatePool.slice(
          i,
          i +
            STRATEGY_BATCH_SIZE
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
                rows.length < 70
              ) {
                return null;
              }

              return (
                calculateStrategyScores(
                  stock,
                  rows
                )
              );
            }
          )
        );

      for (
        const result
        of results
      ) {
        if (
          result.status ===
            "fulfilled" &&
          result.value
        ) {
          strategyStocks.push(
            result.value
          );
        }
      }
    }

    /* =========================
       首頁
       「符合策略可進場股票」

       65 = 接近條件
       75 = 條件符合
       85 = 高符合

       分數是技術條件符合度，
       不是未來勝率。
    ========================= */

    const strategyReady =
      strategyStocks
        .filter(
          x =>
            x.entryScore >=
              65 &&
            x.structureValid
        )
        .sort(
          (a, b) => {
            if (
              b.entryScore !==
              a.entryScore
            ) {
              return (
                b.entryScore -
                a.entryScore
              );
            }

            return (
              b.score -
              a.score
            );
          }
        )
        .slice(
          0,
          12
        );

    /* =========================
       爆量排行
    ========================= */

    const volumeLeaders =
      [...stocks]
        .filter(
          x =>
            x.volumeRatio >
              0
        )
        .sort(
          (a, b) =>
            b.volumeRatio -
            a.volumeRatio
        )
        .slice(
          0,
          10
        );

    /* =========================
       動能排行
    ========================= */

    const momentumLeaders =
      [...stocks]
        .filter(
          x =>
            x.changePercent >
              0
        )
        .sort(
          (a, b) =>
            b.changePercent -
            a.changePercent
        )
        .slice(
          0,
          10
        );

    /*
      Vercel CDN 快取。

      第一個人成功掃描後，
      其他裝置可以直接拿快取，
      不需要每支手機重新掃一次。
    */

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=120"
    );

    return res
      .status(200)
      .json({
        ok: true,

        platform:
          "妖子平台 4.5",

        mode:
          "FinMind Sponsor 即時盤中＋波段策略掃描",

        market:
          "TW",

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
          finalRadar.length,

        longWatchCount:
          longWatch.length,

        strategyReadyCount:
          strategyReady.length,

        strategyScannedCount:
          strategyStocks.length,

        /*
          額外提供候選池數量，
          方便你之後判斷
          到底掃了幾支。
        */

        strategyCandidateCount:
          candidatePool.length,

        strategyReady,

        radar:
          finalRadar,

        longWatch,

        volumeLeaders,

        momentumLeaders,

        notice:
          "建議入場分數代表目前技術條件符合程度，不代表未來上漲機率或實際勝率。"
      });

  } catch (error) {
    console.error(
      "Radar server error:",
      error
    );

    /*
      即使出錯也禁止瀏覽器
      把錯誤頁長時間快取。
    */

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
            ? "FinMind 連線逾時，請重新掃描"
            : error?.message ||
              "Radar server error"
      });
  }
}
