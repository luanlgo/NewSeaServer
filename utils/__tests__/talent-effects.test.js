import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as fx from '../talent-effects.js';
import { aggregateTalentStats } from '../talent-logic.js';
import talents from '../../constants/talents.js';

const { TALENT_DEFS } = talents;

// Monta um player com os talentos pedidos JÁ agregados em player.tal — é assim
// que o servidor entrega, então testar em cima do agregado real evita um
// fixture que concorda com o teste e discorda do jogo.
function mk(levels = {}, extra = {}) {
  const p = { talents: { ...levels }, hp: 1000, maxHp: 1000, lastCombatTime: 0, ...extra };
  p.tal = aggregateTalentStats(p, TALENT_DEFS);
  return p;
}

const NOW = 1_000_000;
// Sem combate recente: NOW menos a janela inteira.
const IDLE = { lastCombatTime: NOW - fx.OUT_OF_COMBAT_MS - 1 };
const BUSY = { lastCombatTime: NOW };

// ── Cobertura ────────────────────────────────────────────────────────────────

describe('cobertura dos stats', () => {
  // max_hp_flat/_2 são somados por recalcMaxHp e cannon_slots por calcMaxCannons.
  const FORA = new Set(['max_hp_flat', 'max_hp_flat_2', 'cannon_slots']);

  // Substring crua e não `'stat'` porque talent-logic.js lê alguns por notação
  // de ponto (tal.cannon_slots). O que interessa é que o nome apareça.
  it('todo stat de talento é lido em algum lugar', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../talent-effects.js'), 'utf8');
    const logic = fs.readFileSync(path.resolve(__dirname, '../talent-logic.js'), 'utf8');
    for (const def of Object.values(TALENT_DEFS)) {
      const alvo = FORA.has(def.stat) ? logic : src;
      expect(alvo.includes(def.stat), `${def.id} → ${def.stat}`).toBe(true);
    }
  });
});

// ── Dano causado ─────────────────────────────────────────────────────────────

describe('outgoingDamageMult', () => {
  it('sem talentos é neutro', () => {
    expect(fx.outgoingDamageMult(mk(), {})).toBe(1.0);
  });

  it('soma damage_pct e damage_final_pct de forma ADITIVA', () => {
    // atk_artilharia 10 = +20%, atk_poderdefogo 10 = +15% → 1,35 (não 1,38)
    const p = mk({ atk_artilharia: 10, atk_poderdefogo: 10 });
    expect(fx.outgoingDamageMult(p, {})).toBeCloseTo(1.35, 6);
  });

  it('o bônus contra criatura só vale contra criatura', () => {
    const p = mk({ atk_cacafera: 10 });                       // +20% vs NPC
    expect(fx.outgoingDamageMult(p, { targetIsNPC: true })).toBeCloseTo(1.20, 6);
    expect(fx.outgoingDamageMult(p, { targetIsPlayer: true })).toBeCloseTo(1.0, 6);
  });

  it('execute só abaixo de 30% de vida do alvo', () => {
    const p = mk({ atk_misericordia: 10 });                   // +30%
    expect(fx.outgoingDamageMult(p, { targetHpFrac: 0.31 })).toBeCloseTo(1.0, 6);
    expect(fx.outgoingDamageMult(p, { targetHpFrac: 0.30 })).toBeCloseTo(1.30, 6);
  });

  it('abordagem só dentro de 100 unidades', () => {
    const p = mk({ atk_abordagem: 10 });                      // +30%
    expect(fx.outgoingDamageMult(p, { dist: 101 })).toBeCloseTo(1.0, 6);
    expect(fx.outgoingDamageMult(p, { dist: 100 })).toBeCloseTo(1.30, 6);
  });

  it('frenesi soma por pilha e vale até 5', () => {
    const p = mk({ atk_frenesi: 10 });                        // +10% por pilha
    expect(fx.outgoingDamageMult(p, {})).toBeCloseTo(1.0, 6);
    for (let i = 0; i < 9; i++) fx.onHitDealt(p);
    expect(p._frenzyStacks).toBe(fx.FRENZY_MAX_STACKS);
    expect(fx.outgoingDamageMult(p, {})).toBeCloseTo(1.50, 6);
  });

  it('carnificina soma por abate e vale até 3', () => {
    const p = mk({ atk_carnificina: 10 });                    // +20% por pilha
    for (let i = 0; i < 8; i++) fx.onKill(p, NOW);
    expect(p._killstreakStacks).toBe(fx.KILLSTREAK_MAX);
    expect(fx.outgoingDamageMult(p, {})).toBeCloseTo(1.60, 6);
  });

  it('as duas pilhas caem juntas ao sair de combate', () => {
    const p = mk({ atk_frenesi: 10, atk_carnificina: 10 }, BUSY);
    fx.onHitDealt(p); fx.onKill(p, NOW);
    fx.tickCombatState(p, NOW);
    expect(p._frenzyStacks).toBe(1);
    expect(p._killstreakStacks).toBe(1);

    p.lastCombatTime = NOW - fx.OUT_OF_COMBAT_MS - 1;
    fx.tickCombatState(p, NOW);
    expect(p._frenzyStacks).toBe(0);
    expect(p._killstreakStacks).toBe(0);
  });

  it('emboscada vale uma vez por alvo', () => {
    const p = mk({ atk_emboscada: 10 });
    expect(fx.consumeOpener(p, 'npc1')).toBe(true);
    expect(fx.consumeOpener(p, 'npc1')).toBe(false);
    expect(fx.consumeOpener(p, 'npc2')).toBe(true);
  });

  it('sem o talento de emboscada nunca consome nada', () => {
    expect(fx.consumeOpener(mk(), 'npc1')).toBe(false);
  });
});

// ── Crítico ──────────────────────────────────────────────────────────────────

describe('crítico', () => {
  it('olho de águia soma à chance base', () => {
    expect(fx.critChance(mk({ atk_olhoaguia: 10 }), 0.10)).toBeCloseTo(0.20, 6);
  });

  it('cascata só vale para o tiro seguinte a um crítico', () => {
    const p = mk({ atk_cascata: 10 });                        // +20% no próximo
    fx.noteCritRoll(p, true);
    expect(fx.critChance(p, 0.10)).toBeCloseTo(0.30, 6);
    fx.noteCritRoll(p, false);
    expect(fx.critChance(p, 0.10)).toBeCloseTo(0.10, 6);
  });

  it('sangue frio só com a vida acima de 80%', () => {
    const p = mk({ atk_sanguefrio: 10 });                     // +5%
    expect(fx.critMult(p, 1.5, 0.90)).toBeCloseTo(1.55, 6);
    expect(fx.critMult(p, 1.5, 0.70)).toBeCloseTo(1.50, 6);
  });
});

// ── Dano recebido ────────────────────────────────────────────────────────────

describe('dano recebido', () => {
  it('sem talentos o golpe passa inteiro', () => {
    expect(fx.applyDamageReduction(mk(), 100, {})).toBe(100);
  });

  it('armadura grossa reduz e a perfuração do atacante come a redução', () => {
    const alvo = mk({ def_armadura: 10 });                    // 5% de redução
    expect(fx.applyDamageReduction(alvo, 100, {})).toBe(95);
    // atk_perfurante 10 = ignora 15% da defesa → DR efetiva 4,25%
    expect(fx.applyDamageReduction(alvo, 100, { pen: 0.15 })).toBe(96);
  });

  it('a redução tem teto — não dá para ficar imortal com 1200 pontos', () => {
    const alvo = mk({
      def_armadura: 10, def_fortaleza: 10, def_escudoguerra: 10, def_anteparo: 10,
      def_ancoraviva: 10, def_lobodomar: 10, def_coracaoabissal: 10, def_vigia: 10,
    });
    const dr = fx.damageReduction(alvo, { fromNPC: true, isAoe: true, isStill: true, isCrit: true });
    expect(dr).toBeLessThanOrEqual(fx.MAX_DR);
    expect(fx.applyDamageReduction(alvo, 1000, { fromNPC: true })).toBeGreaterThan(0);
  });

  it('lobo do mar e moral de ferro são excludentes', () => {
    const p = mk({ def_lobodomar: 10, def_moral: 10 });       // 5% solo | 5% por aliado
    expect(fx.damageReduction(p, { inParty: false })).toBeCloseTo(0.05, 6);
    expect(fx.damageReduction(p, { inParty: true, allyCount: 2 })).toBeCloseTo(0.10, 6);
  });

  it('fúria do kraken troca redução por dano', () => {
    const p = mk({ atk_furiakraken: 10 });                    // +30% dano, −12% DR
    expect(fx.outgoingDamageMult(p, {})).toBeCloseTo(1.30, 6);
    expect(fx.damageReduction(p, {})).toBeCloseTo(-0.12, 6);
    expect(fx.applyDamageReduction(p, 100, {})).toBe(112);
  });

  // A penalidade do Kraken sai DEPOIS do teto de redução. Cobrando antes ela
  // sumia para quem mais tinha como pagá-la: um build de anel 5 em Defesa passa
  // dos 85% de teto com folga, e os 12 pontos cabiam inteiros nessa folga — o
  // tanque levava o dano extra de graça, o oposto da troca prometida.
  it('a penalidade do kraken não é engolida pelo teto de redução', () => {
    const DEFESA = {
      def_armadura: 10, def_fortaleza: 10, def_coracaoabissal: 10,
      def_escudoguerra: 10, def_ancoraviva: 10, def_lobodomar: 10, def_sentinela: 10,
    };
    const ctx  = { fromNPC: true, isStill: true, inParty: false };
    const meta = { _sentinelStacks: fx.SENTINEL_MAX_STACKS };

    const tanque = mk(DEFESA, meta);
    const comKraken = mk({ ...DEFESA, atk_furiakraken: 10 }, meta);

    // Desde que cada talento de redução passou a valer no máximo 5%, nem a
    // árvore de Defesa inteira alcança o MAX_DR (chega a ~55% neste cenário,
    // 75% no teto teórico com todos os contextos ligados de uma vez). O teto
    // virou rede de segurança e não corta mais nada na prática.
    const drTanque = fx.damageReduction(tanque, ctx);
    expect(drTanque).toBeLessThanOrEqual(fx.MAX_DR);
    // O que este teste guarda continua de pé: os 12 pontos do Kraken saem
    // INTEIROS, com ou sem o teto mordendo.
    expect(fx.damageReduction(comKraken, ctx)).toBeCloseTo(drTanque - 0.12, 6);
  });

  it('carapaça de kraken tira dano plano DEPOIS da redução', () => {
    // O corte é 1% da vida MÁXIMA no talento cheio — num casco de 1000, −10.
    const p = mk({ def_carapaca: 10 });
    expect(fx.flatReduction(p)).toBeCloseTo(10, 6);
    expect(fx.applyDamageReduction(p, 100, {})).toBe(90);
    // Nunca zera o golpe.
    expect(fx.applyDamageReduction(p, 5, {})).toBe(1);
    // E acompanha o casco: dobrar a vida máxima dobra o corte, que é a razão
    // de o número ter deixado de ser fixo.
    const grande = mk({ def_carapaca: 10 }, { hp: 70000, maxHp: 70000 });
    expect(fx.applyDamageReduction(grande, 10000, {})).toBe(10000 - 700);
  });

  it('sentinela acumula até 5 e expira sozinha', () => {
    const p = mk({ def_sentinela: 10 });                      // +5% por pilha
    for (let i = 0; i < 9; i++) fx.onHitTaken(p, NOW);
    expect(p._sentinelStacks).toBe(fx.SENTINEL_MAX_STACKS);
    // 5 pilhas × 5% — é o único talento de redução que passa dos 5% somando
    // com ele mesmo, porque o teto de 5% é POR PILHA.
    expect(fx.damageReduction(p, {})).toBeCloseTo(0.25, 6);
    fx.tickCombatState(p, NOW + 6000);
    expect(p._sentinelStacks).toBe(0);
  });

  it('esquiva soma o bônus de movimento e tem teto', () => {
    const p = mk({ def_esquiva: 10, def_alvodificil: 10, def_espiritovento: 10 });
    expect(fx.dodgeChance(p, false)).toBeCloseTo(0.20, 6);   // 10 + 10/2
    expect(fx.dodgeChance(p, true)).toBeCloseTo(0.30, 6);
    expect(fx.dodgeChance(p, true)).toBeLessThanOrEqual(fx.MAX_DODGE);
  });

  it('segundo fôlego só abaixo de 25% e só uma vez por minuto', () => {
    const p = mk({ def_segundofolego: 10 }, { hp: 200, maxHp: 1000 });
    expect(fx.secondWindHeal(p, NOW)).toBe(200);              // 20% de 1000
    expect(fx.secondWindHeal(p, NOW + 1000)).toBe(0);
    expect(fx.secondWindHeal(p, NOW + fx.SECOND_WIND_CD_MS + 1)).toBe(200);

    const cheio = mk({ def_segundofolego: 10 }, { hp: 900, maxHp: 1000 });
    expect(fx.secondWindHeal(cheio, NOW)).toBe(0);
  });

  it('espinhos e sanguessuga saem do dano de verdade', () => {
    expect(fx.thornsDamage(mk({ def_espinhos: 10 }), 500)).toBe(50);
    expect(fx.lifestealAmount(mk({ def_sanguessuga: 10 }), 500)).toBe(25);
  });
});

// ── Vida, mana e regeneração ─────────────────────────────────────────────────

describe('vida e mana', () => {
  it('sobrou UMA fonte de regeneração: as Bombas de Porão', () => {
    // O Calafate (regen plana) e os Reparos de Emergência (regen fora de
    // combate) viraram multiplicadores de CURA em 09/2026. O jogo perdeu de
    // propósito a regeneração passiva acima de 40% de vida — foi a moeda de
    // troca da mudança, e este teste é onde ela fica registrada.
    const p = mk({ def_calafate: 10, def_bombeamento: 10, def_reparo: 10 },
      { hp: 300, maxHp: 1000, ...IDLE });
    expect(fx.hpRegenPerSec(p, NOW)).toBeCloseTo(30, 6);      // 3% de 1000

    p.lastCombatTime = NOW;                                   // entrou em combate
    expect(fx.hpRegenPerSec(p, NOW), 'as Bombas não dependem de estar fora de combate')
      .toBeCloseTo(30, 6);

    p.hp = 900;                                               // acima de 40%
    expect(fx.hpRegenPerSec(p, NOW)).toBeCloseTo(0, 6);
  });

  it('a cura recebida soma os três nós, e o de fora de combate só fora dele', () => {
    const p = mk({ def_calafate: 10, def_recuperacao: 10, def_reparo: 10 },
      { hp: 300, maxHp: 1000, ...IDLE });
    // Calafate +10% · Recuperação +20% · Reparos +20% (fora de combate)
    expect(fx.healingReceivedMult(p, NOW)).toBeCloseTo(1.50, 6);
    p.lastCombatTime = NOW;
    expect(fx.healingReceivedMult(p, NOW)).toBeCloseTo(1.30, 6);
  });

  it('concentração só conta fora de combate', () => {
    const p = mk({ res_manaflow: 10, res_concentracao: 10 }, IDLE);
    expect(fx.manaRegenMult(p, NOW)).toBeCloseTo(1 + 0.80 + 1.00, 6);
    p.lastCombatTime = NOW;
    expect(fx.manaRegenMult(p, NOW)).toBeCloseTo(1.80, 6);
  });

  it('coração do abismo dá vida E redução', () => {
    const p = mk({ def_coracaoabissal: 10 });                 // +30% vida, +5% DR
    expect(fx.maxHpPctBonus(p)).toBeCloseTo(0.30, 6);
    expect(fx.damageReduction(p, {})).toBeCloseTo(0.05, 6);
  });
});

// ── Relíquias ────────────────────────────────────────────────────────────────

describe('relíquias', () => {
  it('sobrecarga aumenta dano e custo ao mesmo tempo', () => {
    const p = mk({ atk_sobrecarga: 10 });                     // +30% dano, +10% mana
    expect(fx.relicDamageMult(p)).toBeCloseTo(1.30, 6);
    expect(fx.relicManaCostMult(p)).toBeCloseTo(1.10, 6);
  });

  it('economia arcana desconta o custo e nunca zera', () => {
    expect(fx.relicManaCostMult(mk({ res_economia: 10 }))).toBeCloseTo(0.85, 6);
    expect(fx.relicManaCostMult(mk({ res_economia: 10, atk_sobrecarga: 10 }))).toBeCloseTo(0.95, 6);
  });

  it('barreira arcana escala com a vida máxima', () => {
    expect(fx.relicShieldAmount(mk({ def_barreira: 10 }, { maxHp: 4000 }))).toBe(400);
  });
});

// ── Movimento ────────────────────────────────────────────────────────────────

describe('movimento', () => {
  // Níveis DIFERENTES de propósito. Todo talento de velocidade dá 0,5%/nível
  // desde o balanceamento de 2026-08-15, então com os dois no nível 10 os dois
  // ramos dariam o mesmo número e o teste passaria sem conseguir dizer QUAL
  // deles aplicou — que é exatamente a única coisa que ele existe para provar.
  it('perseguição e correnteza são excludentes', () => {
    const p = mk({ atk_perseguicao: 10, res_correnteza: 6 }, BUSY);
    expect(fx.speedMult(p, { now: NOW })).toBeCloseTo(1.05, 6);   // 10 × 0,5%
    p.lastCombatTime = NOW - fx.OUT_OF_COMBAT_MS - 1;
    expect(fx.speedMult(p, { now: NOW })).toBeCloseTo(1.03, 6);   // 6 × 0,5%
  });

  it('arrancada dura 3s a partir do início do movimento', () => {
    const p = mk({ atk_arrancada: 10 }, IDLE);                // +5%
    fx.onMoveStart(p, NOW);
    expect(fx.speedMult(p, { now: NOW + 2999 })).toBeCloseTo(1.05, 6);
    expect(fx.speedMult(p, { now: NOW + 3001 })).toBeCloseTo(1.00, 6);
  });

  it('ventania dura 5s depois do abate', () => {
    const p = mk({ atk_ventania: 10 }, IDLE);                 // +5%
    fx.onKill(p, NOW);
    expect(fx.speedMult(p, { now: NOW + 4999 })).toBeCloseTo(1.05, 6);
    expect(fx.speedMult(p, { now: NOW + 5001 })).toBeCloseTo(1.00, 6);
  });

  it('a manobra vem só do Leme Leve', () => {
    // A Deriva somava manobra em velocidade máxima e virou PRECISÃO de canhão
    // (atk_deriva → Pulso Firme). O `atFullSpeed` continua no argumento, e hoje
    // não muda nada — é o que este teste trava.
    const p = mk({ def_leme: 10, atk_deriva: 10 });
    expect(fx.turnRateMult(p, false)).toBeCloseTo(1.10, 6);
    expect(fx.turnRateMult(p, true)).toBeCloseTo(1.10, 6);
    expect(fx.cannonAccuracyBonus(p)).toBeCloseTo(0.10, 6);
  });

  it('vontade de ferro e casco escorregadio mexem em coisas diferentes', () => {
    expect(fx.ccDurationMult(mk({ def_vontade: 10 }))).toBeCloseTo(0.75, 6);
    expect(fx.slowStrengthMult(mk({ def_escorregadio: 10 }))).toBeCloseTo(0.70, 6);
  });
});

// ── Economia ─────────────────────────────────────────────────────────────────

describe('economia', () => {
  it('tesouro do abismo soma em ouro, dobrão e XP — e só neles', () => {
    const p = mk({ res_tesouroabissal: 10 });                 // +20%
    expect(fx.lootMult(p, 'gold')).toBeCloseTo(1.20, 6);
    expect(fx.lootMult(p, 'dobrao')).toBeCloseTo(1.20, 6);
    expect(fx.lootMult(p, 'xp')).toBeCloseTo(1.20, 6);
    expect(fx.lootMult(p, 'fishing')).toBeCloseTo(1.00, 6);
  });

  it('XP de chefe acumula com o XP geral', () => {
    const p = mk({ res_estudioso: 10, res_sabedoria: 10 });   // +40% geral, +50% chefe
    expect(fx.lootMult(p, 'xp')).toBeCloseTo(1.40, 6);
    expect(fx.lootMult(p, 'xp_boss')).toBeCloseTo(1.90, 6);
  });

  it('desconto de loja e penalidade de morte têm piso', () => {
    expect(fx.shopPriceMult(mk({ res_negociante: 10 }))).toBeCloseTo(0.90, 6);
    expect(fx.deathPenaltyMult(mk({ res_seguro: 10 }))).toBeCloseTo(0.60, 6);
    expect(fx.deathPenaltyMult(mk({ res_seguro: 10 }))).toBeGreaterThanOrEqual(0);
  });

  it('um tipo de ganho desconhecido não inventa bônus', () => {
    expect(fx.lootMult(mk({ res_pilhador: 10 }), 'nao_existe')).toBe(1.0);
  });
});

// ── Robustez ─────────────────────────────────────────────────────────────────

describe('robustez', () => {
  it('player sem tal nunca quebra nem inventa bônus', () => {
    const vazio = {};
    expect(fx.outgoingDamageMult(vazio, {})).toBe(1.0);
    expect(fx.damageReduction(vazio, {})).toBe(0);
    expect(fx.speedMult(vazio, {})).toBe(1.0);
    expect(fx.dodgeChance(vazio)).toBe(0);
    expect(fx.lootMult(vazio, 'gold')).toBe(1.0);
    expect(fx.hpRegenPerSec(vazio)).toBe(0);
    expect(() => fx.tickCombatState(null)).not.toThrow();
    expect(() => fx.onHitDealt(undefined)).not.toThrow();
  });

  it('nenhum multiplicador vira negativo ou NaN com tudo no máximo', () => {
    const todos = {};
    for (const id of Object.keys(TALENT_DEFS)) todos[id] = 10;
    const p = mk(todos, { hp: 100, maxHp: 1000, ...BUSY });
    const nums = [
      fx.outgoingDamageMult(p, { targetIsNPC: true, targetIsBoss: true, dist: 10, targetHpFrac: 0.1 }),
      fx.speedMult(p, { now: NOW }), fx.relicManaCostMult(p), fx.relicCooldownMult(p),
      fx.reloadMult(p), fx.shopPriceMult(p), fx.ccDurationMult(p),
      fx.slowStrengthMult(p), fx.deathPenaltyMult(p), fx.respawnHpFrac(p),
      fx.healingReceivedMult(p, NOW), fx.explorationLootMult(p), fx.petXpMult(p),
      fx.archCooldownMult(p), fx.armorPen(p) + 1, fx.blockChance(p) + 1,
      fx.applyDamageReduction(p, 1000, { fromNPC: true }),
    ];
    for (const n of nums) {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });
});
