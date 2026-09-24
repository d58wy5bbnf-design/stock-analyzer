// ============================================================
// 妖子平台 3.3
// api/kbar.js
//
// Fugle 台股盤中 K 棒
//
// 支援：
// 1m / 3m / 5m / 10m / 15m / 30m / 60m
// 2h / 4h / 6h / 12h
//
// Vercel Environment Variable:
// FUGLE_API_KEY
// ============================================================

const FUGLE_BASE =
  "https://api.fugle.tw/marketdata/v1.0/stock/intraday/candles";


function setCors(res){

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
}


function send(
  res,
  status,
  data
){

  return res
    .status(status)
    .json(data);
}


function number(value){

  const n=
    Number(value);

  return Number.isFinite(n)
    ?n
    :null;
}


function normalizeSymbol(value){

  return String(
    value||""
  )
  .trim()
  .toUpperCase();
}


/* ============================================================
   TIMEFRAME
============================================================ */

function normalizeTimeframe(value){

  let tf=
    String(
      value||"1m"
    )
    .trim()
    .toLowerCase();


  const aliases={

    "1":"1m",
    "3":"3m",
    "5":"5m",
    "10":"10m",
    "15":"15m",
    "30":"30m",
    "60":"60m",

    "1m":"1m",
    "3m":"3m",
    "5m":"5m",
    "10m":"10m",
    "15m":"15m",
    "30m":"30m",
    "60m":"60m",

    "1h":"60m",

    "2h":"2h",
    "4h":"4h",
    "6h":"6h",
    "12h":"12h"
  };


  return aliases[tf]||
    "1m";
}


/* ============================================================
   TIMESTAMP
============================================================ */

function timestampOf(candle){

  const raw=
    candle.date ??
    candle.time ??
    candle.timestamp ??
    candle.datetime ??
    candle.at;


  if(raw==null){
    return null;
  }


  if(
    typeof raw==="number"&&
    raw>1000000000000
  ){

    return raw;
  }


  if(
    typeof raw==="number"&&
    raw>1000000000
  ){

    return raw*1000;
  }


  const parsed=
    new Date(raw)
      .getTime();


  return Number.isFinite(parsed)
    ?parsed
    :null;
}


/* ============================================================
   NORMALIZE CANDLE
============================================================ */

function normalizeCandle(candle){

  const timestamp=
    timestampOf(candle);


  return {

    timestamp,

    time:
      timestamp!=null
        ?new Date(
          timestamp
        ).toISOString()
        :null,

    open:
      number(
        candle.open
      ),

    high:
      number(
        candle.high
      ),

    low:
      number(
        candle.low
      ),

    close:
      number(
        candle.close
      ),

    volume:
      number(
        candle.volume ??
        candle.totalVolume ??
        candle.tradeVolume
      )||0
  };
}


/* ============================================================
   AGGREGATE
============================================================ */

function aggregateCandles(
  candles,
  minutes
){

  if(
    !Array.isArray(candles)||
    !candles.length
  ){

    return [];
  }


  const interval=
    minutes*
    60*
    1000;


  const buckets=
    new Map();


  for(
    const candle of candles
  ){

    if(
      !Number.isFinite(
        candle.timestamp
      )
    ){
      continue;
    }


    const bucket=
      Math.floor(
        candle.timestamp/
        interval
      )*
      interval;


    if(
      !buckets.has(bucket)
    ){

      buckets.set(
        bucket,
        {
          timestamp:
            bucket,

          time:
            new Date(
              bucket
            ).toISOString(),

          open:
            candle.open,

          high:
            candle.high,

          low:
            candle.low,

          close:
            candle.close,

          volume:
            Number(
              candle.volume
            )||0
        }
      );

      continue;
    }


    const current=
      buckets.get(bucket);


    current.high=
      Math.max(
        current.high,
        candle.high
      );


    current.low=
      Math.min(
        current.low,
        candle.low
      );


    current.close=
      candle.close;


    current.volume+=
      Number(
        candle.volume
      )||0;
  }


  return Array
    .from(
      buckets.values()
    )
    .sort(
      (
        a,
        b
      )=>
        a.timestamp-
        b.timestamp
    );
}


/* ============================================================
   FETCH FUGLE
============================================================ */

async function fetchFugle(
  symbol,
  timeframe,
  apiKey
){

  const url=

    `${FUGLE_BASE}/`+
    `${encodeURIComponent(symbol)}`+
    `?timeframe=`+
    `${encodeURIComponent(timeframe)}`+
    `&sort=asc`;


  const response=
    await fetch(
      url,
      {
        method:"GET",

        headers:{
          "X-API-KEY":
            apiKey,

          "Accept":
            "application/json"
        },

        cache:
          "no-store"
      }
    );


  const text=
    await response.text();


  let raw=null;


  try{

    raw=
      JSON.parse(text);

  }catch(error){

    raw=null;
  }


  if(
    !response.ok
  ){

    throw new Error(

      raw?.message||
      raw?.error||
      text||
      `Fugle HTTP ${response.status}`
    );
  }


  let source=[];


  if(
    Array.isArray(
      raw?.data
    )
  ){

    source=
      raw.data;

  }else if(
    Array.isArray(
      raw?.candles
    )
  ){

    source=
      raw.candles;

  }else if(
    Array.isArray(
      raw?.data?.candles
    )
  ){

    source=
      raw.data.candles;

  }else if(
    Array.isArray(raw)
  ){

    source=
      raw;
  }


  const candles=
    source
      .map(
        normalizeCandle
      )
      .filter(
        candle=>

          Number.isFinite(
            candle.timestamp
          )&&

          candle.open!=null&&
          candle.high!=null&&
          candle.low!=null&&
          candle.close!=null
      )
      .sort(
        (
          a,
          b
        )=>
          a.timestamp-
          b.timestamp
      );


  return {
    raw,
    candles
  };
}


/* ============================================================
   HANDLER
============================================================ */

export default async function handler(
  req,
  res
){

  setCors(res);


  if(
    req.method==="OPTIONS"
  ){

    return res
      .status(204)
      .end();
  }


  if(
    req.method!=="GET"
  ){

    return send(
      res,
      405,
      {
        ok:false,
        error:
          "Method not allowed"
      }
    );
  }


  const apiKey=
    process.env
      .FUGLE_API_KEY;


  if(!apiKey){

    return send(
      res,
      500,
      {
        ok:false,

        error:
          "Vercel 尚未設定 FUGLE_API_KEY"
      }
    );
  }


  const symbol=
    normalizeSymbol(
      req.query.symbol
    );


  const timeframe=
    normalizeTimeframe(
      req.query.timeframe
    );


  if(!symbol){

    return send(
      res,
      400,
      {
        ok:false,

        error:
          "缺少股票代號"
      }
    );
  }


  if(
    !/^[0-9A-Z]{4,10}$/
      .test(symbol)
  ){

    return send(
      res,
      400,
      {
        ok:false,

        error:
          "股票代號格式錯誤"
      }
    );
  }


  try{

    let fugleTimeframe;

    let aggregateMinutes=
      null;


    switch(timeframe){

      case "1m":
        fugleTimeframe="1";
        break;

      case "3m":
        fugleTimeframe="3";
        break;

      case "5m":
        fugleTimeframe="5";
        break;

      case "10m":
        fugleTimeframe="10";
        break;

      case "15m":
        fugleTimeframe="15";
        break;

      case "30m":
        fugleTimeframe="30";
        break;

      case "60m":
        fugleTimeframe="60";
        break;


      /*
        小時級 K 棒：

        使用 60 分 K
        再由妖子平台後端聚合。

        不在前端假造 OHLCV。
      */

      case "2h":

        fugleTimeframe=
          "60";

        aggregateMinutes=
          120;

        break;


      case "4h":

        fugleTimeframe=
          "60";

        aggregateMinutes=
          240;

        break;


      case "6h":

        fugleTimeframe=
          "60";

        aggregateMinutes=
          360;

        break;


      case "12h":

        fugleTimeframe=
          "60";

        aggregateMinutes=
          720;

        break;


      default:

        fugleTimeframe=
          "1";
    }


    const result=
      await fetchFugle(

        symbol,

        fugleTimeframe,

        apiKey
      );


    let candles=
      result.candles;


    if(
      aggregateMinutes
    ){

      candles=
        aggregateCandles(

          candles,

          aggregateMinutes
        );
    }


    if(
      !candles.length
    ){

      return send(
        res,
        502,
        {
          ok:false,

          source:
            "Fugle",

          symbol,

          timeframe,

          error:
            "Fugle 有回應，但目前沒有可用 K 棒"
        }
      );
    }


    const latest=
      candles[
        candles.length-1
      ];


    const previous=
      candles.length>=2
        ?candles[
          candles.length-2
        ]
        :null;


    let changePercent=
      null;


    if(
      previous&&
      previous.close
    ){

      changePercent=

        (
          latest.close-
          previous.close
        )/
        previous.close*
        100;
    }


    const high=
      Math.max(
        ...candles.map(
          candle=>
            candle.high
        )
      );


    const low=
      Math.min(
        ...candles.map(
          candle=>
            candle.low
        )
      );


    const volume=
      candles.reduce(
        (
          total,
          candle
        )=>

          total+
          (
            Number(
              candle.volume
            )||0
          ),

        0
      );


    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );


    res.setHeader(
      "Pragma",
      "no-cache"
    );


    res.setHeader(
      "Expires",
      "0"
    );


    return send(
      res,
      200,
      {
        ok:true,

        platform:
          "妖子平台 3.3",

        source:
          "Fugle MarketData",

        market:
          "TW",

        symbol,

        timeframe,

        sourceTimeframe:
          fugleTimeframe,

        aggregated:
          Boolean(
            aggregateMinutes
          ),

        count:
          candles.length,

        latest,

        previous,

        latestChangePercent:
          changePercent,

        high,

        low,

        totalVolume:
          volume,

        candles,

        updatedAt:
          new Date()
            .toISOString()
      }
    );


  }catch(error){

    console.error(
      "妖子平台 kbar error:",
      error
    );


    return send(
      res,
      500,
      {
        ok:false,

        source:
          "Fugle",

        symbol,

        timeframe,

        error:
          error?.message||
          "取得 K 棒失敗"
      }
    );
  }
}
