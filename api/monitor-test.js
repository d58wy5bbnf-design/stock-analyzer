/* =========================================================
   api/monitor-test.js
   Monitor 7.0 Safari Test Bridge

   用途：
   - Safari 可直接開啟測試
   - 不需要手動輸入 CRON_SECRET
   - 自動呼叫正式 /api/monitor
   - 不修改正式 Cron
========================================================= */

module.exports = async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  try {
    const host =
      req.headers["x-forwarded-host"] ||
      req.headers.host;

    const proto =
      req.headers["x-forwarded-proto"] ||
      "https";

    const origin = `${proto}://${host}`;

    const secret =
      process.env.CRON_SECRET;

    if (!secret) {
      return res.status(500).json({
        ok: false,
        engine: "Monitor Test Bridge 1.0",
        error: "CRON_SECRET 尚未設定"
      });
    }

    const controller =
      new AbortController();

    const timer =
      setTimeout(() => {
        controller.abort();
      }, 290000);

    try {
      const response =
        await fetch(
          `${origin}/api/monitor`,
          {
            method: "GET",

            headers: {
              Authorization:
                `Bearer ${secret}`,

              "Cache-Control":
                "no-cache",

              "x-monitor-test":
                "1"
            },

            cache: "no-store",

            signal:
              controller.signal
          }
        );

      const text =
        await response.text();

      let data;

      try {
        data =
          JSON.parse(text);
      } catch {
        data = {
          raw: text
        };
      }

      return res
        .status(response.status)
        .json({
          bridgeOk:
            response.ok,

          bridgeEngine:
            "Monitor Test Bridge 1.0",

          monitorStatus:
            response.status,

          result:
            data
        });

    } finally {
      clearTimeout(timer);
    }

  } catch (error) {
    return res.status(500).json({
      ok: false,

      engine:
        "Monitor Test Bridge 1.0",

      error:
        error?.name ===
        "AbortError"
          ? "Monitor 測試超過 290 秒"
          : error?.message ||
            "Monitor 測試失敗"
    });
  }
};
