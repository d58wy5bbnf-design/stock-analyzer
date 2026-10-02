const https = require("https");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  const token = process.env.FINMIND_TOKEN;

  if (!token) {
    return res.status(500).json({
      ok: false,
      error: "找不到 FINMIND_TOKEN",
    });
  }

  try {
    const result = await getUsage(token);

    const used =
      Number(
        result.user_count ??
        result.api_usage ??
        result.used ??
        result.count
      ) || 0;

    const limit =
      Number(
        result.api_request_limit ??
        result.api_usage_limit ??
        result.limit
      ) || 0;

    const remaining =
      limit > 0 ? Math.max(0, limit - used) : null;

    return res.status(200).json({
      ok: true,

      finmind: {
        used,
        limit,
        remaining,

        usagePercent:
          limit > 0
            ? Number(((used / limit) * 100).toFixed(2))
            : null,
      },

      raw: result,
    });
  } catch (error) {
    console.error("FinMind usage error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "FinMind usage 查詢失敗",
    });
  }
};

function getUsage(token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.web.finmindtrade.com",
      path: "/v2/user_info",
      method: "GET",

      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "Stock-Analyzer/1.0",
      },
    };

    const request = https.request(options, (response) => {
      let body = "";

      response.on("data", (chunk) => {
        body += chunk;
      });

      response.on("end", () => {
        let data;

        try {
          data = JSON.parse(body);
        } catch {
          return reject(
            new Error(
              `FinMind 回傳格式錯誤 HTTP ${response.statusCode}`
            )
          );
        }

        if (
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          return reject(
            new Error(
              data?.msg ||
              data?.message ||
              `FinMind HTTP ${response.statusCode}`
            )
          );
        }

        resolve(data);
      });
    });

    request.setTimeout(15000, () => {
      request.destroy(
        new Error("FinMind API timeout")
      );
    });

    request.on("error", reject);

    request.end();
  });
}
