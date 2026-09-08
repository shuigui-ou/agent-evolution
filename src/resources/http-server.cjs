/**
 * @module src/resources/http-server
 * @layer 资源服务（§5 四接口 HTTP 形态）
 * @owner Alex（软件工程师，K5）
 *
 * 零依赖 HTTP 服务器：把 resource-service 暴露成宿主未来可用
 * resource-client.cjs（HTTP 客户端）直接调用的四接口：
 *   GET  /resources/experiences?fingerprint=&agent=
 *   GET  /resources/solutions?fingerprint=&agent=&skeleton=&env=
 *   POST /jobs/analyze   { traces_ref, agent, env }
 *   POST /verify         { experience_id }
 * 另附 GET /healthz 供探活。
 */
'use strict';

const http = require('node:http');
const { KernelError, nowIso } = require('../../kernel/src/util.cjs');

const MAX_BODY_BYTES = 1024 * 1024; // 1MB

/** 把任意异常归一成可回包的 { code, message } */
function normalizeError(e) {
  if (e instanceof KernelError) {
    return { code: e.code, message: e.message.replace(/^\[[^\]]+\]\s*/, '') };
  }
  const code = (e && e.code) || 'E_INTERNAL';
  return { code, message: (e && e.message) || String(e) };
}

/**
 * 创建资源服务 HTTP 服务器
 * @param {object} opts
 * @param {object} opts.service - createResourceService() 返回
 * @param {string} [opts.host='127.0.0.1']
 * @param {number} [opts.port=7879]
 * @returns {object} { server, listen, close, baseUrl }
 */
function createResourceServer({ service, host = '127.0.0.1', port = 7879 } = {}) {
  if (!service || typeof service.queryExperiences !== 'function') {
    throw new KernelError('SERVER_INVALID', 'createResourceServer 需要注入 resource-service 实例');
  }

  const respondJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new KernelError('BODY_TOO_LARGE', `请求体超过 ${MAX_BODY_BYTES} 字节`));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (_e) {
          reject(new KernelError('BODY_INVALID_JSON', '请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });

  const handler = async (req, res) => {
    const started = nowIso();
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const method = String(req.method || 'GET').toUpperCase();
      const p = url.pathname;

      // 探活
      if (method === 'GET' && p === '/healthz') {
        respondJson(res, 200, { ok: true, ts: started });
        return;
      }

      // 外置记忆（只读）
      if (method === 'GET' && p === '/resources/experiences') {
        const out = service.queryExperiences({
          fingerprint: url.searchParams.get('fingerprint') || '',
          agent: url.searchParams.get('agent') || '',
          includeInactive: url.searchParams.get('includeInactive') === '1',
        });
        respondJson(res, 200, { ok: true, items: out.items, count: out.items.length, ts: started });
        return;
      }

      // 解法索引（只读 + 命中统计落盘）
      if (method === 'GET' && p === '/resources/solutions') {
        const out = service.querySolutions({
          fingerprint: url.searchParams.get('fingerprint') || '',
          skeleton: url.searchParams.get('skeleton') || '',
          agent: url.searchParams.get('agent') || '',
          env: url.searchParams.get('env') || '',
        });
        respondJson(res, 200, {
          ok: true,
          items: out.items,
          matched_count: out.matched_count,
          total_hits: out.total_hits,
          recorded_hits: out.recorded_hits,
          cross_agent_hits: out.cross_agent_hits,
          ts: started,
        });
        return;
      }

      // 定时批分析
      if (method === 'POST' && p === '/jobs/analyze') {
        const body = await readBody(req);
        const out = await service.analyzeTraces({
          traces_ref: body.traces_ref || body.tracesRef || '',
          agent: body.agent || 'unknown',
          env: body.env || 'unknown',
          base_dir: body.base_dir || undefined,
        });
        respondJson(res, 200, { ok: true, ...out });
        return;
      }

      // 独立复验
      if (method === 'POST' && p === '/verify') {
        const body = await readBody(req);
        const out = service.verifyExperience({ experience_id: body.experience_id || body.experienceId || '' });
        respondJson(res, 200, { ok: true, ...out });
        return;
      }

      respondJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未找到路由: ${method} ${p}` } });
    } catch (e) {
      const err = normalizeError(e);
      respondJson(res, e instanceof KernelError ? 400 : 500, { ok: false, error: err });
    }
  };

  const server = http.createServer(handler);

  /** 启动监听；port=0 时自动分配端口，返回实际端口 */
  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const actual = server.address();
        resolve({ host, port: typeof actual === 'object' && actual ? actual.port : port });
      });
    });
  }

  function close() {
    return new Promise((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    });
  }

  return { server, listen, close };
}

module.exports = { createResourceServer, normalizeError, MAX_BODY_BYTES };
