import { describe, it, expect } from 'vitest';
import {
  calcXpRequired,
  getCostTier,
  aggregateTalentStats,
  sumTalentStat,
  countTreeSpent,
  applyTalentBonuses,
  recalcMaxHp,
  migrateLegacyTalents,
  validateBuyTalent,
} from '../talent-logic.js';
import talents from '../../constants/talents.js';

// Os defs REAIS, não uma cópia. Com 120 talentos em 3 árvores, um fixture à mão
// aqui só serviria para o teste continuar verde depois de o jogo mudar.
const {
  TALENT_DEFS,
  TALENT_COST_TIERS,
  TALENT_XP_BASE:   XP_BASE,
  TALENT_XP_GROWTH: XP_GROWTH,
  RING_GATE,
  TALENT_MAX,
  LEGACY_TALENT_MAP,
} = talents;

const SHIP_DEFS = {
  fragata: { hp: 600 },
  sloop:   { hp: 800 },
  galleon: { hp: 2500 },
};

const constants = {
  talentDefs: TALENT_DEFS,
  costTiers:  TALENT_COST_TIERS,
  xpBase:     XP_BASE,
  xpGrowth:   XP_GROWTH,
  xpCap:      talents.TALENT_XP_CAP,
};

// ── Integridade das árvores ───────────────────────────────────────────────────

describe('estrutura das árvores', () => {
  it('tem 3 árvores de 40 talentos cada', () => {
    expect(talents.TREE_ORDER).toHaveLength(3);
    for (const tree of talents.TREE_ORDER) {
      expect(talents.TALENT_TREES[tree]).toHaveLength(40);
    }
    expect(Object.keys(TALENT_DEFS)).toHaveLength(120);
  });

  it('todo talento vai até 10 e declara árvore, anel e stat', () => {
    for (const [id, def] of Object.entries(TALENT_DEFS)) {
      expect(def.max, id).toBe(TALENT_MAX);
      expect(talents.TREE_ORDER, id).toContain(def.tree);
      expect(def.ring, id).toBeGreaterThanOrEqual(0);
      expect(def.ring, id).toBeLessThan(RING_GATE.length);
      expect(typeof def.stat, id).toBe('string');
      expect(def.perLevel, id).toBeGreaterThan(0);
    }
  });

  it('ids são ASCII (vão para o DB e para dicionários GDScript)', () => {
    for (const id of Object.keys(TALENT_DEFS)) {
      expect(id, id).toMatch(/^[a-z]{3}_[a-z0-9_]+$/);
    }
  });

  it('nenhum stat é reaproveitado por dois talentos', () => {
    const stats = Object.values(TALENT_DEFS).map(d => d.stat);
    expect(new Set(stats).size).toBe(stats.length);
  });
});

// ── calcXpRequired ────────────────────────────────────────────────────────────

describe('calcXpRequired', () => {
  it('retorna xpBase na primeira compra (totalSpent=0)', () => {
    expect(calcXpRequired(0, XP_BASE, XP_GROWTH)).toBe(500);
  });

  // A curva é +10% sobre a exigência anterior, e é ESTA sequência que o
  // balanceamento pediu — os números literais existem para que mexer no
  // XP_GROWTH sem querer apareça aqui.
  it('cresce 10% a cada compra: 500 → 550 → 605 → 665', () => {
    expect(calcXpRequired(1, XP_BASE, XP_GROWTH)).toBe(550);
    expect(calcXpRequired(2, XP_BASE, XP_GROWTH)).toBe(605);
    expect(calcXpRequired(3, XP_BASE, XP_GROWTH)).toBe(665);
  });

  // O teto não é mais balanceamento, é trava de overflow: 500 × 1,1^1199 ≈ 10^52
  // vira lixo ao virar int64 no cliente. Até a 320ª compra a curva passa livre.
  it('cresce livre bem além das primeiras centenas de compras', () => {
    expect(calcXpRequired(100, XP_BASE, XP_GROWTH, talents.TALENT_XP_CAP)).toBe(6_890_306);
    expect(calcXpRequired(200, XP_BASE, XP_GROWTH, talents.TALENT_XP_CAP)).toBeGreaterThan(9e10);
  });

  it('trava no MAX_SAFE_INTEGER — sem isso a 1200ª compra estoura o int64', () => {
    const req = calcXpRequired(1199, XP_BASE, XP_GROWTH, talents.TALENT_XP_CAP);
    expect(req).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(req)).toBe(true);
  });
});

// ── getCostTier ───────────────────────────────────────────────────────────────

describe('getCostTier', () => {
  it('as 5 primeiras compras custam 500 ouro', () => {
    expect(getCostTier(0, TALENT_COST_TIERS)).toMatchObject({ cost: 500, currency: 'gold' });
    expect(getCostTier(4, TALENT_COST_TIERS)).toMatchObject({ cost: 500, currency: 'gold' });
  });

  it('a moeda vira dobrão a partir da 200ª compra', () => {
    expect(getCostTier(199, TALENT_COST_TIERS)).toMatchObject({ currency: 'gold' });
    expect(getCostTier(200, TALENT_COST_TIERS)).toMatchObject({ currency: 'dobrao' });
  });

  it('acima do último tier o custo trava no mais caro', () => {
    const last = TALENT_COST_TIERS[TALENT_COST_TIERS.length - 1];
    expect(getCostTier(5000, TALENT_COST_TIERS)).toMatchObject({ cost: last.cost });
  });
});

// ── aggregateTalentStats / sumTalentStat / countTreeSpent ─────────────────────

describe('aggregateTalentStats', () => {
  it('player sem talentos agrega um mapa vazio', () => {
    expect(aggregateTalentStats({ talents: {} }, TALENT_DEFS)).toEqual({});
  });

  it('multiplica nível × perLevel por chave de stat', () => {
    const tal = aggregateTalentStats({ talents: { atk_artilharia: 3 } }, TALENT_DEFS);
    expect(tal.damage_pct).toBeCloseTo(6); // 3 × 2
  });

  it('ignora ids que não existem mais (save antigo)', () => {
    const tal = aggregateTalentStats({ talents: { dano: 5, totalSpent: 5 } }, TALENT_DEFS);
    expect(tal).toEqual({});
  });
});

describe('sumTalentStat e countTreeSpent', () => {
  it('soma só o stat pedido', () => {
    const p = { talents: { def_cascoferro: 2, def_madeiranobre: 3 } };
    expect(sumTalentStat(p, TALENT_DEFS, 'max_hp_flat')).toBe(500);    // 2 × 250
    expect(sumTalentStat(p, TALENT_DEFS, 'max_hp_flat_2')).toBe(1200); // 3 × 400
  });

  it('conta pontos por árvore, ignorando as outras', () => {
    const p = { talents: { atk_artilharia: 4, def_cascoferro: 7, totalSpent: 11 } };
    expect(countTreeSpent(p, TALENT_DEFS, 'ataque')).toBe(4);
    expect(countTreeSpent(p, TALENT_DEFS, 'defesa')).toBe(7);
    expect(countTreeSpent(p, TALENT_DEFS, 'recurso')).toBe(0);
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
    expect(player.talentManaRegenBonus).toBe(0);
  });

  it('Armadura Grossa nível 4 → 6% de redução (0.06)', () => {
    const player = { talents: { def_armadura: 4 } };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(player.talentDefenseBonus).toBeCloseTo(0.06); // 4 × 1,5 / 100
  });

  it('Artilharia Pesada nível 5 → 10% de dano extra (0.10)', () => {
    const player = { talents: { atk_artilharia: 5 } };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(player.talentDamageBonus).toBeCloseTo(0.10); // 5 × 2 / 100
  });

  it('Bateria Extra nível 6 → +6 slots de canhão', () => {
    const player = { talents: { atk_bateria: 6 } };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(player.talentCannonBonus).toBe(6);
  });

  it('Fluxo de Mana no máximo → +80% de regeneração', () => {
    const player = { talents: { res_manaflow: 10 } };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(player.talentManaRegenBonus).toBeCloseTo(0.80);
  });

  it('talentos de árvores diferentes não se contaminam', () => {
    const player = { talents: { atk_artilharia: 2, res_estudioso: 3, res_pilhador: 1 } };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(player.talentDamageBonus).toBeCloseTo(0.04); // 2 × 2 / 100
    expect(player.talentXpBonus).toBeCloseTo(0.12);     // 3 × 4 / 100
    expect(player.talentGoldBonus).toBeCloseTo(0.03);   // 1 × 3 / 100
  });
});

// ── recalcMaxHp ───────────────────────────────────────────────────────────────

describe('recalcMaxHp', () => {
  it('hp base do navio sem talento, sem skill, sem island', () => {
    const player = { activeShip: 'fragata', talents: {}, skills: {}, shipIslandUpgrades: {} };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(600);
  });

  it('Casco de Ferro nível 2 adiciona +500 HP (2 × 250)', () => {
    const player = { activeShip: 'fragata', talents: { def_cascoferro: 2 }, skills: {}, shipIslandUpgrades: {} };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(600 + 500);
  });

  it('Madeira Nobre soma junto com Casco de Ferro', () => {
    const player = {
      activeShip: 'fragata',
      talents: { def_cascoferro: 4, def_madeiranobre: 2 },
      skills: {}, shipIslandUpgrades: {},
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(600 + 1000 + 800);
  });

  it('island upgrade HP nível 1 adiciona 5% do HP base do navio', () => {
    const player = { activeShip: 'sloop', talents: {}, skills: {}, shipIslandUpgrades: { hp: 1 } };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(800 + 40); // round(1 × 800 × 0,05)
  });

  it('skill vida nível 5 adiciona 4% de HP base (nível-1 = 4%)', () => {
    const player = {
      activeShip: 'galleon',
      talents: {},
      skills: { vida: { level: 5 } },
      shipIslandUpgrades: {},
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(Math.floor(2500 * 1.04));
  });

  it('stacking: navio + talento + skill + island', () => {
    const player = {
      activeShip: 'galleon',
      talents: { def_cascoferro: 3 },        // +750 flat
      skills: { vida: { level: 3 } },        // +2% base
      shipIslandUpgrades: { hp: 2 },         // round(2 × 2500 × 0,05) = 250
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(Math.floor(2500 * 1.02) + 750 + 250);
  });

  it('navio desconhecido usa fragata como fallback', () => {
    const player = { activeShip: 'navio_inexistente', talents: {}, skills: {}, shipIslandUpgrades: {} };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(600);
  });
});

// ── migrateLegacyTalents ──────────────────────────────────────────────────────

describe('migrateLegacyTalents', () => {
  it('devolve o total gasto e apaga os ids antigos', () => {
    const player = { talents: { hp: 5, dano: 3, canhoes: 2, totalSpent: 10 }, talentPoints: 0 };
    const refund = migrateLegacyTalents(player, LEGACY_TALENT_MAP);
    expect(refund).toBe(10);
    expect(player.talentPoints).toBe(10);
    expect(player.talents.totalSpent).toBe(0);
    expect(player.talents.hp).toBeUndefined();
    expect(player.talents.dano).toBeUndefined();
  });

  it('soma aos pontos livres que o jogador já tinha', () => {
    const player = { talents: { hp: 2, totalSpent: 2 }, talentPoints: 7 };
    expect(migrateLegacyTalents(player, LEGACY_TALENT_MAP)).toBe(2);
    expect(player.talentPoints).toBe(9);
  });

  it('é idempotente — a segunda passada não devolve nada', () => {
    const player = { talents: { hp: 4, totalSpent: 4 }, talentPoints: 0 };
    migrateLegacyTalents(player, LEGACY_TALENT_MAP);
    expect(migrateLegacyTalents(player, LEGACY_TALENT_MAP)).toBe(0);
    expect(player.talentPoints).toBe(4);
  });

  it('não mexe num player já migrado para as árvores novas', () => {
    const player = { talents: { atk_artilharia: 6, totalSpent: 6 }, talentPoints: 0 };
    expect(migrateLegacyTalents(player, LEGACY_TALENT_MAP)).toBe(0);
    expect(player.talents.atk_artilharia).toBe(6);
    expect(player.talents.totalSpent).toBe(6);
  });

  it('todo id antigo aponta para um talento que existe', () => {
    for (const [legacy, novo] of Object.entries(LEGACY_TALENT_MAP)) {
      expect(TALENT_DEFS[novo], `${legacy} → ${novo}`).toBeDefined();
    }
  });
});

// ── validateBuyTalent ─────────────────────────────────────────────────────────

describe('validateBuyTalent', () => {
  const basePlayer = () => ({
    talents: { totalSpent: 0 },
    mapXp:   500,
    gold:    1000,
    dobroes: 0,
    talentPoints: 0,
  });

  it('retorna null quando tudo está correto (1ª compra com ouro)', () => {
    expect(validateBuyTalent(basePlayer(), 'atk_artilharia', constants)).toBeNull();
  });

  it('erro: talento inválido', () => {
    expect(validateBuyTalent(basePlayer(), 'talento_fake', constants)).toMatch(/inválido/i);
  });

  it('erro: talento já no nível máximo', () => {
    const player = basePlayer();
    player.talents.atk_artilharia = TALENT_MAX;
    expect(validateBuyTalent(player, 'atk_artilharia', constants)).toMatch(/nível máximo/i);
  });

  it('erro: XP insuficiente', () => {
    const player = basePlayer();
    player.mapXp = 100; // xpReq(0) = 400
    expect(validateBuyTalent(player, 'atk_artilharia', constants)).toMatch(/XP insuficiente/i);
  });

  it('erro: ouro insuficiente (totalSpent=0, tier=500 gold)', () => {
    const player = basePlayer();
    player.gold = 400;
    expect(validateBuyTalent(player, 'atk_artilharia', constants)).toMatch(/Ouro insuficiente/i);
  });

  it('erro: dobrões insuficientes no tier de dobrão', () => {
    const player = { ...basePlayer(), talents: { totalSpent: 250 }, mapXp: Number.MAX_SAFE_INTEGER, gold: 9e9, dobroes: 100 };
    expect(validateBuyTalent(player, 'atk_artilharia', constants)).toMatch(/Dobrões insuficientes/i);
  });

  it('talentPoints > 0 ignora custo de moeda', () => {
    const player = { ...basePlayer(), gold: 0, dobroes: 0, talentPoints: 1 };
    expect(validateBuyTalent(player, 'atk_artilharia', constants)).toBeNull();
  });

  it('talentPoints > 0 ainda requer XP suficiente', () => {
    const player = { ...basePlayer(), mapXp: 0, talentPoints: 1 };
    expect(validateBuyTalent(player, 'atk_artilharia', constants)).toMatch(/XP insuficiente/i);
  });

  // ── gate de anel ───────────────────────────────────────────────────────────

  const gated = { ...constants, ringGate: RING_GATE };

  it('anel 0 abre sem nenhum ponto investido', () => {
    expect(validateBuyTalent(basePlayer(), 'atk_artilharia', gated)).toBeNull();
  });

  it('erro: capstone bloqueado sem os pontos do anel', () => {
    const player = { ...basePlayer(), mapXp: Number.MAX_SAFE_INTEGER, gold: 9e9, talentPoints: 5 };
    expect(validateBuyTalent(player, 'atk_furiakraken', gated)).toMatch(/abrir este anel/i);
  });

  it('o gate conta só a própria árvore', () => {
    // 100 pontos em Defesa abrem o anel 5 DELA e continuam não abrindo o de Ataque.
    const player = { ...basePlayer(), mapXp: Number.MAX_SAFE_INTEGER, gold: 9e9, talentPoints: 99, talents: { def_cascoferro: 10, def_armadura: 10, def_calafate: 10, def_leme: 10, def_reforcado: 10, def_esquiva: 10, def_escudoguerra: 10, def_couraca: 10, def_cascoliso: 10, def_anteparo: 10, totalSpent: 100 } };
    expect(validateBuyTalent(player, 'atk_furiakraken', gated)).toMatch(/abrir este anel/i);
    expect(validateBuyTalent(player, 'def_fortaleza', gated)).toBeNull();
  });
});
