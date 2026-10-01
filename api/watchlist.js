function cleanDeviceId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 120);
}

function cleanSymbols(value) {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .map(x => String(x || '').trim())
        .filter(x => /^\d{4,6}$/.test(x))
    )
  ].slice(0, 200);
}


/* =========================================================
   Redis REST
========================================================= */

function getRedisConfig() {

  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;

  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error('缺少 Upstash Redis 環境變數');
  }

  return {
    url: url.replace(/\/+$/, ''),
    token
  };
}


async function redisCommand(command) {

  const { url, token } =
    getRedisConfig();

  const r =
    await fetch(url, {
      method: 'POST',

      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },

      body:
        JSON.stringify(command)
    });

  let data;

  try {
    data = await r.json();
  }
  catch {
    throw new Error(
      'Redis 回傳格式錯誤'
    );
  }

  if (!r.ok) {
    throw new Error(
      data?.error ||
      `Redis HTTP ${r.status}`
    );
  }

  if (data?.error) {
    throw new Error(
      data.error
    );
  }

  return data?.result;
}


/* =========================================================
   API
========================================================= */

export default async function handler(req, res) {

  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate'
  );

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  try {

    /* =====================================================
       GET
       取得自選
    ===================================================== */

    if (req.method === 'GET') {

      const deviceId =
        cleanDeviceId(
          req.query?.deviceId
        );

      if (!deviceId) {

        return res.status(400).json({
          ok: false,
          error: '缺少 deviceId'
        });

      }

      const key =
        `watchlist:${deviceId}`;

      const saved =
        await redisCommand([
          'GET',
          key
        ]);

      let symbols = [];

      if (saved) {

        try {

          symbols =
            cleanSymbols(
              JSON.parse(saved)
            );

        }
        catch {

          symbols = [];

        }

      }

      return res.status(200).json({
        ok: true,
        deviceId,
        symbols,
        count: symbols.length
      });

    }


    /* =====================================================
       POST
       儲存自選
    ===================================================== */

    if (req.method === 'POST') {

      const deviceId =
        cleanDeviceId(
          req.body?.deviceId
        );

      const symbols =
        cleanSymbols(
          req.body?.symbols
        );

      if (!deviceId) {

        return res.status(400).json({
          ok: false,
          error: '缺少 deviceId'
        });

      }

      const key =
        `watchlist:${deviceId}`;

      await redisCommand([
        'SET',
        key,
        JSON.stringify(symbols)
      ]);

      return res.status(200).json({
        ok: true,
        deviceId,
        symbols,
        count: symbols.length
      });

    }


    /* =====================================================
       其他 Method
    ===================================================== */

    res.setHeader(
      'Allow',
      'GET, POST'
    );

    return res.status(405).json({
      ok: false,
      error: 'Method Not Allowed'
    });

  }
  catch (error) {

    console.error(
      'watchlist error:',
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        '雲端自選同步失敗'
    });

  }

}
