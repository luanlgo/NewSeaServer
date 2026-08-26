import { describe, it, expect } from 'vitest';
import { calcProjectileDamage, calcKillGold, calcKillXp } from '../combat-calc.js';
import { applyTalentBonuses } from '../talent-logic.js';
import { TALENT_DEFS } from '../../constants/talents.js';

// Os defs REAIS. Um fixture local aqui já ficou para trás uma vez, na troca dos
// 10 talentos antigos pelas 4 árvores — e o teste continuou verde medindo nada.
//
// Talentos usados abaixo (árvore · efeito por nível):
//   atk_artilharia  Ataque   +2%   de dano
//   def_armadura    Defesa   +1,5% de redução de dano
//   res_pilhador    Recurso  +3%   de ouro
//   res_estudioso   Recurso  +4%   de XP

// ── calcProjectileDamage — dano base ──────────────────────────────────────────

describe('calcProjectileDamage — sem talentos', () => {
  it('dano base é arredondado e mínimo 1', () => {
    expect(calcProjectileDamage({ baseDmg: 10 })).toBe(10);
  });

  it('crit multiplica por 1.5', () => {
    expect(calcProjectileDamage({ baseDmg: 10, critMult: 1.5 })).toBe(15);
  });

  it('dano mínimo é sempre 1 (não pode ser 0 ou negativo)', () => {
    expect(calcProjectileDamage({ baseDmg: 0 })).toBe(1);
    expect(calcProjectileDamage({ baseDmg: 1, talentDef: 0.01 })).toBe(1);
  });
});

// ── TALENTO DE DANO ───────────────────────────────────────────────────────────

describe('Artilharia Pesada — efeito real no combate', () => {
  it('sem talento de dano: talentDmg = 1.0 (sem efeito)', () => {
    const attacker = { talents: { atk_artilharia: 0 } };
    applyTalentBonuses(attacker, TALENT_DEFS);

    const talentDmg = 1 + (attacker.talentDamageBonus || 0);
    expect(calcProjectileDamage({ baseDmg: 100, talentDmg })).toBe(100);
  });

  it('nível 1 (+2%): 100 → 102', () => {
    const attacker = { talents: { atk_artilharia: 1 } };
    applyTalentBonuses(attacker, TALENT_DEFS);

    const talentDmg = 1 + attacker.talentDamageBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDmg })).toBe(102);
  });

  it('nível 5 (+10%): 100 → 110', () => {
    const attacker = { talents: { atk_artilharia: 5 } };
    applyTalentBonuses(attacker, TALENT_DEFS);

    const talentDmg = 1 + attacker.talentDamageBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDmg })).toBe(110);
  });

  it('nível máximo 10 (+20%): 100 → 120', () => {
    const attacker = { talents: { atk_artilharia: 10 } };
    applyTalentBonuses(attacker, TALENT_DEFS);

    const talentDmg = 1 + attacker.talentDamageBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDmg })).toBe(120);
  });

  it('dano aumenta progressivamente com cada nível', () => {
    const damages = [];
    for (let level = 0; level <= 10; level++) {
      const attacker = { talents: { atk_artilharia: level } };
      applyTalentBonuses(attacker, TALENT_DEFS);
      const talentDmg = 1 + (attacker.talentDamageBonus || 0);
      damages.push(calcProjectileDamage({ baseDmg: 100, talentDmg }));
    }
    for (let i = 1; i < damages.length; i++) {
      expect(damages[i]).toBeGreaterThanOrEqual(damages[i - 1]);
    }
  });
});

// ── TALENTO DE DEFESA ─────────────────────────────────────────────────────────

// A redução por nível sai do próprio TALENT_DEFS. Estes testes já quebraram em
// bloco quando a Armadura caiu de 1,5%/nível para 0,5%, e o que eles provam é a
// CONTA (dano × (1 − redução)), não o número de balanceamento da vez.
const PL_ARM = TALENT_DEFS.def_armadura.perLevel;
/** Dano de 100 depois da Armadura Grossa no nível `n`. */
const comArmadura = (base, n) => Math.round(base * (1 - (PL_ARM * n) / 100));

describe('Armadura Grossa — efeito real no combate', () => {
  it('sem talento de defesa: talentDef = 1.0 (sem redução)', () => {
    const defender = { talents: { def_armadura: 0 } };
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDef = 1 - (defender.talentDefenseBonus || 0);
    expect(calcProjectileDamage({ baseDmg: 100, talentDef })).toBe(100);
  });

  it(`nível 2 (−${PL_ARM * 2}%): 100 → ${comArmadura(100, 2)}`, () => {
    const defender = { talents: { def_armadura: 2 } };
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDef = 1 - defender.talentDefenseBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDef })).toBe(comArmadura(100, 2));
  });

  it(`nível 6 (−${PL_ARM * 6}%): 100 → ${comArmadura(100, 6)}`, () => {
    const defender = { talents: { def_armadura: 6 } };
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDef = 1 - defender.talentDefenseBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDef })).toBe(comArmadura(100, 6));
  });

  it(`nível máximo 10 (−${PL_ARM * 10}%): 100 → ${comArmadura(100, 10)}`, () => {
    const defender = { talents: { def_armadura: 10 } };
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDef = 1 - defender.talentDefenseBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDef })).toBe(comArmadura(100, 10));
  });

  it('dano recebido diminui progressivamente com cada nível de defesa', () => {
    const damages = [];
    for (let level = 0; level <= 10; level++) {
      const defender = { talents: { def_armadura: level } };
      applyTalentBonuses(defender, TALENT_DEFS);
      const talentDef = 1 - (defender.talentDefenseBonus || 0);
      damages.push(calcProjectileDamage({ baseDmg: 100, talentDef }));
    }
    for (let i = 1; i < damages.length; i++) {
      expect(damages[i]).toBeLessThanOrEqual(damages[i - 1]);
    }
  });
});

// ── CONFRONTO: Atacante com dano vs Defensor com defesa ──────────────────────

describe('Confronto — atacante com Artilharia vs defensor com Armadura', () => {
  it('Armadura 10 do alvo reduz o dano de um atacante com Artilharia 5', () => {
    const attacker = { talents: { atk_artilharia: 5 } };
    const defender = { talents: { def_armadura: 10 } };
    applyTalentBonuses(attacker, TALENT_DEFS);
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDmg = 1 + attacker.talentDamageBonus;  // 1.10
    const talentDef = 1 - defender.talentDefenseBonus; // 1 − Armadura 10

    const dmgComTalentosAmbos = calcProjectileDamage({ baseDmg: 100, talentDmg, talentDef });
    const dmgSoAtacante       = calcProjectileDamage({ baseDmg: 100, talentDmg });
    const dmgSoDefensor       = calcProjectileDamage({ baseDmg: 100, talentDef });

    expect(dmgComTalentosAmbos).toBeLessThan(dmgSoAtacante);
    expect(dmgSoDefensor).toBeLessThan(100);
    expect(dmgComTalentosAmbos).toBe(Math.round(100 * 1.10 * (1 - PL_ARM * 10 / 100)));
  });

  it('atacante sem talento vs defensor com Armadura 6', () => {
    const defender = { talents: { def_armadura: 6 } };
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDef = 1 - defender.talentDefenseBonus; // 1 − Armadura 6
    expect(calcProjectileDamage({ baseDmg: 50, talentDef })).toBe(comArmadura(50, 6));
  });
});

// ── TALENTO DE OURO ───────────────────────────────────────────────────────────

describe('Pilhador — efeito real nos drops', () => {
  it('sem talento: ouro base intacto', () => {
    const killer = { talents: {} };
    applyTalentBonuses(killer, TALENT_DEFS);
    expect(calcKillGold({ baseGold: 100, talentGoldBonus: killer.talentGoldBonus || 0 })).toBe(100);
  });

  it('nível 1 (+3%): 100 → 103', () => {
    const killer = { talents: { res_pilhador: 1 } };
    applyTalentBonuses(killer, TALENT_DEFS);
    expect(calcKillGold({ baseGold: 100, talentGoldBonus: killer.talentGoldBonus })).toBe(103);
  });

  it('nível máximo 10 (+30%): 100 → 130', () => {
    const killer = { talents: { res_pilhador: 10 } };
    applyTalentBonuses(killer, TALENT_DEFS);
    expect(calcKillGold({ baseGold: 100, talentGoldBonus: killer.talentGoldBonus })).toBe(130);
  });

  it('ouro aumenta a cada nível', () => {
    const golds = [];
    for (let level = 0; level <= 10; level++) {
      const killer = { talents: { res_pilhador: level } };
      applyTalentBonuses(killer, TALENT_DEFS);
      golds.push(calcKillGold({ baseGold: 100, talentGoldBonus: killer.talentGoldBonus || 0 }));
    }
    for (let i = 1; i < golds.length; i++) {
      expect(golds[i]).toBeGreaterThanOrEqual(golds[i - 1]);
    }
  });

  it('stacking: talento ouro + dropBonus do navio', () => {
    const killer = { talents: { res_pilhador: 3 } }; // +9% ouro
    applyTalentBonuses(killer, TALENT_DEFS);
    const gold = calcKillGold({
      baseGold:        100,
      dropBonus:       0.2,   // navio Royal Fortune (+20%)
      talentGoldBonus: killer.talentGoldBonus,
    });
    // 100 × 1,2 × 1,09 = 130,8 → 130
    expect(gold).toBe(Math.floor(100 * 1.2 * 1.09));
  });
});

// ── TALENTO DE XP ─────────────────────────────────────────────────────────────

describe('Estudioso — efeito real nos drops', () => {
  it('sem talento: XP base intacto', () => {
    const killer = { talents: {} };
    applyTalentBonuses(killer, TALENT_DEFS);
    expect(calcKillXp({ xpPerKill: 12, talentXpBonus: killer.talentXpBonus || 0 })).toBe(12);
  });

  it('nível 1 (+4%): 12 → 12 (floor)', () => {
    const killer = { talents: { res_estudioso: 1 } };
    applyTalentBonuses(killer, TALENT_DEFS);
    expect(calcKillXp({ xpPerKill: 12, talentXpBonus: killer.talentXpBonus })).toBe(Math.floor(12 * 1.04));
  });

  it('nível 5 (+20%): 12 → 14', () => {
    const killer = { talents: { res_estudioso: 5 } };
    applyTalentBonuses(killer, TALENT_DEFS);
    // 12 × 1,20 = 14,4 → 14
    expect(calcKillXp({ xpPerKill: 12, talentXpBonus: killer.talentXpBonus })).toBe(14);
  });

  it('nível máximo 10 (+40%) com xpPerKill maior (mapa 2+)', () => {
    const killer = { talents: { res_estudioso: 10 } };
    applyTalentBonuses(killer, TALENT_DEFS);
    expect(calcKillXp({ xpPerKill: 50, talentXpBonus: killer.talentXpBonus })).toBe(70);
  });
});
