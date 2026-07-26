// constants/difficulty.js
// Dificuldades de mundo — desbloqueadas pelo total de NPCs mortos (npcKills).
//
// `mult` multiplica os ATRIBUTOS dos NPCs (HP e dano) na dificuldade base.
// `rewardMult` escala as RECOMPENSAS (ouro, XP, dobrão, fragmentos, chance de
// drop) — deliberadamente NÃO é metade uniforme: fácil/médio pagam 1:1 (baixo
// risco não precisa de desconto), difícil em diante paga metade do desafio
// (risco cresce mais rápido que o lucro, senão fica fácil demais "ficar full").
//
// Fácil (id 0) = mult 1.0 = comportamento atual do jogo (baseline).
// Para adicionar mais tiers (ex: 2000/5000/10000 kills) basta acrescentar
// entradas aqui e as chaves de i18n no cliente.
const DIFFICULTIES = [
  { id: 0, key: 'easy',      mult: 1.0,  reqKills: 0,    rewardMult: 1 },
  { id: 1, key: 'normal',    mult: 2.0,  reqKills: 100,  rewardMult: 2 },
  { id: 2, key: 'hard',      mult: 6.0,  reqKills: 500,  rewardMult: 3 },
  { id: 3, key: 'very_hard', mult: 8.0,  reqKills: 2000,  rewardMult: 4 },
  { id: 4, key: 'extreme',   mult: 10.0, reqKills: 5000, rewardMult: 5 },
];

/** Definição da dificuldade por índice (clampa para faixa válida). */
function difficultyDef(idx) {
  const i = Math.max(0, Math.min(DIFFICULTIES.length - 1, idx | 0));
  return DIFFICULTIES[i];
}

/** Multiplicador da dificuldade por índice (1.0 se inválida). */
function difficultyMult(idx) {
  const def = DIFFICULTIES[idx | 0];
  return def ? def.mult : 1.0;
}

/** true se o jogador com `npcKills` já desbloqueou a dificuldade `idx`. */
function isDifficultyUnlocked(idx, npcKills) {
  const def = DIFFICULTIES[idx | 0];
  return !!def && (npcKills || 0) >= def.reqKills;
}

// Pontos de controle (mult → rewardMult) ordenados, derivados de DIFFICULTIES —
// única fonte da verdade. Usado para interpolar o caso do World Boss, cujo
// diffMult é uma MÉDIA de difficultyMult dos jogadores online e por isso pode
// cair entre dois tiers (ex.: metade em 'normal', metade em 'hard' → mult 4.0,
// que não bate exatamente com nenhuma linha da tabela).
const _REWARD_POINTS = [...DIFFICULTIES]
  .sort((a, b) => a.mult - b.mult)
  .map(d => ({ x: d.mult, y: d.rewardMult }));

/**
 * Multiplicador de RECOMPENSA a partir do multiplicador de ATRIBUTOS travado
 * no NPC/boss (`npc.diffMult`/`boss.diffMult`). Bate exato com a tabela para
 * qualquer NPC/boss normal (diffMult sempre = um dos `mult` acima); interpola
 * linearmente só no caso do World Boss (média entre tiers).
 */
function difficultyRewardMult(mult) {
  const m = mult || 1;
  const pts = _REWARD_POINTS;
  if (m <= pts[0].x) return pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    if (m <= pts[i].x) {
      const a = pts[i - 1], b = pts[i];
      const t = (m - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return pts[pts.length - 1].y;
}

module.exports = { DIFFICULTIES, difficultyDef, difficultyMult, difficultyRewardMult, isDifficultyUnlocked };
