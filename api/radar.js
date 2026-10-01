// api/radar.js
// 妖子平台 5.0
// 全市場台股雷達
// FinMind Snapshot 全市場初篩
// → 日 K 波段快篩
// → 回傳首頁候選池

const SNAPSHOT_URL =
  "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot";

const DATA_URL =
  "https://api.finmindtrade.com/api/v4/data";

/*
  ============================================================
  全市場雷達設定
  ============================================================
*/

const STRATEGY_SCAN_LIMIT = 180;
const STRATEGY_BATCH_SIZE = 6;
const DAILY_TIMEOUT_MS = 5000;
const FRONTEND_CANDIDATE_LIMIT = 80;


/* ============================================================
   基礎工具
============================================================ */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, d = 2) {
  const p = 10 ** d;

  return (
    Math.round(
      (num(v) + Number.EPSILON) * p
    ) / p
  );
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


/* ============================================================
   技術指標
============================================================ */

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
      (
        1 +
        gain / loss
      )
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


/* ============================================================
   高週期 Swing 結構
============================================================ */

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
          x =>
            num(x.high)
        )
      );

    const afterHigh =
      Math.max(
        ...after.map(
          x =>
            num(x.high)
        )
      );

    pivots.push({
      low,

      confirmed:
        afterHigh >
        priorHigh,

      date:
        data[i].date ||
        ""
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
      low:
        last.low,

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
            x =>
              num(x.low)
          )
      ),

    type:
      "FALLBACK"
  };
}


/* ============================================================
   股票名稱
============================================================ */

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

  } catch {
    return {};
  }
}


/* ============================================================
   Snapshot 快速分數
============================================================ */

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
    num(x.change_rate);

  const volumeRatio =
    num(x.volume_ratio);

  const totalVolume =
    num(x.total_volume);

  const buyVolume =
    num(x.buy_volume);

  const sellVolume =
    num(x.sell_volume);

  let score = 0;

  const reasons = [];
  const warnings = [];


  /* 漲跌幅 */

  if (
    changeRate >= 0.5 &&
    changeRate <= 2
  ) {
    score += 12;

    reasons.push(
      "價格開始轉強"
    );

  } else if (
    changeRate > 2 &&
    changeRate <= 4
  ) {
    score += 18;

    reasons.push(
      "價格動能轉強"
    );

  } else if (
    changeRate > 4 &&
    changeRate <= 6.5
  ) {
    score += 14;

    reasons.push(
      "強勢上漲"
    );

  } else if (
    changeRate > 6.5
  ) {
    score += 3;

    warnings.push(
      "今日漲幅偏大"
    );

  } else if (
    changeRate >= -1.5
  ) {
    score += 6;

    reasons.push(
      "價格維持整理"
    );

  } else if (
    changeRate < -3
  ) {
    score -= 15;
  }


  /* 量比 */

  if (
    volumeRatio >= 3
  ) {
    score += 28;

    reasons.push(
      `爆量 ${round(
        volumeRatio,
        1
      )}x`
    );

  } else if (
    volumeRatio >= 2
  ) {
    score += 24;

  } else if (
    volumeRatio >= 1.5
  ) {
    score += 18;

  } else if (
    volumeRatio >= 1.1
  ) {
    score += 10;

  } else if (
    volumeRatio >= 0.8
  ) {
    score += 4;
  }


  /* K 棒位置 */

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
    position >= 0.85
  ) {
    score += 18;

  } else if (
    position >= 0.65
  ) {
    score += 12;

  } else if (
    position >= 0.5
  ) {
    score += 5;
  }


  /* 紅 K */

  if (
    open > 0 &&
    price > open
  ) {
    score += 7;
  }


  /* 買賣力 */

  const orderTotal =
    buyVolume +
    sellVolume;

  if (orderTotal > 0) {
    const buyStrength =
      buyVolume /
      orderTotal;

    if (
      buyStrength >= 0.62
    ) {
      score += 10;

    } else if (
      buyStrength <= 0.35
    ) {
      score -= 5;
    }
  }


  /* 流動性 */

  if (
    totalVolume >= 5000
  ) {
    score += 7;

  } else if (
    totalVolume >= 1500
  ) {
    score += 5;

  } else if (
    totalVolume >= 500
  ) {
    score += 2;

  } else if (
    totalVolume > 0 &&
    totalVolume < 200
  ) {
    score -= 15;
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
    score >= 65 &&
    changeRate >= -0.5 &&
    changeRate <= 6.5 &&
    position >= 0.60
  ) {
    longStatus =
      "優先觀察";

  } else if (
    score >= 40 &&
    changeRate > -2.5
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
      round(
        changeRate
      ),

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


/* ============================================================
   抓日 K
============================================================ */

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

  } catch {
    return [];

  } finally {
    clearTimeout(timer);
  }
}


/* ============================================================
   日 K 波段策略快篩
============================================================ */

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

  if (!previous20.length) {
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
    ma20 >
      old20;

  const ma60Up =
    Number.isFinite(
      old60
    ) &&
    ma60 >
      old60;

  const breakoutDistance =
    (
      price -
      resistance
    ) /
    atr;

  const aboveMA20 =
    (
      price -
      ma20
    ) /
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


  /* 支撐回踩 */

  let pullback = 0;

  if (
    price >
    ma60
  ) {
    pullback += 10;
  }

  if (
    ma20 >
    ma60
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
    rsi >= 40 &&
    rsi <= 70
  ) {
    pullback += 10;
  }

  if (
    price >=
      entryLow -
        atr * 0.25 &&
    price <=
      entryHigh +
        atr * 0.35
  ) {
    pullback += 25;
  }

  if (
    structureValid
  ) {
    pullback += 10;
  }

  if (
    stock.changePercent >= -2 &&
    stock.changePercent <= 5
  ) {
    pullback += 5;
  }


  /* 高 R */

  let highR = 0;

  if (
    price >
      ma20 &&
    ma20 >
      ma60
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
    rsi >= 48 &&
    rsi <= 74
  ) {
    highR += 10;
  }

  if (
    breakoutDistance >= -0.4 &&
    breakoutDistance <= 1
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
    aboveMA20 <= 3
  ) {
    highR += 5;
  }

  if (
    structureValid
  ) {
    highR += 10;
  }

  if (
    stock.volumeRatio >= 1
  ) {
    highR += 5;
  }


  /* 強勢續攻 */

  let surge = 0;

  if (
    price >
      ma20 &&
    ma20 >
      ma60
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
    rsi >= 52 &&
    rsi <= 76
  ) {
    surge += 10;
  }

  if (
    breakoutDistance >= -0.2 &&
    breakoutDistance <= 1.1
  ) {
    surge += 15;
  }

  if (
    stock.volumeRatio >= 1.5
  ) {
    surge += 15;

  } else if (
    stock.volumeRatio >= 1
  ) {
    surge += 8;
  }

  if (
    stock.dayPosition >= 65
  ) {
    surge += 10;
  }

  if (
    structureValid
  ) {
    surge += 5;
  }

  if (
    stock.changePercent > 7
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
    best.score >= 55
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


/* ============================================================
   API
============================================================ */

export default async function handler(
  req,
  res
) {
  try {
    if (
      req.method !==
      "GET"
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


    /* ========================================================
       全市場 Snapshot
    ======================================================== */

    const snapshotController =
      new AbortController();

    const snapshotTimer =
      setTimeout(
        () =>
          snapshotController.abort(),
        7000
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


    /*
      stocks = 全市場 4 碼普通股票

      所以 scanned 就會告訴你
      Snapshot 實際掃到多少檔。
    */

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
              ] ||
              ""
          })
        )

        .filter(
          x =>
            x.price > 0
        );


    /* ========================================================
       第一層：
       全市場快速初篩

       從全部 stocks 挑最多 180 檔。
    ======================================================== */

    const candidatePool =
      [...stocks]

        .filter(
          x =>
            x.totalVolume >= 200 &&

            x.changePercent > -4 &&

            x.changePercent <= 7.5 &&

            x.price > 3 &&

            (
              x.score >= 20 ||

              x.volumeRatio >= 0.8 ||

              x.longStatus ===
                "優先觀察" ||

              x.longStatus ===
                "等待確認"
            )
        )

        .sort(
          (a, b) => {
            const volumeBonusA =
              Math.min(
                a.volumeRatio * 7,
                22
              );

            const volumeBonusB =
              Math.min(
                b.volumeRatio * 7,
                22
              );


            const liquidityA =
              Math.min(
                Math.log10(
                  Math.max(
                    a.totalVolume,
                    1
                  )
                ) * 3,
                15
              );

            const liquidityB =
              Math.min(
                Math.log10(
                  Math.max(
                    b.totalVolume,
                    1
                  )
                ) * 3,
                15
              );


            const positionA =
              a.dayPosition >= 50
                ? 5
                : 0;

            const positionB =
              b.dayPosition >= 50
                ? 5
                : 0;


            const aa =
              a.score +
              volumeBonusA +
              liquidityA +
              positionA;

            const bb =
              b.score +
              volumeBonusB +
              liquidityB +
              positionB;


            return bb - aa;
          }
        )

        .slice(
          0,
          STRATEGY_SCAN_LIMIT
        );


    /* ========================================================
       第二層：
       180 檔分批抓日 K
    ======================================================== */

    const strategyStocks = [];


    for (
      let i = 0;
      i < candidatePool.length;
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
                rows.length <
                70
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


    /* ========================================================
       第三層：
       回傳首頁候選

       55 分故意比較寬鬆。

       因為真正的：
       5/8 接近形成
       6/8 策略成立
       7～8/8 強勢成立

       最後還是由 index.html 的
       完整策略重新判斷。
    ======================================================== */

    const strategyReady =
      strategyStocks

        .filter(
          x =>
            x.entryScore >= 55
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
          FRONTEND_CANDIDATE_LIMIT
        );


    /* 一般異動 Radar */

    const radar =
      [...stocks]

        .filter(
          x =>
            x.score >= 35
        )

        .sort(
          (a, b) =>
            b.score -
            a.score
        )

        .slice(
          0,
          30
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
              20
            );


    /* 多方觀察 */

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
          30
        );


    /* 爆量排行 */

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

        .slice(
          0,
          15
        );


    /* 動能排行 */

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

        .slice(
          0,
          15
        );


    res.setHeader(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=120"
    );


    return res
      .status(200)
      .json({
        ok: true,

        platform:
          "妖子平台 5.0",

        mode:
          "全市場 Snapshot＋日K波段雷達",

        market:
          "TW",

        source:
          "FinMind",

        updatedAt:
          new Date()
            .toISOString(),

        taipeiTime:
          getTaipeiTime(),

        /*
          全市場 Snapshot
          實際掃描股票數
        */

        scanned:
          stocks.length,

        /*
          進入日 K 掃描數
          最多 180
        */

        strategyCandidateCount:
          candidatePool.length,

        /*
          成功取得日 K
          並完成策略計算
        */

        strategyScannedCount:
          strategyStocks.length,

        /*
          最後回傳首頁
          最多 80
        */

        strategyReadyCount:
          strategyReady.length,

        found:
          finalRadar.length,

        longWatchCount:
          longWatch.length,

        strategyReady,

        radar:
          finalRadar,

        longWatch,

        volumeLeaders,

        momentumLeaders,

        notice:
          "全市場 Snapshot 掃描後，最多 180 檔進入日 K 波段快篩，再回傳最多 80 檔候選給首頁做完整 8 條件與 SMC 分析。"
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

        error:
          error?.name ===
          "AbortError"
            ? "FinMind 連線逾時，請重新掃描"
            : error?.message ||
              "Radar server error"
      });
  }
}
