/* =========================================================
   api/monitor-test.js
   Monitor 7.1 Force Test Bridge

   用途：
   - Safari 直接開啟即可測試
   - 自動帶入 CRON_SECRET
   - 強制啟用 test=1
   - 不受 08:55～13:40 限制
   - 不修改正式 Cron
   - 正式 /api/monitor 仍維持 CRON_SECRET 保護
========================================================= */

module.exports = async function handler(req, res) {

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  try {

    /* =====================================================
       取得目前網站網址
    ===================================================== */

    const host =
      req.headers["x-forwarded-host"] ||
      req.headers.host;

    const proto =
      req.headers["x-forwarded-proto"] ||
      "https";

    if (!host) {

      return res.status(500).json({
        ok: false,
        engine: "Monitor Test Bridge 1.1",
        error: "無法取得網站 Host"
      });
    }

    const origin =
      `${proto}://${host}`;


    /* =====================================================
       CRON_SECRET
    ===================================================== */

    const secret =
      process.env.CRON_SECRET;

    if (!secret) {

      return res.status(500).json({
        ok: false,
        engine: "Monitor Test Bridge 1.1",
        error: "CRON_SECRET 尚未設定"
      });
    }


    /* =====================================================
       Timeout
    ===================================================== */

    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => {
          controller.abort();
        },
        290000
      );


    try {

      /* ===================================================
         ★ 重點
         ★ 正式 monitor 加上 ?test=1
         ★ 同時保留 Authorization
      =================================================== */

      const monitorUrl =
        `${origin}/api/monitor?test=1&t=${Date.now()}`;


      const response =
        await fetch(
          monitorUrl,
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

            cache:
              "no-store",

            signal:
              controller.signal
          }
        );


      /* ===================================================
         讀取 Monitor 回傳
      =================================================== */

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


      /* ===================================================
         回傳 Safari
      =================================================== */

      return res
        .status(response.status)
        .json({

          bridgeOk:
            response.ok,

          bridgeEngine:
            "Monitor Test Bridge 1.1",

          forceTest:
            true,

          monitorStatus:
            response.status,

          monitorUrl:
            "/api/monitor?test=1",

          result:
            data
        });


    } finally {

      clearTimeout(timer);
    }


  } catch (error) {

    console.error(
      "monitor-test bridge error:",
      error
    );


    return res
      .status(500)
      .json({

        ok: false,

        engine:
          "Monitor Test Bridge 1.1",

        error:
          error?.name === "AbortError"
            ? "Monitor 測試超過 290 秒"
            : error?.message ||
              "Monitor 測試失敗"
      });
  }
};
