/* =========================================================
   api/monitor.js
   台股背景進場訊號監控 + Web Push

   正式 Push 條件與 index.html 對齊：
   1. passed >= 7
   2. hasRealStructure === true
   3. entryReady === true

   支援：
   - iPhone / iPad 多裝置
   - Redis
   - Vercel Cron
   - 6 小時同 Setup 防重複
   - 失效 Push 自動清除
========================================================= */

const webpush = require("web-push");


/* =========================================================
   ENV
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


function avg(a) {

  const values =
    a.filter(
      Number.isFinite
    );

  return values.length
    ? values.reduce(
        (x, y) => x + y,
        0
      ) / values.length
    : 0;
}


function sma(a, n) {

  return avg(
    a.slice(-n)
  );
}


function ema(a, n) {

  if (!a.length) {
    return 0;
  }

  let e =
    a[0];

  const k =
    2 / (n + 1);

  for (
    let i = 1;
    i < a.length;
    i++
  ) {

    e =
      a[i] * k +
      e * (1 - k);
  }

  return e;
}


function rsi(a, n = 14) {

  if (
    a.length <= n
  ) {
    return 50;
  }

  let g = 0;
  let l = 0;

  for (
    let i =
      a.length - n;
    i < a.length;
    i++
  ) {

    const d =
      a[i] -
      a[i - 1];

    if (d > 0) {
      g += d;
    } else {
      l -= d;
    }
  }

  if (l === 0) {
    return 100;
  }

  return (
    100 -
    100 /
    (
      1 +
      (g / n) /
      (l / n)
    )
  );
}


function atr(rows, n = 14) {

  const v = [];

  for (
    let i =
      Math.max(
        1,
        rows.length - n
      );
    i < rows.length;
    i++
  ) {

    const x =
      rows[i];

    const p =
      rows[i - 1].close;

    v.push(
      Math.max(
        x.high - x.low,
        Math.abs(
          x.high - p
        ),
        Math.abs(
          x.low - p
        )
      )
    );
  }

  return avg(v);
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


function formatPrice(v) {

  if (
    !Number.isFinite(
      Number(v)
    )
  ) {
    return "--";
  }

  const n =
    Number(v);

  if (n >= 1000) {
    return n.toFixed(0);
  }

  if (n >= 100) {
    return n.toFixed(1);
  }

  return n.toFixed(2);
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
        p => p.type === type
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
   SMC
   與 index.html 對齊
========================================================= */

function swings(
  rows,
  left = 2,
  right = 2
) {

  const lows = [];
  const highs = [];

  for (
    let i = left;
    i < rows.length - right;
    i++
  ) {

    let lo = true;
    let hi = true;

    for (
      let j = 1;
      j <= left;
      j++
    ) {

      if (
        rows[i].low >
        rows[i - j].low
      ) {
        lo = false;
      }

      if (
        rows[i].high <
        rows[i - j].high
      ) {
        hi = false;
      }
    }

    for (
      let j = 1;
      j <= right;
      j++
    ) {

      if (
        rows[i].low >
        rows[i + j].low
      ) {
        lo = false;
      }

      if (
        rows[i].high <
        rows[i + j].high
      ) {
        hi = false;
      }
    }

    if (lo) {

      lows.push({
        i,
        value:
          rows[i].low,
        row:
          rows[i]
      });
    }

    if (hi) {

      highs.push({
        i,
        value:
          rows[i].high,
        row:
          rows[i]
      });
    }
  }

  return {
    lows,
    highs
  };
}


function zoneValid(
  zone,
  rows,
  bullish = true
) {

  const after =
    rows.slice(
      zone.i + 1
    );

  if (bullish) {

    return !after.some(
      x =>
        x.close <
        zone.low
    );
  }

  return !after.some(
    x =>
      x.close >
      zone.high
  );
}


function smcAnalysis(
  rows,
  price,
  A,
  inst
) {

  /*
    跟 index.html 一樣：
    只使用最近 140 根
  */

  const recent =
    rows.slice(-140);

  const S =
    swings(
      recent,
      2,
      2
    );

  const volBase =
    avg(
      recent
      .slice(
        -21,
        -1
      )
      .map(
        x =>
          x.volume
      )
    );

  const supports = [];
  const pressures = [];


  /* =======================================================
     Bullish / Bearish OB
  ======================================================= */

  for (
    let i = 2;
    i < recent.length - 2;
    i++
  ) {

    const x =
      recent[i];

    const n2 =
      recent[i + 2];

    const displacementUp =
      n2.close >
      x.high +
      Math.max(
        A * 0.35,
        price * 0.004
      );

    const displacementDown =
      n2.close <
      x.low -
      Math.max(
        A * 0.35,
        price * 0.004
      );

    if (
      x.close < x.open &&
      displacementUp
    ) {

      const z = {
        type:
          "Bullish OB",

        i,

        low:
          x.low,

        high:
          Math.max(
            x.open,
            x.close
          ),

        score: 5
      };

      if (
        zoneValid(
          z,
          recent,
          true
        ) &&
        z.low < price
      ) {

        supports.push(z);
      }
    }

    if (
      x.close > x.open &&
      displacementDown
    ) {

      const z = {
        type:
          "Bearish OB",

        i,

        low:
          Math.min(
            x.open,
            x.close
          ),

        high:
          x.high,

        score: 5
      };

      if (
        zoneValid(
          z,
          recent,
          false
        ) &&
        z.high > price
      ) {

        pressures.push(z);
      }
    }
  }


  /* =======================================================
     FVG
  ======================================================= */

  for (
    let i = 1;
    i < recent.length - 1;
    i++
  ) {

    const a =
      recent[i - 1];

    const c =
      recent[i + 1];

    if (
      c.low >
      a.high
    ) {

      const z = {
        type:
          "Bullish FVG",

        i,

        low:
          a.high,

        high:
          c.low,

        score:
          3.5
      };

      if (
        zoneValid(
          z,
          recent,
          true
        ) &&
        z.low < price
      ) {

        supports.push(z);
      }
    }

    if (
      c.high <
      a.low
    ) {

      const z = {
        type:
          "Bearish FVG",

        i,

        low:
          c.high,

        high:
          a.low,

        score:
          3.5
      };

      if (
        zoneValid(
          z,
          recent,
          false
        ) &&
        z.high > price
      ) {

        pressures.push(z);
      }
    }
  }


  /* =======================================================
     BOS / Breaker
  ======================================================= */

  for (
    const h of
    S.highs
  ) {

    const later =
      recent.slice(
        h.i + 1
      );

    const broken =
      later.some(
        x =>
          x.close >
          h.value +
          Math.max(
            A * 0.12,
            h.value * 0.0025
          )
      );

    if (
      broken &&
      h.value < price
    ) {

      supports.push({
        type:
          "BOS / Breaker",

        i:
          h.i,

        low:
          h.value -
          A * 0.15,

        high:
          h.value +
          A * 0.15,

        score: 6
      });

    } else if (
      h.value > price
    ) {

      pressures.push({
        type:
          "Buy-side Liquidity",

        i:
          h.i,

        low:
          h.value -
          A * 0.08,

        high:
          h.value +
          A * 0.08,

        score:
          4.5
      });
    }
  }


  for (
    const l of
    S.lows
  ) {

    if (
      l.value < price
    ) {

      supports.push({
        type:
          "Sell-side Liquidity / Demand",

        i:
          l.i,

        low:
          l.value -
          A * 0.10,

        high:
          l.value +
          A * 0.12,

        score:
          3.8
      });
    }
  }


  /* =======================================================
     Liquidity Sweep
  ======================================================= */

  for (
    let i = 3;
    i < recent.length;
    i++
  ) {

    const prevLow =
      Math.min(
        ...recent
        .slice(
          Math.max(
            0,
            i - 8
          ),
          i
        )
        .map(
          x =>
            x.low
        )
      );

    const prevHigh =
      Math.max(
        ...recent
        .slice(
          Math.max(
            0,
            i - 8
          ),
          i
        )
        .map(
          x =>
            x.high
        )
      );

    const x =
      recent[i];

    if (
      x.low <
      prevLow &&
      x.close >
      prevLow
    ) {

      supports.push({
        type:
          "Liquidity Sweep",

        i,

        low:
          x.low,

        high:
          prevLow,

        score:
          5.5
      });
    }

    if (
      x.high >
      prevHigh &&
      x.close <
      prevHigh
    ) {

      pressures.push({
        type:
          "Liquidity Sweep",

        i,

        low:
          prevHigh,

        high:
          x.high,

        score:
          5.5
      });
    }
  }


  /* =======================================================
     成交量加權
  ======================================================= */

  for (
    const z of
    [
      ...supports,
      ...pressures
    ]
  ) {

    const r =
      recent[z.i];

    if (
      r &&
      volBase > 0 &&
      r.volume >=
      volBase * 1.35
    ) {

      z.score += 1.5;
    }

    const dist =
      Math.abs(
        price -
        (
          z.low +
          z.high
        ) / 2
      ) /
      price;

    z.score -=
      dist * 12;
  }


  /* =======================================================
     法人加權
  ======================================================= */

  const chip =
    inst || {};

  const chip5 =
    Number(
      chip.total5 || 0
    );

  if (
    chip5 > 0
  ) {

    supports.forEach(
      z =>
        z.score += 0.7
    );
  }

  if (
    chip5 < 0
  ) {

    pressures.forEach(
      z =>
        z.score += 0.7
    );
  }

  if (
    Number(
      chip.foreign5 || 0
    ) > 0
  ) {

    supports.forEach(
      z =>
        z.score += 0.3
    );
  }

  if (
    Number(
      chip.trust5 || 0
    ) > 0
  ) {

    supports.forEach(
      z =>
        z.score += 0.3
    );
  }


  /* =======================================================
     有效支撐
  ======================================================= */

  const validS =
    supports
    .filter(
      z =>
        z.high <=
        price * 1.012
    )
    .sort(
      (a, b) => {

        const da =
          (
            price -
            a.high
          ) /
          price;

        const db =
          (
            price -
            b.high
          ) /
          price;

        return (
          (db - da) * 5 +
          (
            b.score -
            a.score
          )
        );
      }
    );


  /* =======================================================
     有效壓力
  ======================================================= */

  const validP =
    pressures
    .filter(
      z =>
        z.low >
        price * 1.001
    )
    .sort(
      (a, b) =>
        a.low -
        b.low
    );


  const nearS =
    validS.filter(
      z =>
        (
          price -
          z.high
        ) /
        price <=
        0.10
    );


  let s1 =
    nearS
    .sort(
      (a, b) => {

        const da =
          (
            price -
            a.high
          ) /
          price;

        const db =
          (
            price -
            b.high
          ) /
          price;

        return (
          b.score -
          db * 30
        ) -
        (
          a.score -
          da * 30
        );
      }
    )[0]
    ||
    validS[0]
    ||
    null;


  let s2 =
    null;

  if (s1) {

    s2 =
      validS
      .filter(
        z =>
          z !== s1 &&
          z.high <
          s1.low -
          Math.max(
            A * 0.25,
            price * 0.003
          )
      )
      .sort(
        (a, b) =>
          b.high -
          a.high
      )[0]
      ||
      null;
  }


  const p1 =
    validP[0] ||
    null;


  let p2 =
    null;

  let p3 =
    null;


  if (p1) {

    p2 =
      validP.find(
        z =>
          z !== p1 &&
          z.low >
          p1.high +
          Math.max(
            A * 0.2,
            price * 0.002
          )
      )
      ||
      null;
  }


  if (p2) {

    p3 =
      validP.find(
        z =>
          z !== p1 &&
          z !== p2 &&
          z.low >
          p2.high +
          Math.max(
            A * 0.2,
            price * 0.002
          )
      )
      ||
      null;
  }


  /* =======================================================
     Entry / SL
  ======================================================= */

  let entryLow =
    null;

  let entryHigh =
    null;

  let sl =
    null;


  if (s1) {

    entryLow =
      Math.max(
        0,
        s1.low
      );

    entryHigh =
      s1.high;

    sl =
      s1.low -
      Math.max(
        A * 0.45,
        price * 0.006
      );

    if (
      sl >=
      entryLow
    ) {

      sl =
        entryLow -
        Math.max(
          A * 0.35,
          price * 0.005
        );
    }
  }


  /* =======================================================
     Entry Ready
  ======================================================= */

  let entryReady =
    false;


  if (
    s1 &&
    Number.isFinite(
      entryLow
    ) &&
    Number.isFinite(
      entryHigh
    )
  ) {

    const tolerance =
      Math.max(
        A * 0.60,
        price * 0.012
      );

    entryReady =
      price >=
      entryLow -
      Math.max(
        A * 0.15,
        price * 0.003
      )
      &&
      price <=
      entryHigh +
      tolerance;
  }


  return {

    support1:
      s1,

    support2:
      s2,

    breakout:
      p1
      ?
      p1.low
      :
      null,

    pressure1:
      p1,

    pressure2:
      p2,

    pressure3:
      p3,

    entryLow,

    entryHigh,

    sl,

    tp1:
      p1
      ?
      p1.low
      :
      null,

    tp2:
      p2
      ?
      p2.low
      :
      null,

    tp3:
      p3
      ?
      p3.low
      :
      null,

    entryReady,

    hasRealStructure:
      !!s1,

    chipBias:
      chip5 > 0
      ?
      "偏多"
      :
      chip5 < 0
      ?
      "偏空"
      :
      "中性"
  };
}


/* =========================================================
   8 條策略
   與 index.html 對齊
========================================================= */

function analyzeData(d) {

  if (
    !Array.isArray(
      d?.rows
    ) ||
    d.rows.length < 60
  ) {

    return null;
  }


  const rows =
    d.rows
    .map(
      x => ({
        date:
          x.date || "",

        open:
          +x.open,

        high:
          +x.high,

        low:
          +x.low,

        close:
          +x.close,

        volume:
          +x.volume || 0
      })
    )
    .filter(
      x =>
        Number.isFinite(
          x.close
        ) &&
        x.close > 0
    );


  if (
    rows.length < 60
  ) {

    return null;
  }


  const c =
    rows.map(
      x =>
        x.close
    );


  let p =
    +d.price;


  if (
    !Number.isFinite(p) ||
    p <= 0
  ) {

    p =
      rows[
        rows.length - 1
      ].close;
  }


  const m20 =
    sma(
      c,
      20
    );


  const m60 =
    sma(
      c,
      60
    );


  /*
    跟 index.html 完全相同：
    ATR 至少使用股價 0.6%
  */

  const A =
    Math.max(
      atr(rows),
      p * 0.006
    );


  const R =
    rsi(c);


  const macd =
    ema(
      c.slice(-100),
      12
    )
    -
    ema(
      c.slice(-100),
      26
    );


  const r20 =
    rows.slice(-20);


  const r60 =
    rows.slice(-60);


  const support =
    Math.min(
      ...r20.map(
        x =>
          x.low
      )
    );


  const res =
    Math.max(
      ...r20.map(
        x =>
          x.high
      )
    );


  const high60 =
    Math.max(
      ...r60.map(
        x =>
          x.high
      )
    );


  const vol =
    rows[
      rows.length - 1
    ].volume;


  const volAvg =
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


  const vr =
    volAvg
    ?
    vol /
    volAvg
    :
    0;


  const conditions = [

    m20 > m60,

    p >=
      m60 * 0.985,

    Math.abs(
      p - m20
    ) <=
      A * 2.2,

    p >=
      support * 0.99,

    R >= 45 &&
      R <= 72,

    macd >=
      -A * 0.05,

    vr >=
      0.8,

    Math.max(
      res,
      high60
    ) >
      p * 1.025
  ];


  const passed =
    conditions
    .filter(Boolean)
    .length;


  const smc =
    smcAnalysis(
      rows,
      p,
      A,
      d.institutional
    );


  return {

    symbol:
      String(
        d.symbol || ""
      ),

    name:
      d.name ||
      d.symbol ||
      "",

    price:
      p,

    passed,

    qualified:
      passed >= 7,

    near:
      passed === 6,

    A,

    vr,

    R,

    hasRealStructure:
      smc.hasRealStructure,

    entryReady:
      smc.entryReady,

    support1Low:
      smc.support1
      ?
      smc.support1.low
      :
      null,

    support1High:
      smc.support1
      ?
      smc.support1.high
      :
      null,

    support1Type:
      smc.support1
      ?
      smc.support1.type
      :
      "無有效 SMC 結構",

    entryLow:
      smc.entryLow,

    entryHigh:
      smc.entryHigh,

    sl:
      smc.sl,

    breakout:
      smc.breakout,

    pressure1:
      smc.pressure1
      ?
      smc.pressure1.low
      :
      null,

    pressure2:
      smc.pressure2
      ?
      smc.pressure2.low
      :
      null,

    tp1:
      smc.tp1,

    tp2:
      smc.tp2,

    tp3:
      smc.tp3,

    chipBias:
      smc.chipBias
  };
}


/* =========================================================
   正式進場訊號
========================================================= */

function makeSignal(data) {

  const a =
    analyzeData(data);

  if (!a) {
    return null;
  }


  /*
    跟網站一致：
    7 / 8 才是策略成立
  */

  if (
    !a.qualified
  ) {
    return null;
  }


  /*
    一定要有真正 SMC 支撐
  */

  if (
    !a.hasRealStructure
  ) {
    return null;
  }


  /*
    一定要真的進入網站計算的
    SMC 進場範圍
  */

  if (
    !a.entryReady
  ) {
    return null;
  }


  if (
    !Number.isFinite(
      a.entryLow
    ) ||
    !Number.isFinite(
      a.entryHigh
    ) ||
    !Number.isFinite(
      a.sl
    )
  ) {

    return null;
  }


  /*
    fingerprint：
    同一支股票、同一個 SMC 支撐區，
    6 小時只通知一次。
  */

  const fingerprint =
    [
      a.symbol,

      a.support1Type,

      Number(
        a.entryLow
      ).toFixed(2),

      Number(
        a.entryHigh
      ).toFixed(2),

      a.passed
    ]
    .join(":");


  return {

    ...a,

    fingerprint
  };
}


/* =========================================================
   股票 API
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

      console.error(
        "stock api status:",
        symbol,
        response.status
      );

      return null;
    }


    const data =
      await response.json();


    if (
      !data?.ok
    ) {

      console.error(
        "stock api error:",
        symbol,
        data?.error
      );

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
   Push
========================================================= */

function buildNotification(
  signal
) {

  const entry =
    `${formatPrice(signal.entryLow)}～${formatPrice(signal.entryHigh)}`;


  const targets = [];


  if (
    Number.isFinite(
      signal.tp1
    )
  ) {

    targets.push(
      `TP1 ${formatPrice(signal.tp1)}`
    );
  }


  if (
    Number.isFinite(
      signal.tp2
    )
  ) {

    targets.push(
      `TP2 ${formatPrice(signal.tp2)}`
    );
  }


  if (
    Number.isFinite(
      signal.tp3
    )
  ) {

    targets.push(
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

        `SL ${formatPrice(signal.sl)}`,

        targets.join("｜"),

        `${signal.support1Type}｜法人${signal.chipBias}`
      ]
      .filter(Boolean)
      .join("\n"),

    tag:
      `entry-${signal.symbol}`,

    url:
      `/?symbol=${encodeURIComponent(signal.symbol)}`
  };
}


async function sendPush(
  device,
  signal
) {

  const subscription =
    device.subscription ||
    device.pushSubscription;


  if (
    !subscription?.endpoint
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
   Handler
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
     Cron Secret
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
      !VAPID_PRIVATE_KEY ||
      !VAPID_SUBJECT
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


    const testMode =
      req.query?.test === "1";


    /*
      正式 Cron：
      只在台股監控時間真正掃股票。
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

        marketTime:
          false,

        reason:
          "非台股監控時段"
      });
    }


    /* =====================================================
       取得所有裝置
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

        marketTime:
          isMarketTime(),

        devices: 0,

        stocks: 0,

        signals: 0,

        sent: 0,

        failed: 0,

        removed: 0,

        deduped: 0
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


      if (!raw) {

        /*
          Set 裡有 ID，
          但實際 device 不存在，
          順便清掉。
        */

        await redis([
          "SREM",
          "swing:push:devices",
          deviceId
        ]);

        continue;
      }


      try {

        const device =
          typeof raw === "string"
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
          ) &&
          device.symbols.length
        ) {

          devices.push({

            ...device,

            deviceId:
              device.deviceId ||
              deviceId,

            subscription,

            symbols:
              unique(
                device.symbols
              )
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

        marketTime:
          isMarketTime(),

        devices: 0,

        stocks: 0,

        signals: 0,

        sent: 0,

        failed: 0,

        removed: 0,

        deduped: 0
      });
    }


    /* =====================================================
       iPhone + iPad 的股票全部合併
       同一支股票只抓一次
    ===================================================== */

    const symbols =
      unique(
        devices.flatMap(
          d =>
            d.symbols
        )
      );


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


    const signalMap =
      new Map();


    const checkedStocks =
      [];


    /*
      避免一次同時打太多 API
    */

    const batchSize = 3;


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
        j < results.length;
        j++
      ) {

        const symbol =
          String(
            batch[j]
          );


        const data =
          results[j];


        if (!data) {

          checkedStocks.push({

            symbol,

            api:
              false,

            signal:
              false,

            reason:
              "股票資料取得失敗"
          });

          continue;
        }


        /*
          先取得完整網站分析結果，
          測試時方便查看為何沒 Push。
        */

        const analysis =
          analyzeData(
            data
          );


        const signal =
          makeSignal(
            data
          );


        checkedStocks.push({

          symbol,

          name:
            data.name ||
            "",

          api:
            true,

          price:
            analysis?.price ??
            null,

          passed:
            analysis?.passed ??
            null,

          qualified:
            analysis?.qualified ??
            false,

          hasRealStructure:
            analysis?.hasRealStructure ??
            false,

          entryReady:
            analysis?.entryReady ??
            false,

          supportType:
            analysis?.support1Type ??
            null,

          entryLow:
            analysis?.entryLow ??
            null,

          entryHigh:
            analysis?.entryHigh ??
            null,

          signal:
            !!signal
        });


        if (signal) {

          signalMap.set(
            symbol,
            signal
          );
        }
      }
    }


    /* =====================================================
       Push 到每一台裝置
    ===================================================== */

    let sent = 0;
    let failed = 0;
    let removed = 0;
    let deduped = 0;


    const pushResults = [];


    /*
      如果同一裝置已經失效，
      不要後面其他股票繼續送。
    */

    const deadDevices =
      new Set();


    for (
      const device of
      devices
    ) {

      if (
        deadDevices.has(
          device.deviceId
        )
      ) {
        continue;
      }


      for (
        const rawSymbol of
        device.symbols
      ) {

        if (
          deadDevices.has(
            device.deviceId
          )
        ) {
          break;
        }


        const symbol =
          String(
            rawSymbol
          );


        const signal =
          signalMap.get(
            symbol
          );


        if (!signal) {
          continue;
        }


        let dedupeKey =
          null;


        /*
          test=1 不使用防重複，
          正式 Cron 才使用。
        */

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
            acquired !== "OK"
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

            symbol,

            ok:
              true,

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


          if (
            expired ||
            vapidMismatch
          ) {

            deleted =
              await deleteDevice(
                device.deviceId
              );


            if (deleted) {

              removed++;

              deadDevices.add(
                device.deviceId
              );
            }

          } else {

            failed++;


            /*
              真正發送失敗：
              刪掉 dedupe，
              下一輪可以重試。
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

            symbol,

            ok:
              false,

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
       Result
    ===================================================== */

    return res
    .status(200)
    .json({

      ok:
        true,

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
        test=1 才輸出詳細分析。
        正式 Cron 保持精簡。
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

      ok:
        false,

      error:
        error?.message ||
        "背景監控失敗"
    });
  }
};
