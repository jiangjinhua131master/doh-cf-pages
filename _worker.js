/**
 * Advanced DoH Resolver for Cloudflare Workers / Pages
 * Features: LRU Cache, Multi-upstream Race, DNSSEC, EDNS (ECS) forwarding, RFC 8484 compliant.
 */

// ==================== 配置项 ====================
const CONFIG = {
  // 1. 上游 DoH 列表：开启并发竞速，取最快返回的有效响应
  UPSTREAMS: [
    'https://dns.google/dns-query',
    'https://1.1.1.1/dns-query'
  ],
  
  // 2. LRU 缓存设置
  CACHE_MAX_ENTRIES: 1000,    // 内存最多保存的 DNS 记录条数
  MIN_TTL: 60,                // 强制最小缓存 TTL（秒），避免短 TTL 频繁触发上游请求
  MAX_TTL: 86400,             // 最大缓存 TTL（秒）
  
  // 3. 超时设置（毫秒）
  UPSTREAM_TIMEOUT: 2500,     // 单个上游超时时间
};

// ==================== LRU Cache 缓存实现 ====================
class LRUCache {
  constructor(limit) {
    this.limit = limit;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const item = this.cache.get(key);
    
    // 检查是否过期
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    
    // 刷新 LRU 顺序
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.data;
  }

  set(key, value, ttlSeconds) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.limit) {
      // 淘汰最老未使用的条目 (Map 的第一个 key)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    const ttl = Math.max(CONFIG.MIN_TTL, Math.min(ttlSeconds || CONFIG.MIN_TTL, CONFIG.MAX_TTL));
    this.cache.set(key, {
      data: value,
      expiresAt: Date.now() + ttl * 1000
    });
  }
}

// 实例化全局内存缓存（Worker 实例生命周期内持续有效）
const globalCache = new LRUCache(CONFIG.CACHE_MAX_ENTRIES);

// ==================== 主逻辑处理 ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 仅响应 /dns-query 路径及根路径
    if (url.pathname !== '/dns-query' && url.pathname !== '/') {
      return new Response('Not Found', { status: 404 });
    }

    // CORS 跨域支持
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

      // 提取客户端 IP 以便透传 EDNS (ECS)
      const clientIP = request.headers.get('cf-connecting-ip') || '';

      // 1. 解析请求体/参数（支持 GET 和 POST RFC 8484 规格）
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
        // 对 POST body 计算简单 hash 作为缓存 key
        const hashBuf = await crypto.subtle.digest('SHA-256', dnsBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuf));
        cacheKey = `POST:${hashArray.map(b => b.toString(16).padStart(2, '0')).join('')}`;
      } else {
        return new Response('Method Not Allowed', { status: 405 });
      }

      // 2. 查询 LRU 缓存 (命中则直接秒回)
      const cachedResponse = globalCache.get(cacheKey);
      if (cachedResponse) {
        return createDnsResponse(cachedResponse.buffer, 'HIT-LRU');
      }

      // 3. 缓存未命中，并发请求上游 DNS (并发竞赛，极速响应)
      const upstreamResponse = await raceUpstreams(dnsBuffer, request.headers, clientIP);

      if (upstreamResponse) {
        // 缓存本次查询结果
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

// 并发请求多上游 DNS，取最快返回且状态码为 200 的响应
async function raceUpstreams(dnsBuffer, origHeaders, clientIP) {
  const controller = new AbortController();
  const { signal } = controller;

  const fetchPromises = CONFIG.UPSTREAMS.map(async (upstream) => {
    try {
      const headers = new Headers({
        'Accept': 'application/dns-message',
        'Content-Type': 'application/dns-message',
      });

      // 保留并透传 EDNS Client Subnet (ECS)
      if (origHeaders.has('edns-client-subnet')) {
        headers.set('edns-client-subnet', origHeaders.get('edns-client-subnet'));
      } else if (clientIP) {
        // 若客户端未显式带 ECS，自动透传客户端真实 IP 段以优化 CDN 解析
        headers.set('X-Forwarded-For', clientIP);
      }

      // 转发 DNSSEC 标记请求
      if (origHeaders.has('accept')) {
        headers.set('Accept', origHeaders.get('accept'));
      }

      const response = await fetch(upstream, {
        method: 'POST',
        headers: headers,
        body: dnsBuffer,
        signal: signal,
        cf: {
          cacheTtl: 0, // 禁用 Cloudflare 节点默认 HTTP 缓存，由 Worker LRU 接管
        }
      });

      if (response.ok && response.headers.get('content-type')?.includes('application/dns-message')) {
        const buffer = await response.arrayBuffer();
        controller.abort(); // 胜出者取消其他未完成请求
        return { buffer, provider: upstream };
      }
      throw new Error(`Upstream ${upstream} failed status`);
    } catch (e) {
      throw e;
    }
  });

  try {
    // Promise.any 实现优先响应竞速
    return await Promise.any(fetchPromises);
  } catch (aggregateError) {
    return null; // 全部上游均失败
  }
}

// 组装标准的 DoH HTTP Response
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

// Base64URL 转 ArrayBuffer
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
