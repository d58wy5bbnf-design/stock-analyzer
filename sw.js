/* =========================================================
   sw.js
   台股波段分析 Web Push Service Worker

   功能：
   1. 網站關閉後仍可接收 Push
   2. 顯示 iPhone 系統通知
   3. 點通知後開啟網站
   4. 帶股票代號回網站
========================================================= */


/* 安裝 */

self.addEventListener(
  "install",
  event => {

    self.skipWaiting();

  }
);


/* 啟用 */

self.addEventListener(
  "activate",
  event => {

    event.waitUntil(
      self.clients.claim()
    );

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

      if (event.data) {

        data =
          event.data.json();

      }

    } catch {

      try {

        data = {
          body:
            event.data
              ? event.data.text()
              : ""
        };

      } catch {

        data = {};

      }

    }


    const symbol =
      String(
        data.symbol || ""
      );


    const name =
      String(
        data.name || ""
      );


    const title =
      data.title ||
      (
        name || symbol
          ?
          `🟢 ${name || symbol}｜進場訊號`
          :
          "🟢 台股進場訊號"
      );


    const body =
      data.body ||
      "偵測到符合波段策略的進場機會";


    const url =
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


    /*
      tag 很重要。

      同一支股票使用同一個 tag，
      避免 iPhone 短時間堆出
      一大串完全相同的通知。
    */

    const tag =
      data.tag ||
      (
        symbol
          ?
          "entry-" + symbol
          :
          "entry-signal"
      );


    const options = {

      body,

      tag,

      renotify: true,

      requireInteraction: false,

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

                /*
                  navigate 可以讓原本已開啟的
                  Web App 直接切到該股票網址。
                */

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
              直接開新的 Web App 視窗。
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
      現階段不需要回傳任何資料。

      保留事件，
      之後如果要做：
      - 通知點擊率
      - 忽略率
      - 訊號統計
      可以直接擴充。
    */

  }
);
