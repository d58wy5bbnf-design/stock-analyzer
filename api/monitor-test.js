/* =========================================================
   api/monitor-test.js
   Monitor 8.0 Direct Force Test

   用途：
   - Safari 直接開啟即可測試
   - 直接執行 monitor.js
   - 強制 x-monitor-test = 1
   - 強制 test = 1
   - 自動帶入 CRON_SECRET
   - 凌晨也可以測試
   - 不修改正式 Cron
========================================================= */

const monitor =
  require("./monitor.js");


module.exports =
async function handler(
  req,
  res
) {

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );


  try {

    /* =====================================================
       CRON SECRET
    ===================================================== */

    const secret =
      process.env.CRON_SECRET;


    if (!secret) {

      return res
        .status(500)
        .json({

          ok:
            false,

          bridgeEngine:
            "Monitor Test Bridge 8.0",

          error:
            "CRON_SECRET 尚未設定"

        });

    }


    /* =====================================================
       保存原始 request
    ===================================================== */

    const originalUrl =
      req.url;


    const originalQuery =
      req.query;


    const originalAuthorization =
      req.headers.authorization;


    const originalTestHeader =
      req.headers["x-monitor-test"];


    /* =====================================================
       強制 TEST MODE
    ===================================================== */

    req.query = {

      ...(req.query || {}),

      test:
        "1"

    };


    /*
      monitor.js 的 getTestMode()
      會同時檢查：

      x-monitor-test
      query.test
      URL ?test=1

      三個全部強制設成 1。
    */

    req.headers.authorization =
      `Bearer ${secret}`;


    req.headers["x-monitor-test"] =
      "1";


    const separator =
      String(req.url || "")
        .includes("?")
        ?
        "&"
        :
        "?";


    req.url =
      `${req.url || "/api/monitor-test"}${separator}test=1&t=${Date.now()}`;


    /* =====================================================
       標記 Bridge
    ===================================================== */

    res.setHeader(
      "X-Monitor-Test-Bridge",
      "8.0"
    );


    /*
      直接執行正式 monitor。

      不再 fetch /api/monitor，
      所以不會出現：

      bridge forceTest = true
      但 monitor testMode = false

      的狀況。
    */

    try {

      return await monitor(
        req,
        res
      );

    }
    finally {

      /*
        還原 request。
        雖然 Serverless request 通常只使用一次，
        仍保持乾淨。
      */

      req.url =
        originalUrl;


      req.query =
        originalQuery;


      if (
        originalAuthorization ===
        undefined
      ) {

        delete req.headers.authorization;

      }
      else {

        req.headers.authorization =
          originalAuthorization;

      }


      if (
        originalTestHeader ===
        undefined
      ) {

        delete req.headers["x-monitor-test"];

      }
      else {

        req.headers["x-monitor-test"] =
          originalTestHeader;

      }

    }


  }
  catch (error) {

    console.error(
      "Monitor Test Bridge 8.0 error:",
      error
    );


    /*
      如果 monitor 已經送出 response，
      不能再送第二次。
    */

    if (
      res.headersSent
    ) {

      return;

    }


    return res
      .status(500)
      .json({

        ok:
          false,

        bridgeEngine:
          "Monitor Test Bridge 8.0",

        forceTest:
          true,

        error:
          error?.message ||
          "Monitor 測試失敗"

      });

  }

};
