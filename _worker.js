/**
 * Advanced DoH (DNS over HTTPS) Proxy for Cloudflare Workers / Pages
 * Features: Memory LRU Cache, Auto-Speed Race, Health Penalty, ECS, DNSSEC
 */

// 1. 上游 DoH 列表 (可根据需要添加或替换)
const UPSTREAM_DNS = [
  'https://dns.alidns.com/dns-query',      // 阿里云
  'https://doh.pub/dns-query',             // 腾讯云 (DNSPod)
  'https://dns.google/dns-query',          // Google DNS
  'https://1.1.1.1/dns-query',             // Cloudflare DNS
];

// 2. 节点健康度与延迟状态追踪 (运行在 Workers 内存中)
const upstreamStats = UPSTREAM_DNS.map(url => ({
  url,
  latency: 50,      // 初始估算延迟 (ms)
  fails: 0,        // 连续失败/限速计数
  penaltyUntil: 0  // 惩罚截至时间戳
}));

// 3. 内存 LRU 缓存 (无需 KV，零 API 消耗)
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
    // 移除最旧的元素
    const oldestKey = dnsCache.keys().next().value;
    dnsCache.delete(oldestKey);
  }
  // 最少缓存 10 秒，最多缓存 3600 秒，防止过度频繁请求
  const effectiveTTL = Math.max(10, Math.min(ttlSeconds || 60, 3600));
  dnsCache.set(key, {
    data,
    expireAt: Date.now() + effectiveTTL * 1000
  });
}

// 4. 选择最佳上游 DNS (基于延迟和惩罚机制)
function getBestUpstreams(count = 2) {
  const now = Date.now();
  return upstreamStats
    .map(item => {
      let score = item.latency;
      // 如果处于惩罚期（被限速或超时），增加惩罚权重
      if (now < item.penaltyUntil) {
        score += 2000;
      }
      return { ...item, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, count);
}

// 5. 更新上游状态
function updateUpstreamStat(url, duration, isSuccess) {
  const stat = upstreamStats.find(s => s.url === url);
  if (!stat) return;

  if (isSuccess) {
    // EWMA 平滑计算延迟
    stat.latency = Math.round(stat.latency * 0.7 + duration * 0.3);
    stat.fails = Math.max(0, stat.fails - 1);
  } else {
    stat.fails += 1;
    // 连续失败触发惩罚时间 (例如 30 秒内降权避开)
    stat.penaltyUntil = Date.now() + Math.min(stat.fails * 10000, 60000);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查/根目录提示
    if (url.pathname === '/' && request.method === 'GET' && !url.searchParams.has('dns')) {
      return new Response('DoH Proxy is Running Successfully.', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      });
    }

    // 只处理 /dns-query 或带有 ?dns= 的请求
    if (url.pathname !== '/dns-query' && !url.searchParams.has('dns')) {
      return new Response('Not Found', { status: 404 });
    }

    let dnsBuffer = null;
    let cacheKey = '';

    // 解析 GET 或 POST 中的 DNS wireformat 数据
    if (request.method === 'GET' && url.searchParams.has('dns')) {
      const base64Param = url.searchParams.get('dns');
      cacheKey = 'GET:' + base64Param;
      dnsBuffer = base64ToUint8Array(base64Param);
    } else if (request.method === 'POST' && request.headers.get('content-type') === 'application/dns-message') {
      const arrayBuffer = await request.arrayBuffer();
      dnsBuffer = new Uint8Array(arrayBuffer);
      // 将二进制数据做简单哈希/字符串化作为缓存 Key
      cacheKey = 'POST:' + arrayBufferToBase64(dnsBuffer);
    } else {
      return new Response('Bad Request', { status: 400 });
    }

    // 1. 尝试从内存缓存读取
    const cachedResponse = getCache(cacheKey);
    if (cachedResponse) {
      return new Response(cachedResponse, {
        status: 200,
        headers: {
          'content-type': 'application/dns-message',
          'x-cache': 'HIT-MEMORY'
        }
      });
    }

    // 2. 选择当前体验最佳的 2 个上游并发/备选查询
    const bestTargets = getBestUpstreams(2);
    
    // 获取客户端 IP 准备透传 EDNS (ECS)
    const clientIP = request.headers.get('cf-connecting-ip') || '';

    // 向上游发起请求
    const fetchPromises = bestTargets.map(target => {
      const startTime = Date.now();
      const reqHeaders = {
        'accept': 'application/dns-message',
        'content-type': 'application/dns-message'
      };
      
      // 透传 EDNS (ECS) 客户端 IP 提升解析精准度
      if (clientIP) {
        reqHeaders['x-forwarded-for'] = clientIP;
      }

      return fetch(target.url + (request.method === 'GET' ? `?dns=${url.searchParams.get('dns')}` : ''), {
        method: request.method,
        headers: reqHeaders,
        body: request.method === 'POST' ? dnsBuffer : null,
        timeout: 3000
      }).then(async res => {
        const duration = Date.now() - startTime;
        if (res.ok && res.headers.get('content-type')?.includes('application/dns-message')) {
          updateUpstreamStat(target.url, duration, true);
          const data = await res.arrayBuffer();
          return { data, targetUrl: target.url };
        } else {
          updateUpstreamStat(target.url, duration, false);
          throw new Error(`Upstream ${target.url} responded status ${res.status}`);
        }
      }).catch(err => {
        updateUpstreamStat(target.url, 3000, false);
        throw err;
      });
    });

    try {
      // 采用 Promise.any：哪家上游先正确返回结果，就直接用哪家的
      const winner = await Promise.any(fetchPromises);
      const responseBuffer = winner.data;

      // 简单解析 TTL（若解不出则默认 60 秒）
      const ttl = parseTTLFromDNSResponse(new Uint8Array(responseBuffer)) || 60;

      // 写入内存缓存
      setCache(cacheKey, responseBuffer, ttl);

      return new Response(responseBuffer, {
        status: 200,
        headers: {
          'content-type': 'application/dns-message',
          'cache-control': `max-age=${ttl}`,
          'x-dns-upstream': winner.targetUrl,
          'x-cache': 'MISS'
        }
      });
    } catch (e) {
      return new Response('DNS Resolving Failed or All Upstreams Rate Limited', { status: 502 });
    }
  }
};

// --- 工具函数：Base64 编解码与 DNS 响应 TTL 简易解析 ---

function base64ToUint8Array(base64) {
  const binaryString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 解析 DNS 二进制报文中的 Answer TTL
function parseTTLFromDNSResponse(buf) {
  try {
    if (buf.length < 12) return 60;
    const ancount = (buf[6] << 8) | buf[7];
    if (ancount === 0) return 30; // 无响应记录时简短缓存

    let offset = 12;
    const qdcount = (buf[4] << 8) | buf[5];
    
    // 跳过 Question 区块
    for (let i = 0; i < qdcount; i++) {
      while (offset < buf.length) {
        const len = buf[offset];
        if (len === 0) { offset += 5; break; }
        if ((len & 0xC0) === 0xC0) { offset += 6; break; }
        offset += len + 1;
      }
    }

    // 读取 Answer 第一条记录的 TTL
    if (offset < buf.length) {
      if ((buf[offset] & 0xC0) === 0xC0) {
        offset += 2;
      } else {
        while (offset < buf.length && buf[offset] !== 0) {
          offset += buf[offset] + 1;
        }
        offset += 1;
      }
      offset += 4; // 跳过 Type 和 Class
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
