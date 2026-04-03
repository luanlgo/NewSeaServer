import { describe, it, expect } from 'vitest';
import {
  calcXpRequired,
  getCostTier,
  applyTalentBonuses,
  recalcMaxHp,
  validateBuyTalent,
} from '../talent-logic.js';

// ── Fixtures (mesmas que constants/talents.js) ────────────────────────────────

const TALENT_DEFS = {
  hp:           { name: 'Casco de Ferro',    max: 5, perLevel: 500, stat: 'hp'           },
  defesa:       { name: 'Armadura Grossa',   max: 5, perLevel: 300, stat: 'defense'      },
  canhoes:      { name: 'Canhoneira',        max: 5, perLevel: 2,   stat: 'cannon_slots' },
  dano:         { name: 'Artilheiro',        max: 5, perLevel: 2,   stat: 'damage'       },
  dano_relic:   { name: 'Místico',           max: 5, perLevel: 3,   stat: 'relic_damage' },
  riqueza:      { name: 'Pilhador',          max: 5, perLevel: 3,   stat: 'gold_drop'    },
  ganancioso:   { name: 'Corsário Ganancioso', max: 5, perLevel: 3, stat: 'dobrao_drop'  },
  mestre:       { name: 'Estudioso',         max: 5, perLevel: 5,   stat: 'xp_drop'      },
  slot_reliquia:{ name: 'Guardião das Relíquias', max: 1, perLevel: 1, stat: 'relic_slot' },
};

const TALENT_COST_TIERS = [
  { upTo: 3,    cost: 500,  currency: 'gold'   },
  { upTo: 10,   cost: 1000, currency: 'gold'   },
  { upTo: 20,   cost: 500,  currency: 'dobrao' },
  { upTo: 30,   cost: 1000, currency: 'dobrao' },
  { upTo: 9999, cost: 3000, currency: 'dobrao' },
];

const XP_BASE   = 400;
const XP_GROWTH = 1.3;

const SHIP_DEFS = {
  fragata: { hp: 600 },
  sloop:   { hp: 800 },
  galleon: { hp: 2500 },
};

const constants = { talentDefs: TALENT_DEFS, costTiers: TALENT_COST_TIERS, xpBase: XP_BASE, xpGrowth: XP_GROWTH };

// ── calcXpRequired ────────────────────────────────────────────────────────────

describe('calcXpRequired', () => {
  it('retorna xpBase na primeira compra (totalSpent=0)', () => {
    expect(calcXpRequired(0, XP_BASE, XP_GROWTH)).toBe(400);
  });

  it('cresce com a curva de XP_GROWTH a cada compra', () => {
    expect(calcXpRequired(1, XP_BASE, XP_GROWTH)).toBe(Math.floor(400 * 1.3));    // 520
    expect(calcXpRequired(2, XP_BASE, XP_GROWTH)).toBe(Math.floor(400 * 1.3**2)); // 676
    expect(calcXpRequired(3, XP_BASE, XP_GROWTH)).toBe(Math.floor(400 * 1.3**3)); // 879
  });

  it('nunca retorna valor menor que xpBase', () => {
    for (let i = 0; i < 20; i++) {
      expect(calcXpRequired(i, XP_BASE, XP_GROWTH)).toBeGreaterThanOrEqual(XP_BASE);
    }
  });
});

// ── getCostTier ───────────────────────────────────────────────────────────────

describe('getCostTier', () => {
  it('compras 0-2 custam 500 ouro', () => {
    expect(getCostTier(0, TALENT_COST_TIERS)).toMatchObject({ cost: 500, currency: 'gold' });
    expect(getCostTier(2, TALENT_COST_TIERS)).toMatchObject({ cost: 500, currency: 'gold' });
  });

  it('compras 3-9 custam 1000 ouro', () => {
    expect(getCostTier(3, TALENT_COST_TIERS)).toMatchObject({ cost: 1000, currency: 'gold' });
    expect(getCostTier(9, TALENT_COST_TIERS)).toMatchObject({ cost: 1000, currency: 'gold' });
  });

  it('compras 10-19 custam 500 dobrões', () => {
    expect(getCostTier(10, TALENT_COST_TIERS)).toMatchObject({ cost: 500, currency: 'dobrao' });
    expect(getCostTier(19, TALENT_COST_TIERS)).toMatchObject({ cost: 500, currency: 'dobrao' });
  });

  it('compras 20-29 custam 1000 dobrões', () => {
    expect(getCostTier(20, TALENT_COST_TIERS)).toMatchObject({ cost: 1000, currency: 'dobrao' });
  });

  it('compras 30+ custam 3000 dobrões (último tier)', () => {
    expect(getCostTier(30, TALENT_COST_TIERS)).toMatchObject({ cost: 3000, currency: 'dobrao' });
    expect(getCostTier(999, TALENT_COST_TIERS)).toMatchObject({ cost: 3000, currency: 'dobrao' });
  });
});

// ── applyTalentBonuses ────────────────────────────────────────────────────────

describe('applyTalentBonuses', () => {
  it('player sem talentos tem todos os bônus em 0', () => {
    const player = { talents: {} };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(player.talentDefenseBonus).toBe(0);
    expect(player.talentCannonBonus).toBe(0);
    expect(player.talentDamageBonus).toBe(0);
    expect(player.talentRelicBonus).toBe(0);
    expect(player.talentGoldBonus).toBe(0);
    expect(player.talentDobraoBonus).toBe(0);
    expect(player.talentXpBonus).toBe(0);
  });

  it('talento HP 5 não gera bônus em applyTalentBonuses (é flat HP, não multiplicador)', () => {
    const player = { talents: { hp: 5 } };
    applyTalentBonuses(player, TALENT_DEFS);
    // HP é flat e aplicado em recalcMaxHp, não aqui
    expect(player.talentCannonBonus).toBe(0);
  });

  it('talento defesa nível 3 → 9% de redução (0.09)', () => {
    const player = { talents: { defesa: 3 } };
    applyTalentBonuses(player, TALENT_DEFS);
    // 3 * 300 / 10000 = 0.09
    expect(player.talentDefenseBonus).toBeCloseTo(0.09);
  });

  it('talento dano nível 5 → 10% de dano extra (0.10)', () => {
    const player = { talents: { dano: 5 } };
    applyTalentBonuses(player, TALENT_DEFS);
    // 5 * 2 / 100 = 0.10
    expect(player.talentDamageBonus).toBeCloseTo(0.10);
  });

  it('talento canhoes nível 2 → +4 slots', () => {
    const player = { talents: { canhoes: 2 } };
    applyTalentBonuses(player, TALENT_DEFS);
    // 2 * 2 = 4
    expect(player.talentCannonBonus).toBe(4);
  });

  it('múltiplos talentos calculados independentemente', () => {
    const player = { talents: { dano: 2, mestre: 3, riqueza: 1 } };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(player.talentDamageBonus).toBeCloseTo(0.04);  // 2*2/100
    expect(player.talentXpBonus).toBeCloseTo(0.15);       // 3*5/100
    expect(player.talentGoldBonus).toBeCloseTo(0.03);     // 1*3/100
  });
});

// ── recalcMaxHp ───────────────────────────────────────────────────────────────

describe('recalcMaxHp', () => {
  it('hp base do navio sem talento, sem skill, sem island', () => {
    const player = { activeShip: 'fragata', talents: {}, skills: {}, shipIslandUpgrades: {} };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(600);
  });

  it('talento HP nível 2 adiciona +1000 HP (2 × 500)', () => {
    const player = { activeShip: 'fragata', talents: { hp: 2 }, skills: {}, shipIslandUpgrades: {} };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(600 + 1000);
  });

  it('island upgrade HP nível 1 adiciona +1000 HP', () => {
    const player = { activeShip: 'sloop', talents: {}, skills: {}, shipIslandUpgrades: { hp: 1 } };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(800 + 1000);
  });

  it('skill vida nível 5 adiciona 4% de HP base (nível-1 = 4%)', () => {
    const player = {
      activeShip: 'galleon',
      talents: {},
      skills: { vida: { level: 5 } },
      shipIslandUpgrades: {},
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    // floor(2500 * (1 + 0.04)) = floor(2600) = 2600
    expect(player.maxHp).toBe(Math.floor(2500 * 1.04));
  });

  it('stacking: navio + talento + skill + island', () => {
    const player = {
      activeShip: 'galleon',
      talents: { hp: 3 },                   // +1500 flat
      skills: { vida: { level: 3 } },        // +2% base
      shipIslandUpgrades: { hp: 2 },         // +2000 flat
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    const expected = Math.floor(2500 * 1.02) + 1500 + 2000;
    expect(player.maxHp).toBe(expected);
  });

  it('navio desconhecido usa fragata como fallback', () => {
    const player = { activeShip: 'navio_inexistente', talents: {}, skills: {}, shipIslandUpgrades: {} };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(600); // fragata
  });
});

// ── validateBuyTalent ─────────────────────────────────────────────────────────

describe('validateBuyTalent', () => {
  const basePlayer = () => ({
    talents: { hp: 0, totalSpent: 0 },
    mapXp:   500,
    gold:    1000,
    dobroes: 0,
    talentPoints: 0,
  });

  it('retorna null quando tudo está correto (1ª compra com ouro)', () => {
    const player = basePlayer(); // mapXp=500 ≥ xpReq(0)=400, gold=1000 ≥ 500
    expect(validateBuyTalent(player, 'hp', constants)).toBeNull();
  });

  it('erro: talento inválido', () => {
    expect(validateBuyTalent(basePlayer(), 'talento_fake', constants))
      .toMatch(/inválido/i);
  });

  it('erro: talento já no nível máximo', () => {
    const player = basePlayer();
    player.talents.hp = 5; // max é 5
    expect(validateBuyTalent(player, 'hp', constants))
      .toMatch(/nível máximo/i);
  });

  it('erro: XP insuficiente', () => {
    const player = basePlayer();
    player.mapXp = 100; // xpReq(0) = 400
    expect(validateBuyTalent(player, 'hp', constants))
      .toMatch(/XP insuficiente/i);
  });

  it('erro: ouro insuficiente (totalSpent=0, tier=500 gold)', () => {
    const player = basePlayer();
    player.gold = 400; // precisa de 500
    expect(validateBuyTalent(player, 'hp', constants))
      .toMatch(/Ouro insuficiente/i);
  });

  it('erro: dobrões insuficientes (totalSpent=10, tier=500 dobrao)', () => {
    const player = {
      ...basePlayer(),
      talents: { hp: 0, totalSpent: 10 },
      mapXp: 99999,
      gold: 99999,
      dobroes: 100,   // precisa de 500
    };
    expect(validateBuyTalent(player, 'hp', constants))
      .toMatch(/Dobrões insuficientes/i);
  });

  it('talentPoints > 0 ignora custo de moeda', () => {
    const player = { ...basePlayer(), gold: 0, dobroes: 0, talentPoints: 1 };
    // sem ouro, sem dobrões, mas tem ponto gratuito → válido
    expect(validateBuyTalent(player, 'hp', constants)).toBeNull();
  });

  it('talentPoints > 0 ainda requer XP suficiente', () => {
    const player = { ...basePlayer(), mapXp: 0, talentPoints: 1 };
    expect(validateBuyTalent(player, 'hp', constants))
      .toMatch(/XP insuficiente/i);
  });

  it('slot_reliquia max=1: compra segunda vez retorna erro', () => {
    const player = basePlayer();
    player.talents.slot_reliquia = 1;
    expect(validateBuyTalent(player, 'slot_reliquia', constants))
      .toMatch(/nível máximo/i);
  });
});
