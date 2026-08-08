// ======= 【Gamer DoH Hub - 零报错终极完全体 (HTTP/3 优化版)】 =======

// 提示：Cloudflare Workers 的 fetch API 必须使用 https:// 前缀。
// Cloudflare 边缘节点会自动与这些上游建立 HTTP/3 (QUIC) 链接，切勿改为 h3://
const SPEED_RACE_UPSTREAMS = [
  'https://dns.google/dns-query',                 // 1. 谷歌全球 Anycast (原生支持 H3)
  'https://cloudflare-dns.com/dns-query',         // 2. Cloudflare DNS (原生支持 H3)
  'https://doh.opendns.com/dns-query'             // 3. OpenDNS (Cisco)
];

const ULTIMATE_FALLBACK_UPSTREAM = 'https://dns.google/dns-query';

const GAME_KEYWORDS = [
  'game', 'steam', 'epic', 'pubg', 'apex', 'riot', 'ea', 'sony', 'playstation', 'xbox', 'nintendo',
  'warthunder', 'gaijin', 'netgames', 'wargaming', 'wotblitz', 'tankcompany', 'battle', 'pjsekai', 'sega',
  'youtube', 'googlevideo', 'ytimg', 'netflix', 'nflxvideo', 'garena', 'lol', 'bilibili'
];

const RACE_TIMEOUT_MS = 1800;
const MIN_TTL_NORMAL = 3600; 
const MIN_TTL_GAME = 60;     
const BEST_UPSTREAM_TTL_SEC = 300; 

function processDnsMessage(arrayBuffer, minTtl) {
  const view = new DataView(arrayBuffer);
  try {
    if (arrayBuffer.byteLength < 12) return arrayBuffer;
    
    const qdcount = view.getUint16(4);
    let ancount = view.getUint16(6);
    const nscount = view.getUint16(8);
    const arcount = view.getUint16(10);
    
    let offset = 12;
    for (let i = 0; i < qdcount; i++) {
      while (offset < arrayBuffer.byteLength) {
        const len = view.getUint8(offset);
        if (len === 0) { offset += 1; break; }
        if ((len & 0xC0) === 0xC0) { offset += 2; break; }
        offset += 1 + len;
      }
      if (offset + 4 <= arrayBuffer.byteLength) offset += 4;
    }
    
    const totalRecords = ancount + nscount + arcount;
    for (let i = 0; i < totalRecords; i++) {
      if (offset >= arrayBuffer.byteLength) break;
      while (offset < arrayBuffer.byteLength) {
        const len = view.getUint8(offset);
        if (len === 0) { offset += 1; break; }
        if ((len & 0xC0) === 0xC0) { offset += 2; break; }
        offset += 1 + len;
      }
      if (offset + 10 > arrayBuffer.byteLength) break;
      const rtype = view.getUint16(offset);
      offset += 4;
      const currentTtl = view.getUint32(offset);
      if (currentTtl < minTtl && rtype !== 41) {
        view.setUint32(offset, minTtl);
      }
      offset += 4;
      const rdlen = view.getUint16(offset);
      offset += 2 + rdlen;
    }
  } catch (e) {
    console.error("DNS 报文修改失败:", e);
  }
  return arrayBuffer;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const isDnsQuery = path.includes('/dns-query') || url.searchParams.has('dns') || url.searchParams.has('name');

    if (!isDnsQuery) {
      const html = '<!DOCTYPE html>' +
'<html lang="zh-CN">' +
'<head>' +
'    <meta charset="UTF-8">' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'    <title>专用 DoH DNS 服务</title>' +
'    <style>' +
'        body { background: #0d1117; color: #c9d1d9; font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }' +
'        .container { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 35px; text-align: center; max-width: 480px; width: 90%; }' +
'        h1 { font-size: 22px; margin: 10px 0; color: #58a6ff; }' +
'        .status-tag { display: inline-flex; align-items: center; background: rgba(56, 139, 253, 0.15); color: #58a6ff; padding: 6px 16px; border-radius: 20px; font-size: 13px; font-weight: bold; margin: 15px 0; border: 1px solid rgba(56, 139, 253, 0.3); }' +
'        .dot { width: 8px; height: 8px; background-color: #3fb950; border-radius: 50%; margin-right: 8px; }' +
'        .info-box { background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 15px; text-align: left; font-size: 13px; font-family: monospace; margin-top: 15px; }' +
'        .info-item { margin: 8px 0; display: flex; justify-content: space-between; }' +
'        .value { color: #79c0ff; word-break: break-all; }' +
'        button { background: #238636; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-top: 15px; width: 100%; }' +
'        pre { background: #0d1117; padding: 10px; border-radius: 6px; text-align: left; white-space: pre-wrap; font-size: 12px; color: #7ee787; border: 1px solid #30363d; max-height: 150px; overflow-y: auto; }' +
'    </style>' +
'</head>' +
'<body>' +
'    <div class="container">' +
'        <div style="font-size:42px;">🚀</div>' +
'        <h1>专用 DoH DNS 服务</h1>' +
'        <div class="status-tag"><span class="dot"></span> Anycast 弹性集群就绪</div>' +
'        <div class="info-box">' +
'            <div class="info-item"><span style="color:#8b949e">DoH 地址:</span><span class="value" style="font-weight:bold;color:#58a6ff;">' + url.origin + '/dns-query</span></div>' +
'            <div class="info-item"><span style="color:#8b949e">防护机制:</span><span class="value" style="color:#3fb950;">防 405 熔断 / 智能 ECS / 边缘 Cache</span></div>' +
'        </div>' +
'        <button onclick="testDns()">⚡ 实时测试 JSON 解析 (baidu.com)</button>' +
'        <pre id="r" style="display:none;"></pre>' +
'    </div>' +
'    <script>' +
'    async function testDns(){' +
'        const r = document.getElementById("r");' +
'        r.style.display = "block";' +
'        r.textContent = "正在发起竞速解析...";' +
'        try {' +
'            const res = await fetch("' + url.origin + '/dns-query?name=baidu.com&type=A");' +
'            if(!res.ok) throw new Error("HTTP Status " + res.status);' +
'            r.textContent = JSON.stringify(await res.json(), null, 2);' +
'        } catch(e) {' +
'            r.textContent = "解析异常: " + e.message;' +
'        }' +
'    }' +
'    </script>' +
'</body>' +
'</html>';
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    let cacheKeyUrl = new URL(request.url);
    let dnsBuffer = null;
    let isGet = request.method === 'GET';

    if (isGet) {
      const dnsParam = url.searchParams.get('dns') || url.searchParams.get('name') || '';
      cacheKeyUrl.pathname = `/cache/GET/${encodeURIComponent(dnsParam)}`;
    } else {
      dnsBuffer = new Uint8Array(await request.arrayBuffer());
      const postHash = btoa(String.fromCharCode(...dnsBuffer.slice(0, 64))).replace(/=/g, '').replace(/\//g, '_');
      cacheKeyUrl.pathname = `/cache/POST/${postHash}`;
    }

    const cfLocation = request.cf?.country || "";
    let clientIp = '114.44.0.1'; 
    if (cfLocation === "JP") clientIp = '61.211.0.1';   
    else if (cfLocation === "SG") clientIp = '175.156.0.1';  
    else if (cfLocation === "HK") clientIp = '203.198.0.1';  
    else if (cfLocation === "US") clientIp = '8.8.8.8';
    else if (cfLocation === "EU") clientIp = '1.1.1.1';

    const cache = caches.default;

    let cachedResponse = await cache.match(new Request(cacheKeyUrl.toString(), { method: 'GET' }));
    if (cachedResponse) {
      let hitResponse = new Response(cachedResponse.body, cachedResponse);
      hitResponse.headers.set('X-Cache-Status', 'HIT_HUB');
      return hitResponse;
    }

    const upstreamCacheKey = `${url.origin}/internal/best-upstream?region=${cfLocation}`;
    let cachedBestUpstreamRes = await cache.match(new Request(upstreamCacheKey));
    let preferredUpstream = cachedBestUpstreamRes ? await cachedBestUpstreamRes.text() : null;

    async function fetchFromUpstream(upstream, timeoutMs) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      
      const upstreamHeaders = new Headers();
      const isJsonRequest = url.searchParams.has('name') && !url.searchParams.has('dns');
      upstreamHeaders.set('Accept', isJsonRequest ? 'application/dns-json' : 'application/dns-message');

      let fetchUrl = upstream;
      
      const supportsEcs = upstream.includes('dns.google') || upstream.includes('alidns');
      const ecsQuery = (supportsEcs && isGet) ? `&edns_client_subnet=${clientIp}` : '';

      if (isGet) {
        fetchUrl = `${upstream}?${url.searchParams.toString()}${ecsQuery}`;
      } else {
        upstreamHeaders.set('Content-Type', 'application/dns-message');
      }

      // 优化网络请求设置：让 Cloudflare 边缘节点自动复用 HTTP/2 和 HTTP/3 高速长连接
      const fetchInit = {
        method: isGet ? 'GET' : 'POST',
        headers: upstreamHeaders,
        signal: controller.signal,
        cf: { 
          cacheTtl: 5, 
          cacheEverything: true
        }
      };

      if (!isGet && dnsBuffer) {
        fetchInit.body = dnsBuffer.slice();
      }

      try {
        const res = await fetch(fetchUrl, fetchInit);
        clearTimeout(id);
        if (!res.ok) throw new Error(`Upstream Status: ${res.status}`);
        return { response: res, source: upstream };
      } catch (e) {
        clearTimeout(id);
        throw e;
      }
    }

    let finalDnsResult = null;
    let chosenSource = "";

    if (preferredUpstream && SPEED_RACE_UPSTREAMS.includes(preferredUpstream)) {
      try {
        const resObj = await fetchFromUpstream(preferredUpstream, 700);
        finalDnsResult = resObj.response;
        chosenSource = resObj.source;
      } catch (err) {
        preferredUpstream = null; 
      }
    }

    if (!finalDnsResult) {
      const racePromises = SPEED_RACE_UPSTREAMS.map(upstream => 
        fetchFromUpstream(upstream, RACE_TIMEOUT_MS)
      );

      try {
        const fastestObj = await Promise.race(racePromises);
        finalDnsResult = fastestObj.response;
        chosenSource = fastestObj.source;

        const saveBestUpstreamResponse = new Response(chosenSource, {
          headers: { 'Cache-Control': `public, max-age=${BEST_UPSTREAM_TTL_SEC}` }
        });
        ctx.waitUntil(cache.put(new Request(upstreamCacheKey), saveBestUpstreamResponse));

      } catch (err) {
        try {
          const fallbackObj = await fetchFromUpstream(ULTIMATE_FALLBACK_UPSTREAM, 3000);
          finalDnsResult = fallbackObj.response;
          chosenSource = fallbackObj.source;
        } catch (fatalErr) {
          return new Response(`DNS Upstream Timeout`, { status: 504 });
        }
      }
    }

    try {
      const contentType = finalDnsResult.headers.get('content-type') || '';
      
      if (contentType.includes('json') || url.searchParams.has('name')) {
        const jsonText = await finalDnsResult.text();
        const cacheResponse = new Response(jsonText, {
          status: 200,
          headers: {
            'Content-Type': 'application/dns-json',
            'Cache-Control': `public, max-age=${MIN_TTL_GAME}`,
            'Access-Control-Allow-Origin': '*'
          }
        });
        ctx.waitUntil(cache.put(new Request(cacheKeyUrl.toString(), { method: 'GET' }), cacheResponse.clone()));
        return cacheResponse;
      }

      let responseData = await finalDnsResult.arrayBuffer();
      const isGameRequest = GAME_KEYWORDS.some(keyword => url.searchParams.toString().toLowerCase().includes(keyword));
      const targetMinTtl = isGameRequest ? MIN_TTL_GAME : MIN_TTL_NORMAL;
      
      responseData = processDnsMessage(responseData, targetMinTtl);

      const cacheResponse = new Response(responseData, {
        status: 200,
        headers: {
          'Content-Type': 'application/dns-message',
          'Cache-Control': `public, max-age=${targetMinTtl}`, 
          'X-Selected-Upstream': chosenSource,
          'Access-Control-Allow-Origin': '*'
        }
      });

      ctx.waitUntil(cache.put(new Request(cacheKeyUrl.toString(), { method: 'GET' }), cacheResponse.clone()));
      return cacheResponse;
    } catch(e) {
      return new Response(`DNS Processing Error: ${e.message}`, { status: 502 });
    }
  }
};
