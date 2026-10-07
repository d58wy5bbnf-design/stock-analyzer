/* =========================================================
   sw.js
   台股波段分析 Web Push Service Worker
   Version 2.0

   功能：
   1. 網站關閉後仍可接收 Push
   2. 顯示 iPhone 系統通知
   3. 點通知後開啟網站
   4. 帶股票代號回網站
   5. HTML / 導覽頁優先取得最新版本
   6. 清除舊 Cache Storage
========================================================= */

const SW_VERSION = "stock-analyzer-sw-v2-20261008";


/* =========================================================
   安裝
========================================================= */

self.addEventListener(
  "install",
  event => {

    /*
      新 Service Worker 安裝完成後，
      不等待舊版本結束，
      直接進入啟用階段。
    */

    self.skipWaiting();

  }
);


/* =========================================================
   啟用
========================================================= */

self.addEventListener(
  "activate",
  event => {

    event.waitUntil(

      Promise.all([

        /*
          清掉以前可能留下來的 Cache Storage。

          目前這個 App 不需要使用離線 HTML Cache，
          所以全部刪除最乾淨。
        */

        caches
          .keys()
          .then(
            keys =>
              Promise.all(
                keys.map(
                  key =>
                    caches.delete(key)
                )
              )
          ),

        /*
          新版 Service Worker
          立刻控制目前已經開啟的頁面。
        */

        self.clients.claim()

      ])

    );

  }
);


/* =========================================================
   FETCH

   重要：
   導覽頁 / index.html 永遠優先走網路。

   目的：
   GitHub / Vercel 部署新版 index.html 後，
   iPhone 主畫面 PWA 不要一直顯示舊版頁面。
========================================================= */

self.addEventListener(
  "fetch",
  event => {

    const request = event.request;


    /*
      只處理 GET。
    */

    if (
      request.method !== "GET"
    ) {

      return;

    }


    const url =
      new URL(
        request.url
      );


    /*
      不攔截其他網域。
    */

    if (
      url.origin !==
      self.location.origin
    ) {

      return;

    }


    /*
      HTML 導覽請求：
      強制向網路取得最新版。

      cache: "no-store"
      避免瀏覽器 HTTP Cache
      繼續拿舊 index.html。
    */

    if (
      request.mode === "navigate"
    ) {

      event.respondWith(

        fetch(
          request,
          {
            cache:
              "no-store"
          }
        )
        .catch(
          () =>
            new Response(
              `
              <!doctype html>
              <html lang="zh-Hant">
              <head>
                <meta charset="utf-8">
                <meta
                  name="viewport"
                  content="width=device-width,initial-scale=1"
                >
                <title>波段分析</title>
              </head>

              <body
                style="
                  font-family:
                    -apple-system,
                    BlinkMacSystemFont,
                    sans-serif;
                  padding:30px;
                "
              >

                <h2>
                  波段分析
                </h2>

                <p>
                  目前網路連線異常，請稍後重新開啟。
                </p>

              </body>
              </html>
              `,
              {
                status: 503,

                headers: {
                  "Content-Type":
                    "text/html; charset=utf-8",

                  "Cache-Control":
                    "no-store"
                }
              }
            )
        )

      );

      return;

    }


    /*
      index.html 即使不是 navigate，
      也強制走最新版。
    */

    if (
      url.pathname === "/" ||
      url.pathname === "/index.html"
    ) {

      event.respondWith(

        fetch(
          request,
          {
            cache:
              "no-store"
          }
        )

      );

      return;

    }


    /*
      API 不做 Service Worker Cache。

      /api/radar
      /api/stock
      /api/news
      /api/search
      /api/watchlist
      等全部直接交給網路。
    */

    if (
      url.pathname.startsWith(
        "/api/"
      )
    ) {

      return;

    }


    /*
      其他檔案：
      manifest、圖片等等，
      直接交給瀏覽器正常處理。
    */

  }
);


/* =========================================================
   收到 Push
========================================================= */

self.addEventListener(
  "push",
  event => {

    let data = {};


    try {

      if (
        event.data
      ) {

        data =
          event.data.json();

      }

    }

    catch {

      try {

        data = {

          body:
            event.data
              ?
              event.data.text()
              :
              ""

        };

      }

      catch {

        data = {};

      }

    }


    const symbol =
      String(
        data.symbol ||
        ""
      );


    const name =
      String(
        data.name ||
        ""
      );


    const title =
      data.title ||
      (
        name ||
        symbol
          ?
          `🟢 ${name || symbol}｜進場訊號`
          :
          "🟢 台股進場訊號"
      );


    const body =
      data.body ||
      "偵測到符合波段策略的進場機會";


    /*
      加上時間參數。

      點通知時也盡量取得最新版 index.html。
    */

    const baseUrl =
      data.url ||
      (
        symbol
          ?
          "/?stock=" +
            encodeURIComponent(
              symbol
            )
          :
          "/"
      );


    const separator =
      baseUrl.includes("?")
        ?
        "&"
        :
        "?";


    const url =
      baseUrl +
      separator +
      "_push=" +
      Date.now();


    /*
      同一檔股票使用同一個 tag，
      避免短時間堆出大量重複通知。
    */

    const tag =
      data.tag ||
      (
        symbol
          ?
          "entry-" +
            symbol
          :
          "entry-signal"
      );


    const options = {

      body,

      tag,

      renotify:
        true,

      requireInteraction:
        false,

      data: {

        url,

        symbol,

        type:
          data.type ||
          "entry"

      }

    };


    event.waitUntil(

      self.registration
        .showNotification(
          title,
          options
        )

    );

  }
);


/* =========================================================
   點擊通知
========================================================= */

self.addEventListener(
  "notificationclick",
  event => {

    event.notification.close();


    const targetUrl =
      event.notification
        ?.data
        ?.url ||
      "/";


    event.waitUntil(

      self.clients
        .matchAll({

          type:
            "window",

          includeUncontrolled:
            true

        })

        .then(
          clients => {

            /*
              如果 Web App 已經存在，
              直接切回去並開啟股票。
            */

            for (
              const client
              of clients
            ) {

              if (
                "focus"
                in client
              ) {

                if (
                  "navigate"
                  in client
                ) {

                  return client
                    .navigate(
                      targetUrl
                    )
                    .then(
                      () =>
                        client.focus()
                    );

                }


                return client.focus();

              }

            }


            /*
              App 完全沒開，
              開啟新的 Web App 視窗。
            */

            if (
              self.clients
                .openWindow
            ) {

              return self.clients
                .openWindow(
                  targetUrl
                );

            }

          }
        )

    );

  }
);


/* =========================================================
   關閉通知
========================================================= */

self.addEventListener(
  "notificationclose",
  event => {

    /*
      暫時不處理。

      未來可加入：
      - 通知忽略率
      - 點擊率
      - 訊號統計
    */

  }
);


/* =========================================================
   MESSAGE

   未來如果需要從網頁要求 SW 立即更新，
   可以直接送 SKIP_WAITING。
========================================================= */

self.addEventListener(
  "message",
  event => {

    if (
      event.data ===
      "SKIP_WAITING"
    ) {

      self.skipWaiting();

    }

  }
);
