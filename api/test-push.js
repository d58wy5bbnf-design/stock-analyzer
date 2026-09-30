const webpush = require("web-push");

// ========================================
// Redis
// ========================================

function getRedisConfig() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;

  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;

  if (!url) {
    throw new Error("缺少 UPSTASH_REDIS_REST_URL");
  }

  if (!token) {
    throw new Error("缺少 UPSTASH_REDIS_REST_TOKEN");
  }

  return {
    url: url.replace(/\/+$/, ""),
    token,
  };
}

async function redis(command) {
  const { url, token } = getRedisConfig();

  const controller = new AbortController();

  // Redis 最多等 8 秒
  const timer = setTimeout(() => {
    controller.abort();
  }, 8000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(
        `Redis 錯誤：${data.error || response.status}`
      );
    }

    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

// ========================================
// VAPID
// ========================================

function configurePush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  let subject =
    process.env.VAPID_SUBJECT ||
    "mailto:liaozhanxie@gmail.com";

  subject = String(subject).trim();

  if (
    !subject.startsWith("mailto:") &&
    !subject.startsWith("https://")
  ) {
    if (subject.includes("@")) {
      subject = `mailto:${subject}`;
    } else {
      subject = `https://${subject}`;
    }
  }

  if (!publicKey) {
    throw new Error("缺少 VAPID_PUBLIC_KEY");
  }

  if (!privateKey) {
    throw new Error("缺少 VAPID_PRIVATE_KEY");
  }

  webpush.setVapidDetails(
    subject,
    publicKey,
    privateKey
  );
}

// ========================================
// 找 Push 訂閱
// ========================================

async function getSubscriptions() {
  const subscriptions = [];

  const deviceIds =
    (await redis([
      "SMEMBERS",
      "swing:push:devices",
    ])) || [];

  for (const deviceId of deviceIds) {
    try {
      const raw = await redis([
        "GET",
        `swing:push:device:${deviceId}`,
      ]);

      if (!raw) continue;

      const device =
        typeof raw === "string"
          ? JSON.parse(raw)
          : raw;

      const subscription =
        device.subscription ||
        device.pushSubscription ||
        device;

      if (
        subscription &&
        subscription.endpoint &&
        subscription.keys &&
        subscription.keys.p256dh &&
        subscription.keys.auth
      ) {
        subscriptions.push({
          deviceId,
          subscription,
        });
      }
    } catch (error) {
      console.error(
        `讀取裝置 ${deviceId} 失敗：`,
        error
      );
    }
  }

  return subscriptions;
}

// ========================================
// 單一 Push：最多等待 10 秒
// ========================================

async function sendPushWithTimeout(
  subscription,
  payload,
  timeoutMs = 10000
) {
  let timer;

  const timeoutPromise = new Promise(
    (_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Apple Push 超過 ${timeoutMs / 1000} 秒沒有回應`
        );

        error.code = "PUSH_TIMEOUT";

        reject(error);
      }, timeoutMs);
    }
  );

  try {
    return await Promise.race([
      webpush.sendNotification(
        subscription,
        payload,
        {
          TTL: 60,
        }
      ),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ========================================
// API
// ========================================

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    configurePush();

    const subscriptions =
      await getSubscriptions();

    if (!subscriptions.length) {
      return res.status(200).json({
        ok: false,
        sent: 0,
        failed: 0,
        totalSubscriptions: 0,
        message:
          "目前 Redis 裡沒有找到手機 Push 訂閱。請先從 iPhone 主畫面的波段分析開啟「進場通知」。",
      });
    }

    const payload = JSON.stringify({
      title: "✅ 台股進場通知測試成功",
      body:
        "背景推播系統測試中。如果你看到這則通知，代表手機 Push 訂閱與通知功能已連線。",
      tag: `test-push-${Date.now()}`,
      url: "/",
    });

    let sent = 0;
    let failed = 0;

    const results = [];

    // ========================================
    // 逐台測試
    // 每台最多 10 秒
    // ========================================

    for (const item of subscriptions) {
      try {
        await sendPushWithTimeout(
          item.subscription,
          payload,
          10000
        );

        sent++;

        results.push({
          deviceId: item.deviceId,
          ok: true,
        });
      } catch (error) {
        failed++;

        const statusCode =
          error.statusCode ||
          error.status ||
          null;

        console.error(
          "Push 發送失敗：",
          item.deviceId,
          statusCode,
          error.message
        );

        results.push({
          deviceId: item.deviceId,
          ok: false,
          statusCode,
          code: error.code || null,
          error: error.message,
        });

        // Apple / Push Service 表示訂閱已失效
        if (
          statusCode === 404 ||
          statusCode === 410
        ) {
          try {
            await redis([
              "DEL",
              `swing:push:device:${item.deviceId}`,
            ]);

            await redis([
              "SREM",
              "swing:push:devices",
              item.deviceId,
            ]);
          } catch (cleanupError) {
            console.error(
              "清除失效訂閱失敗：",
              cleanupError
            );
          }
        }
      }
    }

    return res.status(200).json({
      ok: sent > 0,
      sent,
      failed,
      totalSubscriptions:
        subscriptions.length,
      message:
        sent > 0
          ? `測試通知已送出 ${sent} 台裝置`
          : "找到訂閱，但通知沒有成功送出",
      results,
    });
  } catch (error) {
    console.error(
      "test-push error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Internal Server Error",
    });
  }
};
