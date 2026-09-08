/**
 * @module src/assessment/definitions
 * @layer 评估脚手架（K6）
 * @owner Alex（软件工程师，K5/K6）
 *
 * K6 四指标的权威定义（回溯式口径，不设前置基线窗）。
 * 每个指标自带 definition/algorithm 一句话，供 JSON 报告与人类可读摘要复用。
 */
'use strict';

const METRIC_DEFINITIONS = Object.freeze([
  {
    key: 'rr',
    name: 'RR 同类问题复发率',
    unit: 'ratio',
    polarity: 'lower_is_better',
    role: '北极星',
    definition:
      '已落地修复（至少一次内核写知识面 / 修复事件表）的同类问题指纹中，在首次修复时刻之后再次出现同类错误信号的比例。',
    algorithm:
      '以每个已修复指纹的首次修复时刻为分界，统计该时刻之后是否仍有该指纹的错误信号；RR = 复发指纹数 / 已修复指纹数。',
    empty: '无修复事件或无错误信号时返回 N/A（数值按 0 处理），不崩溃。',
  },
  {
    key: 'fsr',
    name: 'FSR 修复成功率',
    unit: 'ratio',
    polarity: 'higher_is_better',
    role: '配套',
    definition:
      '已落地且有 probe 反馈（至少一条记分记录）的经验中，至少一次“命中且解决（hit_solved）”的比例。',
    algorithm: 'FSR = 出现过 outcome=hit_solved 的经验数 / 有 probe 记分的经验数。',
    empty: 'probe 账本为空时返回 N/A（数值按 0 处理）。',
  },
  {
    key: 'missed_call_rate',
    name: '漏调用率',
    unit: 'ratio',
    polarity: 'lower_is_better',
    role: '配套',
    definition:
      '同类错误再现的判定样本中，注入经验未被调用（probe 记分 miss / 漏触发）的比例。',
    algorithm:
      '判定样本 = probe 中 hit_solved + hit_invalid + miss 的记录数；漏调用率 = miss 记录数 / 判定样本数。',
    empty: '判定样本为 0 时返回 N/A（数值按 0 处理）。',
  },
  {
    key: 'adherence_rate',
    name: '遵循率',
    unit: 'ratio',
    polarity: 'higher_is_better',
    role: '配套',
    definition:
      '同类错误再现时，agent 实际使用注入经验（无论是否一次解决）的比例——对应规范 §8“写入≠遵循”的遵循侧。',
    algorithm: '遵循率 = (hit_solved + hit_invalid) / (hit_solved + hit_invalid + miss)。',
    empty: '判定样本为 0 时返回 N/A（数值按 0 处理）。',
  },
]);

/** 指标元信息索引 */
function getMetricDefinition(key) {
  return METRIC_DEFINITIONS.find((d) => d.key === key) || null;
}

module.exports = { METRIC_DEFINITIONS, getMetricDefinition };
