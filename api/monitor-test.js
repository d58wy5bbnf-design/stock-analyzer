/* =========================================================
   api/monitor-test.js

   Monitor 獨立測試入口
   不使用 CRON_SECRET
   不受台股開盤時間限制
   不修改正式 /api/monitor

   用途：
   1. 確認新版檔案真的部署
   2. 確認 Redis
   3. 確認 Push 裝置
   4. 確認股票 API
   5. 可手動測試 Push
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
  "mailto:liaozhanxjie@gmail.com";


/* =========================================================
   Redis
========================================================= */

async function redis(command) {

  if (
    !REDIS_URL ||
    !REDIS_TOKEN
  ) {

    throw new Error(
      "Redis 環境變數尚未設定"
    );
  }


  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      8000
    );


  try {

    const response =
      await fetch(
        REDIS_URL,
        {
          method:
            "POST",

          headers: {
            Authorization:
              `Bearer ${REDIS_TOKEN}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(
              command
            ),

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

    clearTimeout(
      timer
    );
  }
}


/* =========================================================
   Utility
========================================================= */

function unique(list) {

  return [
    ...new Set(
      (
        Array.isArray(list)
          ? list
          : []
      )
        .map(
          x =>
            String(x).trim()
        )
        .filter(Boolean)
    )
  ];
}


function getOrigin(req) {

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


  return (
    `${proto}://${host}`
  );
}


/* =========================================================
   Stock API Test
========================================================= */

async function testStock(
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


    let data = null;


    try {

      data =
        await response.json();

    } catch (_) {}


    return {

      symbol,

      httpStatus:
        response.status,

      ok:
        response.ok &&
        data?.ok === true,

      name:
        data?.name ||
        null,

      price:
        data?.price ??
        null,

      rows:
        Array.isArray(
          data?.rows
        )
          ? data.rows.length
          : 0,

      institutional:
        data?.institutional
          ? true
          : false,

      fundamental:
        !!(
          data?.fundamental ||
          data?.revenue ||
          data?.financial
        ),

      error:
        data?.error ||
        null
    };


  } catch (error) {

    return {

      symbol,

      ok:
        false,

      error:
        error?.message ||
        "股票 API 測試失敗"
    };
  }
}


/* =========================================================
   Test Push
========================================================= */

async function sendTestPush(
  device
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
    JSON.stringify({

      title:
        "✅ 波段分析監控測試成功",

      body:
        "背景監控、Redis 與 Web Push 連線正常。",

      tag:
        `monitor-test-${Date.now()}`,

      url:
        "/"
    });


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


  /*
    這支 API 故意不檢查 CRON_SECRET。
    它與正式 monitor 完全分開。
  */


  try {

    /* =====================================================
       ENV Check
    ===================================================== */

    const env = {

      redisUrl:
        !!REDIS_URL,

      redisToken:
        !!REDIS_TOKEN,

      vapidPublic:
        !!VAPID_PUBLIC_KEY,

      vapidPrivate:
        !!VAPID_PRIVATE_KEY,

      vapidSubject:
        !!VAPID_SUBJECT
    };


    if (
      !REDIS_URL ||
      !REDIS_TOKEN
    ) {

      return res
        .status(500)
        .json({

          ok:
            false,

          engine:
            "Monitor Test 1.0",

          stage:
            "ENV",

          env,

          error:
            "Redis 環境變數缺少"
        });
    }


    if (
      !VAPID_PUBLIC_KEY ||
      !VAPID_PRIVATE_KEY ||
      !VAPID_SUBJECT
    ) {

      return res
        .status(500)
        .json({

          ok:
            false,

          engine:
            "Monitor Test 1.0",

          stage:
            "ENV",

          env,

          error:
            "VAPID 環境變數缺少"
        });
    }


    webpush.setVapidDetails(
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );


    /* =====================================================
       Redis Test
    ===================================================== */

    const redisPing =
      await redis([
        "PING"
      ]);


    /* =====================================================
       Device IDs
    ===================================================== */

    const deviceIds =
      await redis([
        "SMEMBERS",
        "swing:push:devices"
      ]) || [];


    const devices = [];

    const invalidDevices = [];


    for (
      const deviceId of
      deviceIds
    ) {

      try {

        const raw =
          await redis([
            "GET",
            `swing:push:device:${deviceId}`
          ]);


        if (!raw) {

          invalidDevices.push({
            deviceId,

            reason:
              "Redis 找不到裝置資料"
          });

          continue;
        }


        const device =
          typeof raw ===
            "string"
            ? JSON.parse(raw)
            : raw;


        const subscription =
          device.subscription ||
          device.pushSubscription;


        if (
          !subscription?.endpoint
        ) {

          invalidDevices.push({
            deviceId,

            reason:
              "沒有 Push endpoint"
          });

          continue;
        }


        devices.push({

          deviceId:
            device.deviceId ||
            deviceId,

          subscription,

          symbols:
            unique(
              device.symbols
            ),

          endpoint:
            subscription.endpoint
              .replace(
                /https?:\/\//,
                ""
              )
              .split("/")[0]
        });


      } catch (error) {

        invalidDevices.push({

          deviceId,

          reason:
            error?.message ||
            "裝置資料解析失敗"
        });
      }
    }


    /* =====================================================
       股票清單
    ===================================================== */

    const symbols =
      unique(
        devices.flatMap(
          device =>
            device.symbols
        )
      );


    const origin =
      getOrigin(req);


    /* =====================================================
       股票 API 測試
       最多先測 5 支，避免手動測試太慢
    ===================================================== */

    const stockSymbols =
      symbols.slice(
        0,
        5
      );


    const stockTests =
      await Promise.all(
        stockSymbols.map(
          symbol =>
            testStock(
              origin,
              symbol
            )
        )
      );


    /* =====================================================
       是否發送測試 Push

       /api/monitor-test
       = 只檢查

       /api/monitor-test?push=1
       = 真正發一則測試 Push
    ===================================================== */

    let pushRequested =
      false;


    try {

      const url =
        new URL(
          req.url || "/",
          origin
        );


      pushRequested =
        url.searchParams.get(
          "push"
        ) === "1";

    } catch (_) {}


    const pushResults = [];


    if (
      pushRequested
    ) {

      for (
        const device of
        devices
      ) {

        try {

          const response =
            await sendTestPush(
              device
            );


          pushResults.push({

            deviceId:
              device.deviceId,

            ok:
              true,

            statusCode:
              response?.statusCode ||
              201
          });


        } catch (error) {

          pushResults.push({

            deviceId:
              device.deviceId,

            ok:
              false,

            statusCode:
              error?.statusCode ||
              null,

            error:
              error?.message ||
              "Push 發送失敗"
          });
        }
      }
    }


    /* =====================================================
       判斷
    ===================================================== */

    const stockApiOK =
      stockTests.length === 0
        ? null
        : stockTests.every(
            x =>
              x.ok
          );


    const pushOK =
      !pushRequested
        ? null
        : (
            pushResults.length >
              0 &&
            pushResults.every(
              x =>
                x.ok
            )
          );


    /* =====================================================
       Result
    ===================================================== */

    return res
      .status(200)
      .json({

        ok:
          true,

        engine:
          "Monitor Test 1.0",

        message:
          "獨立測試 API 已正常執行",

        cronSecretRequired:
          false,

        redis: {

          ok:
            redisPing ===
            "PONG",

          response:
            redisPing
        },

        env,

        devices: {

          registered:
            deviceIds.length,

          valid:
            devices.length,

          invalid:
            invalidDevices.length,

          invalidDevices
        },

        watchSymbols: {

          total:
            symbols.length,

          symbols
        },

        stockApi: {

          tested:
            stockTests.length,

          ok:
            stockApiOK,

          results:
            stockTests
        },

        push: {

          requested:
            pushRequested,

          ok:
            pushOK,

          sent:
            pushResults.filter(
              x =>
                x.ok
            ).length,

          failed:
            pushResults.filter(
              x =>
                !x.ok
            ).length,

          results:
            pushResults
        }
      });


  } catch (error) {

    console.error(
      "monitor-test error:",
      error
    );


    return res
      .status(500)
      .json({

        ok:
          false,

        engine:
          "Monitor Test 1.0",

        error:
          error?.message ||
          "Monitor 測試失敗"
      });
  }
};
