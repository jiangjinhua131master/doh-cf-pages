/**
 * Ultimate DoH Resolver for Cloudflare Workers / Pages
 * Features: 
 *  1. Dual-layer Cache (L1 ARC Memory + L2 Cache API / CDN)
 *  2. Multi-Upstream Race & Rate-limit Mitigation (Anti-429/Failover)
 *  3. In-flight Request Deduplication (防刷爆上游)
 *  4. Full EDNS (ECS) & DNSSEC Pass-through
 */

// ==================== 配置项 ====================
const CONFIG = {
  // 1. 上游 DoH 列表（包含了 Google、Cloudflare、DNSPod、AliDNS）
  UPSTREAMS: [
    'https://dns.google/dns-query',
    'https://azure.cloudflare-dns.com/dns-query',
    'https://doh.pub/dns-query',      // 腾讯云 DNSPod
    'https://dns.alidns.com/dns-query' // 阿里云 DNS
  ],
  
  // 2. 缓存参数
  CACHE_MAX_ENTRIES: 1000,const ULTIMATE_FALLBACK_UPSTREAM = 'https://dns.google/dns-query';

const GAME_KEYWORDS = [
  'game', 'steam', 'epic', 'pubg', 'apex', 'riot', 'ea', 'sony', 'playstation', 'xbox', 'nintendo',
  'warthunder', 'gaijin', 'netgames', 'wargaming', 'wotblitz', 'tankcompany', 'battle', 'pjsekai', 'sega',
  'youtube', 'googlevideo', 'ytimg', 'netflix', 'nflxvideo', 'garena', 'lol', 'bilibili'
];

const RACE_TIMEOUT_MS = 1800;
const MIN_TTL_NORMAL = 3600; 
const MIN_TTL_GAME = 60;     
const BEST_UPSTREAM_TTL_SEC = 300; 
  // 3. 防限速与超时控制
  UPSTREAM_TIMEOUT: 2000,     // 单个上游超时时间 (2000ms)
};

// ==================== ARC (Adaptive Replacement Cache) 算法 ====================
class ARCCache {
  constructor(capacity) {
    this.c = capacity;
    this.p = 0;
    this.t1 = new Map();
    this.t2 = new Map();
    this.b1 = new Map();
    this.b2 = new Map();
  }

  _touch(map, key) {
    const val = map.get(key);
    map.delete(key);
    map.set(key, val);
    return val;
  }

  get(key) {
    if (this.t1.has(key)) {
      const item = this.t1.get(key);
      if (Date.now() > item.expiresAt) {
        this.t1.delete(key);
        return null;
      }
      this.t1.delete(key);
      this.t2.set(key, item);
      return item.data;
    }

    if (this.t2.has(key)) {
      const item = this.t2.get(key);
      if (Date.now() > item.expiresAt) {
        this.t2.delete(key);
        return null;
      }
      this._touch(this.t2, key);
      return item.data;
    }

    return null;
  }

  set(key, value, ttlSeconds) {
    const ttl = Math.max(CONFIG.MIN_TTL, Math.min(ttlSeconds || CONFIG.MIN_TTL, CONFIG.MAX_TTL));
    const newItem = { data: value, expiresAt: Date.now() + ttl * 1000 };

    if (this.t1.has(key)) {
      this.t1.delete(key);
      this.t2.set(key, newItem);
      return;
    }
    if (this.t2.has(key)) {
      this.t2.delete(key);
      this.t2.set(key, newItem);
      return;
    }

    if (this.b1.has(key)) {
      const delta = this.b1.size >= this.b2.size ? 1 : this.b2.size / this.b1.size;
      this.p = Math.min(this.c, this.p + delta);
      this._replace(key);
      this.b1.delete(key);
      this.t2.set(key, newItem);
      return;
    }

    if (this.b2.has(key)) {
      const delta = this.b2.size >= this.b1.size ? 1 : this.b1.size / this.b2.size;
      this.p = Math.max(0, this.p - delta);
      this._replace(key);
      this.b2.delete(key);
      this.t2.set(key, newItem);
      return;
    }

    const totalAll = this.t1.size + this.t2.size + this.b1.size + this.b2.size;
    if (this.t1.size + this.b1.size === this.c) {
      if (this.t1.size < this.c) {
        const oldestB1 = this.b1.keys().next().value;
        if (oldestB1) this.b1.delete(oldestB1);
        this._replace(key);
      } else {
        const oldestT1 = this.t1.keys().next().value;
        if (oldestT1) this.t1.delete(oldestT1);
      }
    } else if (totalAll >= this.c) {
      if (totalAll === 2 * this.c) {
        const oldestB2 = this.b2.keys().next().value;
        if (oldestB2) this.b2.delete(oldestB2);
      }
      this._replace(key);
    }

    this.t1.set(key, newItem);
  }

  _replace(key) {
    const t1Size = this.t1.size;
    if (t1Size > 0 && (t1Size > this.p || (this.b2.has(key) && t1Size === Math.floor(this.p)))) {
      const oldestT1 = this.t1.keys().next().value;
      this.t1.delete(oldestT1);
      this.b1.set(oldestT1, true);
    } else {
      const oldestT2 = this.t2.keys().next().value;
      this.t2.delete(oldestT2);
      this.b2.set(oldestT2, true);
    }
  }
}

// 实例化 L1 全局内存缓存 & 单并发合并队列
const globalCache = new ARCCache(CONFIG.CACHE_MAX_ENTRIES);
const inFlightRequests = new Map();

// ==================== 主逻辑处理 ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== '/dns-query' && url.pathname !== '/') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, edns-client-subnet',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      let dnsBuffer = null;
      let cacheKey = '';
      const clientIP = request.headers.get('cf-connecting-ip') || '';

      if (request.method === 'GET') {
        const dnsParam = url.searchParams.get('dns');
        if (!dnsParam) return new Response('Missing "dns" param', { status: 400 });
        cacheKey = `GET:${dnsParam}`;
        dnsBuffer = base64UrlToBuffer(dnsParam);
      } else if (request.method === 'POST') {
        if (request.headers.get('content-type') !== 'application/dns-message') {
          return new Response('Unsupported Content-Type', { status: 415 });
        }
        dnsBuffer = await request.arrayBuffer();
        const hashBuf = await crypto.subtle.digest('SHA-256', dnsBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuf));
        cacheKey = `POST:${hashArray.map(b => b.toString(16).padStart(2, '0')).join('')}`;
      } else {
        return new Response('Method Not Allowed', { status: 405 });
      }

      // ----------------- 【1. 第一层：L1 ARC 内存缓存】 -----------------
      const arcCached = globalCache.get(cacheKey);
      if (arcCached) {
        return createDnsResponse(arcCached.buffer, 'HIT-L1-ARC');
      }

      // ----------------- 【2. 第二层：L2 Cache API (免费 CDN 级缓存)】 -----------------
      const cacheApi = caches.default;
      const cacheApiUrl = new URL(`https://dns-cache.local/${encodeURIComponent(cacheKey)}`);
      const cacheApiReq = new Request(cacheApiUrl.toString(), { method: 'GET' });

      let cfCachedRes = await cacheApi.match(cacheApiReq);
      if (cfCachedRes) {
        const buf = await cfCachedRes.arrayBuffer();
        // 异步回填写 L1 ARC 内存
        globalCache.set(cacheKey, { buffer: buf }, CONFIG.MIN_TTL);
        return createDnsResponse(buf, 'HIT-L2-EDGE');
      }

      // ----------------- 【3. 请求去重 (Deduplication / Single-flight)】 -----------------
      // 如果相同的 DNS 请求正在向上游查询中，不重复触发，而是等待之前的那个请求返回直接拿结果
      if (inFlightRequests.has(cacheKey)) {
        const upstreamBuf = await inFlightRequests.get(cacheKey);
        if (upstreamBuf) return createDnsResponse(upstreamBuf.buffer, 'HIT-INFLIGHT-DEDUP');
      }

      // ----------------- 【4. 向上游发起抗限速竞速查询】 -----------------
      const fetchPromise = (async () => {
        try {
          return await raceUpstreamsWithFallback(dnsBuffer, request.headers, clientIP);
        } finally {
          inFlightRequests.delete(cacheKey);
        }
      })();

      inFlightRequests.set(cacheKey, fetchPromise);
      const upstreamResponse = await fetchPromise;

      if (upstreamResponse) {
        // 1. 写入 L1 ARC 内存
        globalCache.set(cacheKey, { buffer: upstreamResponse.buffer }, CONFIG.MIN_TTL);

        // 2. 写入 L2 免费 Cache API
        const responseToCache = new Response(upstreamResponse.buffer, {
          headers: {
            'Content-Type': 'application/dns-message',
            'Cache-Control': `public, max-age=${CONFIG.MIN_TTL}`,
          },
        });
        ctx.waitUntil(cacheApi.put(cacheApiReq, responseToCache));

        return createDnsResponse(upstreamResponse.buffer, 'MISS', upstreamResponse.provider);
      }

      return new Response('Upstream DNS Limit/Failure', { status: 504 });

    } catch (err) {
      return new Response(`DNS Processing Error: ${err.message}`, { status: 500 });
    }
  }
};

// ==================== 缓解限速与竞速核心逻辑 ====================

async function raceUpstreamsWithFallback(dnsBuffer, origHeaders, clientIP) {
  const fetchPromises = CONFIG.UPSTREAMS.map(async (upstream) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT);

    try {
      const headers = new Headers({
        'Accept': 'application/dns-message',
        'Content-Type': 'application/dns-message',
      });

      // 透传 EDNS Client Subnet (ECS)
      if (origHeaders.has('edns-client-subnet')) {
        headers.set('edns-client-subnet', origHeaders.get('edns-client-subnet'));
      } else if (clientIP) {
        headers.set('X-Forwarded-For', clientIP);
      }

      // 透传 DNSSEC 请求参数
      if (origHeaders.has('accept')) {
        headers.set('Accept', origHeaders.get('accept'));
      }

      const response = await fetch(upstream, {
        method: 'POST',
        headers: headers,
        body: dnsBuffer,
        signal: controller.signal,
        cf: { 
          cacheTtl: 0,
          // 尽量复用长连接
          cacheEverything: false,
        }
      });

      clearTimeout(timer);

      // 缓解阿里/腾讯/Google 429 限速的关键：若遭遇 429/503，抛出异常交由 Promise.any 自动降级使用其他上游
      if (response.status === 429 || response.status === 503) {
        throw new Error(`Rate limited by ${upstream}`);
      }

      if (response.ok && response.headers.get('content-type')?.includes('application/dns-message')) {
        const buffer = await response.arrayBuffer();
        return { buffer, provider: upstream };
      }
      throw new Error(`Upstream ${upstream} error code: ${response.status}`);
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });

  try {
    // 竞速取最快返回且未被限速的成功结果
    return await Promise.any(fetchPromises);
  } catch (allErrors) {
    return null; // 若全部上游被限速，返回 null 抛出 504
  }
}

// 组装 Response
function createDnsResponse(buffer, cacheStatus, provider = 'cache') {
  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/dns-message',
      'Cache-Control': `public, max-age=${CONFIG.MIN_TTL}`,
      'Access-Control-Allow-Origin': '*',
      'X-DNS-Cache-Status': cacheStatus,
      'X-DNS-Upstream': provider,
    },
  });
}

function base64UrlToBuffer(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}
, max-age=${CONFIG.MIN_TTL}`,
      'Access-Control-Allow-Origin': '*',
      'X-DNS-Cache-Status': cacheStatus,
      'X-DNS-Upstream': provider,
    },
  });
}

function base64UrlToBuffer(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}
