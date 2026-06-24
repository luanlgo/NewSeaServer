// constants/difficulty.js
// Dificuldades de mundo — desbloqueadas pelo total de NPCs mortos (npcKills).
//
// `mult` multiplica TUDO que o NPC já faz hoje na dificuldade base:
//   • HP e dano dos NPCs normais (não-boss)  → mais difícil
//   • recompensas (ouro, XP, dobrão, fragmentos, chance de drop) → mais lucro
//
// Fácil (id 0) = mult 1.0 = comportamento atual do jogo (baseline).
// As demais escalam para cima. Para adicionar mais tiers (ex: 2000/5000/10000
// kills) basta acrescentar entradas aqui e as chaves de i18n no cliente.
const DIFFICULTIES = [
  { id: 0, key: 'easy',      mult: 1.0,  reqKills: 0    },
  { id: 1, key: 'normal',    mult: 2.0,  reqKills: 100  },
  { id: 2, key: 'hard',      mult: 3.5,  reqKills: 250  },
  { id: 3, key: 'very_hard', mult: 6.0,  reqKills: 500  },
  { id: 4, key: 'extreme',   mult: 10.0, reqKills: 1000 },
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

module.exports = { DIFFICULTIES, difficultyDef, difficultyMult, isDifficultyUnlocked };
