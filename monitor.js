/* =========================================================
   api/monitor.js
   台股背景進場訊號監控 + Web Push
========================================================= */

const webpush = require("web-push");


/* =========================================================
   環境變數
========================================================= */

const REDIS_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL;

const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN;

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY;

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY;

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  "mailto:liaozhanxie@gmail.com";


/* =========================================================
   Redis
========================================================= */

async function redis(command) {

  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("Redis 環境變數尚未設定");
  }

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      8000
    );

  try {

    const response =
      await fetch(
        REDIS_URL,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${REDIS_TOKEN}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(command),

          signal:
            controller.signal
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      data?.error
    ) {

      throw new Error(
        data?.error ||
        "Redis request failed"
      );
    }

    return data.result;

  } finally {

    clearTimeout(timer);

  }
}


/* =========================================================
   刪除 Push 裝置
========================================================= */

async function deleteDevice(deviceId) {

  try {

    await redis([
      "DEL",
      `swing:push:device:${deviceId}`
    ]);

    await redis([
      "SREM",
      "swing:push:devices",
      deviceId
    ]);

    return true;

  } catch (error) {

    console.error(
      "delete device error:",
      deviceId,
      error
    );

    return false;
  }
}


/* =========================================================
   基本工具
========================================================= */

function num(v) {

  const n =
    Number(v);

  return Number.isFinite(n)
    ? n
    : null;
}


function avg(arr) {

  const clean =
    arr.filter(
      n =>
        Number.isFinite(n)
    );

  if (!clean.length) {
    return 0;
  }

  return (
    clean.reduce(
      (a, b) => a + b,
      0
    ) /
    clean.length
  );
}


function formatPrice(v) {

  if (
    !Number.isFinite(v)
  ) {
    return "--";
  }

  if (v >= 1000) {
    return v.toFixed(0);
  }

  if (v >= 100) {
    return v.toFixed(1);
  }

  return v.toFixed(2);
}


function unique(list) {

  return [
    ...new Set(
      list.map(
        x => String(x)
      )
    )
  ];
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

        hour12:
          false
      }
    )
    .formatToParts(
      new Date()
    );

  const get =
    type =>
      parts.find(
        p =>
          p.type === type
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


function isMarketTime() {

  const t =
    taipeiParts();

  if (
    ![
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri"
    ].includes(
      t.weekday
    )
  ) {

    return false;
  }

  const minutes =
    t.hour * 60 +
    t.minute;

  return (
    minutes >=
      8 * 60 + 55 &&
    minutes <=
      13 * 60 + 40
  );
}


/* =========================================================
   技術指標
========================================================= */

function sma(
  values,
  length
) {

  if (
    values.length <
    length
  ) {
    return null;
  }

  return avg(
    values.slice(
      -length
    )
  );
}


function ema(
  values,
  length
) {

  if (!values.length) {
    return null;
  }

  const k =
    2 /
    (length + 1);

  let value =
    values[0];

  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    value =
      values[i] * k +
      value *
      (1 - k);
  }

  return value;
}


function calcRSI(
  values,
  length = 14
) {

  if (
    values.length <
    length + 1
  ) {

    return null;
  }

  let gains = 0;
  let losses = 0;

  const start =
    values.length -
    length;

  for (
    let i = start;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];

    if (diff > 0) {

      gains += diff;

    } else {

      losses +=
        Math.abs(diff);
    }
  }

  if (
    losses === 0
  ) {
    return 100;
  }

  const rs =
    gains / losses;

  return (
    100 -
    100 /
    (1 + rs)
  );
}


function calcATR(
  rows,
  length = 14
) {

  if (
    rows.length <
    length + 1
  ) {

    return null;
  }

  const trs = [];

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

    const prevClose =
      num(
        rows[i - 1].close
      );

    if (
      high === null ||
      low === null ||
      prevClose === null
    ) {

      continue;
    }

    trs.push(
      Math.max(
        high - low,

        Math.abs(
          high -
          prevClose
        ),

        Math.abs(
          low -
          prevClose
        )
      )
    );
  }

  return avg(
    trs.slice(
      -length
    )
  );
}


/* =========================================================
   Swing High / Swing Low
========================================================= */

function findSwings(
  rows,
  left = 2,
  right = 2
) {

  const highs = [];
  const lows = [];

  for (
    let i = left;
    i <
    rows.length -
    right;
    i++
  ) {

    const h =
      num(
        rows[i].high
      );

    const l =
      num(
        rows[i].low
      );

    if (
      h === null ||
      l === null
    ) {

      continue;
    }

    let isHigh = true;
    let isLow = true;

    for (
      let j =
        i - left;

      j <=
        i + right;

      j++
    ) {

      if (
        j === i
      ) {
        continue;
      }

      if (
        num(
          rows[j].high
        ) >= h
      ) {

        isHigh = false;
      }

      if (
        num(
          rows[j].low
        ) <= l
      ) {

        isLow = false;
      }
    }

    if (isHigh) {

      highs.push({
        index: i,
        price: h
      });
    }

    if (isLow) {

      lows.push({
        index: i,
        price: l
      });
    }
  }

  return {
    highs,
    lows
  };
}


/* =========================================================
   Bullish Order Block
========================================================= */

function bullishOrderBlocks(
  rows,
  atr
) {

  const result = [];

  if (
    !Number.isFinite(atr) ||
    atr <= 0
  ) {

    return result;
  }

  for (
    let i = 1;
    i <
    rows.length - 2;
    i++
  ) {

    const open =
      num(
        rows[i].open
      );

    const close =
      num(
        rows[i].close
      );

    const high =
      num(
        rows[i].high
      );

    const low =
      num(
        rows[i].low
      );

    if (
      open === null ||
      close === null ||
      high === null ||
      low === null
    ) {

      continue;
    }

    if (
      close >= open
    ) {

      continue;
    }

    let displacement =
      false;

    let breakHigh =
      false;

    const previousRows =
      rows.slice(
        Math.max(
          0,
          i - 8
        ),
        i
      );

    if (
      !previousRows.length
    ) {

      continue;
    }

    const previousHigh =
      Math.max(
        ...previousRows
        .map(
          r =>
            num(
              r.high
            )
        )
        .filter(
          Number.isFinite
        )
      );

    if (
      !Number.isFinite(
        previousHigh
      )
    ) {

      continue;
    }

    for (
      let j =
        i + 1;

      j <=
        Math.min(
          rows.length - 1,
          i + 3
        );

      j++
    ) {

      const jo =
        num(
          rows[j].open
        );

      const jc =
        num(
          rows[j].close
        );

      if (
        jo === null ||
        jc === null
      ) {

        continue;
      }

      if (
        jc > jo &&
        jc - jo >=
        atr * 0.55
      ) {

        displacement =
          true;
      }

      if (
        jc >
        previousHigh
      ) {

        breakHigh =
          true;
      }
    }

    if (
      !displacement ||
      !breakHigh
    ) {

      continue;
    }

    let invalidated =
      false;

    for (
      let j =
        i + 1;
      j < rows.length;
      j++
    ) {

      const jc =
        num(
          rows[j].close
        );

      if (
        jc !== null &&
        jc <
        low -
        atr * 0.15
      ) {

        invalidated =
          true;

        break;
      }
    }

    if (
      invalidated
    ) {

      continue;
    }

    result.push({

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
    });
  }

  return result;
}


/* =========================================================
   Bullish FVG
========================================================= */

function bullishFVG(
  rows
) {

  const result = [];

  for (
    let i = 2;
    i < rows.length;
    i++
  ) {

    const firstHigh =
      num(
        rows[
          i - 2
        ].high
      );

    const thirdLow =
      num(
        rows[i].low
      );

    if (
      firstHigh === null ||
      thirdLow === null
    ) {

      continue;
    }

    if (
      thirdLow >
      firstHigh
    ) {

      const low =
        firstHigh;

      const high =
        thirdLow;

      let invalidated =
        false;

      for (
        let j =
          i + 1;
        j < rows.length;
        j++
      ) {

        const c =
          num(
            rows[j].close
          );

        if (
          c !== null &&
          c < low
        ) {

          invalidated =
            true;

          break;
        }
      }

      if (
        !invalidated
      ) {

        result.push({

          type:
            "Bullish FVG",

          low,

          high,

          index:
            i - 1,

          score: 3
        });
      }
    }
  }

  return result;
}


/* =========================================================
   Liquidity Sweep
========================================================= */

function bullishSweeps(
  rows,
  swings,
  atr
) {

  const result = [];

  if (
    !Number.isFinite(
      atr
    )
  ) {

    return result;
  }

  for (
    const swing of
    swings.lows
  ) {

    for (
      let i =
        swing.index + 1;

      i < rows.length;

      i++
    ) {

      const low =
        num(
          rows[i].low
        );

      const close =
        num(
          rows[i].close
        );

      if (
        low === null ||
        close === null
      ) {

        continue;
      }

      if (
        low <
        swing.price -
        atr * 0.05
        &&
        close >
        swing.price
      ) {

        let invalidated =
          false;

        for (
          let j =
            i + 1;

          j <
            rows.length;

          j++
        ) {

          const c =
            num(
              rows[j].close
            );

          if (
            c !== null &&
            c <
            low -
            atr * 0.1
          ) {

            invalidated =
              true;

            break;
          }
        }

        if (
          !invalidated
        ) {

          result.push({

            type:
              "Liquidity Sweep",

            low,

            high:
              swing.price,

            index: i,

            score: 5
          });
        }

        break;
      }
    }
  }

  return result;
}


/* =========================================================
   BOS / Breaker
========================================================= */

function bullishBreakers(
  rows,
  swings,
  atr
) {

  const result = [];

  if (
    !Number.isFinite(
      atr
    )
  ) {

    return result;
  }

  for (
    const swing of
    swings.highs
  ) {

    let breakIndex =
      -1;

    for (
      let i =
        swing.index + 1;

      i < rows.length;

      i++
    ) {

      const close =
        num(
          rows[i].close
        );

      if (
        close !== null &&
        close >
        swing.price +
        atr * 0.08
      ) {

        breakIndex =
          i;

        break;
      }
    }

    if (
      breakIndex === -1
    ) {

      continue;
    }

    let failed =
      false;

    for (
      let i =
        breakIndex + 1;

      i < rows.length;

      i++
    ) {

      const close =
        num(
          rows[i].close
        );

      if (
        close !== null &&
        close <
        swing.price -
        atr * 0.18
      ) {

        failed =
          true;

        break;
      }
    }

    if (
      failed
    ) {

      continue;
    }

    result.push({

      type:
        "BOS / Breaker",

      low:
        swing.price -
        atr * 0.15,

      high:
        swing.price +
        atr * 0.15,

      index:
        breakIndex,

      score: 5
    });
  }

  return result;
}


/* =========================================================
   找 SMC 支撐
========================================================= */

function findSupport(
  rows,
  price,
  atr
) {

  const swings =
    findSwings(
      rows
    );

  const candidates = [

    ...bullishOrderBlocks(
      rows,
      atr
    ),

    ...bullishFVG(
      rows
    ),

    ...bullishSweeps(
      rows,
      swings,
      atr
    ),

    ...bullishBreakers(
      rows,
      swings,
      atr
    )
  ];

  const valid =
    candidates

    .filter(
      z =>
        Number.isFinite(
          z.low
        ) &&
        Number.isFinite(
          z.high
        ) &&
        z.low > 0 &&
        z.high >= z.low
    )

    .filter(
      z =>
        z.low <=
        price +
        atr * 0.5
    )

    .map(
      z => {

        const distance =
          price >
          z.high
          ?
          price -
          z.high
          :
          0;

        const freshness =
          Math.max(
            0,

            2 -
            (
              rows.length -
              1 -
              z.index
            ) /
            25
          );

        return {

          ...z,

          distance,

          finalScore:
            z.score +
            freshness -
            distance /
            Math.max(
              atr,
              0.0001
            ) *
            0.35
        };
      }
    )

    .sort(
      (a, b) =>
        b.finalScore -
        a.finalScore
    );

  return (
    valid[0] ||
    null
  );
}


/* =========================================================
   上方流動性 / TP
========================================================= */

function findTargets(
  rows,
  price,
  atr
) {

  const swings =
    findSwings(
      rows
    );

  let levels =
    swings.highs

    .map(
      s =>
        s.price
    )

    .filter(
      p =>
        p >
        price +
        atr * 0.25
    )

    .sort(
      (a, b) =>
        a - b
    );

  const recentHighs =
    rows
    .slice(-60)
    .map(
      r =>
        num(
          r.high
        )
    )
    .filter(
      Number.isFinite
    );

  for (
    let i = 0;
    i <
    recentHighs.length;
    i++
  ) {

    for (
      let j =
        i + 1;

      j <
        recentHighs.length;

      j++
    ) {

      const a =
        recentHighs[i];

      const b =
        recentHighs[j];

      if (
        Math.abs(
          a - b
        ) <=
        atr * 0.18
      ) {

        const level =
          Math.max(
            a,
            b
          );

        if (
          level >
          price +
          atr * 0.25
        ) {

          levels.push(
            level
          );
        }
      }
    }
  }

  levels =
    unique(
      levels.map(
        n =>
          Number(
            n.toFixed(4)
          )
      )
    )
    .map(Number)
    .sort(
      (a, b) =>
        a - b
    );

  return {

    tp1:
      levels[0] ||
      null,

    tp2:
      levels[1] ||
      null,

    tp3:
      levels[2] ||
      null
  };
}


/* =========================================================
   8 條策略
========================================================= */

function strategyConditions(
  rows,
  price,
  atr
) {

  const closes =
    rows
    .map(
      r =>
        num(
          r.close
        )
    )
    .filter(
      Number.isFinite
    );

  const volumes =
    rows
    .map(
      r =>
        num(
          r.volume
        )
    )
    .filter(
      Number.isFinite
    );

  if (
    closes.length <
    60
  ) {

    return null;
  }

  const ma20 =
    sma(
      closes,
      20
    );

  const ma60 =
    sma(
      closes,
      60
    );

  const rsi =
    calcRSI(
      closes,
      14
    );

  const ema12 =
    ema(
      closes.slice(-80),
      12
    );

  const ema26 =
    ema(
      closes.slice(-80),
      26
    );

  const lows20 =
    rows
    .slice(-20)
    .map(
      r =>
        num(
          r.low
        )
    )
    .filter(
      Number.isFinite
    );

  const highs20 =
    rows
    .slice(-20)
    .map(
      r =>
        num(
          r.high
        )
    )
    .filter(
      Number.isFinite
    );

  const highs60 =
    rows
    .slice(-60)
    .map(
      r =>
        num(
          r.high
        )
    )
    .filter(
      Number.isFinite
    );

  if (
    !lows20.length ||
    !highs20.length ||
    !highs60.length
  ) {

    return null;
  }

  const support20 =
    Math.min(
      ...lows20
    );

  const resistance20 =
    Math.max(
      ...highs20
    );

  const high60 =
    Math.max(
      ...highs60
    );

  const currentVolume =
    volumes[
      volumes.length - 1
    ] || 0;

  const avgVolume20 =
    avg(
      volumes.slice(
        -21,
        -1
      )
    );

  const volumeRatio =
    avgVolume20 > 0
    ?
    currentVolume /
    avgVolume20
    :
    0;

  const conditions = [

    ma20 > ma60,

    price >=
    ma60 * 0.985,

    Math.abs(
      price -
      ma20
    ) <=
    atr * 2.2,

    price >=
    support20 * 0.99,

    rsi >= 45 &&
    rsi <= 72,

    ema12 -
    ema26 >=
    -atr * 0.05,

    volumeRatio >=
    0.8,

    Math.max(
      resistance20,
      high60
    ) >
    price * 1.025
  ];

  return {

    conditions,

    passed:
      conditions.filter(
        Boolean
      ).length,

    ma20,

    ma60,

    rsi,

    volumeRatio
  };
}


/* =========================================================
   法人
========================================================= */

function institutionalBias(
  institutional
) {

  if (
    !institutional
  ) {

    return {
      score: 0,
      text:
        "法人中性"
    };
  }

  /*
    優先使用首頁相同格式
  */

  const total5 =
    Number(
      institutional.total5
    );

  if (
    Number.isFinite(
      total5
    )
  ) {

    if (
      total5 > 0
    ) {

      return {
        score: 1,
        text:
          "法人偏多"
      };
    }

    if (
      total5 < 0
    ) {

      return {
        score: -1,
        text:
          "法人偏空"
      };
    }
  }

  return {
    score: 0,
    text:
      "法人中性"
  };
}


/* =========================================================
   分析股票
========================================================= */

function analyzeStock(
  data
) {

  if (
    !data ||
    !Array.isArray(
      data.rows
    ) ||
    data.rows.length <
    60
  ) {

    return null;
  }

  const rows =
    data.rows

    .map(
      r => ({

        open:
          num(
            r.open
          ),

        high:
          num(
            r.high
          ),

        low:
          num(
            r.low
          ),

        close:
          num(
            r.close
          ),

        volume:
          num(
            r.volume
          )
      })
    )

    .filter(
      r =>
        r.open !== null &&
        r.high !== null &&
        r.low !== null &&
        r.close !== null
    );

  if (
    rows.length <
    60
  ) {

    return null;
  }

  const price =
    num(
      data.price
    ) ??
    rows[
      rows.length - 1
    ].close;

  const atr =
    calcATR(
      rows,
      14
    );

  if (
    !Number.isFinite(
      price
    ) ||
    !Number.isFinite(
      atr
    ) ||
    atr <= 0
  ) {

    return null;
  }

  const strategy =
    strategyConditions(
      rows,
      price,
      atr
    );

  if (
    !strategy
  ) {

    return null;
  }

  /*
    正式訊號：
    至少 7 / 8
  */

  if (
    strategy.passed <
    7
  ) {

    return null;
  }

  const support =
    findSupport(
      rows,
      price,
      atr
    );

  if (
    !support
  ) {

    return null;
  }

  const tolerance =
    Math.max(
      atr * 0.6,
      price * 0.012
    );

  const nearSupport =
    price >=
    support.low -
    atr * 0.15
    &&
    price <=
    support.high +
    tolerance;

  if (
    !nearSupport
  ) {

    return null;
  }

  if (
    price <
    support.low -
    atr * 0.15
  ) {

    return null;
  }

  const targets =
    findTargets(
      rows,
      price,
      atr
    );

  if (
    !targets.tp1
  ) {

    return null;
  }

  const stopLoss =
    support.low -
    atr * 0.22;

  if (
    stopLoss <= 0 ||
    stopLoss >= price
  ) {

    return null;
  }

  if (
    targets.tp1 <=
    price +
    atr * 0.35
  ) {

    return null;
  }

  if (
    strategy.volumeRatio <
    0.8
  ) {

    return null;
  }

  const institution =
    institutionalBias(
      data.institutional
    );

  const fingerprint =
    [
      String(
        data.symbol
      ),

      support.type,

      support.low.toFixed(2),

      support.high.toFixed(2),

      strategy.passed
    ]
    .join(":");

  return {

    symbol:
      String(
        data.symbol
      ),

    name:
      data.name ||
      data.symbol,

    price,

    passed:
      strategy.passed,

    supportType:
      support.type,

    entryLow:
      support.low,

    entryHigh:
      support.high,

    stopLoss,

    tp1:
      targets.tp1,

    tp2:
      targets.tp2,

    tp3:
      targets.tp3,

    volumeRatio:
      strategy.volumeRatio,

    institution:
      institution.text,

    fingerprint
  };
}


/* =========================================================
   取得股票
========================================================= */

async function fetchStock(
  origin,
  symbol
) {

  try {

    const response =
      await fetch(
        `${origin}/api/stock?symbol=${encodeURIComponent(symbol)}&t=${Date.now()}`,
        {
          cache:
            "no-store",

          headers: {
            "Cache-Control":
              "no-cache"
          }
        }
      );

    if (
      !response.ok
    ) {

      return null;
    }

    const data =
      await response.json();

    if (
      !data?.ok
    ) {

      return null;
    }

    return data;

  } catch (error) {

    console.error(
      "fetch stock error:",
      symbol,
      error
    );

    return null;
  }
}


/* =========================================================
   Push 訊息
========================================================= */

function buildNotification(
  signal
) {

  const entry =
    signal.entryLow ===
    signal.entryHigh
    ?
    formatPrice(
      signal.entryLow
    )
    :
    `${formatPrice(signal.entryLow)}～${formatPrice(signal.entryHigh)}`;

  const targetParts = [];

  if (
    signal.tp1
  ) {

    targetParts.push(
      `TP1 ${formatPrice(signal.tp1)}`
    );
  }

  if (
    signal.tp2
  ) {

    targetParts.push(
      `TP2 ${formatPrice(signal.tp2)}`
    );
  }

  if (
    signal.tp3
  ) {

    targetParts.push(
      `TP3 ${formatPrice(signal.tp3)}`
    );
  }

  return {

    title:
      `📈 ${signal.name} ${signal.symbol}｜${signal.passed}/8 進場訊號`,

    body:
      [
        `現價 ${formatPrice(signal.price)}`,

        `進場 ${entry}`,

        `SL ${formatPrice(signal.stopLoss)}`,

        targetParts.join("｜"),

        `${signal.supportType}｜${signal.institution}`
      ]
      .filter(
        Boolean
      )
      .join("\n"),

    tag:
      `entry-${signal.symbol}`,

    url:
      `/?symbol=${encodeURIComponent(signal.symbol)}`
  };
}


/* =========================================================
   發送 Push
========================================================= */

async function sendPush(
  device,
  signal
) {

  const subscription =
    device.subscription ||
    device.pushSubscription ||
    device;

  if (
    !subscription ||
    !subscription.endpoint
  ) {

    throw new Error(
      "Push Subscription 格式錯誤"
    );
  }

  const payload =
    JSON.stringify(
      buildNotification(
        signal
      )
    );

  return webpush
    .sendNotification(
      subscription,
      payload,
      {
        TTL: 120
      }
    );
}


/* =========================================================
   API Handler
========================================================= */

module.exports =
async function handler(
  req,
  res
) {

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );


  /* =======================================================
     Cron 驗證
  ======================================================= */

  if (
    process.env.CRON_SECRET
  ) {

    const expected =
      `Bearer ${process.env.CRON_SECRET}`;

    if (
      req.headers.authorization !==
      expected
    ) {

      return res
      .status(401)
      .json({
        ok: false,
        error:
          "Unauthorized"
      });
    }
  }


  try {

    if (
      !VAPID_PUBLIC_KEY ||
      !VAPID_PRIVATE_KEY
    ) {

      throw new Error(
        "VAPID 環境變數尚未設定"
      );
    }


    webpush.setVapidDetails(
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );


    /* =====================================================
       測試模式
       ?test=1 可以略過交易時間
       但仍然需要 CRON_SECRET
    ===================================================== */

    const testMode =
      req.query?.test === "1";


    /*
      正式模式才限制交易時間
    */

    if (
      !testMode &&
      !isMarketTime()
    ) {

      return res
      .status(200)
      .json({

        ok: true,

        skipped: true,

        testMode:
          false,

        reason:
          "非台股監控時段"
      });
    }


    /* =====================================================
       取得裝置
    ===================================================== */

    const deviceIds =
      await redis([
        "SMEMBERS",
        "swing:push:devices"
      ]) || [];


    if (
      !deviceIds.length
    ) {

      return res
      .status(200)
      .json({

        ok: true,

        testMode,

        devices: 0,

        stocks: 0,

        signals: 0,

        sent: 0,

        removed: 0
      });
    }


    const devices = [];


    for (
      const deviceId of
      deviceIds
    ) {

      const raw =
        await redis([
          "GET",
          `swing:push:device:${deviceId}`
        ]);


      if (
        !raw
      ) {

        await redis([
          "SREM",
          "swing:push:devices",
          deviceId
        ]);

        continue;
      }


      try {

        const device =
          typeof raw ===
          "string"
          ?
          JSON.parse(raw)
          :
          raw;


        const subscription =
          device.subscription ||
          device.pushSubscription;


        if (
          subscription?.endpoint &&
          Array.isArray(
            device.symbols
          )
        ) {

          /*
            確保 deviceId 一定存在。
          */

          devices.push({

            ...device,

            deviceId:
              device.deviceId ||
              deviceId,

            subscription
          });
        }

      } catch (error) {

        console.error(
          "device parse error:",
          deviceId,
          error
        );
      }
    }


    if (
      !devices.length
    ) {

      return res
      .status(200)
      .json({

        ok: true,

        testMode,

        devices: 0,

        stocks: 0,

        signals: 0,

        sent: 0,

        removed: 0
      });
    }


    /* =====================================================
       合併股票
    ===================================================== */

    const symbols =
      unique(
        devices.flatMap(
          device =>
            device.symbols ||
            []
        )
      );


    /* =====================================================
       網站網址
    ===================================================== */

    const host =
      req.headers[
        "x-forwarded-host"
      ] ||
      req.headers.host;


    const proto =
      req.headers[
        "x-forwarded-proto"
      ] ||
      "https";


    const origin =
      `${proto}://${host}`;


    /* =====================================================
       分析股票
    ===================================================== */

    const signalMap =
      new Map();


    const checkedStocks =
      [];


    const batchSize =
      3;


    for (
      let i = 0;
      i < symbols.length;
      i += batchSize
    ) {

      const batch =
        symbols.slice(
          i,
          i + batchSize
        );


      const results =
        await Promise.all(
          batch.map(
            symbol =>
              fetchStock(
                origin,
                symbol
              )
          )
        );


      for (
        let j = 0;
        j <
        results.length;
        j++
      ) {

        const symbol =
          batch[j];

        const data =
          results[j];


        if (
          !data
        ) {

          checkedStocks.push({

            symbol,

            ok: false,

            signal: false,

            reason:
              "股票資料取得失敗"
          });

          continue;
        }


        const signal =
          analyzeStock(
            data
          );


        checkedStocks.push({

          symbol,

          ok: true,

          name:
            data.name ||
            "",

          price:
            num(
              data.price
            ),

          signal:
            !!signal,

          passed:
            signal
            ?
            signal.passed
            :
            null,

          supportType:
            signal
            ?
            signal.supportType
            :
            null
        });


        if (
          signal
        ) {

          signalMap.set(
            symbol,
            signal
          );
        }
      }
    }


    /* =====================================================
       發送 Push
    ===================================================== */

    let sent = 0;
    let removed = 0;
    let failed = 0;
    let deduped = 0;


    const pushResults =
      [];


    for (
      const device of
      devices
    ) {

      for (
        const symbol of
        device.symbols
      ) {

        const signal =
          signalMap.get(
            String(
              symbol
            )
          );


        if (
          !signal
        ) {

          continue;
        }


        /*
          正式模式：
          6 小時內同一 setup 不重複推。

          測試模式：
          不使用 dedupe，
          方便我們現在確認 monitor。
        */

        let dedupeKey =
          null;


        if (
          !testMode
        ) {

          dedupeKey =
            `swing:push:sent:${device.deviceId}:${signal.fingerprint}`;


          const acquired =
            await redis([
              "SET",
              dedupeKey,
              "1",
              "NX",
              "EX",
              "21600"
            ]);


          if (
            acquired !==
            "OK"
          ) {

            deduped++;

            continue;
          }
        }


        try {

          const response =
            await sendPush(
              device,
              signal
            );


          sent++;


          pushResults.push({

            deviceId:
              device.deviceId,

            symbol:
              signal.symbol,

            ok: true,

            statusCode:
              response?.statusCode ||
              201
          });


        } catch (error) {

          console.error(
            "push error:",
            device.deviceId,
            symbol,
            error
          );


          const statusCode =
            error?.statusCode ||
            null;


          const body =
            typeof error?.body ===
            "string"
            ?
            error.body
            :
            JSON.stringify(
              error?.body ||
              ""
            );


          const expired =
            statusCode === 404 ||
            statusCode === 410;


          const vapidMismatch =
            statusCode === 400 &&
            body.includes(
              "VapidPkHashMismatch"
            );


          let deleted =
            false;


          /*
            無效 subscription
            直接清除
          */

          if (
            expired ||
            vapidMismatch
          ) {

            deleted =
              await deleteDevice(
                device.deviceId
              );


            if (
              deleted
            ) {

              removed++;
            }

          } else {

            failed++;


            /*
              正式模式如果 Push 失敗，
              把 dedupe key 刪掉，
              下次 Cron 可以重試。
            */

            if (
              dedupeKey
            ) {

              try {

                await redis([
                  "DEL",
                  dedupeKey
                ]);

              } catch (_) {}

            }
          }


          pushResults.push({

            deviceId:
              device.deviceId,

            symbol:
              signal.symbol,

            ok: false,

            statusCode,

            message:
              error?.message ||
              "Push 發送失敗",

            body,

            deleted
          });
        }
      }
    }


    /* =====================================================
       回傳
    ===================================================== */

    return res
    .status(200)
    .json({

      ok: true,

      testMode,

      marketTime:
        isMarketTime(),

      devices:
        devices.length,

      stocks:
        symbols.length,

      signals:
        signalMap.size,

      sent,

      failed,

      removed,

      deduped,

      /*
        test=1 時把股票檢查結果顯示出來，
        正式 Cron 不需要輸出一堆資料。
      */

      checkedStocks:
        testMode
        ?
        checkedStocks
        :
        undefined,

      pushResults:
        testMode
        ?
        pushResults
        :
        undefined
    });


  } catch (error) {

    console.error(
      "monitor error:",
      error
    );


    return res
    .status(500)
    .json({

      ok: false,

      error:
        error?.message ||
        "背景監控失敗"
    });
  }
};
