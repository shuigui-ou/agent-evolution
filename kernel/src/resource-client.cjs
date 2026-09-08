/**
 * @module resource-client
 * @layer L0 外挂资源层客户端
 * @owner Kou（工程师，K1）
 *
 * 规范 §3（T3 外挂无进化能力）与 §5：外挂资源层只提供只读/受控接口——
 *  - 外置记忆：GET /resources/experiences?fingerprint=&agent=（经验库查询，含 credit/status）
 *  - 解法索引：GET /resources/solutions?fingerprint=（同错他人解法 + 命中统计）
 *  - 定时批分析：POST /jobs/analyze（算力外包）
 *  - 独立复验：POST /verify（信用他评）
 *
 * 本模块提供两种客户端：
 *  - 本地文件适配器（K1 默认）：经验库/解法池 JSONL 查询（零依赖）
 *  - HTTP 客户端（K5 补齐）：Node 内置 fetch 对接 AED 资源服务四接口；
 *    查询类接口在网络故障时默认 soft-fail（resolve [] 不打断内核主链路），
 *    POST 类动作接口失败时抛 KernelError（调用方需要知道任务/复验没跑成）。
 *
 * 原则：外挂不写任何 agent 的知识面——落地动作全部由内核原语④执行。
 */
'use strict';

const { KernelError, readJsonl } = require('./util.cjs');

/**
 * 本地文件适配器：经验库 / 解法池 JSONL 查询
 * @param {object} opts
 * @param {string} [opts.experiencesPath] - 经验库 JSONL 路径
 * @param {string} [opts.solutionsPath] - 解法池 JSONL 路径
 * @returns {object} resource client
 */
function createLocalResourceClient({ experiencesPath = null, solutionsPath = null } = {}) {
  return {
    kind: 'local',
    /**
     * 经验库查询：按 fingerprint（可选 agent）过滤，只返回 status=active 且 credit>0 的条目
     */
    async queryExperiences({ fingerprint = '', agent = '' } = {}) {
      if (!experiencesPath) return [];
      return readJsonl(experiencesPath).filter(
        (e) =>
          (!fingerprint || e.fingerprint === fingerprint) &&
          (!agent || e.agent === agent) &&
          (e.status ? e.status === 'active' : true) &&
          (typeof e.credit === 'number' ? e.credit > 0 : true)
      );
    },
    /**
     * 解法索引查询：按 fingerprint 过滤同错他人解法（含命中统计与环境标签原样透传）
     */
    async querySolutions({ fingerprint = '' } = {}) {
      if (!solutionsPath) return [];
      return readJsonl(solutionsPath).filter((s) => !fingerprint || s.fingerprint === fingerprint);
    },
  };
}

/**
 * 基于 Node 内置 fetch 的 HTTP 资源客户端（K5 接入 AED 资源服务）。
 * 查询类接口（experiences/solutions）默认 soft-fail：网络/服务错误时 resolve []
 * 并记录 this.lastError，保证内核 preAction/analyze 主链路不被外挂拖垮；
 * 动作类接口（analyze/verify）失败时抛 KernelError（调用方必须感知）。
 *
 * @param {string} baseUrl - 资源服务根地址，如 http://127.0.0.1:7879
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000] - 单请求超时
 * @param {boolean} [opts.softFail=true] - 查询类接口网络失败时返回 []（默认开）
 * @returns {object} resource client
 */
function createHttpClient(baseUrl = '', { timeoutMs = 5000, softFail = true } = {}) {
  const normBase = String(baseUrl || '').replace(/\/+$/, '');
  const client = {
    kind: 'http',
    baseUrl: normBase,
    timeoutMs,
    lastError: null,
  };

  /** 统一 fetch+JSON 封装：超时中断 + 非 2xx 抛 HTTP_ERROR */
  async function fetchJson(url, { method = 'GET', body = null } = {}) {
    if (!normBase) {
      throw new KernelError('HTTP_NO_BASE', `资源服务 baseUrl 未配置，无法发起 ${method} ${url}`, {
        method,
        url,
      });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const init = { method, signal: ctrl.signal };
      if (body !== null) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      if (!res.ok) {
        const text = await res.text();
        throw new KernelError(
          'HTTP_ERROR',
          `资源服务返回 HTTP ${res.status}（${method} ${url}）: ${String(text || '').slice(0, 200)}`,
          { status: res.status, url }
        );
      }
      return await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new KernelError('HTTP_TIMEOUT', `资源服务请求超时(>${timeoutMs}ms): ${method} ${url}`, {
          method,
          url,
        });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 查询类包装：softFail 开启时吞网络错误回 [] */
  async function queryWrap(pathAndQuery) {
    try {
      const data = await fetchJson(`${normBase}${pathAndQuery}`);
      return (data && Array.isArray(data.items)) ? data.items : [];
    } catch (e) {
      if (softFail) {
        client.lastError = e;
        return [];
      }
      throw e;
    }
  }

  client.queryExperiences = async ({ fingerprint = '', agent = '' } = {}) => {
    const qs = new URLSearchParams();
    if (fingerprint) qs.set('fingerprint', fingerprint);
    if (agent) qs.set('agent', agent);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return queryWrap(`/resources/experiences${suffix}`);
  };

  client.querySolutions = async ({ fingerprint = '', agent = '', skeleton = '' } = {}) => {
    const qs = new URLSearchParams();
    if (fingerprint) qs.set('fingerprint', fingerprint);
    if (agent) qs.set('agent', agent);
    if (skeleton) qs.set('skeleton', skeleton);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return queryWrap(`/resources/solutions${suffix}`);
  };

  client.analyze = async ({ traces_ref = '', agent = '', env = '' } = {}) => {
    return fetchJson(`${normBase}/jobs/analyze`, { method: 'POST', body: { traces_ref, agent, env } });
  };

  client.verify = async ({ experience_id = '' } = {}) => {
    return fetchJson(`${normBase}/verify`, { method: 'POST', body: { experience_id } });
  };

  /** 健康检查（失败时 soft 返回 false，不抛） */
  client.health = async () => {
    try {
      const data = await fetchJson(`${normBase}/healthz`);
      return !!(data && data.ok);
    } catch (_e) {
      return false;
    }
  };

  return client;
}

module.exports = { createLocalResourceClient, createHttpClient };
