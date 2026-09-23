// api/radar.js
// 妖子平台 2.2
// FinMind Sponsor 台股即時異動雷達
// 自動取得完整台股中文名稱

const SNAPSHOT_URL =
  "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot";

const DATA_URL =
  "https://api.finmindtrade.com/api/v4/data";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, d = 2) {
  const p = 10 ** d;
  return Math.round((num(v) + Number.EPSILON) * p) / p;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function getTaipeiTime() {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function isNormalTaiwanStock(id) {
  return /^\d{4}$/.test(String(id || ""));
}


// ===============================
// 取得全部台股中文名稱
// ===============================

async function fetchTaiwanStockNames(token) {
  try {
    const url =
      `${DATA_URL}?dataset=TaiwanStockInfo`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });

    const body = await response.json();

    if (
      !response.ok ||
      !Array.isArray(body?.data)
    ) {
      console.error(
        "TaiwanStockInfo error:",
        body
      );

      return {};
    }

    const names = {};

    for (const stock of body.data) {
      if (
        stock?.stock_id &&
        stock?.stock_name
      ) {
        names[String(stock.stock_id)] =
          String(stock.stock_name);
      }
    }

    return names;

  } catch (error) {
    console.error(
      "TaiwanStockInfo fetch error:",
      error
    );

    return {};
  }
}


// ===============================
// 即時異動評分
// ===============================

function scoreStock(x) {
  const price = num(x.close);
  const open = num(x.open);
  const high = num(x.high);
  const low = num(x.low);

  const changeRate =
    num(x.change_rate);

  const volumeRatio =
    num(x.volume_ratio);

  const totalVolume =
    num(x.total_volume);

  const yesterdayVolume =
    num(x.yesterday_volume);

  const buyPrice =
    num(x.buy_price);

  const sellPrice =
    num(x.sell_price);

  const buyVolume =
    num(x.buy_volume);

  const sellVolume =
    num(x.sell_volume);

  if (price <= 0) {
    return null;
  }

  let score = 0;

  const reasons = [];
  const warnings = [];


  // ===============================
  // 漲幅
  // ===============================

  if (
    changeRate >= 1 &&
    changeRate <= 3
  ) {
    score += 12;
    reasons.push("價格開始轉強");

  } else if (
    changeRate > 3 &&
    changeRate <= 5
  ) {
    score += 18;
    reasons.push("漲幅明顯加速");

  } else if (
    changeRate > 5 &&
    changeRate <= 7
  ) {
    score += 12;
    reasons.push("強勢上漲");

  } else if (
    changeRate > 7
  ) {
    score += 3;
    warnings.push(
      "今日漲幅偏大，避免追價"
    );

  } else if (
    changeRate < -2
  ) {
    score -= 15;
    warnings.push(
      "目前價格偏弱"
    );
  }


  // ===============================
  // 即時量比
  // ===============================

  if (volumeRatio >= 3) {

    score += 30;

    reasons.push(
      `爆量 ${round(volumeRatio, 1)}x`
    );

  } else if (volumeRatio >= 2) {

    score += 25;

    reasons.push(
      `明顯放量 ${round(volumeRatio, 1)}x`
    );

  } else if (volumeRatio >= 1.5) {

    score += 20;

    reasons.push(
      `成交量放大 ${round(volumeRatio, 1)}x`
    );

  } else if (volumeRatio >= 1.2) {

    score += 10;

    reasons.push(
      `量能增加 ${round(volumeRatio, 1)}x`
    );
  }


  // ===============================
  // 今日價格位置
  // ===============================

  const range =
    high - low;

  const position =
    range > 0
      ? clamp(
          (price - low) / range,
          0,
          1
        )
      : 0.5;

  if (position >= 0.9) {

    score += 20;

    reasons.push(
      "價格貼近今日高點"
    );

  } else if (position >= 0.75) {

    score += 14;

    reasons.push(
      "價格位於今日高檔"
    );

  } else if (
    position <= 0.25 &&
    changeRate < 0
  ) {

    score -= 8;
  }


  // ===============================
  // 開盤價
  // ===============================

  if (
    open > 0 &&
    price > open
  ) {

    score += 8;

    reasons.push(
      "目前站上開盤價"
    );
  }


  // ===============================
  // 買賣盤強度
  // ===============================

  const orderTotal =
    buyVolume + sellVolume;

  if (orderTotal > 0) {

    const buyStrength =
      buyVolume / orderTotal;

    if (buyStrength >= 0.65) {

      score += 12;

      reasons.push(
        "買盤相對積極"
      );

    } else if (
      buyStrength <= 0.35
    ) {

      score -= 6;

      warnings.push(
        "賣盤壓力較高"
      );
    }
  }


  // ===============================
  // 最新買價
  // ===============================

  if (
    buyPrice > 0 &&
    price > 0
  ) {

    const buyDistance =
      Math.abs(
        price - buyPrice
      ) / price;

    if (
      buyDistance <= 0.002
    ) {
      score += 5;
    }
  }


  // ===============================
  // 流動性
  // ===============================

  if (totalVolume > 0) {

    if (
      totalVolume >= 5000
    ) {

      score += 5;

    } else if (
      totalVolume < 300
    ) {

      score -= 12;

      warnings.push(
        "成交量偏低"
      );
    }
  }


  score =
    clamp(
      Math.round(score),
      0,
      100
    );


  // ===============================
  // 異動等級
  // ===============================

  let level = "一般";
  let emoji = "🟢";

  if (score >= 75) {

    level = "強異動";
    emoji = "🔥";

  } else if (
    score >= 55
  ) {

    level = "異動";
    emoji = "🟠";

  } else if (
    score >= 38
  ) {

    level = "蓄勢";
    emoji = "🟡";
  }


  // ===============================
  // 做多觀察
  // ===============================

  let longStatus =
    "暫不列入";

  let longEmoji =
    "⚪";

  const strongVolume =
    volumeRatio >= 1.5;

  const positivePrice =
    changeRate >= 1 &&
    changeRate <= 6.5 &&
    price >= open;

  const nearHigh =
    position >= 0.75;


  if (
    score >= 70 &&
    strongVolume &&
    positivePrice &&
    nearHigh
  ) {

    longStatus =
      "優先觀察";

    longEmoji =
      "🚀";

  } else if (
    score >= 50 &&
    volumeRatio >= 1.2 &&
    changeRate > 0 &&
    nearHigh
  ) {

    longStatus =
      "等待確認";

    longEmoji =
      "👀";
  }


  if (
    changeRate > 7
  ) {

    longStatus =
      "漲幅偏大不追";

    longEmoji =
      "⚠️";
  }


  // ===============================
  // 盤中觀察區
  // ===============================

  const intradayRange =
    range > 0
      ? range
      : price * 0.015;

  const observationLow =
    Math.max(
      low,
      price -
        intradayRange * 0.25
    );

  const observationHigh =
    price;

  const invalidation =
    Math.max(
      0,
      price -
        intradayRange * 0.75
    );

  const risk =
    Math.max(
      price - invalidation,
      price * 0.005
    );

  const target1 =
    price + risk * 1.5;

  const target2 =
    price + risk * 2.5;

  const target3 =
    price + risk * 4;


  return {

    symbol:
      String(x.stock_id),

    name: "",

    emoji,
    level,
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

    changePrice:
      round(x.change_price),

    averagePrice:
      round(x.average_price),

    volume:
      num(x.volume),

    totalVolume,

    yesterdayVolume,

    volumeRatio:
      round(
        volumeRatio,
        2
      ),

    buyPrice:
      round(buyPrice),

    sellPrice:
      round(sellPrice),

    buyVolume,

    sellVolume,

    dayPosition:
      round(
        position * 100,
        1
      ),

    longStatus,

    longEmoji,

    observationLow:
      round(
        observationLow
      ),

    observationHigh:
      round(
        observationHigh
      ),

    invalidation:
      round(
        invalidation
      ),

    target1:
      round(target1),

    target2:
      round(target2),

    target3:
      round(target3),

    reasons:
      reasons.slice(0, 5),

    warnings:
      warnings.slice(0, 3),

    date:
      x.date || null,

    tickType:
      x.TickType ??
      x.tick_type ??
      null
  };
}


// ===============================
// API
// ===============================

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
      process.env.FINMIND_TOKEN;


    if (!token) {

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Vercel 尚未設定 FINMIND_TOKEN"
        });
    }


    // ===============================
    // 同時取得即時行情＋股票名稱
    // ===============================

    const [
      snapshotResponse,
      stockNames
    ] =
      await Promise.all([

        fetch(
          SNAPSHOT_URL,
          {
            headers: {
              Authorization:
                `Bearer ${token}`,

              Accept:
                "application/json"
            }
          }
        ),

        fetchTaiwanStockNames(
          token
        )

      ]);


    let body;

    try {

      body =
        await snapshotResponse.json();

    } catch {

      return res
        .status(502)
        .json({
          ok: false,
          error:
            "FinMind 即時行情回傳格式異常"
        });
    }


    if (
      !snapshotResponse.ok ||
      body?.status !== 200
    ) {

      console.error(
        "FinMind snapshot error:",
        body
      );

      return res
        .status(
          snapshotResponse.status ||
          502
        )
        .json({
          ok: false,

          error:
            body?.msg ||
            `FinMind API 錯誤 (${snapshotResponse.status})`
        });
    }


    const snapshots =
      Array.isArray(body.data)
        ? body.data
        : [];


    // ===============================
    // 評分＋自動加入中文名稱
    // ===============================

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

        .map(stock => ({
          ...stock,

          name:
            stockNames[
              stock.symbol
            ] || ""
        }))

        .filter(
          x =>
            x.price > 0
        );


    // ===============================
    // 異動雷達
    // ===============================

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
      radar.length > 0

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


    // ===============================
    // 今日做多觀察
    // ===============================

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
          (a, b) => {

            if (
              a.longStatus ===
                "優先觀察" &&

              b.longStatus !==
                "優先觀察"
            ) {
              return -1;
            }

            if (
              b.longStatus ===
                "優先觀察" &&

              a.longStatus !==
                "優先觀察"
            ) {
              return 1;
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


    // ===============================
    // 爆量排行
    // ===============================

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
          10
        );


    // ===============================
    // 漲幅排行
    // ===============================

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
          10
        );


    // ===============================
    // Cache
    // ===============================

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=30, stale-while-revalidate=30"
    );


    // ===============================
    // 回傳
    // ===============================

    return res
      .status(200)
      .json({

        ok: true,

        platform:
          "妖子平台2.2",

        mode:
          "FinMind Sponsor 即時盤中版",

        market:
          "TW",

        source:
          "FinMind",

        sourceType:
          "taiwan_stock_tick_snapshot",

        updatedAt:
          new Date().toISOString(),

        taipeiTime:
          getTaipeiTime(),

        scanned:
          stocks.length,

        found:
          finalRadar.length,

        longWatchCount:
          longWatch.length,

        radar:
          finalRadar,

        longWatch,

        volumeLeaders,

        momentumLeaders,

        notice:
          "規則式即時行情篩選，異動分數代表技術條件符合程度，不代表未來上漲機率。"
      });


  } catch (error) {

    console.error(
      "Radar server error:",
      error
    );

    return res
      .status(500)
      .json({

        ok: false,

        error:
          error?.message ||
          "Radar server error"
      });
  }
}
