const webpush = require("web-push");

// ============================================================
// Redis
// ============================================================

function getRedisConfig() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;

  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;

  if (!url) {
    throw new Error("缺少 UPSTASH_REDIS_REST_URL / KV_REST_API_URL");
  }

  if (!token) {
    throw new Error("缺少 UPSTASH_REDIS_REST_TOKEN / KV_REST_API_TOKEN");
  }

  return {
    url: url.replace(/\/+$/, ""),
    token,
  };
}

async function redis(command) {
  const { url, token } = getRedisConfig();

  const controller = new AbortController();

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

    let data;

    try {
      data = await response.json();
    } catch {
      const text = await response.text();

      throw new Error(
        `Redis 回傳不是 JSON：HTTP ${response.status} ${text}`
      );
    }

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

// ============================================================
// VAPID
// ============================================================

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

  return {
    subject,
    publicKeyLength: publicKey.length,
    privateKeyLength: privateKey.length,
  };
}

// ============================================================
// 讀取 Push 訂閱
// ============================================================

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

// ============================================================
// 判斷 Push endpoint
// ============================================================

function getEndpointType(endpoint = "") {
  try {
    const host = new URL(endpoint).hostname;

    if (
      host.includes("push.apple.com") ||
      host.includes("web.push.apple.com")
    ) {
      return "Apple Push";
    }

    if (
      host.includes("googleapis.com") ||
      host.includes("fcm.googleapis.com")
    ) {
      return "Google FCM";
    }

    if (host.includes("mozilla.com")) {
      return "Mozilla Push";
    }

    return host;
  } catch {
    return "Unknown";
  }
}

// ============================================================
// Push timeout
// ============================================================

async function sendPushWithTimeout(
  subscription,
  payload,
  timeoutMs = 15000
) {
  let timer;

  const timeoutPromise = new Promise(
    (_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Push 超時 ${timeoutMs / 1000} 秒`
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

// ============================================================
// 整理錯誤
// ============================================================

function normalizeError(error) {
  let body = error?.body ?? null;

  if (Buffer.isBuffer(body)) {
    body = body.toString("utf8");
  }

  if (
    body &&
    typeof body !== "string"
  ) {
    try {
      body = JSON.stringify(body);
    } catch {
      body = String(body);
    }
  }

  let headers = null;

  if (error?.headers) {
    try {
      headers = JSON.parse(
        JSON.stringify(error.headers)
      );
    } catch {
      headers = String(error.headers);
    }
  }

  return {
    message:
      error?.message ||
      "Unknown Push Error",

    statusCode:
      error?.statusCode ||
      error?.status ||
      null,

    code:
      error?.code ||
      null,

    body,

    headers,
  };
}

// ============================================================
// API
// ============================================================

module.exports = async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  try {
    const vapid = configurePush();

    const subscriptions =
      await getSubscriptions();

    if (!subscriptions.length) {
      return res.status(200).json({
        ok: false,
        sent: 0,
        failed: 0,
        totalSubscriptions: 0,
        vapid,
        message:
          "Redis 裡沒有找到有效的手機 Push 訂閱",
      });
    }

    const payload = JSON.stringify({
      title: "✅ 台股進場通知測試成功",
      body:
        "背景推播系統測試中。如果你看到這則通知，代表 Web Push 已成功。",
      tag: `test-push-${Date.now()}`,
      url: "/",
    });

    let sent = 0;
    let failed = 0;

    const results = [];

    for (const item of subscriptions) {
      const endpoint =
        item.subscription?.endpoint || "";

      const endpointType =
        getEndpointType(endpoint);

      let endpointHost = null;

      try {
        endpointHost =
          new URL(endpoint).hostname;
      } catch {
        endpointHost = "invalid-endpoint";
      }

      try {
        const response =
          await sendPushWithTimeout(
            item.subscription,
            payload
          );

        sent++;

        results.push({
          deviceId: item.deviceId,
          ok: true,
          endpointType,
          endpointHost,
          statusCode:
            response?.statusCode || 201,
        });
      } catch (error) {
        failed++;

        const detail =
          normalizeError(error);

        console.error(
          "Push 發送失敗：",
          {
            deviceId: item.deviceId,
            endpointType,
            endpointHost,
            ...detail,
          }
        );

        results.push({
          deviceId: item.deviceId,
          ok: false,
          endpointType,
          endpointHost,
          ...detail,
        });

        const statusCode =
          detail.statusCode;

        // 訂閱確定失效才刪除
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

      vapid,

      message:
        sent > 0
          ? `測試通知已送出 ${sent} 台裝置`
          : "找到訂閱，但所有 Push 都發送失敗",

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
        error?.message ||
        "Internal Server Error",
      detail: normalizeError(error),
    });
  }
};
