const UPSTREAMS = [
  { name: 'Google', url: 'https://dns.google/dns-query', qps: 1500 },
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query', qps: 10000 },
  { name: 'AliDNS', url: 'https://dns.alidns.com/dns-query', qps: 20 },
  { name: 'Tencent', url: 'https://doh.pub/dns-query', qps: 20 },
  { name: 'DNS.SB', url: 'https://doh.dns.sb/dns-query', qps: 500 }
];

let currentMain = null;
let mainLockUntil = 0;
const CACHE = new Map();
const STATS = new Map(); // 限速计数

export const onRequest = async ({ request }) => {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/' || path === '') {
    return new Response(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head><meta charset="UTF-8"><title>专用 DoH</title>
      <style>body{background:#0f172a;color:#e2e8f0;padding:2rem;text-align:center;}</style>
      </head>
      <body>
        <h1>🚀 专用 DoH DNS 服务 (弹性 + 缓存)</h1>
        <p>DoH 地址: <code>${url.origin}/dns-query</code></p>
        <button onclick="test()">测试 baidu.com</button>
        <pre id="r" style="margin-top:20px;background:#1e2937;padding:15px;border-radius:8px;text-align:left;"></pre>
        <script>async function test(){const res=await fetch('${url.origin}/dns-query?name=baidu.com&type=A');document.getElementById('r').textContent=await res.text();}</script>
      </body></html>
    `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (path.includes('/dns-query')) {
    const cacheKey = url.search || url.pathname;

    // 缓存命中
    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);
      if (Date.now() < cached.expires) return new Response(cached.body, { headers: cached.headers });
    }

    // 智能主用 + 限速熔断
    if (Date.now() > mainLockUntil || !currentMain) {
      currentMain = UPSTREAMS[0];
      mainLockUntil = Date.now() + 5 * 60 * 1000; // 5分钟锁定
    }

    let target = currentMain;

    // 限速检查
    const now = Date.now();
    if (!STATS.has(target.name)) STATS.set(target.name, []);
    const times = STATS.get(target.name);
    times.push(now);
    while (times.length && times[0] < now - 60000) times.shift();

    if (times.length > target.qps * 0.8) {
      // 切换备用
      target = UPSTREAMS.find(u => u !== target && (STATS.get(u.name) || []).length < u.qps * 0.6) || target;
    }

    try {
      const res = await fetch(target.url + url.search, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'POST' ? request.body : null
      });

      if (res.ok) {
        const bodyText = await res.clone().text();
        let ttl = 300;
        try {
          const json = JSON.parse(bodyText);
          if (json.Answer && json.Answer[0]) ttl = json.Answer[0].TTL || 300;
        } catch (e) {}

        CACHE.set(cacheKey, {
          body: bodyText,
          headers: Object.fromEntries(res.headers),
          expires: Date.now() + ttl * 1000
        });

        return res;
      }
    } catch (e) {
      mainLockUntil = 0; // 失败切换
    }

    return new Response('上游错误', { status: 502 });
  }

  return new Response('404', { status: 404 });
};      </body></html>
    `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (path.includes('/dns-query')) {
    const cacheKey = url.pathname + url.search;
    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);
      if (Date.now() < cached.expires) return new Response(cached.body, { headers: cached.headers });
    }

    // 智能主用 + 熔断
    if (Date.now() > mainLockUntil || !currentMain) {
      currentMain = UPSTREAMS[Math.floor(Math.random() * UPSTREAMS.length)];
      mainLockUntil = Date.now() + 5 * 60 * 1000; // 5分钟锁定
    }

    const target = currentMain.url;

    try {
      const res = await fetch(target + url.search, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'POST' ? request.body : null
      });

      if (res.ok) {
        const body = await res.clone().text();
        CACHE.set(cacheKey, { body, headers: Object.fromEntries(res.headers), expires: Date.now() + 300000 });
        return res;
      }
    } catch (e) {
      mainLockUntil = 0; // 失败立即切换
    }

    return new Response('上游错误', { status: 502 });
  }

  return new Response('404', { status: 404 });
};    for (const u of UPSTREAMS) {
      try {
        const res = await fetch(u + url.search, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'POST' ? request.body : null
        });
        if (res.ok) return res;
      } catch (e) {}
    }
    return new Response('上游不可用', { status: 502 });
  }

  return new Response('404', { status: 404 });
};                'Content-Type': contype,
            },
            body: request.body,
        });
		 } else {
        return new Response("", {status: 404})
    }
}
