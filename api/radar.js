/*
  妖子平台 2.1
  台股異動雷達

  功能：
  1. 自動掃描觀察池
  2. 計算 MA20 / MA60 / RSI / MACD
  3. 成交量異動
  4. 接近 / 突破 20 日高點
  5. 波動壓縮
  6. 產生異動等級與原因

  注意：
  目前使用 FinMind 日行情。
  所以這是「每日異動雷達」，
  不是交易所逐筆即時掃描。
*/


/* =========================
   預設股票池
========================= */

const WATCHLIST = [

  "2330", // 台積電
  "2303", // 聯電
  "2454", // 聯發科
  "2317", // 鴻海
  "2382", // 廣達
  "3231", // 緯創
  "6669", // 緯穎
  "3017", // 奇鋐
  "3324", // 雙鴻
  "2345", // 智邦

  "3661", // 世芯-KY
  "3443", // 創意
  "3035", // 智原
  "2376", // 技嘉
  "2377", // 微星
  "2357", // 華碩
  "2356", // 英業達

  "2603", // 長榮
  "2609", // 陽明
  "2615", // 萬海

  "2881", // 富邦金
  "2882", // 國泰金
  "2891", // 中信金

  "1519", // 華城
  "1513", // 中興電
  "1503", // 士電

  "2408", // 南亞科
  "2344", // 華邦電
  "2337", // 旺宏

  "3037", // 欣興
  "8046", // 南電
  "3189", // 景碩

  "2368", // 金像電
  "2383", // 台光電
  "6274", // 台燿

  "3711", // 日月光投控
  "2308", // 台達電
  "2327"  // 國巨

];


/* =========================
   基本計算
========================= */

function average(arr) {

  if (!arr.length) return 0;

  return arr.reduce(
    (a, b) => a + b,
    0
  ) / arr.length;
}


function sma(arr, period) {

  if (arr.length < period)
    return null;

  return average(
    arr.slice(-period)
  );
}


function ema(arr, period) {

  if (!arr.length)
    return null;

  const k =
    2 / (period + 1);

  let value =
    arr[0];

  for (
    let i = 1;
    i < arr.length;
    i++
  ) {

    value =
      arr[i] * k +
      value * (1 - k);
  }

  return value;
}


function RSI(arr, period = 14) {

  if (
    arr.length <
    period + 1
  ) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i =
      arr.length - period;
    i < arr.length;
    i++
  ) {

    const diff =
      arr[i] -
      arr[i - 1];

    if (diff > 0)
      gains += diff;

    else
      losses -= diff;
  }

  if (losses === 0)
    return 100;

  const rs =
    (gains / period) /
    (losses / period);

  return (
    100 -
    100 / (1 + rs)
  );
}


/* =========================
   日期
========================= */

function dateString(date) {

  const y =
    date.getFullYear();

  const m =
    String(
      date.getMonth() + 1
    ).padStart(2, "0");

  const d =
    String(
      date.getDate()
    ).padStart(2, "0");

  return `${y}-${m}-${d}`;
}


/* =========================
   抓單一股票
========================= */

async function fetchStock(
  stockId,
  startDate,
  endDate
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockPrice" +
    `&data_id=${encodeURIComponent(stockId)}` +
    `&start_date=${encodeURIComponent(startDate)}` +
    `&end_date=${encodeURIComponent(endDate)}`;


  const response =
    await fetch(url, {

      headers: {

        "Accept":
          "application/json",

        "User-Agent":
          "YaoZi-Radar-2.1"

      }

    });


  if (!response.ok)
    return null;


  const json =
    await response.json();


  if (
    json?.status &&
    Number(json.status) !== 200
  ) {
    return null;
  }


  const data =
    Array.isArray(json?.data)
      ? json.data
      : [];


  if (data.length < 65)
    return null;


  data.sort(
    (a, b) =>
      String(a.date)
      .localeCompare(
        String(b.date)
      )
  );


  return data.map(x => ({

    date:
      x.date,

    open:
      Number(x.open),

    high:
      Number(x.max),

    low:
      Number(x.min),

    close:
      Number(x.close),

    volume:
      Number(
        x.Trading_Volume
      )

  })).filter(x =>

    Number.isFinite(
      x.close
    ) &&

    Number.isFinite(
      x.high
    ) &&

    Number.isFinite(
      x.low
    )

  );
}


/* =========================
   分析單一股票
========================= */

function analyze(
  stockId,
  rows
) {

  const closes =
    rows.map(
      x => x.close
    );

  const volumes =
    rows.map(
      x => x.volume
    );


  const latest =
    rows.at(-1);

  const previous =
    rows.at(-2);


  const price =
    latest.close;


  const changePercent =
    previous?.close
      ? (
          (
            price /
            previous.close
          ) - 1
        ) * 100
      : 0;


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
    RSI(
      closes,
      14
    );


  const macd =
    ema(
      closes.slice(-80),
      12
    ) -
    ema(
      closes.slice(-80),
      26
    );


  /*
    成交量

    用「前20日平均」
    不把今天算進平均，
    避免稀釋異動。
  */

  const previousVolumes =
    volumes.slice(
      -21,
      -1
    );


  const avgVolume20 =
    average(
      previousVolumes
    );


  const volumeRatio =
    avgVolume20 > 0
      ? latest.volume /
        avgVolume20
      : 0;


  /*
    前20日高點

    不包含今天
  */

  const previous20 =
    rows.slice(
      -21,
      -1
    );


  const high20 =
    Math.max(
      ...previous20.map(
        x => x.high
      )
    );


  const distanceToHigh =
    (
      price /
      high20 -
      1
    ) * 100;


  const breakout =
    price >
    high20;


  const nearBreakout =
    price >=
    high20 * 0.97;


  /*
    最近波動壓縮

    比較最近5日
    與前20日平均日內振幅
  */

  const ranges20 =
    previous20.map(
      x =>
        (
          x.high -
          x.low
        ) /
        x.close
    );


  const avgRange20 =
    average(
      ranges20
    );


  const last5 =
    rows.slice(
      -6,
      -1
    );


  const avgRange5 =
    average(
      last5.map(
        x =>
          (
            x.high -
            x.low
          ) /
          x.close
      )
    );


  const compression =
    avgRange20 > 0
      ? avgRange5 /
        avgRange20
      : 1;


  /*
    評分

    不是預測漲跌機率。
    只是技術異動條件數量。
  */

  let score = 0;

  let reasons = [];

  let warnings = [];


  /*
    趨勢
  */

  if (
    price > ma20
  ) {

    score += 10;

    reasons.push(
      "價格站上 MA20"
    );
  }


  if (
    ma20 > ma60
  ) {

    score += 15;

    reasons.push(
      "MA20 高於 MA60"
    );
  }


  if (
    macd > 0
  ) {

    score += 10;

    reasons.push(
      "MACD 正動能"
    );
  }


  /*
    RSI
  */

  if (
    rsi >= 55 &&
    rsi <= 72
  ) {

    score += 10;

    reasons.push(
      "RSI 位於強勢但未極端區"
    );

  } else if (
    rsi > 78
  ) {

    score -= 10;

    warnings.push(
      "RSI 已偏過熱"
    );
  }


  /*
    量能
  */

  if (
    volumeRatio >= 2
  ) {

    score += 25;

    reasons.push(
      `成交量約為20日均量 ${volumeRatio.toFixed(1)} 倍`
    );

  } else if (
    volumeRatio >= 1.5
  ) {

    score += 18;

    reasons.push(
      `成交量放大至20日均量 ${volumeRatio.toFixed(1)} 倍`
    );

  } else if (
    volumeRatio >= 1.2
  ) {

    score += 8;

    reasons.push(
      "成交量開始增加"
    );
  }


  /*
    突破
  */

  if (
    breakout
  ) {

    score += 25;

    reasons.push(
      "突破前20日高點"
    );

  } else if (
    nearBreakout
  ) {

    score += 12;

    reasons.push(
      "價格接近前20日高點"
    );
  }


  /*
    波動壓縮
  */

  if (
    compression < 0.72 &&
    nearBreakout
  ) {

    score += 10;

    reasons.push(
      "近期波動收斂且接近壓力"
    );
  }


  /*
    當日漲幅

    漲太多反而扣分，
    避免把已經噴完的股票
    當成潛在異動。
  */

  if (
    changePercent >= 1 &&
    changePercent <= 4.5
  ) {

    score += 8;

    reasons.push(
      "價格開始轉強"
    );
  }


  if (
    changePercent > 7
  ) {

    score -= 15;

    warnings.push(
      "當日漲幅已大，注意追價距離"
    );
  }


  /*
    離20日高點太遠
  */

  if (
    distanceToHigh < -8
  ) {

    score -= 10;
  }


  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );


  /*
    異動分類
  */

  let level =
    "一般";

  let emoji =
    "🟢";


  if (
    score >= 75
  ) {

    level =
      "強異動";

    emoji =
      "🔥";

  } else if (
    score >= 55
  ) {

    level =
      "異動";

    emoji =
      "🟠";

  } else if (
    score >= 38
  ) {

    level =
      "蓄勢";

    emoji =
      "🟡";
  }


  return {

    symbol:
      stockId,

    date:
      latest.date,

    price,

    changePercent,

    volumeRatio,

    ma20,

    ma60,

    rsi,

    macd,

    high20,

    distanceToHigh,

    breakout,

    compression,

    score,

    level,

    emoji,

    reasons:
      reasons.slice(
        0,
        6
      ),

    warnings:
      warnings.slice(
        0,
        3
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

    const today =
      new Date();


    const start =
      new Date();


    start.setMonth(
      start.getMonth() - 6
    );


    const startDate =
      dateString(start);


    const endDate =
      dateString(today);


    /*
      分批掃描

      避免同時大量請求
      把資料來源打爆。
    */

    const batchSize = 5;

    let results = [];


    for (
      let i = 0;
      i < WATCHLIST.length;
      i += batchSize
    ) {

      const batch =
        WATCHLIST.slice(
          i,
          i + batchSize
        );


      const responses =
        await Promise.all(

          batch.map(
            async stockId => {

              try {

                const rows =
                  await fetchStock(
                    stockId,
                    startDate,
                    endDate
                  );


                if (!rows)
                  return null;


                return analyze(
                  stockId,
                  rows
                );

              } catch {

                return null;

              }

            }
          )

        );


      results.push(
        ...responses.filter(Boolean)
      );
    }


    /*
      高分排前面
    */

    results.sort(
      (a, b) =>
        b.score -
        a.score
    );


    /*
      只顯示值得注意的
      最多15檔
    */

    let radar =
      results
      .filter(
        x =>
          x.score >= 38
      )
      .slice(
        0,
        15
      );


    /*
      如果今天完全沒有異動，
      還是給前5名，
      讓畫面不會空白。
    */

    if (!radar.length) {

      radar =
        results.slice(
          0,
          5
        );
    }


    res.setHeader(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=600"
    );


    return res.status(200).json({

      platform:
        "妖子平台2.1",

      title:
        "今日異動雷達",

      updatedAt:
        new Date()
        .toISOString(),

      scanned:
        results.length,

      found:
        radar.length,

      radar

    });


  } catch (error) {

    console.error(
      "Radar error:",
      error
    );


    return res.status(500).json({

      error:
        error?.message ||
        "異動雷達暫時無法取得"

    });
  }
}
