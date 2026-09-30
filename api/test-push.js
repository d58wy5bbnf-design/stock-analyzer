const webpush = require("web-push");

// ==============================
// Redis / KV
// ==============================
function getRedisConfig() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;

  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("找不到 Redis / KV 環境變數");
  }

  return { url, token };
}

async function redis(command) {
  const { url, token } = getRedisConfig();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      `Redis 錯誤：${data.error || response.status}`
    );
  }

  return data.result;
}

// ==============================
// VAPID
// ==============================
function configurePush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  let subject =
    process.env.VAPID_SUBJECT ||
    "mailto:liaozhanxie@gmail.com";

  subject = String(subject).trim();

  // 防止之前那種：
  // Liaozhanxie@gmail.com
  // 被 web-push 判定為 invalid URL
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

// ==============================
// 找 Push 訂閱
// ==============================
async function getSubscriptions() {
  const subscriptions = [];

  // 目前系統主要使用的 device list
  const deviceIds =
    (await redis(["SMEMBERS", "swing:push:devices"])) || [];

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

// ==============================
// API
// ==============================
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

    const subscriptions = await getSubscriptions();

    if (!subscriptions.length) {
      return res.status(200).json({
        ok: false,
        sent: 0,
        message:
          "目前 Redis 裡沒有找到手機 Push 訂閱。請先從 iPhone 主畫面的波段分析開啟「進場通知」。",
      });
    }

    const payload = JSON.stringify({
      title: "✅ 台股進場通知測試成功",
      body:
        "背景推播系統已正常連線。之後符合正式進場條件時，網站關閉也可以收到通知。",
      tag: `test-push-${Date.now()}`,
      url: "/",
    });

    let sent = 0;
    let failed = 0;

    const results = [];

    for (const item of subscriptions) {
      try {
        await webpush.sendNotification(
          item.subscription,
          payload,
          {
            TTL: 60,
          }
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
      totalSubscriptions: subscriptions.length,
      message:
        sent > 0
          ? `測試通知已送出 ${sent} 台裝置`
          : "找到訂閱，但通知沒有成功送出",
      results,
    });
  } catch (error) {
    console.error("test-push error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Internal Server Error",
    });
  }
};
