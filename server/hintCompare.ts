// ============================================================
// hint A/B 对比：同一个空间决策点，hint on vs off 各调一次 LLM
// ------------------------------------------------------------
// 目的：肉眼对比 thought 质量与 actionId 选择是否更合理，不烧整局 token。
// 默认对比 1 个决策点（setup1 第一个房屋）。
// 可选 HINT_COMPARE_POINT=setup1|main_road 切换对比点（main_road 需先有局面，
// 此处 setup1 最便宜，main 阶段空间动作请用完整 sim+ logging）。
//
// 用法（容器内）：
//   docker run --rm --env-file .env -v "$PWD":/app -w /app node:20-alpine \
//     sh -c "npm install --no-fund --no-audit --silent && npx tsx server/hintCompare.ts"
// ============================================================

import { createGame } from '../shared/state';
import { createLlmProvider } from './llm/llmProvider';
import { buildActionCatalog } from './llm/actionCatalog';
import { buildPlayerView } from './llm/stateTranslator';
import type { LlmDecisionInput, LlmDecisionOutput, AiDecisionProvider, LegalAction } from './llm/types';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error('❌ 缺 MINIMAX_API_KEY（请确认 .env / 容器 --env-file）');
  process.exit(1);
}

async function decideWith(
  provider: AiDecisionProvider,
  input: LlmDecisionInput,
): Promise<{ out: LlmDecisionOutput; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const out = await provider.decide(input);
    return { out, ms: Date.now() - t0 };
  } catch (err) {
    return {
      out: { thought: '', actionId: '' },
      ms: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}

/** 找到选中的 LegalAction（用来打印它的 hint） */
function lookup(actions: LegalAction[], id: string): LegalAction | undefined {
  return actions.find((a) => a.id === id);
}

async function main() {
  // 1) 准备局面：setup1 第一步，玩家 P0 选第一个房屋顶点
  const { board, state } = createGame();
  state.players.forEach((p) => (p.isAI = true));

  // 2) 算 legalActions + view（hint 已经在 catalog 里嵌好）
  const legalActions = buildActionCatalog(board, state);
  const view = buildPlayerView(board, state, state.current);

  if (legalActions.length === 0) {
    console.error('❌ legalActions 为空，初始局面有问题');
    process.exit(1);
  }

  // 3) 两个 provider：useHint=true / false（其它配置完全相同）
  const providerOn = createLlmProvider({ apiKey: apiKey!, useHint: true });
  const providerOff = createLlmProvider({ apiKey: apiKey!, useHint: false });

  const input: LlmDecisionInput = { view, legalActions };

  console.log(`========== hint A/B 对比 ==========`);
  console.log(`决策点: setup1 第一房屋（玩家 ${view.self.name}）`);
  console.log(`合法动作数: ${legalActions.length}`);
  console.log(`provider on:  ${providerOn.name}`);
  console.log(`provider off: ${providerOff.name}`);
  console.log('');

  // 串行调，避免对方 rate-limit；先 off 后 on（顺序无影响，两次独立）
  console.log('▶ 调用 hint=OFF ...');
  const off = await decideWith(providerOff, input);
  console.log(`  ${off.ms}ms`);

  console.log('▶ 调用 hint=ON ...');
  const on = await decideWith(providerOn, input);
  console.log(`  ${on.ms}ms`);

  console.log('');
  console.log('================ 结果 ================');

  for (const [tag, r] of [
    ['hint=OFF', off],
    ['hint=ON', on],
  ] as const) {
    console.log(`\n--- ${tag} ---`);
    if (r.error) {
      console.log(`❌ error: ${r.error}`);
      continue;
    }
    console.log(`actionId : ${r.out.actionId}`);
    const picked = lookup(legalActions, r.out.actionId);
    if (!picked) {
      console.log(`⚠ actionId 不在 legalActions 里（LLM 自创了 id）`);
    } else {
      console.log(`label    : ${picked.label}`);
      console.log(`hint     : ${picked.hint ?? '(无 hint)'}`);
    }
    console.log(`thought  : ${r.out.thought}`);
  }

  const sameId = !off.error && !on.error && off.out.actionId === on.out.actionId;
  console.log('');
  console.log(`两边 actionId 是否相同: ${sameId ? '✅ 相同' : '❌ 不同（值得分析）'}`);

  // 退出码：只要两边都返回了 legalActions 里的 id 就算成功
  const ok =
    !off.error &&
    !on.error &&
    !!lookup(legalActions, off.out.actionId) &&
    !!lookup(legalActions, on.out.actionId);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('hintCompare crashed:', err);
  process.exit(2);
});
