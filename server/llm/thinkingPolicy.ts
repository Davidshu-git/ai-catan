// ============================================================
// thinking 模式自动策略
// ------------------------------------------------------------
// agent.thinkingMode='auto' 时由这里决定该不该真的开 thinking。
// 设计原则：只在"多因素权衡 + 信息已经被 hint/legalActions 嚼过仍需多步推理"
// 的场景开；贪心/forced/单选场景不开，节省 token 与延迟。
// 详见 README 里的"CoT 收益 vs 卡坦决策"小节。
// ============================================================

import type { Phase } from '../../shared/types';

/**
 * auto 模式下，给定当前 phase 是否值得开 thinking。
 *
 * 开（值得多步推理）：
 *   - setup1 / setup2：选顶点 + 选路，多因素（产出 × 多样性 × 港口 × 邻居威胁）
 *   - moveRobber：放强盗哪格，权衡领先者高产地块 vs 复仇风险
 *   - steal：偷谁，多因素（领先 / 手牌多 / 关系恶劣）
 *
 * 关（贪心 / 单选 / forced）：
 *   - roll：唯一动作
 *   - discard：通常 forced 或近 forced，且已走规则 AI 不喂 LLM
 *   - main：大多数是贪心选项（能建城就建城），开 think 边际收益小
 *   - gameOver：不该被调用，兜底关
 *
 * 注意：交易（OFFER_TRADE）不在 actionCatalog 里，由独立的 negotiation 流程
 * 处理，本函数不覆盖交易决策。交易 LLM 仍读 spec.enableThinking。
 */
export function autoThinkingEnabled(phase: Phase): boolean {
  switch (phase) {
    case 'setup1':
    case 'setup2':
    case 'moveRobber':
    case 'steal':
      return true;
    default:
      return false;
  }
}
