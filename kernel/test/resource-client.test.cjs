/**
 * resource-client.cjs 测试：本地文件适配器查询（经验库/解法池）/ 过滤规则 / HTTP 客户端四接口真实往返
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createLocalResourceClient, createHttpClient } = require('../src/resource-client.cjs');
const { makeTmpDir, rmTmpDir } = require('./helpers.cjs');

const FP = 'c'.repeat(16);

/** 造一份含 \r\n 行尾的 JSONL（验证读取兼容性） */
function writeJsonl(file, rows) {
  fs.writeFileSync(
    file,
    rows.map((r) => JSON.stringify(r)).join('\r\n') + '\r\n',
    'utf8'
  );
}

test('本地经验库查询：按 fingerprint/agent 过滤，只回 active 且 credit>0', async () => {
  const dir = makeTmpDir('res-exp');
  try {
    const expPath = path.join(dir, 'experiences.jsonl');
    writeJsonl(expPath, [
      { fingerprint: FP, agent: 'novel-studio', content: 'e1', status: 'active', credit: 3 },
      { fingerprint: FP, agent: 'other-agent', content: 'e2', status: 'active', credit: 1 },
      { fingerprint: FP, agent: 'novel-studio', content: 'e3', status: 'retired', credit: 9 },
      { fingerprint: FP, agent: 'novel-studio', content: 'e4', status: 'active', credit: 0 },
      { fingerprint: 'd'.repeat(16), agent: 'novel-studio', content: 'e5', status: 'active', credit: 9 },
    ]);
    const client = createLocalResourceClient({ experiencesPath: expPath });
    const mine = await client.queryExperiences({ fingerprint: FP, agent: 'novel-studio' });
    assert.deepEqual(mine.map((x) => x.content), ['e1'], '只留同 agent、active、credit>0 的经验');
    const all = await client.queryExperiences({ fingerprint: FP });
    assert.equal(all.length, 2);
    // 兼容 \r\n：5 行全部解析成功；默认过滤后仅剩 3 条有效经验（retired 与 credit=0 被剔除）
    assert.equal((await client.queryExperiences({})).length, 3);
  } finally {
    rmTmpDir(dir);
  }
});

test('本地解法池查询：按 fingerprint 过滤；空路径返回空数组', async () => {
  const dir = makeTmpDir('res-sol');
  try {
    const solPath = path.join(dir, 'solutions.jsonl');
    writeJsonl(solPath, [
      { fingerprint: FP, title: '外部解法A', content: '先降并发', expected_gain: 5 },
      { fingerprint: 'e'.repeat(16), title: '别的错', content: 'x' },
    ]);
    const client = createLocalResourceClient({ solutionsPath: solPath });
    const hits = await client.querySolutions({ fingerprint: FP });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, '外部解法A');
    const empty = createLocalResourceClient({});
    assert.deepEqual(await empty.querySolutions({ fingerprint: FP }), []);
  } finally {
    rmTmpDir(dir);
  }
});

test('HTTP 客户端：四接口真实往返（GET 查询 / POST analyze+verify / 404 抛错 / soft-fail 兜底）', async () => {
  const server = http.createServer((req, res) => {
    const writeJson = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(body);
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/resources/experiences') {
      writeJson(200, { items: [{ id: 'EXP-1', fingerprint: FP, agent: 'novel-studio', content: 'e1', status: 'active', credit: 3 }] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/resources/solutions') {
      writeJson(200, { items: [{ id: 'SOL-1', fingerprint: FP, title: '外部解法A', content: '先降并发', expected_gain: 5 }] });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/jobs/analyze') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        writeJson(200, { job_id: 'JOB-1', status: 'done', traces_ref: body.traces_ref, candidates: [] });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/verify') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        writeJson(200, { experience_id: body.experience_id, verdict: 'cross_validated', cross_validated_credit: 6 });
      });
      return;
    }
    writeJson(404, { error: { code: 'NOT_FOUND', message: 'no route' } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const client = createHttpClient(baseUrl);
    assert.equal(client.kind, 'http');

    const exps = await client.queryExperiences({ fingerprint: FP });
    assert.equal(exps.length, 1);
    assert.equal(exps[0].content, 'e1');

    const sols = await client.querySolutions({ fingerprint: FP });
    assert.equal(sols.length, 1);
    assert.equal(sols[0].title, '外部解法A');

    const job = await client.analyze({ traces_ref: '/tmp/traces.jsonl', agent: 'novel-studio' });
    assert.equal(job.job_id, 'JOB-1');
    assert.equal(job.traces_ref, '/tmp/traces.jsonl');

    const verdict = await client.verify({ experience_id: 'EXP-1' });
    assert.equal(verdict.verdict, 'cross_validated');

    // 未知路径 → 查询类 soft-fail 兜底 []，动作类抛 HTTP_ERROR
    const unknownClient = createHttpClient(`${baseUrl}/missing-prefix`);
    assert.deepEqual(await unknownClient.querySolutions({ fingerprint: FP }), []);
    assert.ok(unknownClient.lastError instanceof Error);
    await assert.rejects(() => unknownClient.verify({ experience_id: 'EXP-1' }), /HTTP_ERROR/);

    // 关闭端口 → 查询类默认 resolve []，不打断内核主链路
    const strictClient = createHttpClient('http://127.0.0.1:1', { timeoutMs: 800 });
    assert.deepEqual(await strictClient.queryExperiences({}), []);
    assert.ok(strictClient.lastError instanceof Error);
    // softFail=false 时查询失败抛错
    const hardClient = createHttpClient('http://127.0.0.1:1', { timeoutMs: 800, softFail: false });
    await assert.rejects(() => hardClient.queryExperiences({}), /HTTP_ERROR|HTTP_TIMEOUT|fetch failed/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
