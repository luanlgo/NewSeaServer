import { describe, it, expect } from 'vitest';
import { calcProjectileDamage, calcKillGold, calcKillXp } from '../combat-calc.js';
import { applyTalentBonuses } from '../talent-logic.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TALENT_DEFS = {
  dano:     { name: 'Artilheiro',   max: 5, perLevel: 2,   stat: 'damage'    },
  defesa:   { name: 'Armadura',     max: 5, perLevel: 300, stat: 'defense'   },
  riqueza:  { name: 'Pilhador',     max: 5, perLevel: 3,   stat: 'gold_drop' },
  mestre:   { name: 'Estudioso',    max: 5, perLevel: 5,   stat: 'xp_drop'   },
};

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

describe('Talento de Dano (Artilheiro) — efeito real no combate', () => {
  it('sem talento de dano: talentDmg = 1.0 (sem efeito)', () => {
    const attacker = { talents: { dano: 0 } };
    applyTalentBonuses(attacker, TALENT_DEFS);

    const talentDmg = 1 + (attacker.talentDamageBonus || 0);
    const dmg = calcProjectileDamage({ baseDmg: 100, talentDmg });
    expect(dmg).toBe(100);
  });

  it('talento dano nível 1 (+2%): 100 → 102', () => {
    const attacker = { talents: { dano: 1 } };
    applyTalentBonuses(attacker, TALENT_DEFS);

    const talentDmg = 1 + attacker.talentDamageBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDmg })).toBe(102);
  });

  it('talento dano nível 5 (+10%): 100 → 110', () => {
    const attacker = { talents: { dano: 5 } };
    applyTalentBonuses(attacker, TALENT_DEFS);

    const talentDmg = 1 + attacker.talentDamageBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDmg })).toBe(110);
  });

  it('dano aumenta progressivamente com cada nível', () => {
    const damages = [];
    for (let level = 0; level <= 5; level++) {
      const attacker = { talents: { dano: level } };
      applyTalentBonuses(attacker, TALENT_DEFS);
      const talentDmg = 1 + (attacker.talentDamageBonus || 0);
      damages.push(calcProjectileDamage({ baseDmg: 100, talentDmg }));
    }
    // cada nível deve aumentar ou manter o dano
    for (let i = 1; i < damages.length; i++) {
      expect(damages[i]).toBeGreaterThanOrEqual(damages[i - 1]);
    }
  });
});

// ── TALENTO DE DEFESA ─────────────────────────────────────────────────────────

describe('Talento de Defesa (Armadura Grossa) — efeito real no combate', () => {
  it('sem talento de defesa: talentDef = 1.0 (sem redução)', () => {
    const defender = { talents: { defesa: 0 } };
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDef = 1 - (defender.talentDefenseBonus || 0);
    expect(calcProjectileDamage({ baseDmg: 100, talentDef })).toBe(100);
  });

  it('talento defesa nível 1 (-3%): 100 → 97', () => {
    const defender = { talents: { defesa: 1 } };
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDef = 1 - defender.talentDefenseBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDef })).toBe(97);
  });

  it('talento defesa nível 3 (-9%): 100 → 91', () => {
    const defender = { talents: { defesa: 3 } };
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDef = 1 - defender.talentDefenseBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDef })).toBe(91);
  });

  it('talento defesa nível 5 (-15%): 100 → 85', () => {
    const defender = { talents: { defesa: 5 } };
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDef = 1 - defender.talentDefenseBonus;
    expect(calcProjectileDamage({ baseDmg: 100, talentDef })).toBe(85);
  });

  it('dano recebido diminui progressivamente com cada nível de defesa', () => {
    const damages = [];
    for (let level = 0; level <= 5; level++) {
      const defender = { talents: { defesa: level } };
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

describe('Confronto — atacante com talento de dano vs defensor com talento de defesa', () => {
  it('defesa nível 5 do alvo reduz dano de atacante com dano nível 5', () => {
    const attacker = { talents: { dano: 5 } };
    const defender = { talents: { defesa: 5 } };
    applyTalentBonuses(attacker, TALENT_DEFS);
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDmg = 1 + attacker.talentDamageBonus; // 1.10
    const talentDef = 1 - defender.talentDefenseBonus; // 0.85

    const dmgComTalentosAmbos   = calcProjectileDamage({ baseDmg: 100, talentDmg, talentDef });
    const dmgSoAtacante          = calcProjectileDamage({ baseDmg: 100, talentDmg });
    const dmgSoDefensor          = calcProjectileDamage({ baseDmg: 100, talentDef });

    // Com defesa, o dano deve ser menor do que sem defesa
    expect(dmgComTalentosAmbos).toBeLessThan(dmgSoAtacante);
    // Com defesa, o dano deve ser menor do que o base sem talentos
    expect(dmgSoDefensor).toBeLessThan(100);
    // 100 * 1.10 * 0.85 = 93.5 → arredonda para 94
    expect(dmgComTalentosAmbos).toBe(Math.round(100 * 1.10 * 0.85));
  });

  it('attacker sem talento vs defensor com defesa nível 3', () => {
    const defender = { talents: { defesa: 3 } };
    applyTalentBonuses(defender, TALENT_DEFS);

    const talentDef = 1 - defender.talentDefenseBonus; // 0.91
    const dmg = calcProjectileDamage({ baseDmg: 50, talentDef });
    // 50 * 0.91 = 45.5 → 46
    expect(dmg).toBe(Math.round(50 * 0.91));
  });
});

// ── TALENTO DE OURO ───────────────────────────────────────────────────────────

describe('Talento de Ouro (Pilhador) — efeito real nos drops', () => {
  it('sem talento: ouro base intacto', () => {
    const killer = { talents: {} };
    applyTalentBonuses(killer, TALENT_DEFS);
    expect(calcKillGold({ baseGold: 100, talentGoldBonus: killer.talentGoldBonus || 0 })).toBe(100);
  });

  it('talento ouro nível 1 (+3%): 100 → 103', () => {
    const killer = { talents: { riqueza: 1 } };
    applyTalentBonuses(killer, TALENT_DEFS);
    expect(calcKillGold({ baseGold: 100, talentGoldBonus: killer.talentGoldBonus })).toBe(103);
  });

  it('talento ouro nível 5 (+15%): 100 → floor(100 * 1.15)', () => {
    const killer = { talents: { riqueza: 5 } };
    applyTalentBonuses(killer, TALENT_DEFS);
    // 5 * 3 / 100 = 0.14999... (float) → floor(100 * 1.14999) = 114
    const expected = Math.floor(100 * (1 + 5 * TALENT_DEFS.riqueza.perLevel / 100));
    expect(calcKillGold({ baseGold: 100, talentGoldBonus: killer.talentGoldBonus })).toBe(expected);
  });

  it('ouro aumenta a cada nível', () => {
    const golds = [];
    for (let level = 0; level <= 5; level++) {
      const killer = { talents: { riqueza: level } };
      applyTalentBonuses(killer, TALENT_DEFS);
      golds.push(calcKillGold({ baseGold: 100, talentGoldBonus: killer.talentGoldBonus || 0 }));
    }
    for (let i = 1; i < golds.length; i++) {
      expect(golds[i]).toBeGreaterThanOrEqual(golds[i - 1]);
    }
  });

  it('stacking: talento ouro + killTier + dropBonus do navio', () => {
    const killer = { talents: { riqueza: 3 } }; // +9% ouro
    applyTalentBonuses(killer, TALENT_DEFS);
    const gold = calcKillGold({
      baseGold:        100,
      dropBonus:       0.2,   // navio Royal Fortune (+20%)
      killTier:        5,     // 50 kills → tier 5 (+5%)
      goldPerTier:     0.01,
      talentGoldBonus: killer.talentGoldBonus,
    });
    // 100 * 1.2 * 1.05 * 1.09 = floor(137.34) = 137
    expect(gold).toBe(Math.floor(100 * 1.2 * 1.05 * 1.09));
  });
});

// ── TALENTO DE XP ─────────────────────────────────────────────────────────────

describe('Talento de XP (Estudioso) — efeito real nos drops', () => {
  it('sem talento: XP base intacto', () => {
    const killer = { talents: {} };
    applyTalentBonuses(killer, TALENT_DEFS);
    expect(calcKillXp({ xpPerKill: 12, talentXpBonus: killer.talentXpBonus || 0 })).toBe(12);
  });

  it('talento XP nível 1 (+5%): 12 → 12 (floor)', () => {
    const killer = { talents: { mestre: 1 } };
    applyTalentBonuses(killer, TALENT_DEFS);
    // 12 * 1.05 = 12.6 → floor = 12
    expect(calcKillXp({ xpPerKill: 12, talentXpBonus: killer.talentXpBonus })).toBe(Math.floor(12 * 1.05));
  });

  it('talento XP nível 5 (+25%): 12 → 15', () => {
    const killer = { talents: { mestre: 5 } };
    applyTalentBonuses(killer, TALENT_DEFS);
    // 12 * 1.25 = 15
    expect(calcKillXp({ xpPerKill: 12, talentXpBonus: killer.talentXpBonus })).toBe(15);
  });

  it('talento XP visível com xpPerKill maior (mapa 2+)', () => {
    const killer = { talents: { mestre: 3 } };
    applyTalentBonuses(killer, TALENT_DEFS);
    // 50 * 1.15 = 57
    expect(calcKillXp({ xpPerKill: 50, talentXpBonus: killer.talentXpBonus })).toBe(Math.floor(50 * 1.15));
  });
});
