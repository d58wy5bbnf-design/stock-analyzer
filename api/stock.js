const https = require("https");

/*
  api/stock.js
  妖子平台 Stock Analysis API 6.0

  功能：
  1. 歷史日 K
  2. Sponsor 即時報價
  3. 三大法人籌碼
  4. 股票中文名稱 / 市場
  5. 月營收 + YoY / MoM
  6. 財報：EPS / 稅後淨利 / 毛利 / 營業利益
  7. 提供新版股票分析引擎完整資料

  注意：
  新聞另外由 /api/news.js 處理，
  避免每次開啟股票頁大量消耗 API 額度。
*/

module.exports = async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {

    const token = process.env.FINMIND_TOKEN;

    if (!token) {
      throw new Error("Vercel 尚未設定 FINMIND_TOKEN");
    }

    const symbol = String(req.query.symbol || "")
      .trim()
      .toUpperCase();

    if (!/^[0-9A-Z]{4,10}$/.test(symbol)) {
      throw new Error("股票代號格式錯誤");
    }

    const end = new Date();

    /*
      股價 / 法人抓約 500 天。
    */
    const priceStart = new Date();
    priceStart.setDate(priceStart.getDate() - 500);

    /*
      月營收抓約 18 個月，
      才能計算去年同期 YoY。
    */
    const revenueStart = new Date();
    revenueStart.setMonth(revenueStart.getMonth() - 18);

    /*
      財報抓約 2 年。
      足夠比較最近幾季 EPS / 獲利。
    */
    const financialStart = new Date();
    financialStart.setFullYear(financialStart.getFullYear() - 2);

    const startDate = formatDate(priceStart);
    const endDate = formatDate(end);

    const revenueStartDate = formatDate(revenueStart);
    const financialStartDate = formatDate(financialStart);

    /*
      所有資料並行取得。

      歷史 K 為必要資料；
      其他資料失敗時不讓整頁掛掉。
    */
    const [
      priceResult,
      realtimeResult,
      institutionalResult,
      infoResult,
      revenueResult,
      financialResult
    ] = await Promise.allSettled([

      getHistorical(
        symbol,
        startDate,
        endDate,
        token
      ),

      getRealtime(
        symbol,
        token
      ),

      getInstitutional(
        symbol,
        startDate,
        endDate,
        token
      ),

      getStockInfo(token),

      getMonthRevenue(
        symbol,
        revenueStartDate,
        endDate,
        token
      ),

      getFinancialStatements(
        symbol,
        financialStartDate,
        endDate,
        token
      )

    ]);

    /*
      歷史 K 為必要資料。
    */
    if (priceResult.status !== "fulfilled") {
      throw (
        priceResult.reason ||
        new Error("歷史股價取得失敗")
      );
    }

    const rows = priceResult.value;

    if (!Array.isArray(rows) || rows.length < 60) {
      throw new Error("歷史 K 線不足 60 根");
    }

    /*
      股票名稱 / 市場
    */
    let name = "";
    let market = "";

    if (infoResult.status === "fulfilled") {

      const info = infoResult.value.find(
        x => String(x.stock_id || "") === symbol
      );

      if (info) {

        name = String(
          info.stock_name ||
          ""
        );

        market = normalizeMarket(
          info.type ||
          info.industry_category ||
          ""
        );

      }

    }

    /*
      即時報價
    */
    let realtime = null;
    let realtimeError = "";

    if (realtimeResult.status === "fulfilled") {

      realtime = realtimeResult.value;

    } else {

      realtimeError =
        realtimeResult.reason?.message ||
        "即時報價暫時無法取得";

    }

    /*
      法人
    */
    let institutional = emptyInstitutional();
    let institutionalError = "";

    if (institutionalResult.status === "fulfilled") {

      institutional = institutionalResult.value;

    } else {

      institutionalError =
        institutionalResult.reason?.message ||
        "法人籌碼暫時無法取得";

    }

    /*
      月營收
    */
    let revenue = emptyRevenue();
    let revenueError = "";

    if (revenueResult.status === "fulfilled") {

      revenue = revenueResult.value;

    } else {

      revenueError =
        revenueResult.reason?.message ||
        "月營收暫時無法取得";

    }

    /*
      財報
    */
    let financial = emptyFinancial();
    let financialError = "";

    if (financialResult.status === "fulfilled") {

      financial = financialResult.value;

    } else {

      financialError =
        financialResult.reason?.message ||
        "財報暫時無法取得";

    }

    /*
      最新歷史 K
    */
    const latest = rows[rows.length - 1];

    const previous =
      rows.length >= 2
        ? rows[rows.length - 2]
        : latest;

    /*
      優先使用即時價
    */
    const currentPrice = positive(
      realtime?.price,
      realtime?.close,
      realtime?.last_price,
      realtime?.lastPrice,
      latest.close
    );

    const previousClose = positive(
      realtime?.previous_close,
      realtime?.previousClose,
      realtime?.reference_price,
      realtime?.referencePrice,
      previous.close
    );

    const currentOpen = positive(
      realtime?.open,
      realtime?.open_price,
      realtime?.openPrice,
      latest.open
    );

    const currentHigh = positive(
      realtime?.high,
      realtime?.max,
      realtime?.high_price,
      realtime?.highPrice,
      latest.high,
      currentPrice
    );

    const currentLow = positive(
      realtime?.low,
      realtime?.min,
      realtime?.low_price,
      realtime?.lowPrice,
      latest.low,
      currentPrice
    );

    const currentVolume = nonNegative(
      realtime?.volume,
      realtime?.total_volume,
      realtime?.totalVolume,
      realtime?.Trading_Volume,
      latest.volume
    );

    /*
      今日即時價併入最後一根 K。

      新版技術分析仍需要最新 OHLC / Volume。
    */
    const today = formatDate(new Date());

    let mergedRows = rows.map(
      x => ({ ...x })
    );

    const last = mergedRows[
      mergedRows.length - 1
    ];

    if (realtime && currentPrice > 0) {

      if (
        last &&
        normalizeDate(last.date) === today
      ) {

        last.open =
          currentOpen ||
          last.open;

        last.high = Math.max(
          last.high || 0,
          currentHigh || 0,
          currentPrice
        );

        const lows = [
          last.low,
          currentLow,
          currentPrice
        ].filter(
          x =>
            Number.isFinite(+x) &&
            +x > 0
        );

        if (lows.length) {
          last.low = Math.min(...lows);
        }

        last.close = currentPrice;

        if (currentVolume > 0) {
          last.volume = currentVolume;
        }

      } else {

        const lows = [
          currentLow,
          currentPrice
        ].filter(
          x =>
            Number.isFinite(+x) &&
            +x > 0
        );

        mergedRows.push({

          date: today,

          open:
            currentOpen ||
            currentPrice,

          high:
            Math.max(
              currentHigh || currentPrice,
              currentPrice
            ),

          low:
            lows.length
              ? Math.min(...lows)
              : currentPrice,

          close:
            currentPrice,

          volume:
            currentVolume || 0

        });

      }

    }

    /*
      保留最近 300 根日 K。
    */
    mergedRows = mergedRows.slice(-300);

    /*
      漲跌
    */
    const change =
      currentPrice -
      previousClose;

    const changePercent =
      previousClose > 0
        ? change / previousClose * 100
        : 0;

    /*
      統一基本面物件。

      前端之後只需要讀 fundamental。
    */
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

    /*
      回傳
    */
    return res
      .status(200)
      .json({

        ok: true,

        source: "FinMind",

        engine:
          "Stock Analysis 6.0",

        realtime:
          Boolean(realtime),

        symbol,

        name:
          name ||
          symbol,

        market,

        price:
          round(currentPrice),

        previousClose:
          round(previousClose),

        change:
          round(change),

        changePercent:
          round(changePercent),

        open:
          round(currentOpen),

        high:
          round(currentHigh),

        low:
          round(currentLow),

        volume:
          currentVolume,

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

        /*
          各資料來源錯誤狀態。
        */
        realtimeError,
        institutionalError,
        revenueError,
        financialError,

        /*
          法人
        */
        institutional,

        /*
          基本面
        */
        fundamental,

        /*
          為了之後除錯，
          也保留獨立資料。
        */
        revenue,
        financial,

        /*
          日 K
        */
        rows:
          mergedRows

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
          "FinMind",

        engine:
          "Stock Analysis 6.0",

        error:
          error?.message ||
          "FinMind 股票資料取得失敗"

      });

  }

};


/* =========================================================
   歷史日 K
========================================================= */

async function getHistorical(
  symbol,
  startDate,
  endDate,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockPrice" +
    "&data_id=" +
    encodeURIComponent(symbol) +
    "&start_date=" +
    encodeURIComponent(startDate) +
    "&end_date=" +
    encodeURIComponent(endDate);

  const json =
    await requestJSON(
      url,
      token
    );

  checkFinMind(
    json,
    "歷史股價"
  );

  const data =
    Array.isArray(json.data)
      ? json.data
      : [];

  const rows =
    data
      .map(
        row => {

          const open =
            positive(
              row.open
            );

          const high =
            positive(
              row.max,
              row.high
            );

          const low =
            positive(
              row.min,
              row.low
            );

          const close =
            positive(
              row.close
            );

          const volume =
            nonNegative(
              row.Trading_Volume,
              row.volume
            );

          return {

            date:
              normalizeDate(
                row.date
              ),

            open,
            high,
            low,
            close,
            volume

          };

        }
      )
      .filter(
        row =>
          row.date &&
          row.open > 0 &&
          row.high > 0 &&
          row.low > 0 &&
          row.close > 0
      )
      .sort(
        (a, b) =>
          a.date.localeCompare(
            b.date
          )
      );

  /*
    防止同日重複。
  */
  const map = new Map();

  for (const row of rows) {

    map.set(
      row.date,
      row
    );

  }

  return [
    ...map.values()
  ];

}


/* =========================================================
   即時報價
========================================================= */

async function getRealtime(
  symbol,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot" +
    "?data_id=" +
    encodeURIComponent(symbol) +
    "&_=" +
    Date.now();

  const json =
    await requestJSON(
      url,
      token
    );

  checkFinMind(
    json,
    "即時報價"
  );

  let data =
    json.data;

  if (Array.isArray(data)) {

    data =
      data.find(
        x =>
          String(
            x.stock_id ||
            x.code ||
            x.symbol ||
            ""
          ) === symbol
      )
      ||
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

    previous_close:
      positive(
        data.previous_close,
        data.previousClose,
        data.reference_price,
        data.referencePrice
      )

  };

}


/* =========================================================
   股票中文名稱
========================================================= */

async function getStockInfo(
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockInfo";

  const json =
    await requestJSON(
      url,
      token
    );

  checkFinMind(
    json,
    "股票名稱"
  );

  if (!Array.isArray(json.data)) {
    return [];
  }

  return json.data;

}


/* =========================================================
   三大法人
========================================================= */

async function getInstitutional(
  symbol,
  startDate,
  endDate,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockInstitutionalInvestorsBuySell" +
    "&data_id=" +
    encodeURIComponent(symbol) +
    "&start_date=" +
    encodeURIComponent(startDate) +
    "&end_date=" +
    encodeURIComponent(endDate);

  const json =
    await requestJSON(
      url,
      token
    );

  checkFinMind(
    json,
    "法人籌碼"
  );

  const data =
    Array.isArray(json.data)
      ? json.data
      : [];

  const daily = {};

  for (const row of data) {

    const date =
      normalizeDate(
        row.date
      );

    if (!date) {
      continue;
    }

    if (!daily[date]) {

      daily[date] = {

        date,

        foreign: 0,
        trust: 0,
        dealer: 0,
        total: 0

      };

    }

    const buy =
      nonNegative(
        row.buy
      );

    const sell =
      nonNegative(
        row.sell
      );

    const net =
      buy - sell;

    const name =
      String(
        row.name || ""
      )
        .toLowerCase();

    if (
      name.includes("foreign") ||
      name.includes("外資")
    ) {

      daily[date].foreign += net;

    }

    else if (
      name.includes("investment_trust") ||
      name.includes("investment trust") ||
      name.includes("投信")
    ) {

      daily[date].trust += net;

    }

    else if (
      name.includes("dealer") ||
      name.includes("自營")
    ) {

      daily[date].dealer += net;

    }

    daily[date].total += net;

  }

  const dates =
    Object
      .keys(daily)
      .sort();

  if (!dates.length) {
    return emptyInstitutional();
  }

  const latestDate =
    dates[
      dates.length - 1
    ];

  const latest =
    daily[
      latestDate
    ];

  const recent3 =
    pickRecent(
      daily,
      dates,
      3
    );

  const recent5 =
    pickRecent(
      daily,
      dates,
      5
    );

  const recent10 =
    pickRecent(
      daily,
      dates,
      10
    );

  const recent20 =
    pickRecent(
      daily,
      dates,
      20
    );

  /*
    買超天數。

    後面籌碼評分會用到：
    例如外資近 5 天有 4 天買超，
    比單純一天大量買超更可靠。
  */
  const foreignBuyDays5 =
    recent5.filter(
      x => x.foreign > 0
    ).length;

  const trustBuyDays5 =
    recent5.filter(
      x => x.trust > 0
    ).length;

  const totalBuyDays5 =
    recent5.filter(
      x => x.total > 0
    ).length;

  return {

    available: true,

    latestDate,

    foreignLatest:
      latest.foreign,

    trustLatest:
      latest.trust,

    dealerLatest:
      latest.dealer,

    totalLatest:
      latest.total,

    /*
      3 日
    */
    foreign3:
      sum(
        recent3,
        "foreign"
      ),

    trust3:
      sum(
        recent3,
        "trust"
      ),

    dealer3:
      sum(
        recent3,
        "dealer"
      ),

    total3:
      sum(
        recent3,
        "total"
      ),

    /*
      5 日
    */
    foreign5:
      sum(
        recent5,
        "foreign"
      ),

    trust5:
      sum(
        recent5,
        "trust"
      ),

    dealer5:
      sum(
        recent5,
        "dealer"
      ),

    total5:
      sum(
        recent5,
        "total"
      ),

    /*
      10 日
    */
    foreign10:
      sum(
        recent10,
        "foreign"
      ),

    trust10:
      sum(
        recent10,
        "trust"
      ),

    dealer10:
      sum(
        recent10,
        "dealer"
      ),

    total10:
      sum(
        recent10,
        "total"
      ),

    /*
      20 日
    */
    foreign20:
      sum(
        recent20,
        "foreign"
      ),

    trust20:
      sum(
        recent20,
        "trust"
      ),

    dealer20:
      sum(
        recent20,
        "dealer"
      ),

    total20:
      sum(
        recent20,
        "total"
      ),

    /*
      連續性
    */
    foreignBuyDays5,
    trustBuyDays5,
    totalBuyDays5,

    recent:
      recent20

  };

}


/* =========================================================
   月營收
========================================================= */

async function getMonthRevenue(
  symbol,
  startDate,
  endDate,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockMonthRevenue" +
    "&data_id=" +
    encodeURIComponent(symbol) +
    "&start_date=" +
    encodeURIComponent(startDate) +
    "&end_date=" +
    encodeURIComponent(endDate);

  const json =
    await requestJSON(
      url,
      token
    );

  checkFinMind(
    json,
    "月營收"
  );

  const data =
    Array.isArray(json.data)
      ? json.data
      : [];

  const rows =
    data
      .map(
        row => ({

          date:
            normalizeDate(
              row.date
            ),

          year:
            Number(
              row.revenue_year
            ) || 0,

          month:
            Number(
              row.revenue_month
            ) || 0,

          revenue:
            Number(
              row.revenue
            ) || 0,

          createTime:
            normalizeDate(
              row.create_time
            )

        })
      )
      .filter(
        x =>
          x.year > 0 &&
          x.month >= 1 &&
          x.month <= 12 &&
          x.revenue >= 0
      )
      .sort(
        (a, b) => {

          if (a.year !== b.year) {
            return a.year - b.year;
          }

          return a.month - b.month;

        }
      );

  if (!rows.length) {
    return emptyRevenue();
  }

  /*
    同月份若 API 有重複資料，
    取最後一筆。
  */
  const map =
    new Map();

  for (const row of rows) {

    const key =
      row.year +
      "-" +
      String(
        row.month
      ).padStart(
        2,
        "0"
      );

    map.set(
      key,
      row
    );

  }

  const clean =
    [
      ...map.values()
    ]
      .sort(
        (a, b) => {

          if (a.year !== b.year) {
            return a.year - b.year;
          }

          return a.month - b.month;

        }
      );

  const latest =
    clean[
      clean.length - 1
    ];

  const previous =
    clean.length >= 2
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
    ) || null;

  const mom =
    previous &&
    previous.revenue > 0
      ?
      (
        latest.revenue -
        previous.revenue
      ) /
      previous.revenue *
      100
      :
      null;

  const yoy =
    lastYear &&
    lastYear.revenue > 0
      ?
      (
        latest.revenue -
        lastYear.revenue
      ) /
      lastYear.revenue *
      100
      :
      null;

  return {

    available: true,

    latestDate:
      latest.date,

    createTime:
      latest.createTime,

    year:
      latest.year,

    month:
      latest.month,

    latest:
      latest.revenue,

    previousMonth:
      previous
        ? previous.revenue
        : null,

    lastYearSameMonth:
      lastYear
        ? lastYear.revenue
        : null,

    mom:
      nullableRound(
        mom
      ),

    yoy:
      nullableRound(
        yoy
      ),

    /*
      前端可以畫最近 13 個月。
    */
    recent:
      clean
        .slice(-13)
        .map(
          x => ({

            date:
              x.date,

            year:
              x.year,

            month:
              x.month,

            revenue:
              x.revenue

          })
        )

  };

}


/* =========================================================
   綜合損益表
========================================================= */

async function getFinancialStatements(
  symbol,
  startDate,
  endDate,
  token
) {

  const url =
    "https://api.finmindtrade.com/api/v4/data" +
    "?dataset=TaiwanStockFinancialStatements" +
    "&data_id=" +
    encodeURIComponent(symbol) +
    "&start_date=" +
    encodeURIComponent(startDate) +
    "&end_date=" +
    encodeURIComponent(endDate);

  const json =
    await requestJSON(
      url,
      token
    );

  checkFinMind(
    json,
    "財報"
  );

  const data =
    Array.isArray(json.data)
      ? json.data
      : [];

  if (!data.length) {
    return emptyFinancial();
  }

  /*
    FinMind 財報是：

    date
    type
    value
    origin_name

    所以轉成每季一個物件。
  */
  const quarters = {};

  for (const row of data) {

    const date =
      normalizeDate(
        row.date
      );

    if (!date) {
      continue;
    }

    if (!quarters[date]) {

      quarters[date] = {

        date,

        eps: null,

        incomeAfterTaxes: null,

        grossProfit: null,

        operatingIncome: null,

        revenue: null

      };

    }

    const type =
      String(
        row.type || ""
      );

    const origin =
      String(
        row.origin_name || ""
      );

    const value =
      finiteOrNull(
        row.value
      );

    if (value === null) {
      continue;
    }

    /*
      EPS
    */
    if (
      type === "EPS" ||
      origin.includes("每股盈餘")
    ) {

      quarters[date].eps =
        value;

    }

    /*
      本期淨利
    */
    else if (
      type ===
        "IncomeAfterTaxes" ||
      origin.includes(
        "本期淨利"
      ) ||
      origin.includes(
        "本期淨損"
      )
    ) {

      quarters[
        date
      ].incomeAfterTaxes =
        value;

    }

    /*
      毛利
    */
    else if (
      type ===
        "GrossProfit" ||
      origin.includes(
        "營業毛利"
      )
    ) {

      quarters[
        date
      ].grossProfit =
        value;

    }

    /*
      營業利益
    */
    else if (
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

      quarters[
        date
      ].operatingIncome =
        value;

    }

    /*
      財報營收欄位。

      不同產業 origin_name 可能不同，
      所以主要以 type 判斷。
    */
    else if (
      type === "Revenue" ||
      type ===
        "OperatingRevenue" ||
      origin ===
        "營業收入合計" ||
      origin ===
        "營業收入"
    ) {

      quarters[
        date
      ].revenue =
        value;

    }

  }

  /*
    至少要有一個我們需要的欄位。
  */
  const clean =
    Object
      .values(
        quarters
      )
      .filter(
        x =>
          x.eps !== null ||
          x.incomeAfterTaxes !== null ||
          x.grossProfit !== null ||
          x.operatingIncome !== null ||
          x.revenue !== null
      )
      .sort(
        (a, b) =>
          a.date.localeCompare(
            b.date
          )
      );

  if (!clean.length) {
    return emptyFinancial();
  }

  const latest =
    clean[
      clean.length - 1
    ];

  /*
    找上一期有 EPS 的財報。

    避免某一季 EPS 欄位缺失，
    直接拿 null 比較。
  */
  const epsRows =
    clean.filter(
      x =>
        x.eps !== null
    );

  const latestEPSRow =
    epsRows.length
      ? epsRows[
          epsRows.length - 1
        ]
      : null;

  const previousEPSRow =
    epsRows.length >= 2
      ? epsRows[
          epsRows.length - 2
        ]
      : null;

  /*
    找最近兩期有淨利的資料。
  */
  const incomeRows =
    clean.filter(
      x =>
        x.incomeAfterTaxes !==
        null
    );

  const latestIncomeRow =
    incomeRows.length
      ? incomeRows[
          incomeRows.length - 1
        ]
      : null;

  const previousIncomeRow =
    incomeRows.length >= 2
      ? incomeRows[
          incomeRows.length - 2
        ]
      : null;

  const eps =
    latestEPSRow
      ? latestEPSRow.eps
      : null;

  const previousEPS =
    previousEPSRow
      ? previousEPSRow.eps
      : null;

  /*
    EPS 成長率。

    若上一期 <= 0，
    百分比會失真，
    所以不硬算。
  */
  const epsGrowth =
    eps !== null &&
    previousEPS !== null &&
    previousEPS > 0
      ?
      (
        eps -
        previousEPS
      ) /
      Math.abs(
        previousEPS
      ) *
      100
      :
      null;

  const incomeAfterTaxes =
    latestIncomeRow
      ?
      latestIncomeRow
        .incomeAfterTaxes
      :
      latest
        .incomeAfterTaxes;

  const previousIncomeAfterTaxes =
    previousIncomeRow
      ?
      previousIncomeRow
        .incomeAfterTaxes
      :
      null;

  const netIncomeGrowth =
    incomeAfterTaxes !== null &&
    previousIncomeAfterTaxes !== null &&
    previousIncomeAfterTaxes > 0
      ?
      (
        incomeAfterTaxes -
        previousIncomeAfterTaxes
      ) /
      Math.abs(
        previousIncomeAfterTaxes
      ) *
      100
      :
      null;

  /*
    公司目前是否有獲利。

    優先看最近淨利；
    沒淨利資料才看 EPS。
  */
  let profitable = null;

  if (
    incomeAfterTaxes !==
    null
  ) {

    profitable =
      incomeAfterTaxes > 0;

  } else if (
    eps !== null
  ) {

    profitable =
      eps > 0;

  }

  return {

    available: true,

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
      nullableRound(
        epsGrowth
      ),

    incomeAfterTaxes:
      incomeAfterTaxes,

    previousIncomeAfterTaxes:
      previousIncomeAfterTaxes,

    netIncomeGrowth:
      nullableRound(
        netIncomeGrowth
      ),

    grossProfit:
      latest.grossProfit,

    operatingIncome:
      latest.operatingIncome,

    financialRevenue:
      latest.revenue,

    profitable,

    /*
      最近 8 期給前端趨勢分析。
    */
    recent:
      clean
        .slice(-8)
        .map(
          x => ({

            date:
              x.date,

            eps:
              nullableRound(
                x.eps
              ),

            incomeAfterTaxes:
              x.incomeAfterTaxes,

            grossProfit:
              x.grossProfit,

            operatingIncome:
              x.operatingIncome,

            revenue:
              x.revenue

          })
        )

  };

}


/* =========================================================
   空法人資料
========================================================= */

function emptyInstitutional() {

  return {

    available: false,

    latestDate: "",

    foreignLatest: 0,
    trustLatest: 0,
    dealerLatest: 0,
    totalLatest: 0,

    foreign3: 0,
    trust3: 0,
    dealer3: 0,
    total3: 0,

    foreign5: 0,
    trust5: 0,
    dealer5: 0,
    total5: 0,

    foreign10: 0,
    trust10: 0,
    dealer10: 0,
    total10: 0,

    foreign20: 0,
    trust20: 0,
    dealer20: 0,
    total20: 0,

    foreignBuyDays5: 0,
    trustBuyDays5: 0,
    totalBuyDays5: 0,

    recent: []

  };

}


/* =========================================================
   空月營收
========================================================= */

function emptyRevenue() {

  return {

    available: false,

    latestDate: "",

    createTime: "",

    year: 0,
    month: 0,

    latest: null,

    previousMonth: null,

    lastYearSameMonth: null,

    mom: null,

    yoy: null,

    recent: []

  };

}


/* =========================================================
   空財報
========================================================= */

function emptyFinancial() {

  return {

    available: false,

    latestDate: "",

    eps: null,

    previousEPS: null,

    epsGrowth: null,

    incomeAfterTaxes: null,

    previousIncomeAfterTaxes: null,

    netIncomeGrowth: null,

    grossProfit: null,

    operatingIncome: null,

    financialRevenue: null,

    profitable: null,

    recent: []

  };

}


/* =========================================================
   最近 N 日法人
========================================================= */

function pickRecent(
  daily,
  dates,
  count
) {

  return dates
    .slice(-count)
    .map(
      date =>
        daily[date]
    );

}


/* =========================================================
   加總
========================================================= */

function sum(
  rows,
  key
) {

  return rows.reduce(
    (
      total,
      row
    ) =>
      total +
      (
        Number(
          row[key]
        ) || 0
      ),
    0
  );

}


/* =========================================================
   FinMind 錯誤檢查
========================================================= */

function checkFinMind(
  json,
  label
) {

  if (
    !json ||
    typeof json !== "object"
  ) {

    throw new Error(
      label +
      " API 回傳格式錯誤"
    );

  }

  if (
    json.status !== undefined &&
    Number(json.status) !== 200
  ) {

    throw new Error(
      json.msg ||
      json.message ||
      label +
      "取得失敗"
    );

  }

}


/* =========================================================
   HTTPS
========================================================= */

function requestJSON(
  url,
  token
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      let settled = false;

      const request =
        https.get(

          url,

          {

            headers: {

              Authorization:
                "Bearer " +
                token,

              Accept:
                "application/json",

              "User-Agent":
                "stock-analyzer/6.0",

              "Cache-Control":
                "no-cache"

            },

            timeout:
              15000

          },

          response => {

            let body = "";

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

                  body += chunk;

                }

              }
            );

            response.on(
              "end",
              () => {

                if (settled) {
                  return;
                }

                settled = true;

                if (
                  response.statusCode <
                    200 ||
                  response.statusCode >=
                    300
                ) {

                  return reject(
                    new Error(
                      "FinMind HTTP " +
                      response.statusCode
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

          if (settled) {
            return;
          }

          settled = true;

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

          if (settled) {
            return;
          }

          settled = true;

          reject(error);

        }
      );

    }
  );

}


/* =========================================================
   市場名稱
========================================================= */

function normalizeMarket(
  value
) {

  const x =
    String(
      value || ""
    )
      .toLowerCase();

  if (
    x.includes("twse") ||
    x.includes("上市")
  ) {

    return "上市";

  }

  if (
    x.includes("tpex") ||
    x.includes("otc") ||
    x.includes("上櫃")
  ) {

    return "上櫃";

  }

  if (
    x.includes("emerging") ||
    x.includes("興櫃")
  ) {

    return "興櫃";

  }

  return value || "";

}


/* =========================================================
   日期
========================================================= */

function formatDate(
  date
) {

  return (
    date.getFullYear() +
    "-" +
    String(
      date.getMonth() + 1
    ).padStart(
      2,
      "0"
    ) +
    "-" +
    String(
      date.getDate()
    ).padStart(
      2,
      "0"
    )
  );

}


function normalizeDate(
  value
) {

  const match =
    String(
      value || ""
    )
      .match(
        /^(\d{4}-\d{2}-\d{2})/
      );

  return match
    ? match[1]
    : "";

}


/* =========================================================
   數字
========================================================= */

function num(
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

  return Number.isFinite(n)
    ? n
    : null;

}


function finiteOrNull(
  value
) {

  const n =
    num(
      value
    );

  return n === null
    ? null
    : n;

}


function positive(
  ...values
) {

  for (const value of values) {

    const n =
      num(
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

  for (const value of values) {

    const n =
      num(
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

  if (!Number.isFinite(n)) {
    return 0;
  }

  return (
    Math.round(
      n * 100
    ) /
    100
  );

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

  if (!Number.isFinite(n)) {
    return null;
  }

  return (
    Math.round(
      n * 100
    ) /
    100
  );

}
