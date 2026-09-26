/**
 * Optimized DoH Resolver for Cloudflare Workers / Pages
 * 
 * Features:
 * 1. Single-flight Request Deduplication (极大地减少重复请求)
 * 2. Fastest Upstream Pinning (动态测试并锁定最快上游，避免每次全量竞速浪费请求额度)
 * 3. Rate-Limit Mitigation & Failover (遇到 429/超时自动回退备用上游)
 * 4. EDNS (ECS) & DNSSEC Pass-through
 * 5. Two-Tier Caching (L1 ARC Memory + L2 Edge Cache API, 零 KV 依赖)
 */

// ==================== 1. 配置项 ====================
const CONFIG = {
  // 上游 DoH 列表
  UPSTREAMS: [
    'https://doh.pub/dns-query',        // 腾讯云 DNSPod
    'https://dns.alidns.com/dns-query'   // 阿里云 DNS
  ],

  // 优选 DNS 刷新周期（单位：毫秒，默认 10 分钟测试并固定一次最快 DNS）
  TEST_INTERVAL: 10 * 60 * 1000,

  // 缓存参数
  CACHE_MAX_ENTRIES: 1000,      // 一级 ARC 内存最大记录数
  MIN_TTL: 600,                  // 强制最小 TTL (秒)，大幅减少穿透与 Worker 调用
  MAX_TTL: 86400,               // 最大 TTL (秒)

  // 超时控制 (毫秒)
  UPSTREAM_TIMEOUT: 2000,
};

// ==================== 2. ARC (Adaptive Replacement Cache) 内存缓存 ====================
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

// 实例化内存对象
const globalCache = new ARCCache(CONFIG.CACHE_MAX_ENTRIES);
const inFlightRequests = new Map();

// ==================== 3. 动态优选 DNS 选路管理 ====================
let sortedUpstreams = [...CONFIG.UPSTREAMS];
let lastSpeedTestTime = 0;
let isTesting = false;

// 校验与并发测速，更新 sortedUpstreams 排序
async function updateFastestUpstream(ctx) {
  const now = Date.now();
  if (now - lastSpeedTestTime < CONFIG.TEST_INTERVAL || isTesting) {
    return;
  }
  isTesting = true;

  const testTask = async () => {
    // 构造测试包 (针对 root-a.dnspod.cn / A 记录测试)
    const testDnsQuery = new Uint8Array([
      0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x01, 0x61, 0x0c, 0x72, 0x6f, 0x6f, 0x74, 0x2d, 0x73, 0x65, 0x72, 0x76,
      0x65, 0x72, 0x73, 0x03, 0x6e, 0x65, 0x74, 0x00, 0x00, 0x01, 0x00, 0x01
    ]).buffer;

    const results = await Promise.all(
      CONFIG.UPSTREAMS.map(async (upstream) => {
        const start = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);

        try {
          const res = await fetch(upstream, {
            method: 'POST',
            headers: { 'Accept': 'application/dns-message', 'Content-Type': 'application/dns-message' },
            body: testDnsQuery,
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (res.ok) {
            return { upstream, rtt: Date.now() - start };
          }
        } catch (e) {
          clearTimeout(timer);
        }
        return { upstream, rtt: 9999 }; // 失败或超时记为高延迟
      })
    );

    // 按 RTT 升序排列
    results.sort((a, b) => a.rtt - b.rtt);
    sortedUpstreams = results.map(r => r.upstream);
    lastSpeedTestTime = Date.now();
    isTesting = false;
  };

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(testTask());
  } else {
    await testTask();
  }
}

// ==================== 4. 主逻辑处理 ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== '/dns-query' && url.pathname !== '/') {
      return new Response('Not Found', { status: 404 });
    }

    // CORS 预检
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
      // 触发/检查异步更新 DNS 优选排序（不阻塞主请求处理）
      updateFastestUpstream(ctx);

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

      // --- 【阶段 1：L1 ARC 内存缓存】 ---
      const arcCached = globalCache.get(cacheKey);
      if (arcCached) {
        return createDnsResponse(arcCached.buffer, 'HIT-L1-ARC');
      }

      // --- 【阶段 2：L2 Cloudflare Edge Cache API】 ---
      const cacheApi = caches.default;
      const cacheApiUrl = new URL(`https://dns-cache.local/${encodeURIComponent(cacheKey)}`);
      const cacheApiReq = new Request(cacheApiUrl.toString(), { method: 'GET' });

      let cfCachedRes = await cacheApi.match(cacheApiReq);
      if (cfCachedRes) {
        const buf = await cfCachedRes.arrayBuffer();
        globalCache.set(cacheKey, { buffer: buf }, CONFIG.MIN_TTL);
        return createDnsResponse(buf, 'HIT-L2-EDGE');
      }

      // --- 【阶段 3：请求去重合并 (Single-Flight Deduplication)】 ---
      if (inFlightRequests.has(cacheKey)) {
        const upstreamBuf = await inFlightRequests.get(cacheKey);
        if (upstreamBuf) return createDnsResponse(upstreamBuf.buffer, 'HIT-INFLIGHT-DEDUP');
      }

      // --- 【阶段 4：按优选顺序请求 DNS（支持自动故障转移及限速回退）】 ---
      const fetchPromise = (async () => {
        try {
          return await fetchWithSequentialFallback(dnsBuffer, request.headers, clientIP);
        } finally {
          inFlightRequests.delete(cacheKey);
        }
      })();

      inFlightRequests.set(cacheKey, fetchPromise);
      const upstreamResponse = await fetchPromise;

      if (upstreamResponse) {
        // 1. 写入 L1 内存缓存
        globalCache.set(cacheKey, { buffer: upstreamResponse.buffer }, CONFIG.MIN_TTL);

        // 2. 写入 L2 边缘节点 Cache API
        const responseToCache = new Response(upstreamResponse.buffer, {
          headers: {
            'Content-Type': 'application/dns-message',
            'Cache-Control': `public, max-age=${CONFIG.MIN_TTL}`,
          },
        });
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(cacheApi.put(cacheApiReq, responseToCache));
        }

        return createDnsResponse(upstreamResponse.buffer, 'MISS', upstreamResponse.provider);
      }

      return new Response('Upstream DNS Limit/Failure', { status: 504 });

    } catch (err) {
      return new Response(`DNS Processing Error: ${err.message}`, { status: 500 });
    }
  }
};

// ==================== 5. 顺序回退请求逻辑（缓解 429 与限速） ====================
async function fetchWithSequentialFallback(dnsBuffer, origHeaders, clientIP) {
  const currentList = [...sortedUpstreams]; // 使用当前最快排序列表

  for (const upstream of currentList) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT);

    try {
      const headers = new Headers({
        'Accept': 'application/dns-message',
        'Content-Type': 'application/dns-message',
      });

      // EDNS Client Subnet (ECS) 透传
      if (origHeaders.has('edns-client-subnet')) {
        headers.set('edns-client-subnet', origHeaders.get('edns-client-subnet'));
      } else if (clientIP) {
        headers.set('X-Forwarded-For', clientIP);
      }

      // DNSSEC 参数透传
      if (origHeaders.has('accept')) {
        headers.set('Accept', origHeaders.get('accept'));
      }

      const response = await fetch(upstream, {
        method: 'POST',
        headers: headers,
        body: dnsBuffer,
        signal: controller.signal,
        cf: { cacheTtl: 0 }
      });

      clearTimeout(timer);

      // 若遇 429 限速或 5xx 错误，立即尝试下一个上游
      if (response.status === 429 || response.status >= 500) {
        continue;
      }

      if (response.ok && response.headers.get('content-type')?.includes('application/dns-message')) {
        const buffer = await response.arrayBuffer();
        return { buffer, provider: upstream };
      }
    } catch (e) {
      clearTimeout(timer);
      // 网络错误/超时，自动切换下一节点
      continue;
    }
  }

  return null; // 若全部上游异常则返回 null
}

// 辅助工具：组装 Response
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

// 辅助工具：Base64URL 转 ArrayBuffer
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
