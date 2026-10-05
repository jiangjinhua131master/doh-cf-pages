/**
 * 纯内存高效 DoH Proxy for Cloudflare Workers / Pages
 * 特性：零 KV 依赖 / 自定义 DNS 路径 / 多上游并发竞速 / EWMA 健康惩罚 / LRU 缓存 / 二进制 ECS 注入
 */

// 1. 基础路由与路径配置
const DNS_PATH = '/doh-munka';                                                    // 自定义 DNS 路径（修改此路径防扫）
const ECS_ENABLED = true;                                                          // 是否透传 EDNS Client Subnet (ECS)
const ECS_DEFAULT_PREFIX_V4 = 24;                                           // IPv4 默认掩码前缀
const ECS_DEFAULT_PREFIX_V6 = 56;                                           // IPv6 默认掩码前缀

// 2. 上游 DoH 服务器池（按需增减）
const UPSTREAM_DNS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query'
];

// 3. 上游健康度与延迟状态追踪
const upstreamStats = UPSTREAM_DNS.map(url => ({
  url,
  latency: 50,      // 初始估算延迟 (ms)
  fails: 0,        // 连续失败/限速计数
  penaltyUntil: 0  // 惩罚截至时间戳
}));

// 4. 内存 LRU 缓存 (无需 KV)
const MAX_CACHE_SIZE = 1000;
const dnsCache = new Map();

function getCache(key) {
  const item = dnsCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expireAt) {
    dnsCache.delete(key);
    return null;
  }
  // 刷新 LRU 顺序
  dnsCache.delete(key);
  dnsCache.set(key, item);
  return item.data;
}

function setCache(key, data, ttlSeconds) {
  if (dnsCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = dnsCache.keys().next().value;
    dnsCache.delete(oldestKey);
  }
  const effectiveTTL = Math.max(10, Math.min(ttlSeconds || 60, 3600));
  dnsCache.set(key, {
    data,
    expireAt: Date.now() + effectiveTTL * 1000
  });
}

// 5. 动态上游选择算法
function getBestUpstreams(count = 2) {
  const now = Date.now();
  return upstreamStats
    .map(item => {
      let score = item.latency;
      if (now < item.penaltyUntil) score += 2000; // 处于惩罚期时赋予极高权重避开
      return { ...item, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, count);
}

function updateUpstreamStat(url, duration, isSuccess) {
  const stat = upstreamStats.find(s => s.url === url);
  if (!stat) return;
  if (isSuccess) {
    stat.latency = Math.round(stat.latency * 0.7 + duration * 0.3); // EWMA 指数移动平均
    stat.fails = Math.max(0, stat.fails - 1);
  } else {
    stat.fails += 1;
    stat.penaltyUntil = Date.now() + Math.min(stat.fails * 10000, 60000); // 阶梯式惩罚
  }
}

// 6. 辅助常量与自定义解析配置
const CONTENT_TYPE_DNS = 'application/dns-message';
const CONTENT_TYPE_JSON = 'application/dns-json';

let customDnsCache = { text: null, map: null };
function getCustomDns(env) {
  const raw = env.CUSTOM_DNS || '';
  if (customDnsCache.map && customDnsCache.text === raw) return customDnsCache.map;
  const map = new Map();
  for (const item of raw.split(',')) {
    const line = item.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length === 2 && /^\d+\.\d+\.\d+\.\d+$/.test(parts[1])) {
      map.set(parts[0].toLowerCase(), parts[1]);
    }
  }
  customDnsCache = { text: raw, map };
  return map;
}

export default {
  async fetch(request, env, ctx) {
    const { method, headers, url } = request;
    const { pathname, searchParams } = new URL(url);

    // 非自定义 DNS 路径且无 dns 参数时返回简单提示或 404
    if (pathname !== DNS_PATH && !searchParams.has('dns')) {
      if (pathname === '/' && method === 'GET') {
        return serveStatic(env, request);
      }
      return new Response('Not Found', { status: 404 });
    }

    const isDoh =
      (method === 'POST' && headers.get('content-type') === CONTENT_TYPE_DNS) ||
      (method === 'GET' && searchParams.has('dns')) ||
      (method === 'GET' && headers.get('Accept') === CONTENT_TYPE_JSON);

    if (isDoh) {
      try {
        return await handleDohRequest(request, env);
      } catch (e) {
        return new Response('DNS Service Error', { status: 500 });
      }
    }

    return serveStatic(env, request);
  }
};

// 7. Core DoH 处理主流程
async function handleDohRequest(request, env) {
  const { method, headers, url } = request;
  const { searchParams } = new URL(url);
  const customMap = getCustomDns(env);
  const blockIP = env.BLOCK_IP || '0.0.0.0';

  // --- JSON 格式 DNS 查询支持 ---
  if (method === 'GET' && headers.get('Accept') === CONTENT_TYPE_JSON) {
    const domain = searchParams.get('name');
    if (domain) {
      const lower = domain.toLowerCase();
      if (customMap.has(lower)) {
        return Response.json(buildJsonResponse(domain, customMap.get(lower)));
      }
    }
    const bestTargets = getBestUpstreams(2);
    const fetchPromises = bestTargets.map(target => {
      const upstreamUrl = new URL(target.url);
      searchParams.forEach((v, k) => upstreamUrl.searchParams.set(k, v));
      const startTime = Date.now();
      return fetch(upstreamUrl.toString(), { method: 'GET', headers: { 'Accept': CONTENT_TYPE_JSON } })
        .then(async res => {
          if (res.ok) {
            updateUpstreamStat(target.url, Date.now() - startTime, true);
            return res;
          }
          throw new Error();
        })
        .catch(err => {
          updateUpstreamStat(target.url, 3000, false);
          throw err;
        });
    });
    return Promise.any(fetchPromises).catch(() => new Response('Upstream Timeout', { status: 504 }));
  }

  // --- Wireformat 二进制 DNS 报文处理 ---
  let dnsBuffer = null;
  let cacheKey = '';

  if (method === 'GET' && searchParams.has('dns')) {
    const b64 = searchParams.get('dns');
    cacheKey = 'GET:' + b64;
    dnsBuffer = base64ToUint8Array(b64).buffer;
  } else if (method === 'POST' && headers.get('content-type') === CONTENT_TYPE_DNS) {
    dnsBuffer = await request.arrayBuffer();
    cacheKey = 'POST:' + arrayBufferToBase64(dnsBuffer);
  } else {
    return new Response('Bad Request', { status: 400 });
  }

  // 查内存缓存
  const cachedResponse = getCache(cacheKey);
  if (cachedResponse) {
    return new Response(cachedResponse, {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPE_DNS,
        'X-Cache': 'HIT-MEMORY'
      }
    });
  }

  // 检查自定义域名解析
  if (dnsBuffer.byteLength >= 12) {
    const view = new DataView(dnsBuffer);
    const { name, endOffset } = decodeDnsQuestion(view);
    if (name) {
      const lower = name.toLowerCase();
      if (customMap.has(lower)) {
        const customIp = customMap.get(lower);
        const wireResp = buildWireResponse(dnsBuffer, endOffset, customIp);
        return new Response(wireResp, { headers: { 'Content-Type': CONTENT_TYPE_DNS } });
      }
    }
  }

  // 构建 ECS 数据
  const clientIp = getClientIp(request);
  const explicitEcs = (() => {
    if (!ECS_ENABLED) return null;
    const ecsRaw = searchParams.get('ecs');
    if (!ecsRaw) return null;
    const [ip, prefixStr] = ecsRaw.split('/');
    if (!ip) return null;
    const prefix = prefixStr != null ? Number(prefixStr) : defaultPrefixFor(ip);
    return { ip, prefix };
  })();
  const autoEcs = (!explicitEcs && ECS_ENABLED && clientIp) ? { ip: clientIp, prefix: defaultPrefixFor(clientIp) } : null;
  const ecs = explicitEcs || autoEcs || null;

  // 注入二进制 ECS 报文
  let finalBuffer = dnsBuffer;
  if (ecs && ecs.ip) {
    try {
      let parsedEcs = parseEcs(dnsBuffer);
      if (!parsedEcs) {
        finalBuffer = injectEcsToWire(dnsBuffer, ecs).buffer;
      }
    } catch (e) {}
  }

  // 多上游竞速并发 Fetch
  const bestTargets = getBestUpstreams(2);
  const fetchPromises = bestTargets.map(target => {
    const startTime = Date.now();
    let upstreamUrl = target.url;
    if (method === 'GET') {
      const u = new URL(target.url);
      u.searchParams.set('dns', searchParams.get('dns'));
      upstreamUrl = u.toString();
    }

    return fetch(upstreamUrl, {
      method: method,
      headers: { 'Accept': CONTENT_TYPE_DNS, 'Content-Type': CONTENT_TYPE_DNS },
      body: method === 'POST' ? finalBuffer : null,
      signal: AbortSignal.timeout(3500)
    }).then(async res => {
      const duration = Date.now() - startTime;
      if (res.ok && res.headers.get('content-type')?.includes(CONTENT_TYPE_DNS)) {
        updateUpstreamStat(target.url, duration, true);
        return { buffer: await res.arrayBuffer(), targetUrl: target.url };
      }
      updateUpstreamStat(target.url, duration, false);
      throw new Error(`Status ${res.status}`);
    }).catch(err => {
      updateUpstreamStat(target.url, 3500, false);
      throw err;
    });
  });

  try {
    const winner = await Promise.any(fetchPromises);
    const responseBuffer = winner.buffer;
    const ttl = parseTTLFromDNSResponse(new Uint8Array(responseBuffer)) || 60;

    // 写入 LRU 缓存
    setCache(cacheKey, responseBuffer, ttl);

    return new Response(responseBuffer, {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPE_DNS,
        'Cache-Control': `max-age=${ttl}`,
        'X-DNS-Upstream': winner.targetUrl,
        'X-Cache': 'MISS'
      }
    });
  } catch (e) {
    return new Response('Upstream DNS Failure', { status: 502 });
  }
}

// 8. 静态页面回退/提示
async function serveStatic(env, request) {
  if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    return env.ASSETS.fetch(request);
  }
  return new Response(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>DoH Service</title></head>' +
    '<body><h2>DoH Endpoint Ready</h2><p>Path: <code>' + DNS_PATH + '</code></p></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// --- 实用与协议编解码工具函数集 ---

function base64ToUint8Array(base64) {
  const binaryString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getClientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf && /^[0-9a-fA-F:.]+$/.test(cf.trim())) return cf.trim();
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (/^[0-9a-fA-F:.]+$/.test(first)) return first;
  }
  return null;
}

function defaultPrefixFor(ip) {
  return ip.includes(':') ? ECS_DEFAULT_PREFIX_V6 : ECS_DEFAULT_PREFIX_V4;
}

function buildJsonResponse(name, ip, ttl = 3600) {
  return {
    Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false,
    Question: [{ name, type: 1 }],
    Answer: [{ name, type: 1, TTL: ttl, data: ip }],
  };
}

function decodeDnsQuestion(view) {
  const len = view.byteLength;
  if (len < 12) return { name: '', endOffset: 12 };
  let labels = [], offset = 12, end = 12, jumps = 0;
  while (true) {
    if (offset >= len) return { name: labels.join('.'), endOffset: len };
    const b = view.getUint8(offset);
    if (b === 0) { offset++; end = offset; break; }
    if ((b & 0xC0) === 0xC0) {
      if (offset + 2 > len) return { name: labels.join('.'), endOffset: len };
      if (++jumps > 10) return { name: labels.join('.'), endOffset: offset + 2 }; 
      offset = ((b & 0x3F) << 8) | view.getUint8(offset + 1);
      continue;
    }
    if (b > 63) return { name: labels.join('.'), endOffset: offset + 1 };
    if (offset + 1 + b > len) return { name: labels.join('.'), endOffset: len };
    try {
      labels.push(String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + 1, b)));
    } catch (e) {
      labels.push('');
    }
    offset += 1 + b; end = offset;
  }
  return { name: labels.join('.'), endOffset: end + 4 };
}

function buildWireResponse(reqBuffer, questionEndOffset, ip) {
  const view = new DataView(reqBuffer);
  const id = view.getUint16(0);
  const questionBytes = reqBuffer.slice(12, questionEndOffset);
  const [a, b, c, d] = ip.split('.').map(Number);
  const answer = new Uint8Array([0xC0, 0x0C, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x0E, 0x10, 0x00, 0x04, a, b, c, d]);
  const header = new Uint8Array(12);
  const hv = new DataView(header.buffer);
  hv.setUint16(0, id); hv.setUint16(2, 0x8180); hv.setUint16(4, 1); hv.setUint16(6, 1);
  const response = new Uint8Array(12 + questionBytes.byteLength + answer.byteLength);
  response.set(header, 0);
  response.set(new Uint8Array(questionBytes), 12);
  response.set(answer, 12 + questionBytes.byteLength);
  return response.buffer;
}

function parseTTLFromDNSResponse(buf) {
  try {
    if (buf.length < 12) return 60;
    const ancount = (buf[6] << 8) | buf[7];
    if (ancount === 0) return 30;
    let offset = 12;
    const qdcount = (buf[4] << 8) | buf[5];
    for (let i = 0; i < qdcount; i++) {
      while (offset < buf.length) {
        const len = buf[offset];
        if (len === 0) { offset += 5; break; }
        if ((len & 0xC0) === 0xC0) { offset += 6; break; }
        offset += len + 1;
      }
    }
    if (offset < buf.length) {
      if ((buf[offset] & 0xC0) === 0xC0) {
        offset += 2;
      } else {
        while (offset < buf.length && buf[offset] !== 0) offset += buf[offset] + 1;
        offset += 1;
      }
      offset += 4;
      if (offset + 4 <= buf.length) {
        const ttl = (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
        return ttl > 0 ? ttl : 60;
      }
    }
  } catch (e) {
    return 60;
  }
  return 60;
}

// --- 二进制 EDNS (ECS) 逻辑处理 ---

function ipToBytes(ip) {
  if (!ip || typeof ip !== 'string') return new Uint8Array(4);
  const trimmed = ip.trim();
  if (trimmed.includes(':')) {
    try {
      let str = trimmed.includes('/') ? trimmed.split('/')[0] : trimmed;
      const expand = (seg) => (seg === '' ? [] : seg.split(':').map(x => parseInt(x, 16) || 0));
      const parts = str.split('::');
      if (parts.length > 2) return new Uint8Array(16);
      let left = parts[0] ? expand(parts[0]) : [];
      let right = parts[1] ? expand(parts[1]) : [];
      const zeros = Math.max(0, 8 - left.length - right.length);
      const all = [...left, ...Array(zeros).fill(0), ...right];
      const result = new Uint8Array(16);
      for (let i = 0; i < 8; i++) {
        result[i * 2] = (all[i] >> 8) & 0xff;
        result[i * 2 + 1] = all[i] & 0xff;
      }
      return result;
    } catch (e) {
      return new Uint8Array(16);
    }
  }
  const ps = trimmed.split('.').map(p => parseInt(p, 10));
  if (ps.length !== 4 || ps.some(n => Number.isNaN(n) || n < 0 || n > 255)) return new Uint8Array(4);
  return Uint8Array.from(ps);
}

function parseEcs(dnsBuffer) {
  const bytes = new Uint8Array(dnsBuffer);
  const view = new DataView(dnsBuffer);
  const len = bytes.byteLength;
  if (len < 12) return null;
  const qdcount = view.getUint16(4);
  const ancount = view.getUint16(6);
  const nscount = view.getUint16(8);
  const arcount = view.getUint16(10);

  let off = 12;
  const skipName = () => {
    if (off >= len) return;
    const first = view.getUint8(off);
    if ((first & 0xC0) === 0xC0) { off += 2; return; }
    if (first === 0) { off += 1; return; }
    let jumps = 0;
    while (off < len && bytes[off] !== 0) {
      if ((bytes[off] & 0xC0) === 0xC0) { off += 2; break; }
      off += bytes[off] + 1;
      if (++jumps > 20) { off = len; return; }
    }
    if (off < len && bytes[off] === 0) off += 1;
  };

  for (let i = 0; i < qdcount && off < len; i++) { skipName(); off += 4; }
  const skipRR = () => {
    skipName();
    if (off + 8 > len) { off = len; return; }
    off += 8;
    if (off + 2 > len) { off = len; return; }
    const rdlen = view.getUint16(off); off += 2;
    if (off + rdlen > len) { off = len; return; }
    off += rdlen;
  };

  for (let i = 0; i < ancount && off < len; i++) skipRR();
  for (let i = 0; i < nscount && off < len; i++) skipRR();

  for (let i = 0; i < arcount && off < len; i++) {
    skipName();
    if (off + 8 > len) break;
    const type = view.getUint16(off); off += 2;
    off += 6;
    if (off + 2 > len) break;
    const rdlen = view.getUint16(off); off += 2;
    const rdEnd = off + rdlen;
    if (type !== 41) { off = rdEnd; continue; }
    let p = off;
    while (p + 4 <= rdEnd && p + 4 <= len) {
      const optCode = (bytes[p] << 8) | bytes[p + 1]; p += 2;
      const optLen = (bytes[p] << 8) | bytes[p + 1]; p += 2;
      const optEnd = p + optLen;
      if (optCode === 8 && optLen >= 4) {
        if (optEnd > rdEnd || optEnd > len) break;
        const family = (bytes[p] << 8) | bytes[p + 1]; p += 2;
        const srcPrefix = bytes[p]; p += 2;
        if (family === 1 && optLen >= 8) {
          return { ip: `${bytes[p]}.${bytes[p + 1]}.${bytes[p + 2]}.${bytes[p + 3]}`, prefix: srcPrefix, family: 1 };
        }
      }
      p = optEnd;
    }
    off = rdEnd;
  }
  return null;
}

function concatBytes(arrays) {
  const total = arrays.reduce((s, a) => s + (a ? a.byteLength : 0), 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { if (a && a.byteLength) { out.set(a, o); o += a.byteLength; } }
  return out;
}

function buildEcsOptionPayload(ip, prefix) {
  const isV6 = ip.includes(':');
  const family = isV6 ? 2 : 1;
  const addrBytes = ipToBytes(ip);
  const addrLen = isV6 ? 16 : 4;
  const optDataLen = 4 + addrLen;
  const buf = new Uint8Array(4 + optDataLen);
  const v = new DataView(buf.buffer);
  v.setUint16(0, 8); v.setUint16(2, optDataLen);
  v.setUint16(4, family);
  buf[6] = prefix & 0xff; buf[7] = 0;
  buf.set(addrBytes, 8);
  return buf;
}

function injectEcsToWire(dnsBuffer, ecs) {
  if (!ecs || !ecs.ip) return { buffer: dnsBuffer, hasEcs: false };
  const bytes = new Uint8Array(dnsBuffer);
  const len = bytes.byteLength;
  if (len < 12) return { buffer: dnsBuffer, hasEcs: false };

  try {
    const ecsPayload = buildEcsOptionPayload(ecs.ip, ecs.prefix);
    const head = new Uint8Array(11);
    const hv = new DataView(head.buffer);
    head[0] = 0; hv.setUint16(1, 41); hv.setUint16(3, 1232); hv.setUint32(5, 0);
    hv.setUint16(9, ecsPayload.byteLength);

    const optRr = concatBytes([head, ecsPayload]);
    const out = new Uint8Array(len + optRr.byteLength);
    out.set(bytes, 0);
    out.set(optRr, len);
    const view = new DataView(out.buffer);
    const arcount = view.getUint16(10);
    view.setUint16(10, arcount + 1);
    return { buffer: out.buffer, hasEcs: true };
  } catch (e) {
    return { buffer: dnsBuffer, hasEcs: false };
  }
}
