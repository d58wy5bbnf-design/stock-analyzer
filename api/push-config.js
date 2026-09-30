/* =========================================================
   api/push-config.js

   提供前端 Web Push 公鑰。
   私鑰永遠不傳到前端。
========================================================= */

module.exports = async function handler(req, res) {

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  if (req.method !== "GET") {

    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed"
    });

  }

  try {

    const publicKey =
      process.env.VAPID_PUBLIC_KEY;

    if (!publicKey) {

      return res.status(500).json({
        ok: false,
        error: "VAPID_PUBLIC_KEY 尚未設定"
      });

    }

    return res.status(200).json({

      ok: true,

      publicKey

    });

  } catch (error) {

    console.error(
      "push config error:",
      error
    );

    return res.status(500).json({

      ok: false,

      error:
        error?.message ||
        "Push 設定取得失敗"

    });

  }

};
