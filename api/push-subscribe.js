/* =========================================================
   api/push-subscribe.js
   儲存 / 更新 / 刪除 Web Push 訂閱
========================================================= */

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN;


/* ---------- Redis ---------- */

async function redis(command) {

  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error(
      "Upstash Redis 環境變數尚未設定"
    );
  }

  const response = await fetch(
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
        JSON.stringify(command)
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
}


/* ---------- 股票代號整理 ---------- */

function normalizeSymbols(list) {

  if (!Array.isArray(list)) {
    return [];
  }

  return [
    ...new Set(
      list
        .map(
          item =>
            String(item || "")
              .trim()
        )

        .filter(
          symbol =>
            /^\d{4,6}$/.test(symbol)
        )
    )
  ].slice(0, 50);

}


/* ---------- API ---------- */

module.exports =
async function handler(req, res) {

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );


  if (
    !["POST", "DELETE"]
      .includes(req.method)
  ) {

    return res
      .status(405)
      .json({
        ok: false,
        error:
          "Method Not Allowed"
      });

  }


  try {

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});


    const deviceId =
      String(
        body.deviceId || ""
      ).trim();


    if (!deviceId) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "缺少 deviceId"
        });

    }


    /* =====================================================
       DELETE
       使用者關閉通知
    ===================================================== */

    if (
      req.method === "DELETE"
    ) {

      await redis([
        "DEL",
        `swing:push:device:${deviceId}`
      ]);


      await redis([
        "SREM",
        "swing:push:devices",
        deviceId
      ]);


      return res
        .status(200)
        .json({
          ok: true,
          removed: true
        });

    }


    /* =====================================================
       POST
       新增 / 更新訂閱
    ===================================================== */

    const subscription =
      body.subscription;


    if (
      !subscription ||
      !subscription.endpoint ||
      !subscription.keys ||
      !subscription.keys.p256dh ||
      !subscription.keys.auth
    ) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Push subscription 資料不完整"
        });

    }


    const symbols =
      normalizeSymbols(
        body.symbols
      );


    if (!symbols.length) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "至少需要一支監控股票"
        });

    }


    const record = {

      deviceId,

      subscription: {
        endpoint:
          subscription.endpoint,

        expirationTime:
          subscription.expirationTime ??
          null,

        keys: {
          p256dh:
            subscription.keys.p256dh,

          auth:
            subscription.keys.auth
        }
      },

      symbols,

      enabled: true,

      updatedAt:
        new Date().toISOString()

    };


    await redis([
      "SET",
      `swing:push:device:${deviceId}`,
      JSON.stringify(record)
    ]);


    await redis([
      "SADD",
      "swing:push:devices",
      deviceId
    ]);


    return res
      .status(200)
      .json({

        ok: true,

        deviceId,

        symbols,

        count:
          symbols.length

      });


  } catch (error) {

    console.error(
      "push subscribe error:",
      error
    );


    return res
      .status(500)
      .json({

        ok: false,

        error:
          error?.message ||
          "Push 訂閱儲存失敗"

      });

  }

};
