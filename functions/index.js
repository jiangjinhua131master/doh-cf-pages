const UPSTREAMS = [
  'https://dns.google/dns-query',
  'https://cloudflare-dns.com/dns-query',
  'https://dns.alidns.com/dns-query',
  'https://doh.pub/dns-query',
  'https://doh.dns.sb/dns-query',
  'https://doh.opendns.com/dns-query'
];

export const onRequest = async ({ request }) => {
  const url = new URL(request.url);

  if (url.pathname === '/' || url.pathname === '') {
    return new Response(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head><meta charset="UTF-8"><title>专用 DoH</title>
      <style>body{background:#0f172a;color:#e2e8f0;padding:2rem;text-align:center;font-family:sans-serif;}</style>
      </head>
      <body>
        <h1>🚀 专用 DoH DNS 服务</h1>
        <p>DoH 地址: <code>${url.origin}/dns-query</code></p>
        <button onclick="test()">测试 baidu.com</button>
        <pre id="r" style="margin-top:20px;background:#1e2937;padding:15px;border-radius:8px;text-align:left;"></pre>
        <script>
          async function test() {
            const res = await fetch('${url.origin}/dns-query?name=baidu.com&type=A');
            const data = await res.text();
            document.getElementById('r').textContent = data;
          }
        </script>
      </body></html>
    `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (url.pathname.includes('/dns-query')) {
    for (const u of UPSTREAMS) {
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
