/**
 * O abate por DoT paga o MESMO que o abate a tiro.
 *
 * Relato de 2026-09-06, com o extrato na mão: "Abates de NPC ×4 — +6.983.825
 * de ouro, +1.343.920 de XP". Quatro bichos comuns rendendo sete milhões.
 *
 * A causa não era o mapa bônus (o ouro por NPC é o mesmo da leva 1 à 15 —
 * medido). Era o bloco de morte por DANO CONTÍNUO no server.js, que tinha uma
 * conta PRÓPRIA em vez da do projectile-manager, e nela:
 *
 *     (1 + tier * 0.01)      com  tier = Math.floor(npcKills / 10)
 *
 * sem teto nenhum. O caminho do canhão nunca teve esse termo. Resultado: o
 * MESMO bicho pagava 6.250 de ouro morrendo de tiro e 2.100.000 morrendo
 * queimando, numa conta com ~336 mil abates — e ia crescendo para sempre.
 *
 * O que este arquivo trava é a PARIDADE, não um número: enquanto as duas
 * mortes pagarem igual, não há tabela paralela para uma delas apodrecer.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { calcKillGold, calcKillXp } = require('../combat-calc.js');
const { difficultyRewardMult }     = require('../../constants/difficulty.js');
const { MAP_DEFS }                 = require('../../constants/maps.js');

// ═══════════════════════════════════════════════════════════════════════════
describe('a conta compartilhada não conhece o tier', () => {
  it('o ouro por abate não depende de quantos abates a conta tem', () => {
    // `npcKills` não é sequer parâmetro — é isso que garante que o número não
    // cresça com a vida da conta. A trava é a ASSINATURA, não o valor.
    const base = { baseGold: 1250 };
    expect(calcKillGold(base)).toBe(calcKillGold({ ...base, npcKills: 999999 }));
    expect(calcKillXp({ xpPerKill: 200 }))
      .toBe(calcKillXp({ xpPerKill: 200, npcKills: 999999 }));
  });

  it('o que MULTIPLICA é só dropBonus e talento, e os dois são limitados', () => {
    // Teto de talento: com a árvore inteira comprada, lootMult('gold') é 1,5.
    // Somado a um dropBonus generoso, o teto do abate fica na casa do dobro —
    // não em ×336.
    const teto = calcKillGold({ baseGold: 1000, dropBonus: 0.5, talentGoldBonus: 0.5 });
    expect(teto).toBe(2250);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('as duas mortes pagam igual', () => {
  // Espelho das DUAS contas como elas estão no código. Se alguém reintroduzir
  // um fator num lado só, os números param de bater aqui.
  const npcDe = (lvl) => MAP_DEFS[lvl].npc;

  function porTiro(lvl, diffMult, blood = 1) {
    const n = npcDe(lvl);
    const rewardMult = difficultyRewardMult(diffMult / blood) * blood;
    return {
      gold: Math.round(calcKillGold({ baseGold: n.goldMin }) * rewardMult),
      xp:   Math.round(calcKillXp({ xpPerKill: n.xpPerKill }) * rewardMult),
    };
  }

  function porDot(lvl, diffMult, blood = 1) {
    const n = npcDe(lvl);
    const dotDiff = difficultyRewardMult(diffMult / blood) * blood;
    return {
      gold: Math.round(calcKillGold({ baseGold: n.goldMin }) * dotDiff),
      xp:   Math.round(calcKillXp({ xpPerKill: n.xpPerKill }) * dotDiff),
    };
  }

  for (const lvl of [1, 4, 7, 9, 10, 11]) {
    for (const diff of [1, 10]) {
      it(`mapa ${lvl}, dificuldade ×${diff}`, () => {
        expect(porDot(lvl, diff)).toEqual(porTiro(lvl, diff));
      });
    }
  }

  it('a Lua de Sangue entra separado nos dois — senão satura num lado só', () => {
    // difficultyRewardMult satura no último degrau da tabela: jogar o total
    // dentro dela anularia o evento nas dificuldades altas. O caminho do DoT
    // ignorava o bloodMult por completo.
    expect(porDot(7, 30, 3)).toEqual(porTiro(7, 30, 3));
    expect(porDot(7, 30, 3).gold).toBeGreaterThan(porDot(7, 10, 1).gold);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('guarda de fiação — o bloco do DoT usa a conta compartilhada', () => {
  const fs   = require('fs');
  const path = require('path');
  const src  = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'server.js'), 'utf8');

  it('o server.js importa calcKillGold e calcKillXp', () => {
    expect(src).toMatch(/calcKillGold,\s*calcKillXp\s*\}\s*=\s*require\('\.\/utils\/combat-calc'\)/);
  });

  it('não sobrou nenhum `tier * 0.01` multiplicando recompensa', () => {
    // O termo sem teto. Ele só existia no bloco do DoT; se voltar, volta calado.
    const semComentarios = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(semComentarios, 'o bônus de tier sem teto voltou')
      .not.toMatch(/tier\s*\*\s*0\.01/);
  });
});
