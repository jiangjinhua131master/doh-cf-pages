const UPSTREAMS = [
  { name: 'Google', url: 'https://dns.google/dns-query' },
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'AliDNS', url: 'https://dns.alidns.com/dns-query' },
  { name: 'Tencent', url: 'https://doh.pub/dns-query' },
  { name: 'DNS.SB', url: 'https://doh.dns.sb/dns-query' },
];

let currentMain = null;
let mainLockUntil = 0;
const CACHE = new Map();

export const onRequest = async ({ request }) => {
  const url = new URL(request.url);
  const path = url.pathname;

  // 网页界面
  if (path === '/' || path === '') {
    return new Response(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head><meta charset="UTF-8"><title>专用 DoH</title>
      <style>body{background:#0f172a;color:#e2e8f0;padding:2rem;text-align:center;}</style>
      </head>
      <body>
        <h1>🚀 专用 DoH DNS 服务</h1>
        <p>DoH 地址: <code>${url.origin}/dns-query</code></p>
        <p>当前主用: ${currentMain ? currentMain.name : '自动'}</p>
        <button onclick="test()">测试 baidu.com</button>
        <pre id="r" style="margin-top:20px;background:#1e2937;padding:15px;border-radius:8px;text-align:left;"></pre>
        <script>
          async function test() {
            const res = await fetch('${url.origin}/dns-query?name=baidu.com&type=A');
            document.getElementById('r').textContent = await res.text();
          }
        </script>
      </body></html>
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
