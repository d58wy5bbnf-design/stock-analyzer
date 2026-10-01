import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL,

  token:
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN
});

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

export default async function handler(req, res) {

  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate'
  );

  try {

    /* ==============================
       GET：取得雲端自選
    ============================== */

    if (req.method === 'GET') {

      const deviceId =
        cleanDeviceId(req.query?.deviceId);

      if (!deviceId) {
        return res.status(400).json({
          ok: false,
          error: '缺少 deviceId'
        });
      }

      const key =
        `watchlist:${deviceId}`;

      const saved =
        await redis.get(key);

      let symbols = [];

      if (Array.isArray(saved)) {
        symbols = cleanSymbols(saved);
      }
      else if (typeof saved === 'string') {

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
        symbols
      });

    }


    /* ==============================
       POST：儲存雲端自選
    ============================== */

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

      await redis.set(
        key,
        symbols
      );

      return res.status(200).json({
        ok: true,
        deviceId,
        symbols,
        count: symbols.length
      });

    }


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
      'watchlist api error',
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        '自選同步失敗'
    });

  }

}
