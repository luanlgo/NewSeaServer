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
  validateRefundTalent,
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

  // ── A TAXA cai pela metade a cada faixa de 40 compras ─────────────────────
  // A exponencial pura pedia 1 MILHÃO de XP na 80ª compra e 46 milhões na 120ª:
  // com 1200 pontos compráveis, a árvore virava um muro por volta de 15% dela.
  // A taxa decaindo mantém o custo SEMPRE subindo, mas em ritmo farmável.
  it('a 1ª faixa (até 40) continua exatamente como era', () => {
    expect(calcXpRequired(10, XP_BASE, XP_GROWTH)).toBe(1_296);
    expect(calcXpRequired(20, XP_BASE, XP_GROWTH)).toBe(3_363);
    expect(calcXpRequired(40, XP_BASE, XP_GROWTH)).toBe(22_629);
  });

  it('a taxa cai pela metade a cada 40 e PARA em 2,5%', () => {
    const taxa = (n) => calcXpRequired(n + 1, XP_BASE, XP_GROWTH, talents.TALENT_XP_CAP)
                      / calcXpRequired(n,     XP_BASE, XP_GROWTH, talents.TALENT_XP_CAP);
    expect(taxa(10),  '1ª faixa: +10%').toBeCloseTo(1.10,   3);
    expect(taxa(50),  '2ª faixa: +5%').toBeCloseTo(1.05,    3);
    expect(taxa(90),  '3ª faixa: +2,5%').toBeCloseTo(1.025, 3);
    // Daqui para a frente a taxa é a mesma para sempre — é o PISO.
    expect(taxa(130), '4ª faixa: continua +2,5%').toBeCloseTo(1.025, 3);
    expect(taxa(400), 'compra 400: continua +2,5%').toBeCloseTo(1.025, 3);
    expect(taxa(900), 'compra 900: continua +2,5%').toBeCloseTo(1.025, 3);
  });

  // O bug que o piso conserta: sem ele a taxa continuava caindo (1,25%, 0,625%…)
  // e a série geométrica CONVERGIA — o requisito travava em ~1,16 milhão por
  // volta da compra 800 e o incremento virava literalmente zero, deixando o
  // último terço da árvore sem gate de XP nenhum.
  it('o incremento nunca chega a zero enquanto o valor cabe no int64', () => {
    const req = (n) => calcXpRequired(n, XP_BASE, XP_GROWTH, talents.TALENT_XP_CAP);
    // Acima da compra ~1083 o requisito satura no teto anti-overflow e o
    // incremento vira 0 por construção — lá o gate já é inalcançável de qualquer
    // forma. O que importa é que não haja platô ANTES disso.
    for (let n = 0; n < 1000; n += 7) {
      expect(req(n + 1) - req(n), `platô na compra ${n}`).toBeGreaterThan(0);
    }
  });

  it('a curva só encosta no teto anti-overflow muito além do jogável', () => {
    // O teto não é balanceamento, é proteção de int64. Se ele passar a ser
    // atingido cedo, o gate de XP some justamente onde deveria morder.
    let satura = null;
    for (let n = 0; n <= 1300; n++) {
      if (calcXpRequired(n, XP_BASE, XP_GROWTH, talents.TALENT_XP_CAP) >= talents.TALENT_XP_CAP) {
        satura = n;
        break;
      }
    }
    expect(satura, 'a curva satura dentro da faixa jogável').toBeGreaterThan(1000);
  });

  it('o muro sumiu: a 120ª compra sai de 46 milhões para centenas de milhares', () => {
    const req120 = calcXpRequired(120, XP_BASE, XP_GROWTH, talents.TALENT_XP_CAP);
    expect(req120).toBeLessThan(1_000_000);
    // ...mas continua MUITO acima da primeira compra: barato não ficou.
    expect(req120).toBeGreaterThan(100 * XP_BASE);
  });

  it('o custo nunca para de subir nem regride', () => {
    let anterior = 0;
    for (let n = 0; n <= 1200; n += 13) {
      const req = calcXpRequired(n, XP_BASE, XP_GROWTH, talents.TALENT_XP_CAP);
      expect(req, `compra ${n} ficou mais barata que a anterior`).toBeGreaterThanOrEqual(anterior);
      anterior = req;
    }
  });

  it('segue seguro como int64 até a última compra da árvore', () => {
    const req = calcXpRequired(1199, XP_BASE, XP_GROWTH, talents.TALENT_XP_CAP);
    expect(Number.isSafeInteger(req)).toBe(true);
    expect(req).toBeLessThanOrEqual(talents.TALENT_XP_CAP);
  });
});

// ── getCostTier ───────────────────────────────────────────────────────────────

describe('getCostTier', () => {
  it('as 5 primeiras compras custam 1.000 ouro', () => {
    expect(getCostTier(0, TALENT_COST_TIERS)).toMatchObject({ cost: 1000, currency: 'gold' });
    expect(getCostTier(4, TALENT_COST_TIERS)).toMatchObject({ cost: 1000, currency: 'gold' });
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
    expect(sumTalentStat(p, TALENT_DEFS, 'max_hp_flat_2')).toBe(6000); // 3 × 2000
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
    expect(player.maxHp).toBe(600 + 1000 + 4000);   // 4 × 250 + 2 × 2000
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

  // Os navios bônus não estão no SHIP_DEFS: o HP vem do próprio drop. Antes eles
  // repetiam a fórmula à mão e ficaram para trás quando o Casco Reforçado passou
  // a somar percentual — quem estava num navio bônus perdia os dois talentos
  // percentuais de vida sem nenhum erro aparecer.
  it('baseHpOverride usa o HP do navio bônus e ainda assim soma TODOS os talentos', () => {
    const player = {
      activeShip: 'fragata',
      talents: { def_cascoferro: 4, def_reforcado: 5, def_coracaoabissal: 2 },
      skills: {}, shipIslandUpgrades: {},
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS, 9000);

    const flat = 4 * 250;                       // Casco de Ferro
    const pct  = (5 * 2 + 2 * 3) / 100;         // Casco Reforçado + Coração do Abismo
    expect(player.maxHp).toBe(Math.floor(9000 * (1 + pct)) + flat);
  });

  it('o override não muda em nada o caminho do navio regular', () => {
    const talents = { def_cascoferro: 3, def_reforcado: 4 };
    const a = { activeShip: 'galleon', talents, skills: {}, shipIslandUpgrades: {} };
    const b = { activeShip: 'galleon', talents, skills: {}, shipIslandUpgrades: {} };
    recalcMaxHp(a, SHIP_DEFS, TALENT_DEFS);
    recalcMaxHp(b, SHIP_DEFS, TALENT_DEFS, SHIP_DEFS.galleon.hp);
    expect(b.maxHp).toBe(a.maxHp);
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
    gold:    10000,
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

  it('erro: ouro insuficiente (totalSpent=0, tier=1.000 gold)', () => {
    const player = basePlayer();
    player.gold = 900;
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

// ── validateRefundTalent ──────────────────────────────────────────────
// Clique direito no nó devolve um nível. O caso que importa é o gate: tirar um
// ponto pode derrubar a árvore abaixo do mínimo de um anel onde o jogador JÁ
// investiu, criando um estado que o próprio servidor recusaria montar do zero.

describe('validateRefundTalent', () => {
  const gated = { talentDefs: TALENT_DEFS, ringGate: RING_GATE };

  it('devolve um nível quando não há nada segurando', () => {
    const player = { talents: { atk_artilharia: 3, totalSpent: 3 } };
    expect(validateRefundTalent(player, 'atk_artilharia', gated)).toBeNull();
  });

  it('erro: talento sem ponto investido', () => {
    const player = { talents: { atk_artilharia: 0, totalSpent: 0 } };
    expect(validateRefundTalent(player, 'atk_artilharia', gated)).toMatch(/não tem ponto/i);
  });

  it('erro: talento inválido', () => {
    expect(validateRefundTalent({ talents: {} }, 'nao_existe', gated)).toMatch(/inválido/i);
  });

  // 96 pontos em anéis internos + 4 no anel 5 = exatamente o gate de 100. É o
  // estado mais apertado possível: tirar QUALQUER ponto derruba a árvore para 99.
  const NO_LIMITE = {
    def_cascoferro: 10, def_armadura: 10, def_calafate: 10, def_leme: 10,
    def_reforcado: 10, def_esquiva: 10, def_escudoguerra: 10, def_couraca: 10,
    def_cascoliso: 10, def_anteparo: 6,
  };
  const COM_ANEL_5 = { ...NO_LIMITE, def_fortaleza: 4, totalSpent: 100 };

  it('erro: devolver de dentro fecharia o anel de um nó já investido', () => {
    const erro = validateRefundTalent({ talents: { ...COM_ANEL_5 } }, 'def_cascoferro', gated);
    expect(erro).toMatch(/Fortaleza Flutuante/);
    expect(erro).toMatch(/sobrariam 99/);
  });

  // Sem esta permissão o jogador ficava preso: no limite exato do gate, nem os
  // pontos do próprio anel externo poderiam sair.
  it('o nó do anel externo sempre pode ser desmontado', () => {
    expect(validateRefundTalent({ talents: { ...COM_ANEL_5 } }, 'def_fortaleza', gated)).toBeNull();
  });

  it('dois nós no anel externo não travam um ao outro', () => {
    const player = { talents: { ...NO_LIMITE, def_fortaleza: 2, def_absorcao: 2, totalSpent: 100 } };
    expect(validateRefundTalent(player, 'def_fortaleza', gated)).toBeNull();
    expect(validateRefundTalent(player, 'def_absorcao', gated)).toBeNull();
  });

  it('esvaziado o anel externo, os internos liberam', () => {
    const player = { talents: { ...NO_LIMITE, totalSpent: 96 } };
    expect(validateRefundTalent(player, 'def_cascoferro', gated)).toBeNull();
  });

  it('uma árvore não trava a outra', () => {
    const player = { talents: { ...COM_ANEL_5, atk_artilharia: 5, totalSpent: 105 } };
    expect(validateRefundTalent(player, 'atk_artilharia', gated)).toBeNull();
  });

  it('sem ringGate a checagem de anel não roda', () => {
    const player = { talents: { ...COM_ANEL_5 } };
    expect(validateRefundTalent(player, 'def_cascoferro', { talentDefs: TALENT_DEFS })).toBeNull();
  });
});
