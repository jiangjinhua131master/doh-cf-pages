// ======= 【Gamer DoH Hub - 无 Cloudflare DNS 纯净版】 =======

// 自定义纯净 upstream 池 (已完全剔除 Cloudflare 所有 DNS 节点)
const SPEED_RACE_UPSTREAMS = [
  'https://dns.google/dns-query',                 // 1. 谷歌全球 Anycast
  'https://dns.alidns.com/dns-query',             // 2. 阿里云公共 DNS
  'https://doh.pub/dns-query',                    // 3. 腾讯云公共 DNS
  'https://doh.opendns.com/dns-query',            // 4. OpenDNS (Cisco) 
  'https://doh.dns.sb/dns-query',                 // 5. DNS.SB 极速专线
  'https://dns11.quad9.net/dns-query'             // 6. Quad9 隐私加强
];

// 万能兜底节点 (当竞速全部失败时使用，剔除 Cloudflare)
const ULTIMATE_FALLBACK_UPSTREAM = 'https://dns.google/dns-query';

const GAME_KEYWORDS = [
  'game', 'steam', 'epic', 'pubg', 'apex', 'riot', 'ea', 'sony', 'playstation', 'xbox', 'nintendo', 
  'warthunder', 'gaijin', 'netgames', 'wargaming', 'wotblitz', 'tankcompany', 'battle', 'pjsekai', 'sega',
  'youtube', 'googlevideo', 'ytimg', 'netflix', 'nflxvideo', 'opendns', 'dnssb', 'garena', 'lol'
];

const RACE_TIMEOUT_MS = 2000;
const MIN_TTL_NORMAL = 3600; 
const MIN_TTL_GAME = 60;     
const BEST_UPSTREAM_TTL_SEC = 300; 

// 二进制 DNS 报文转译与 TTL 改写
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
      if (offset + 4 <= arrayBuffer.byteLength) {
        offset += 4;
      }
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

    // 1️⃣ 控制台 UI (测试界面)
    if (!isDnsQuery) {
      const html = `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>专用 DoH DNS 服务 (无 Cloudflare 节点依赖版)</title>
          <style>
              body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
              .container { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 35px; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.5); max-width: 480px; width: 90%; }
              h1 { font-size: 22px; margin: 10px 0; color: #58a6ff; }
              .status-tag { display: inline-flex; align-items: center; background: rgba(56, 139, 253, 0.15); color: #58a6ff; padding: 6px 16px; border-radius: 20px; font-size: 13px; font-weight: bold; margin: 15px 0; border: 1px solid rgba(56, 139, 253, 0.3); }
              .dot { width: 8px; height: 8px; background-color: #3fb950; border-radius: 50%; margin-right: 8px; box-shadow: 0 0 8px #3fb950; }
              .info-box { background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 15px; text-align: left; font-size: 13px; font-family: monospace; margin-top: 15px; }
              .info-item { margin: 8px 0; display: flex; justify-content: space-between; }
              .value { color: #79c0ff; word-break: break-all; }
              button { background: #238636; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-top: 15px; width: 100%; }
              button:hover { background: #2ea043; }
              pre { background: #0d1117; padding: 10px; border-radius: 6px; text-align: left; white-space: pre-wrap; font-size: 12px; color: #7ee787; border: 1px solid #30363d; max-height: 150px; overflow-y: auto; }
          </style>
      </head>
      <body>
          <div class="container">
              <div style="font-size:42px;">⚡</div>
              <h1>专用 DoH DNS 服务</h1>
              <div class="status-tag"><span class="dot"></span>纯净 Anycast 集群 (防 405)</div>
              
              <div class="info-box">
                  <div class="info-item"><span style="color:#8b949e">DoH 地址:</span><span class="value" style="font-weight:bold;color:#58a6ff;">${url.origin}/dns-query</span></div>
                  <div class="info-item"><span style="color:#8b949e">架构状态:</span><span class="value" style="color:#3fb950;">无 Cloudflare 上游依赖</span></div>
              </div>

              <button onclick="testDns()">⚡ 实时测试解析 (baidu.com)</button>
              <pre id="r" style="display:none;"></pre>
          </div>
          <script>
          async function testDns(){
              const r = document.getElementById('r');
              r.style.display = 'block';
              r.textContent = '正在发起竞速解析...';
              try {
                  const res = await fetch('${url.origin}/dns-query?name=baidu.com&type=A');
                  if(!res.ok) throw new Error('HTTP Status ' + res.status);
                  r.textContent = JSON.stringify(await res.json(), null, 2);
              } catch(e) {
                  r.textContent = '解析异常: ' + e.message;
              }
          }
          </script>
      </body>
      </html>
      `;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 2️⃣ 核心 DNS 路由转发
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

    // ECS (Subnet) 客户端智能定位
    const cfLocation = request.cf?.country || "";
    let clientIp = '114.44.0.1'; 
    if (cfLocation === "JP") clientIp = '61.211.0.1';   
    else if (cfLocation === "SG") clientIp = '175.156.0.1';  
    else if (cfLocation === "HK") clientIp = '203.198.0.1';  
    else if (cfLocation === "US") clientIp = '8.8.8.8';

    const cache = caches.default;

    // A. 边缘 Cache 匹配
    let cachedResponse = await cache.match(new Request(cacheKeyUrl.toString(), { method: 'GET' }));
    if (cachedResponse) {
      let hitResponse = new Response(cachedResponse.body, cachedResponse);
      hitResponse.headers.set('X-Cache-Status', 'HIT_HUB');
      return hitResponse;
    }

    // B. 获取记忆中最快上游
    const upstreamCacheKey = `${url.origin}/internal/best-upstream?region=${cfLocation}`;
    let cachedBestUpstreamRes = await cache.match(new Request(upstreamCacheKey));
    let preferredUpstream = cachedBestUpstreamRes ? await cachedBestUpstreamRes.text() : null;

    async function fetchFromUpstream(upstream, timeoutMs) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      
      const upstreamHeaders = new Headers();
      // 兼容 Accept 协议
      const isJsonRequest = url.searchParams.has('name') && !url.searchParams.has('dns');
      upstreamHeaders.set('Accept', isJsonRequest ? 'application/dns-json' : 'application/dns-message');

      let fetchUrl = upstream;
      
      // 只有支持 Subnet 的上游且在特定模式下才拼接 edns
      const supportsEcs = upstream.includes('dns.google') || upstream.includes('alidns');
      const ecsQuery = (supportsEcs && isGet) ? `&edns_client_subnet=${clientIp}` : '';

      if (isGet) {
        fetchUrl = `${upstream}?${url.searchParams.toString()}${ecsQuery}`;
      } else {
        upstreamHeaders.set('Content-Type', 'application/dns-message');
      }

      const fetchInit = {
        method: isGet ? 'GET' : 'POST',
        headers: upstreamHeaders,
        signal: controller.signal,
        cf: { cacheTtl: 5, cacheEverything: true }
      };

      if (!isGet && dnsBuffer) {
        fetchInit.body = dnsBuffer.slice();
      }

      try {
        const res = await fetch(fetchUrl, fetchInit);
        clearTimeout(id);
        // 关键改动：遇到非 200/405 等非正常响应直接抛出错误，触发竞速降级
        if (!res.ok) throw new Error(`Upstream Error Status: ${res.status}`);
        return { response: res, source: upstream };
      } catch (e) {
        clearTimeout(id);
        throw e;
      }
    }

    let finalDnsResult = null;
    let chosenSource = "";

    // C. 优先尝试主用节点
    if (preferredUpstream && SPEED_RACE_UPSTREAMS.includes(preferredUpstream)) {
      try {
        const resObj = await fetchFromUpstream(preferredUpstream, 700);
        finalDnsResult = resObj.response;
        chosenSource = resObj.source;
      } catch (err) {
        preferredUpstream = null; 
      }
    }

    // D. 全量竞速 (并发尝试)
    if (!finalDnsResult) {
      const racePromises = SPEED_RACE_UPSTREAMS.map(upstream => 
        fetchFromUpstream(upstream, RACE_TIMEOUT_MS)
      );

      try {
        const fastestObj = await Promise.race(racePromises);
        finalDnsResult = fastestObj.response;
        chosenSource = fastestObj.source;

        // 记忆最快节点
        const saveBestUpstreamResponse = new Response(chosenSource, {
          headers: { 'Cache-Control': `public, max-age=${BEST_UPSTREAM_TTL_SEC}` }
        });
        ctx.waitUntil(cache.put(new Request(upstreamCacheKey), saveBestUpstreamResponse));

      } catch (err) {
        // E. 绝对安全的双重兜底 (使用 Google DNS 替代 Cloudflare)
        try {
          const fallbackObj = await fetchFromUpstream(ULTIMATE_FALLBACK_UPSTREAM, 3000);
          finalDnsResult = fallbackObj.response;
          chosenSource = fallbackObj.source;
        } catch (fatalErr) {
          return new Response(`DNS Upstream Timeout / Service Unavailable`, { status: 504 });
        }
      }
    }

    // F. 响应处理与 Cache 缓存写入
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
}
      const html = `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>专用 DoH DNS 服务 (Pages 架构)</title>
          <style>
              body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
              .container { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 35px; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.5); max-width: 480px; width: 90%; }
              h1 { font-size: 22px; margin: 10px 0; color: #58a6ff; }
              .status-tag { display: inline-flex; align-items: center; background: rgba(56, 139, 253, 0.15); color: #58a6ff; padding: 6px 16px; border-radius: 20px; font-size: 13px; font-weight: bold; margin: 15px 0; border: 1px solid rgba(56, 139, 253, 0.3); }
              .dot { width: 8px; height: 8px; background-color: #3fb950; border-radius: 50%; margin-right: 8px; box-shadow: 0 0 8px #3fb950; }
              .info-box { background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 15px; text-align: left; font-size: 13px; font-family: monospace; margin-top: 15px; }
              .info-item { margin: 8px 0; display: flex; justify-content: space-between; }
              .value { color: #79c0ff; word-break: break-all; }
              button { background: #238636; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-top: 15px; width: 100%; }
              button:hover { background: #2ea043; }
              pre { background: #0d1117; padding: 10px; border-radius: 6px; text-align: left; white-space: pre-wrap; font-size: 12px; color: #7ee787; border: 1px solid #30363d; max-height: 150px; overflow-y: auto; }
          </style>
      </head>
      <body>
          <div class="container">
              <div style="font-size:42px;">🚀</div>
              <h1>专用 DoH DNS 服务</h1>
              <div class="status-tag"><span class="dot"></span>七星 Anycast 弹性集群已就绪</div>
              
              <div class="info-box">
                  <div class="info-item"><span style="color:#8b949e">DoH 地址:</span><span class="value" style="font-weight:bold;color:#58a6ff;">${url.origin}/dns-query</span></div>
                  <div class="info-item"><span style="color:#8b949e">QPS 保护机制:</span><span class="value" style="color:#3fb950;">800ms 熔断 / 边缘 API 缓存</span></div>
              </div>

              <button onclick="testDns()">⚡ 实时测试 JSON 解析 (baidu.com)</button>
              <pre id="r" style="display:none;"></pre>
          </div>
          <script>
          async function testDns(){
              const r = document.getElementById('r');
              r.style.display = 'block';
              r.textContent = '正在发起路由解析...';
              try {
                  const res = await fetch('${url.origin}/dns-query?name=baidu.com&type=A');
                  r.textContent = JSON.stringify(await res.json(), null, 2);
              } catch(e) {
                  r.textContent = '解析异常: ' + e.message;
              }
          }
          </script>
      </body>
      </html>
      `;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 2️⃣ 核心 DoH 处理逻辑
    let cacheKeyUrl = new URL(request.url);
    let dnsBuffer = null;
    let isGet = request.method === 'GET';

    if (isGet) {
      const dnsParam = url.searchParams.get('dns') || url.searchParams.get('name');
      cacheKeyUrl.pathname = `/cache/GET/${dnsParam}`;
    } else {
      dnsBuffer = new Uint8Array(await request.arrayBuffer());
      const postHash = btoa(String.fromCharCode(...dnsBuffer.slice(0, 128))).replace(/=/g, '').replace(/\//g, '_');
      cacheKeyUrl.pathname = `/cache/POST/${postHash}`;
    }

    // ECS 客户端矩阵
    const cfLocation = request.cf?.country || "";
    let clientIp = '114.44.0.1'; 
    if (cfLocation === "JP") clientIp = '61.211.0.1';   
    else if (cfLocation === "SG") clientIp = '175.156.0.1';  
    else if (cfLocation === "HK") clientIp = '203.198.0.1';  
    else if (cfLocation === "US") clientIp = '8.8.8.8';
    else if (cfLocation === "EU") clientIp = '1.1.1.1';

    const cache = caches.default;

    // A. 第一防线：Cloudflare 边缘 Cache 检索
    let cachedResponse = await cache.match(new Request(cacheKeyUrl.toString(), { method: 'GET' }));
    if (cachedResponse) {
      let hitResponse = new Response(cachedResponse.body, cachedResponse);
      hitResponse.headers.set('X-Cache-Status', 'HIT_PAGES_BOOST');
      return hitResponse;
    }

    // B. 读取 5 分钟内最快主用节点
    const upstreamCacheKey = `${url.origin}/internal/best-upstream?region=${cfLocation}`;
    let cachedBestUpstreamRes = await cache.match(new Request(upstreamCacheKey));
    let preferredUpstream = null;
    if (cachedBestUpstreamRes) {
      preferredUpstream = await cachedBestUpstreamRes.text();
    }

    const ecsParam = `&edns_client_subnet=${clientIp}`;

    async function fetchFromUpstream(upstream, timeoutMs) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      
      const upstreamHeaders = new Headers();
      upstreamHeaders.set('Accept', 'application/dns-message, application/dns-json');

      let fetchUrl = upstream;
      const fetchInit = {
        method: isGet ? 'GET' : 'POST',
        headers: upstreamHeaders,
        signal: controller.signal,
        cf: { cacheTtl: 10, cacheEverything: true }
      };

      if (isGet) {
        fetchUrl = `${upstream}?${url.searchParams.toString()}${ecsParam}`;
      } else {
        fetchUrl = `${upstream}?${ecsParam.slice(1)}`;
        upstreamHeaders.set('Content-Type', 'application/dns-message');
        fetchInit.body = dnsBuffer.slice(); 
      }

      try {
        const res = await fetch(fetchUrl, fetchInit);
        clearTimeout(id);
        if (!res.ok) throw new Error(`Status: ${res.status}`);
        return { response: res, source: upstream };
      } catch (e) {
        clearTimeout(id);
        throw e;
      }
    }

    let finalDnsResult = null;
    let chosenSource = "";

    // C. 第二防线：尝试单发主用节点（带 800ms 熔断保护）
    if (preferredUpstream && SPEED_RACE_UPSTREAMS.includes(preferredUpstream)) {
      try {
        const resObj = await fetchFromUpstream(preferredUpstream, 800);
        finalDnsResult = resObj.response;
        chosenSource = resObj.source;
      } catch (err) {
        preferredUpstream = null; // 触发抖动降级，跌落至并发洗牌
      }
    }

    // D. 第三防线：七大上游全量并发竞速 (Promise.race)
    if (!finalDnsResult) {
      const racePromises = SPEED_RACE_UPSTREAMS.map(upstream => fetchFromUpstream(upstream, RACE_TIMEOUT_MS));
      
      const timeoutPromise = new Promise((_, reject) => {
        ctx.waitUntil(new Promise(resolve => {
          setTimeout(() => { reject(new Error("Timeout")); resolve(); }, RACE_TIMEOUT_MS);
        }));
      });

      try {
        const fastestObj = await Promise.race([...racePromises, timeoutPromise]);
        finalDnsResult = fastestObj.response;
        chosenSource = fastestObj.source;

        // 记忆当前最快节点
        const saveBestUpstreamResponse = new Response(chosenSource, {
          headers: { 'Cache-Control': `public, max-age=${BEST_UPSTREAM_TTL_SEC}` }
        });
        ctx.waitUntil(cache.put(new Request(upstreamCacheKey), saveBestUpstreamResponse));

      } catch (err) {
        // 万能备用直连兜底
        return fetch(`https://cloudflare-dns.com/dns-query${url.search}`, {
          method: request.method,
          headers: { 'Accept': 'application/dns-message' }
        }).catch(() => new Response(`全网 Gateway 繁忙`, { status: 502 }));
      }
    }

    // E. 结果改写与 Cache 写入
    try {
      const contentType = finalDnsResult.headers.get('content-type') || '';
      
      // 如果是纯 JSON 查询
      if (contentType.includes('json')) {
        const jsonText = await finalDnsResult.text();
        const cacheResponse = new Response(jsonText, {
          headers: {
            'Content-Type': 'application/dns-json',
            'Cache-Control': `public, max-age=${MIN_TTL_GAME}`,
            'Access-Control-Allow-Origin': '*'
          }
        });
        ctx.waitUntil(cache.put(new Request(cacheKeyUrl.toString(), { method: 'GET' }), cacheResponse.clone()));
        return cacheResponse;
      }

      // 如果是标准二进制 DNS 报文
      let responseData = await finalDnsResult.arrayBuffer();
      const isGameRequest = GAME_KEYWORDS.some(keyword => cacheKeyUrl.pathname.toLowerCase().includes(keyword));
      const targetMinTtl = isGameRequest ? MIN_TTL_GAME : MIN_TTL_NORMAL;
      
      responseData = processDnsMessage(responseData, targetMinTtl);

      const cacheResponse = new Response(responseData, {
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
      return new Response(`DNS 数据流转译异常`, { status: 502 });
    }
  }
}
