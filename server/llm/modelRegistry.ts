// ============================================================
// LLM 模型注册表：所有可调模型的单一事实来源
// ------------------------------------------------------------
// 设计目标：模型配置只在这里写一次，buildProvider / callLlm / 前端选项 / 别名归一
// 全部从本表派生。
//   - 新增模型 = 往 LLM_MODELS 加一条（复用已有 api adapter；只有遇到新 API 形态才需写 adapter）
//   - 停用模型 = 删掉 / 注释该条（订阅失效、换供应商都只动这里）
// rule / mock 是内置非 LLM provider，不在本表：它们无 API key、工厂签名是 (board, state)。
// 本模块 server-only（读 process.env），不要进 shared/ 或前端。
// ============================================================

/** API 形态：决定走哪个 adapter（anthropic 兼容 = llmProvider.ts；openai 兼容 = qwenProvider.ts） */
export type LlmApiShape = 'anthropic' | 'openai';

export interface LlmModelSpec {
  /** 稳定 provider key：前后端、持久化、set_ai_provider、别名归一都以它为准 */
  key: string;
  /** UI 显示名（含模型 id） */
  label: string;
  /** API 形态：决定 adapter 与 callLlm 分支 */
  api: LlmApiShape;
  /** 发给 API 的 model 字段 */
  model: string;
  /** anthropic: host（不含协议，如 api.minimaxi.com）；openai: 完整 base url */
  endpoint: string;
  /** 读取 api key 的环境变量名 */
  apiKeyEnv: string;
  /** 历史 / 简写别名（resolveProviderKey 归一用） */
  aliases: string[];
  /** 是否开启 thinking（trade/social 的 callLlm 用；decision adapter 自身另读 env） */
  enableThinking: boolean;
  /**
   * AiDecisionProvider.name / providerLabel 前缀（如 "qwen" / "deepseek" / "minimax"）。
   * 省略时按 api 推断：anthropic→minimax，openai→qwen。
   */
  labelPrefix?: string;
}

/** 取本 spec 的 label 前缀（与 AiDecisionProvider.name 前缀 / providerLabel 一致） */
export function labelPrefixOf(spec: LlmModelSpec): string {
  if (spec.labelPrefix) return spec.labelPrefix;
  return spec.api === 'anthropic' ? 'minimax' : 'qwen';
}

/** 内置非 LLM provider（不在注册表里，单独处理） */
export const BUILTIN_PROVIDERS = ['rule', 'mock'] as const;

function qwenModel(): string {
  return process.env.QWEN_MODEL ?? process.env.ALI_QWEN_MODEL ?? 'qwen3.6-plus';
}

export const LLM_MODELS: LlmModelSpec[] = [
  {
    key: 'qwen36',
    label: `Qwen ${qwenModel()}`,
    api: 'openai',
    model: qwenModel(),
    endpoint:
      process.env.ALI_CODING_PLAN_BASE_URL ??
      process.env.QWEN_BASE_URL ??
      'https://coding.dashscope.aliyuncs.com/v1',
    apiKeyEnv: 'ALI_CODING_PLAN_KEY',
    aliases: ['qwen', 'qwen3.6', 'qwen3.6-plus'],
    enableThinking: process.env.QWEN_ENABLE_THINKING === '1',
    labelPrefix: 'qwen',
  },

  {
    key: 'deepseek',
    label: `DeepSeek ${process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'}`,
    api: 'openai',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    endpoint: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    aliases: ['deepseek-v4-flash', 'deepseek-flash', 'dsf', 'ds'],
    enableThinking: false,
    labelPrefix: 'deepseek',
  },

  {
    key: 'deepseek-pro',
    label: `DeepSeek ${process.env.DEEPSEEK_PRO_MODEL ?? 'deepseek-v4-pro'}`,
    api: 'openai',
    model: process.env.DEEPSEEK_PRO_MODEL ?? 'deepseek-v4-pro',
    endpoint: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    aliases: ['deepseek-v4-pro', 'dsp'],
    enableThinking: false,
    labelPrefix: 'deepseek-pro',
  },

  // ── MiniMax 已退役（订阅失效，2026-05-25）──────────────────────────────
  // anthropic adapter（llmProvider.ts）仍在，重订阅时取消下面注释即可恢复：
  // {
  //   key: 'minimax',
  //   label: `MiniMax ${process.env.LLM_MODEL ?? 'MiniMax-M2.7'}`,
  //   api: 'anthropic',
  //   model: process.env.LLM_MODEL ?? 'MiniMax-M2.7',
  //   endpoint: process.env.MINIMAX_API_HOST ?? 'api.minimaxi.com',
  //   apiKeyEnv: 'MINIMAX_API_KEY',
  //   aliases: ['llm', 'minimax-m27', 'minimax-m2.7'],
  //   enableThinking: process.env.MINIMAX_ENABLE_THINKING === '1',
  // },
];

/** 按 key 或别名查模型（大小写不敏感） */
export function findModel(key: string): LlmModelSpec | undefined {
  const k = (key ?? '').trim().toLowerCase();
  if (!k) return undefined;
  return LLM_MODELS.find((m) => m.key === k || m.aliases.includes(k));
}

/** 该 provider 字符串是否对应一个已注册的 LLM 模型 */
export function isLlmProvider(key: string): boolean {
  return findModel(key) != null;
}

/**
 * 归一化任意 provider 字符串到稳定 key：
 *  - rule / mock 原样返回
 *  - LLM 模型 key / 别名 / 形如 "qwen(qwen3.6-plus)" 的 adapter 名 → canonical key
 *  - 其余（含已退役的 minimax）→ 'rule' 兜底
 */
export function resolveProviderKey(raw: string): string {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'rule' || v === 'mock') return v;
  const base = v.replace(/\(.*$/, ''); // "qwen(qwen3.6-plus)" → "qwen"
  const m = findModel(v) ?? findModel(base);
  return m ? m.key : 'rule';
}

/** 前端 provider 选项里的 LLM 部分（available 取决于对应 env key 是否就绪） */
export function llmModelOptions(): Array<{
  key: string;
  label: string;
  model: string;
  available: boolean;
  reason?: string;
}> {
  return LLM_MODELS.map((m) => {
    const ready = Boolean(process.env[m.apiKeyEnv]);
    return {
      key: m.key,
      label: m.label,
      model: m.model,
      available: ready,
      reason: ready ? undefined : `缺 ${m.apiKeyEnv}`,
    };
  });
}

/** 前端展示用 provider 标签（含模型 id）；非 LLM 原样返回。与历史输出保持一致。 */
export function providerLabel(key: string): string {
  const m = findModel(key);
  if (!m) return key;
  return `${labelPrefixOf(m)}(${m.model})`;
}

/**
 * 判断 AiDecisionProvider.name（如 "qwen(qwen3.6-plus+hint)" / "deepseek(deepseek-v4-flash)"）
 * 是否对应注册表里某个 LLM adapter。controller / observability 用它区分
 * "真 LLM（有 system+user prompt 可展示）" vs "rule/mock（结构化输入）"。
 */
export function isLlmAdapterName(name: string): boolean {
  if (!name) return false;
  const m = name.match(/^([a-z0-9-]+)\(/i);
  if (!m) return false;
  const prefix = m[1].toLowerCase();
  return LLM_MODELS.some((spec) => labelPrefixOf(spec) === prefix);
}
