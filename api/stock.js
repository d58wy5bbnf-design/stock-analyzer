const https = require("https");

/*
  波段分析 Stock API 6.3 Redis Cache

  功能：
  - 歷史 K
  - 即時價格
  - 法人
  - 月營收
  - 財報
  - 股票名稱

  Cache：
  - Memory Cache
  - Upstash Redis 持久快取
  - FinMind 失敗 / HTTP 402 時自動使用 Redis 舊資料

  目的：
  - 大幅降低 FinMind API 使用量
  - 避免 Sponsor 6000/hour 被重複資料打爆
  - 保留 Stock API 6.2 原本回傳格式
*/

const CACHE =
  global.__STOCK_CACHE__ ||
  new Map();

global.__STOCK_CACHE__ = CACHE;


/* =========================
   CACHE TTL
========================= */

/*
  fresh：
  在這段時間內直接使用 Cache，不呼叫 FinMind

  stale：
  Redis 最長保存時間。
  fresh 過期後會嘗試更新 FinMind；
  如果 FinMind 402 / timeout / error，
  就使用 Redis 裡最後一次成功資料。
*/

const TTL = {
  price: {
    fresh: 30 * 60 * 1000,
    stale: 7 * 24 * 60 * 60
  },

  realtime: {
    fresh: 60 * 1000,
    stale: 6 * 60 * 60
  },

  institutional: {
    fresh: 2 * 60 * 60 * 1000,
    stale: 14 * 24 * 60 * 60
  },

  info: {
    fresh: 24 * 60 * 60 * 1000,
    stale: 30 * 24 * 60 * 60
  },

  revenue: {
    fresh: 12 * 60 * 60 * 1000,
    stale: 60 * 24 * 60 * 60
  },

  financial: {
    fresh: 24 * 60 * 60 * 1000,
    stale: 90 * 24 * 60 * 60
  }
};


/* =========================
   MAIN
========================= */

module.exports =
async function handler(req, res) {

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {

    const token =
      process.env.FINMIND_TOKEN;

    if (!token) {
      throw new Error(
        "Vercel 尚未設定 FINMIND_TOKEN"
      );
    }


    const symbol =
      String(
        req.query.symbol || ""
      )
        .trim()
        .toUpperCase();


    if (
      !/^[0-9A-Z]{4,10}$/.test(symbol)
    ) {
      throw new Error(
        "股票代號格式錯誤"
      );
    }


    /* =========================
       DATE
    ========================= */

    const end =
      new Date();


    const priceStart =
      new Date();

    priceStart.setDate(
      priceStart.getDate() - 500
    );


    const revenueStart =
      new Date();

    revenueStart.setMonth(
      revenueStart.getMonth() - 18
    );


    const financialStart =
      new Date();

    financialStart.setFullYear(
      financialStart.getFullYear() - 2
    );


    const startDate =
      date(priceStart);

    const endDate =
      date(end);

    const revenueStartDate =
      date(revenueStart);

    const financialStartDate =
      date(financialStart);


    /* =========================
       DATA
    ========================= */

    const results =
      await Promise.allSettled([

        smartCached(
          `price:${symbol}`,
          TTL.price,
          () =>
            getPrice(
              symbol,
              startDate,
              endDate,
              token
            )
        ),

        smartCached(
          `rt:${symbol}`,
          TTL.realtime,
          () =>
            getRealtime(
              symbol,
              token
            )
        ),

        smartCached(
          `inst:${symbol}`,
          TTL.institutional,
          () =>
            getInstitutional(
              symbol,
              startDate,
              endDate,
              token
            )
        ),

        smartCached(
          "stock-info",
          TTL.info,
          () =>
            getStockInfo(
              token
            )
        ),

        smartCached(
          `revenue:${symbol}`,
          TTL.revenue,
          () =>
            getRevenue(
              symbol,
              revenueStartDate,
              endDate,
              token
            )
        ),

        smartCached(
          `financial:${symbol}`,
          TTL.financial,
          () =>
            getFinancial(
              symbol,
              financialStartDate,
              endDate,
              token
            )
        )

      ]);


    const [
      priceR,
      realtimeR,
      institutionalR,
      infoR,
      revenueR,
      financialR
    ] = results;


    /*
      K 線是唯一必要資料
    */

    if (
      priceR.status !== "fulfilled"
    ) {
      throw (
        priceR.reason ||
        new Error(
          "歷史股價取得失敗"
        )
      );
    }


    let rows =
      priceR.value;


    if (
      !Array.isArray(rows) ||
      rows.length < 60
    ) {
      throw new Error(
        "歷史 K 線不足 60 根"
      );
    }


    /* =========================
       OPTIONAL DATA
    ========================= */

    const realtime =
      realtimeR.status === "fulfilled"
        ? realtimeR.value
        : null;


    const institutional =
      institutionalR.status === "fulfilled"
        ? institutionalR.value
        : emptyInstitutional();


    const revenue =
      revenueR.status === "fulfilled"
        ? revenueR.value
        : emptyRevenue();


    const financial =
      financialR.status === "fulfilled"
        ? financialR.value
        : emptyFinancial();


    /* =========================
       STOCK NAME
    ========================= */

    let name =
      symbol;

    let market =
      "";


    if (
      infoR.status === "fulfilled" &&
      Array.isArray(infoR.value)
    ) {

      const info =
        infoR.value.find(
          x =>
            String(
              x.stock_id || ""
            ) === symbol
        );


      if (info) {

        name =
          String(
            info.stock_name ||
            symbol
          );


        market =
          marketName(
            info.type ||
            info.industry_category ||
            ""
          );

      }

    }


    /* =========================
       PRICE
    ========================= */

    const latest =
      rows[
        rows.length - 1
      ];


    const previous =
      rows.length > 1
        ? rows[
            rows.length - 2
          ]
        : latest;


    const currentPrice =
      positive(
        realtime?.price,
        latest.close
      );


    const previousClose =
      positive(
        realtime?.previousClose,
        previous.close
      );


    const open =
      positive(
        realtime?.open,
        latest.open,
        currentPrice
      );


    const high =
      positive(
        realtime?.high,
        latest.high,
        currentPrice
      );


    const low =
      positive(
        realtime?.low,
        latest.low,
        currentPrice
      );


    const volume =
      nonNegative(
        realtime?.volume,
        latest.volume
      );


    /* =========================
       MERGE REALTIME
    ========================= */

    const today =
      date(
        new Date()
      );


    rows =
      rows.map(
        x => ({ ...x })
      );


    const last =
      rows[
        rows.length - 1
      ];


    if (
      realtime &&
      currentPrice > 0
    ) {

      if (
        last &&
        last.date === today
      ) {

        last.open =
          open;


        last.high =
          Math.max(
            Number(
              last.high
            ) || 0,
            high,
            currentPrice
          );


        const lows =
          [
            Number(
              last.low
            ),
            low,
            currentPrice
          ].filter(
            x =>
              Number.isFinite(x) &&
              x > 0
          );


        if (lows.length) {
          last.low =
            Math.min(
              ...lows
            );
        }


        last.close =
          currentPrice;


        if (
          volume > 0
        ) {
          last.volume =
            volume;
        }

      } else {

        rows.push({

          date:
            today,

          open,

          high:
            Math.max(
              high,
              currentPrice
            ),

          low:
            Math.min(
              low,
              currentPrice
            ),

          close:
            currentPrice,

          volume

        });

      }

    }


    rows =
      rows.slice(-300);


    /* =========================
       CHANGE
    ========================= */

    const change =
      currentPrice -
      previousClose;


    const changePercent =
      previousClose > 0
        ? (
            change /
            previousClose
          ) * 100
        : 0;


    /* =========================
       FUNDAMENTAL
    ========================= */

    const fundamental = {

      available:
        Boolean(
          revenue.available ||
          financial.available
        ),


      revenue: {

        available:
          revenue.available,

        latestDate:
          revenue.latestDate,

        year:
          revenue.year,

        month:
          revenue.month,

        latest:
          revenue.latest,

        previousMonth:
          revenue.previousMonth,

        lastYearSameMonth:
          revenue.lastYearSameMonth,

        mom:
          revenue.mom,

        yoy:
          revenue.yoy,

        recent:
          revenue.recent

      },


      financial: {

        available:
          financial.available,

        latestDate:
          financial.latestDate,

        eps:
          financial.eps,

        previousEPS:
          financial.previousEPS,

        epsGrowth:
          financial.epsGrowth,

        incomeAfterTaxes:
          financial.incomeAfterTaxes,

        previousIncomeAfterTaxes:
          financial.previousIncomeAfterTaxes,

        netIncomeGrowth:
          financial.netIncomeGrowth,

        grossProfit:
          financial.grossProfit,

        operatingIncome:
          financial.operatingIncome,

        profitable:
          financial.profitable,

        recent:
          financial.recent

      }

    };


    /* =========================
       ERRORS
    ========================= */

    const errors = {

      realtime:
        resultError(
          realtimeR
        ),

      institutional:
        resultError(
          institutionalR
        ),

      info:
        resultError(
          infoR
        ),

      revenue:
        resultError(
          revenueR
        ),

      financial:
        resultError(
          financialR
        )

    };


    /* =========================
       RESPONSE
    ========================= */

    return res
      .status(200)
      .json({

        ok: true,

        source:
          "FinMind + Upstash Redis",

        engine:
          "Stock Analysis 6.3 Redis Cache",

        symbol,

        name,

        market,

        realtime:
          Boolean(
            realtime
          ),

        degraded:
          Object
            .values(errors)
            .some(Boolean),

        price:
          round(
            currentPrice
          ),

        previousClose:
          round(
            previousClose
          ),

        change:
          round(
            change
          ),

        changePercent:
          round(
            changePercent
          ),

        open:
          round(open),

        high:
          round(high),

        low:
          round(low),

        volume,

        quoteDate:
          today,

        updatedAt:
          new Date()
            .toLocaleString(
              "zh-TW",
              {
                timeZone:
                  "Asia/Taipei",

                hour12:
                  false
              }
            ),

        errors,

        realtimeError:
          errors.realtime,

        institutionalError:
          errors.institutional,

        revenueError:
          errors.revenue,

        financialError:
          errors.financial,

        institutional,

        fundamental,

        revenue,

        financial,

        rows

      });


  } catch (error) {

    console.error(
      "stock api error:",
      error
    );


    return res
      .status(500)
      .json({

        ok: false,

        source:
          "FinMind + Upstash Redis",

        engine:
          "Stock Analysis 6.3 Redis Cache",

        error:
          error?.message ||
          "股票資料取得失敗"

      });

  }

};


/* =========================
   SMART CACHE
========================= */

async function smartCached(
  key,
  ttl,
  loader
) {

  const now =
    Date.now();


  /* =========================
     1. MEMORY
  ========================= */

  const memory =
    CACHE.get(key);


  if (
    memory &&
    memory.freshUntil > now
  ) {
    return memory.value;
  }


  /* =========================
     2. REDIS
  ========================= */

  let redisEntry =
    null;


  try {

    redisEntry =
      await redisGet(
        key
      );

  } catch (error) {

    console.error(
      "Redis GET error:",
      key,
      error?.message
    );

  }


  /*
    Redis fresh
  */

  if (
    redisEntry &&
    redisEntry.value !== undefined &&
    redisEntry.value !== null
  ) {

    const savedAt =
      Number(
        redisEntry.savedAt
      ) || 0;


    if (
      savedAt > 0 &&
      now - savedAt <
        ttl.fresh
    ) {

      CACHE.set(
        key,
        {
          value:
            redisEntry.value,

          freshUntil:
            savedAt +
            ttl.fresh
        }
      );


      return redisEntry.value;

    }

  }


  /* =========================
     3. FINMIND
  ========================= */

  try {

    const value =
      await loader();


    CACHE.set(
      key,
      {
        value,

        freshUntil:
          now +
          ttl.fresh
      }
    );


    /*
      Redis 寫入失敗不能影響股票分析
    */

    try {

      await redisSet(
        key,
        {
          savedAt:
            Date.now(),

          value
        },
        ttl.stale
      );

    } catch (error) {

      console.error(
        "Redis SET error:",
        key,
        error?.message
      );

    }


    return value;


  } catch (error) {


    /* =========================
       4. STALE REDIS FALLBACK
    ========================= */

    if (
      redisEntry &&
      redisEntry.value !== undefined &&
      redisEntry.value !== null
    ) {

      console.warn(
        "FinMind failed, use stale Redis:",
        key,
        error?.message
      );


      CACHE.set(
        key,
        {
          value:
            redisEntry.value,

          /*
            發生 402 時，
            暫時 5 分鐘不要一直重試 FinMind
          */

          freshUntil:
            Date.now() +
            5 * 60 * 1000
        }
      );


      return redisEntry.value;

    }


    /* =========================
       5. STALE MEMORY FALLBACK
    ========================= */

    if (
      memory &&
      memory.value !== undefined
    ) {

      console.warn(
        "FinMind failed, use stale memory:",
        key,
        error?.message
      );


      CACHE.set(
        key,
        {
          value:
            memory.value,

          freshUntil:
            Date.now() +
            5 * 60 * 1000
        }
      );


      return memory.value;

    }


    throw error;

  }

}


/* =========================
   REDIS
========================= */

function redisConfig() {

  const url =
    process.env
      .UPSTASH_REDIS_REST_URL ||
    process.env
      .KV_REST_API_URL ||
    "";


  const token =
    process.env
      .UPSTASH_REDIS_REST_TOKEN ||
    process.env
      .KV_REST_API_TOKEN ||
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


async function redisGet(
  key
) {

  const config =
    redisConfig();


  if (!config) {
    return null;
  }


  const result =
    await redisCommand(
      [
        "GET",
        redisKey(key)
      ]
    );


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


  try {
    return JSON.parse(
      result
    );
  } catch {
    return null;
  }

}


async function redisSet(
  key,
  value,
  seconds
) {

  const config =
    redisConfig();


  if (!config) {
    return false;
  }


  const ttl =
    Math.max(
      60,
      Math.floor(
        Number(seconds) ||
        3600
      )
    );


  await redisCommand(
    [
      "SET",
      redisKey(key),
      JSON.stringify(value),
      "EX",
      String(ttl)
    ]
  );


  return true;

}


async function redisCommand(
  command
) {

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
      `Redis HTTP ${response.status}: ${text.slice(0, 200)}`
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


  if (
    json &&
    json.error
  ) {

    throw new Error(
      String(
        json.error
      )
    );

  }


  return json
    ? json.result
    : null;

}


function redisKey(
  key
) {

  return (
    "stock:v63:" +
    key
  );

}


/* =========================
   PRICE
========================= */

async function getPrice(
  symbol,
  start,
  end,
  token
) {

  const json =
    await finmind(
      "TaiwanStockPrice",
      symbol,
      start,
      end,
      token
    );


  const rows =
    (json.data || [])

      .map(
        x => ({

          date:
            normalizeDate(
              x.date
            ),

          open:
            positive(
              x.open
            ),

          high:
            positive(
              x.max,
              x.high
            ),

          low:
            positive(
              x.min,
              x.low
            ),

          close:
            positive(
              x.close
            ),

          volume:
            nonNegative(
              x.Trading_Volume,
              x.volume
            )

        })
      )

      .filter(
        x =>
          x.date &&
          x.open > 0 &&
          x.high > 0 &&
          x.low > 0 &&
          x.close > 0
      )

      .sort(
        (a, b) =>
          a.date.localeCompare(
            b.date
          )
      );


  const map =
    new Map();


  for (
    const row of rows
  ) {
    map.set(
      row.date,
      row
    );
  }


  return [
    ...map.values()
  ];

}


/* =========================
   REALTIME
========================= */

async function getRealtime(
  symbol,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot" +
    "?data_id=" +
    encodeURIComponent(
      symbol
    );


  const json =
    await requestJSON(
      url,
      token
    );


  check(
    json,
    "即時報價"
  );


  let data =
    json.data;


  if (
    Array.isArray(data)
  ) {

    data =
      data.find(
        x =>
          String(
            x.stock_id ||
            x.code ||
            x.symbol ||
            ""
          ) === symbol
      ) ||
      data[0];

  }


  if (
    !data ||
    typeof data !== "object"
  ) {

    throw new Error(
      "即時報價沒有資料"
    );

  }


  return {

    price:
      positive(
        data.price,
        data.close,
        data.last_price,
        data.lastPrice
      ),

    open:
      positive(
        data.open,
        data.open_price,
        data.openPrice
      ),

    high:
      positive(
        data.high,
        data.max,
        data.high_price,
        data.highPrice
      ),

    low:
      positive(
        data.low,
        data.min,
        data.low_price,
        data.lowPrice
      ),

    volume:
      nonNegative(
        data.total_volume,
        data.totalVolume,
        data.volume,
        data.Trading_Volume
      ),

    previousClose:
      positive(
        data.previous_close,
        data.previousClose,
        data.reference_price,
        data.referencePrice
      )

  };

}


/* =========================
   STOCK INFO
========================= */

async function getStockInfo(
  token
) {

  const json =
    await finmind(
      "TaiwanStockInfo",
      "",
      "",
      "",
      token
    );


  return Array.isArray(
    json.data
  )
    ? json.data
    : [];

}


/* =========================
   INSTITUTIONAL
========================= */

async function getInstitutional(
  symbol,
  start,
  end,
  token
) {

  const json =
    await finmind(
      "TaiwanStockInstitutionalInvestorsBuySell",
      symbol,
      start,
      end,
      token
    );


  const daily =
    {};


  for (
    const x of
    json.data || []
  ) {

    const d =
      normalizeDate(
        x.date
      );


    if (!d) {
      continue;
    }


    if (!daily[d]) {

      daily[d] = {

        date:
          d,

        foreign:
          0,

        trust:
          0,

        dealer:
          0,

        total:
          0

      };

    }


    const net =
      nonNegative(
        x.buy
      ) -
      nonNegative(
        x.sell
      );


    const n =
      String(
        x.name || ""
      )
        .toLowerCase();


    if (
      n.includes(
        "foreign"
      ) ||
      n.includes(
        "外資"
      )
    ) {

      daily[d].foreign +=
        net;

    } else if (
      n.includes(
        "investment_trust"
      ) ||
      n.includes(
        "investment trust"
      ) ||
      n.includes(
        "投信"
      )
    ) {

      daily[d].trust +=
        net;

    } else if (
      n.includes(
        "dealer"
      ) ||
      n.includes(
        "自營"
      )
    ) {

      daily[d].dealer +=
        net;

    }


    daily[d].total +=
      net;

  }


  const dates =
    Object
      .keys(daily)
      .sort();


  if (
    !dates.length
  ) {
    return emptyInstitutional();
  }


  const latest =
    daily[
      dates[
        dates.length - 1
      ]
    ];


  const r3 =
    recent(
      daily,
      dates,
      3
    );

  const r5 =
    recent(
      daily,
      dates,
      5
    );

  const r10 =
    recent(
      daily,
      dates,
      10
    );

  const r20 =
    recent(
      daily,
      dates,
      20
    );


  return {

    available:
      true,

    latestDate:
      latest.date,

    foreignLatest:
      latest.foreign,

    trustLatest:
      latest.trust,

    dealerLatest:
      latest.dealer,

    totalLatest:
      latest.total,

    foreign3:
      sum(
        r3,
        "foreign"
      ),

    trust3:
      sum(
        r3,
        "trust"
      ),

    dealer3:
      sum(
        r3,
        "dealer"
      ),

    total3:
      sum(
        r3,
        "total"
      ),

    foreign5:
      sum(
        r5,
        "foreign"
      ),

    trust5:
      sum(
        r5,
        "trust"
      ),

    dealer5:
      sum(
        r5,
        "dealer"
      ),

    total5:
      sum(
        r5,
        "total"
      ),

    foreign10:
      sum(
        r10,
        "foreign"
      ),

    trust10:
      sum(
        r10,
        "trust"
      ),

    dealer10:
      sum(
        r10,
        "dealer"
      ),

    total10:
      sum(
        r10,
        "total"
      ),

    foreign20:
      sum(
        r20,
        "foreign"
      ),

    trust20:
      sum(
        r20,
        "trust"
      ),

    dealer20:
      sum(
        r20,
        "dealer"
      ),

    total20:
      sum(
        r20,
        "total"
      ),

    foreignBuyDays5:
      r5.filter(
        x =>
          x.foreign > 0
      ).length,

    trustBuyDays5:
      r5.filter(
        x =>
          x.trust > 0
      ).length,

    totalBuyDays5:
      r5.filter(
        x =>
          x.total > 0
      ).length,

    recent:
      r20

  };

}


/* =========================
   REVENUE
========================= */

async function getRevenue(
  symbol,
  start,
  end,
  token
) {

  const json =
    await finmind(
      "TaiwanStockMonthRevenue",
      symbol,
      start,
      end,
      token
    );


  const rows =
    (json.data || [])

      .map(
        x => ({

          date:
            normalizeDate(
              x.date
            ),

          year:
            Number(
              x.revenue_year
            ) || 0,

          month:
            Number(
              x.revenue_month
            ) || 0,

          revenue:
            Number(
              x.revenue
            ) || 0

        })
      )

      .filter(
        x =>
          x.year > 0 &&
          x.month >= 1 &&
          x.month <= 12
      )

      .sort(
        (a, b) =>
          a.year === b.year
            ? a.month -
              b.month
            : a.year -
              b.year
      );


  if (
    !rows.length
  ) {
    return emptyRevenue();
  }


  const map =
    new Map();


  for (
    const x of rows
  ) {

    map.set(
      `${x.year}-${x.month}`,
      x
    );

  }


  const clean =
    [
      ...map.values()
    ].sort(
      (a, b) =>
        a.year === b.year
          ? a.month -
            b.month
          : a.year -
            b.year
    );


  const latest =
    clean[
      clean.length - 1
    ];


  const prev =
    clean.length > 1
      ? clean[
          clean.length - 2
        ]
      : null;


  const lastYear =
    clean.find(
      x =>
        x.year ===
          latest.year - 1 &&
        x.month ===
          latest.month
    ) ||
    null;


  return {

    available:
      true,

    latestDate:
      latest.date,

    year:
      latest.year,

    month:
      latest.month,

    latest:
      latest.revenue,

    previousMonth:
      prev?.revenue ??
      null,

    lastYearSameMonth:
      lastYear?.revenue ??
      null,

    mom:
      prev &&
      prev.revenue > 0

        ? round(
            (
              (
                latest.revenue -
                prev.revenue
              ) /
              prev.revenue
            ) * 100
          )

        : null,

    yoy:
      lastYear &&
      lastYear.revenue > 0

        ? round(
            (
              (
                latest.revenue -
                lastYear.revenue
              ) /
              lastYear.revenue
            ) * 100
          )

        : null,

    recent:
      clean.slice(-13)

  };

}


/* =========================
   FINANCIAL
========================= */

async function getFinancial(
  symbol,
  start,
  end,
  token
) {

  const json =
    await finmind(
      "TaiwanStockFinancialStatements",
      symbol,
      start,
      end,
      token
    );


  const quarters =
    {};


  for (
    const x of
    json.data || []
  ) {

    const d =
      normalizeDate(
        x.date
      );


    if (!d) {
      continue;
    }


    if (!quarters[d]) {

      quarters[d] = {

        date:
          d,

        eps:
          null,

        incomeAfterTaxes:
          null,

        grossProfit:
          null,

        operatingIncome:
          null

      };

    }


    const type =
      String(
        x.type || ""
      );


    const origin =
      String(
        x.origin_name || ""
      );


    const value =
      finite(
        x.value
      );


    if (
      value === null
    ) {
      continue;
    }


    if (
      type === "EPS" ||
      origin.includes(
        "每股盈餘"
      )
    ) {

      quarters[d].eps =
        value;

    } else if (
      type ===
        "IncomeAfterTaxes" ||
      origin.includes(
        "本期淨利"
      ) ||
      origin.includes(
        "本期淨損"
      )
    ) {

      quarters[d]
        .incomeAfterTaxes =
        value;

    } else if (
      type ===
        "GrossProfit" ||
      origin.includes(
        "營業毛利"
      )
    ) {

      quarters[d]
        .grossProfit =
        value;

    } else if (
      type ===
        "OperatingIncome" ||
      type ===
        "OperatingIncomeLoss" ||
      origin.includes(
        "營業利益"
      ) ||
      origin.includes(
        "營業損失"
      )
    ) {

      quarters[d]
        .operatingIncome =
        value;

    }

  }


  const clean =
    Object
      .values(
        quarters
      )

      .filter(
        x =>
          x.eps !== null ||
          x.incomeAfterTaxes !==
            null ||
          x.grossProfit !==
            null ||
          x.operatingIncome !==
            null
      )

      .sort(
        (a, b) =>
          a.date.localeCompare(
            b.date
          )
      );


  if (
    !clean.length
  ) {
    return emptyFinancial();
  }


  const latest =
    clean[
      clean.length - 1
    ];


  const epsRows =
    clean.filter(
      x =>
        x.eps !== null
    );


  const incomeRows =
    clean.filter(
      x =>
        x.incomeAfterTaxes !==
        null
    );


  const eps =
    epsRows.length
      ? epsRows[
          epsRows.length - 1
        ].eps
      : null;


  const previousEPS =
    epsRows.length > 1
      ? epsRows[
          epsRows.length - 2
        ].eps
      : null;


  const income =
    incomeRows.length
      ? incomeRows[
          incomeRows.length - 1
        ].incomeAfterTaxes
      : null;


  const previousIncome =
    incomeRows.length > 1
      ? incomeRows[
          incomeRows.length - 2
        ].incomeAfterTaxes
      : null;


  let profitable =
    null;


  if (
    income !== null
  ) {

    profitable =
      income > 0;

  } else if (
    eps !== null
  ) {

    profitable =
      eps > 0;

  }


  return {

    available:
      true,

    latestDate:
      latest.date,

    eps:
      nullableRound(
        eps
      ),

    previousEPS:
      nullableRound(
        previousEPS
      ),

    epsGrowth:
      eps !== null &&
      previousEPS !== null &&
      previousEPS > 0

        ? round(
            (
              (
                eps -
                previousEPS
              ) /
              Math.abs(
                previousEPS
              )
            ) * 100
          )

        : null,

    incomeAfterTaxes:
      income,

    previousIncomeAfterTaxes:
      previousIncome,

    netIncomeGrowth:
      income !== null &&
      previousIncome !== null &&
      previousIncome > 0

        ? round(
            (
              (
                income -
                previousIncome
              ) /
              Math.abs(
                previousIncome
              )
            ) * 100
          )

        : null,

    grossProfit:
      latest.grossProfit,

    operatingIncome:
      latest.operatingIncome,

    profitable,

    recent:
      clean.slice(-8)

  };

}


/* =========================
   FINMIND
========================= */

async function finmind(
  dataset,
  symbol,
  start,
  end,
  token
) {

  let url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=" +
    encodeURIComponent(
      dataset
    );


  if (symbol) {

    url +=
      "&data_id=" +
      encodeURIComponent(
        symbol
      );

  }


  if (start) {

    url +=
      "&start_date=" +
      encodeURIComponent(
        start
      );

  }


  if (end) {

    url +=
      "&end_date=" +
      encodeURIComponent(
        end
      );

  }


  const json =
    await requestJSON(
      url,
      token
    );


  check(
    json,
    dataset
  );


  return json;

}


function check(
  json,
  label
) {

  if (
    !json ||
    typeof json !== "object"
  ) {

    throw new Error(
      `${label} API 格式錯誤`
    );

  }


  if (
    json.status !== undefined &&
    Number(
      json.status
    ) !== 200
  ) {

    throw new Error(
      json.msg ||
      json.message ||
      `${label}取得失敗`
    );

  }

}


/* =========================
   HTTPS
========================= */

function requestJSON(
  url,
  token
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      let done =
        false;


      const request =
        https.get(

          url,

          {

            headers: {

              Authorization:
                `Bearer ${token}`,

              Accept:
                "application/json",

              "User-Agent":
                "stock-analyzer/6.3"

            },

            timeout:
              15000

          },

          response => {

            let body =
              "";


            response.setEncoding(
              "utf8"
            );


            response.on(
              "data",
              chunk => {

                if (
                  body.length <
                  15 *
                  1024 *
                  1024
                ) {

                  body +=
                    chunk;

                }

              }
            );


            response.on(
              "end",
              () => {

                if (done) {
                  return;
                }


                done =
                  true;


                if (
                  response.statusCode <
                    200 ||
                  response.statusCode >=
                    300
                ) {

                  return reject(
                    new Error(
                      response.statusCode ===
                      402

                        ? "FinMind API 額度已達上限（HTTP 402）"

                        : `FinMind HTTP ${response.statusCode}`
                    )
                  );

                }


                try {

                  resolve(
                    JSON.parse(
                      body
                    )
                  );

                } catch {

                  reject(
                    new Error(
                      "FinMind JSON 解析失敗"
                    )
                  );

                }

              }
            );

          }

        );


      request.on(
        "timeout",
        () => {

          if (done) {
            return;
          }


          done =
            true;


          request.destroy();


          reject(
            new Error(
              "FinMind 連線逾時"
            )
          );

        }
      );


      request.on(
        "error",
        error => {

          if (done) {
            return;
          }


          done =
            true;


          reject(
            error
          );

        }
      );

    }
  );

}


/* =========================
   EMPTY
========================= */

function emptyInstitutional() {

  return {

    available:
      false,

    latestDate:
      "",

    foreignLatest:
      0,

    trustLatest:
      0,

    dealerLatest:
      0,

    totalLatest:
      0,

    foreign3:
      0,

    trust3:
      0,

    dealer3:
      0,

    total3:
      0,

    foreign5:
      0,

    trust5:
      0,

    dealer5:
      0,

    total5:
      0,

    foreign10:
      0,

    trust10:
      0,

    dealer10:
      0,

    total10:
      0,

    foreign20:
      0,

    trust20:
      0,

    dealer20:
      0,

    total20:
      0,

    foreignBuyDays5:
      0,

    trustBuyDays5:
      0,

    totalBuyDays5:
      0,

    recent:
      []

  };

}


function emptyRevenue() {

  return {

    available:
      false,

    latestDate:
      "",

    year:
      0,

    month:
      0,

    latest:
      null,

    previousMonth:
      null,

    lastYearSameMonth:
      null,

    mom:
      null,

    yoy:
      null,

    recent:
      []

  };

}


function emptyFinancial() {

  return {

    available:
      false,

    latestDate:
      "",

    eps:
      null,

    previousEPS:
      null,

    epsGrowth:
      null,

    incomeAfterTaxes:
      null,

    previousIncomeAfterTaxes:
      null,

    netIncomeGrowth:
      null,

    grossProfit:
      null,

    operatingIncome:
      null,

    profitable:
      null,

    recent:
      []

  };

}


/* =========================
   HELPERS
========================= */

function recent(
  daily,
  dates,
  n
) {

  return dates
    .slice(-n)
    .map(
      d =>
        daily[d]
    );

}


function sum(
  rows,
  key
) {

  return rows.reduce(
    (
      total,
      x
    ) =>
      total +
      (
        Number(
          x[key]
        ) || 0
      ),
    0
  );

}


function resultError(
  result
) {

  return result.status ===
    "rejected"

    ? result.reason?.message ||
      "資料暫時無法取得"

    : "";

}


function marketName(
  value
) {

  const x =
    String(
      value || ""
    )
      .toLowerCase();


  if (
    x.includes(
      "twse"
    ) ||
    x.includes(
      "上市"
    )
  ) {
    return "上市";
  }


  if (
    x.includes(
      "tpex"
    ) ||
    x.includes(
      "otc"
    ) ||
    x.includes(
      "上櫃"
    )
  ) {
    return "上櫃";
  }


  if (
    x.includes(
      "emerging"
    ) ||
    x.includes(
      "興櫃"
    )
  ) {
    return "興櫃";
  }


  return value || "";

}


function date(
  d
) {

  return (
    d.getFullYear() +
    "-" +
    String(
      d.getMonth() + 1
    ).padStart(
      2,
      "0"
    ) +
    "-" +
    String(
      d.getDate()
    ).padStart(
      2,
      "0"
    )
  );

}


function normalizeDate(
  value
) {

  const m =
    String(
      value || ""
    )
      .match(
        /^(\d{4}-\d{2}-\d{2})/
      );


  return m
    ? m[1]
    : "";

}


function finite(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }


  const n =
    Number(
      value
    );


  return Number.isFinite(
    n
  )
    ? n
    : null;

}


function positive(
  ...values
) {

  for (
    const value of values
  ) {

    const n =
      finite(
        value
      );


    if (
      n !== null &&
      n > 0
    ) {
      return n;
    }

  }


  return 0;

}


function nonNegative(
  ...values
) {

  for (
    const value of values
  ) {

    const n =
      finite(
        value
      );


    if (
      n !== null &&
      n >= 0
    ) {
      return n;
    }

  }


  return 0;

}


function round(
  value
) {

  const n =
    Number(
      value
    );


  return Number.isFinite(
    n
  )
    ? Math.round(
        n * 100
      ) / 100
    : 0;

}


function nullableRound(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }


  const n =
    Number(
      value
    );


  return Number.isFinite(
    n
  )
    ? Math.round(
        n * 100
      ) / 100
    : null;

}
