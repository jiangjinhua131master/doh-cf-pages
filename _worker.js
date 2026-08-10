/**
 * Advanced DoH Resolver for Cloudflare Workers / Pages
 * Integrated with ARC (Adaptive Replacement Cache), Multi-upstream Race, DNSSEC & EDNS forwarding.
 */

// ==================== 配置项 ====================
const CONFIG = {
  // 1. 上游 DoH 列表：并发竞速
  UPSTREAMS: [
    'https://dns.google/dns-query',
    'https://1.1.1.1/dns-query'
  ],
  
  // 2. ARC 缓存设置
  CACHE_MAX_ENTRIES: 1000,    // 缓存总容量上限 (C)
  MIN_TTL: 60,                // 强制最小缓存 TTL（秒）
  MAX_TTL: 86400,             // 最大缓存 TTL（秒）
  
  // 3. 超时设置（毫秒）
  UPSTREAM_TIMEOUT: 2500,     // 单个上游超时时间
};

// ==================== ARC (Adaptive Replacement Cache) 算法实现 ====================
class ARCCache {
  constructor(capacity) {
    this.c = capacity;
    this.p = 0; // 自适应目标分割参数 (Target size for T1)

    // 四个核心 Map（使用 Map 保持插入顺序以模拟 LRU/FIFO）
    this.t1 = new Map(); // Recent items
    this.t2 = new Map(); // Frequent items
    this.b1 = new Map(); // Ghost entries for T1
    this.b2 = new Map(); // Ghost entries for T2
  }

  // 内部辅助：更新 Map 顺序 (将 Key 移动到最末尾)
  _touch(map, key) {
    const val = map.get(key);
    map.delete(key);
    map.set(key, val);
    return val;
  }

  get(key) {
    // 1. 检查 T1 (最近访问)
    if (this.t1.has(key)) {
      const item = this.t1.get(key);
      if (Date.now() > item.expiresAt) {
        this.t1.delete(key);
        return null;
      }
      // 命中后提升至 T2 (高频访问)
      this.t1.delete(key);
      this.t2.set(key, item);
      return item.data;
    }

    // 2. 检查 T2 (高频访问)
    if (this.t2.has(key)) {
      const item = this.t2.get(key);
      if (Date.now() > item.expiresAt) {
        this.t2.delete(key);
        return null;
      }
      // 刷新 T2 中的位置
      this._touch(this.t2, key);
      return item.data;
    }

    return null;
  }

  set(key, value, ttlSeconds) {
    const ttl = Math.max(CONFIG.MIN_TTL, Math.min(ttlSeconds || CONFIG.MIN_TTL, CONFIG.MAX_TTL));
    const newItem = { data: value, expiresAt: Date.now() + ttl * 1000 };

    // Case 1: Key 已经存在于 T1 或 T2，直接更新并提升至 T2
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

    // Case 2: Key 在 B1 Ghost 列表中 (自适应调大 p，增加 T1 容积)
    if (this.b1.has(key)) {
      const delta = this.b1.size >= this.b2.size ? 1 : this.b2.size / this.b1.size;
      this.p = Math.min(this.c, this.p + delta);
      this._replace(key);
      this.b1.delete(key);
      this.t2.set(key, newItem);
      return;
    }

    // Case 3: Key 在 B2 Ghost 列表中 (自适应调小 p，增加 T2 容积)
    if (this.b2.has(key)) {
      const delta = this.b2.size >= this.b1.size ? 1 : this.b1.size / this.b2.size;
      this.p = Math.max(0, this.p - delta);
      this._replace(key);
      this.b2.delete(key);
      this.t2.set(key, newItem);
      return;
    }

    // Case 4: 完全未命中的全新数据 (Brand new entry)
    const totalReal = this.t1.size + this.t2.size;
    const totalAll = totalReal + this.b1.size + this.b2.size;

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

    // 新元素进入 T1
    this.t1.set(key, newItem);
  }

  // 核心淘汰算法逻辑
  _replace(key) {
    const t1Size = this.t1.size;
    if (t1Size > 0 && (t1Size > this.p || (this.b2.has(key) && t1Size === Math.floor(this.p)))) {
      // 淘汰 T1 中最老的元素，将其 key 移入 Ghost 列表 B1
      const oldestT1 = this.t1.keys().next().value;
      const item = this.t1.get(oldestT1);
      this.t1.delete(oldestT1);
      this.b1.set(oldestT1, true);
    } else {
      // 淘汰 T2 中最老的元素，将其 key 移入 Ghost 列表 B2
      const oldestT2 = this.t2.keys().next().value;
      const item = this.t2.get(oldestT2);
      this.t2.delete(oldestT2);
      this.b2.set(oldestT2, true);
    }
  }
}

// 实例化 ARC 全局内存缓存
const globalCache = new ARCCache(CONFIG.CACHE_MAX_ENTRIES);

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
        if (!dnsParam) {
          return new Response('Missing "dns" query parameter', { status: 400 });
        }
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

      // 1. 查询 ARC 缓存
      const cachedResponse = globalCache.get(cacheKey);
      if (cachedResponse) {
        return createDnsResponse(cachedResponse.buffer, 'HIT-ARC');
      }

      // 2. 未命中，并发竞速请求上游
      const upstreamResponse = await raceUpstreams(dnsBuffer, request.headers, clientIP);

      if (upstreamResponse) {
        globalCache.set(cacheKey, { buffer: upstreamResponse.buffer }, CONFIG.MIN_TTL);
        return createDnsResponse(upstreamResponse.buffer, 'MISS', upstreamResponse.provider);
      }

      return new Response('Upstream DNS Failure', { status: 504 });

    } catch (err) {
      return new Response(`DNS Processing Error: ${err.message}`, { status: 500 });
    }
  }
};

// ==================== 辅助功能实现 ====================

async function raceUpstreams(dnsBuffer, origHeaders, clientIP) {
  const controller = new AbortController();
  const { signal } = controller;

  const fetchPromises = CONFIG.UPSTREAMS.map(async (upstream) => {
    try {
      const headers = new Headers({
        'Accept': 'application/dns-message',
        'Content-Type': 'application/dns-message',
      });

      if (origHeaders.has('edns-client-subnet')) {
        headers.set('edns-client-subnet', origHeaders.get('edns-client-subnet'));
      } else if (clientIP) {
        headers.set('X-Forwarded-For', clientIP);
      }

      if (origHeaders.has('accept')) {
        headers.set('Accept', origHeaders.get('accept'));
      }

      const response = await fetch(upstream, {
        method: 'POST',
        headers: headers,
        body: dnsBuffer,
        signal: signal,
        cf: { cacheTtl: 0 }
      });

      if (response.ok && response.headers.get('content-type')?.includes('application/dns-message')) {
        const buffer = await response.arrayBuffer();
        controller.abort();
        return { buffer, provider: upstream };
      }
      throw new Error(`Upstream ${upstream} failed status`);
    } catch (e) {
      throw e;
    }
  });

  try {
    return await Promise.any(fetchPromises);
  } catch (aggregateError) {
    return null;
  }
}

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
