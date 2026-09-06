import { describe, it, expect } from 'vitest';
import { calcMaxCannons, trimCannons, filterOwnedCannons, hasSpareCannon } from '../combat-calc.js';
import { applyTalentBonuses } from '../talent-logic.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MAX_CANNON_SLOTS = 20;

// Subconjunto de SHIP_DEFS relevante para slots de canhão
const SHIP_DEFS = {
  fragata:    { id: 'fragata',    maxCannons: 5  },
  sloop:      { id: 'sloop',     maxCannons: 10 },
  brigantine: { id: 'brigantine',maxCannons: 15 },
  galleon:    { id: 'galleon',   maxCannons: 20 },
  frigate:    { id: 'frigate',   maxCannons: 25 },
};

const TALENT_DEFS = {
  canhoes: { name: 'Artilheiro Pesado', max: 5, perLevel: 2, stat: 'cannon_slots' },
};

// ── calcMaxCannons — sem talento ───────────────────────────────────────────────

describe('calcMaxCannons — sem talento de canhão', () => {
  it('fragata: 5 slots', () => {
    expect(calcMaxCannons(SHIP_DEFS.fragata, 0, MAX_CANNON_SLOTS)).toBe(5);
  });

  it('sloop: 10 slots', () => {
    expect(calcMaxCannons(SHIP_DEFS.sloop, 0, MAX_CANNON_SLOTS)).toBe(10);
  });

  it('brigantine: 15 slots', () => {
    expect(calcMaxCannons(SHIP_DEFS.brigantine, 0, MAX_CANNON_SLOTS)).toBe(15);
  });

  it('galleon: 20 slots', () => {
    expect(calcMaxCannons(SHIP_DEFS.galleon, 0, MAX_CANNON_SLOTS)).toBe(20);
  });

  it('frigate: 25 slots', () => {
    expect(calcMaxCannons(SHIP_DEFS.frigate, 0, MAX_CANNON_SLOTS)).toBe(25);
  });

  it('navio sem maxCannons usa fallback MAX_CANNON_SLOTS', () => {
    const navioSemDef = {};
    expect(calcMaxCannons(navioSemDef, 0, MAX_CANNON_SLOTS)).toBe(MAX_CANNON_SLOTS);
  });
});

// ── calcMaxCannons — com talento de canhão ────────────────────────────────────

describe('calcMaxCannons — com talento de canhão (Artilheiro Pesado)', () => {
  it('talento nível 1 (+2): fragata 5 → 7', () => {
    const player = { talents: { canhoes: 1 } };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(calcMaxCannons(SHIP_DEFS.fragata, player.talentCannonBonus, MAX_CANNON_SLOTS)).toBe(7);
  });

  it('talento nível 3 (+6): sloop 10 → 16', () => {
    const player = { talents: { canhoes: 3 } };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(calcMaxCannons(SHIP_DEFS.sloop, player.talentCannonBonus, MAX_CANNON_SLOTS)).toBe(16);
  });

  it('talento nível 5 (+10): fragata 5 → 15', () => {
    const player = { talents: { canhoes: 5 } };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(calcMaxCannons(SHIP_DEFS.fragata, player.talentCannonBonus, MAX_CANNON_SLOTS)).toBe(15);
  });

  it('talento nível 5 (+10): galleon 20 → 30', () => {
    const player = { talents: { canhoes: 5 } };
    applyTalentBonuses(player, TALENT_DEFS);
    expect(calcMaxCannons(SHIP_DEFS.galleon, player.talentCannonBonus, MAX_CANNON_SLOTS)).toBe(30);
  });

  it('slots aumentam a cada nível de talento', () => {
    const slots = [];
    for (let level = 0; level <= 5; level++) {
      const player = { talents: { canhoes: level } };
      applyTalentBonuses(player, TALENT_DEFS);
      slots.push(calcMaxCannons(SHIP_DEFS.sloop, player.talentCannonBonus || 0, MAX_CANNON_SLOTS));
    }
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]).toBeGreaterThanOrEqual(slots[i - 1]);
    }
  });
});

// ── trimCannons ───────────────────────────────────────────────────────────────

describe('trimCannons — ajuste ao trocar navio', () => {
  it('não corta quando cannons <= maxCannons', () => {
    const result = trimCannons(['c1', 'c2', 'c3'], 5);
    expect(result.cannons).toEqual(['c1', 'c2', 'c3']);
    expect(result.removed).toBe(0);
  });

  it('não corta quando cannons == maxCannons (exato)', () => {
    const result = trimCannons(['c1', 'c2', 'c3', 'c4', 'c5'], 5);
    expect(result.cannons).toHaveLength(5);
    expect(result.removed).toBe(0);
  });

  it('corta excedente ao mudar de galleon (20) para fragata (5)', () => {
    const cannons = Array.from({ length: 20 }, (_, i) => `cannon_${i}`);
    const result = trimCannons(cannons, 5);
    expect(result.cannons).toHaveLength(5);
    expect(result.removed).toBe(15);
    expect(result.cannons[0]).toBe('cannon_0');
    expect(result.cannons[4]).toBe('cannon_4');
  });

  it('corta 1 canhão quando está 1 acima do limite', () => {
    const result = trimCannons(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], 5);
    expect(result.cannons).toHaveLength(5);
    expect(result.removed).toBe(1);
  });

  it('retorna novo array sem modificar o original', () => {
    const original = ['c1', 'c2', 'c3'];
    const result = trimCannons(original, 2);
    expect(original).toHaveLength(3); // original intacto
    expect(result.cannons).toHaveLength(2);
  });

  it('lista vazia: sem corte, removed = 0', () => {
    const result = trimCannons([], 5);
    expect(result.cannons).toEqual([]);
    expect(result.removed).toBe(0);
  });
});

// ── Integração: troca de navio ────────────────────────────────────────────────

describe('Integração — troca de navio com talento de canhão', () => {
  it('downgrade galleon → fragata sem talento: 20 canhões → corta para 5', () => {
    const player = { talents: {} };
    applyTalentBonuses(player, TALENT_DEFS);

    const cannonsEquipados = Array.from({ length: 20 }, (_, i) => `cannon_${i}`);

    // Equipar galleon
    const maxGalleon = calcMaxCannons(SHIP_DEFS.galleon, player.talentCannonBonus || 0, MAX_CANNON_SLOTS);
    expect(maxGalleon).toBe(20);

    // Trocar para fragata
    const maxFragata = calcMaxCannons(SHIP_DEFS.fragata, player.talentCannonBonus || 0, MAX_CANNON_SLOTS);
    const trimResult = trimCannons(cannonsEquipados, maxFragata);

    expect(maxFragata).toBe(5);
    expect(trimResult.cannons).toHaveLength(5);
    expect(trimResult.removed).toBe(15);
  });

  it('upgrade fragata → sloop sem talento: 5 canhões → nenhum corte', () => {
    const player = { talents: {} };
    applyTalentBonuses(player, TALENT_DEFS);

    const cannonsEquipados = ['c1', 'c2', 'c3', 'c4', 'c5'];

    const maxSloop = calcMaxCannons(SHIP_DEFS.sloop, player.talentCannonBonus || 0, MAX_CANNON_SLOTS);
    const trimResult = trimCannons(cannonsEquipados, maxSloop);

    expect(maxSloop).toBe(10);
    expect(trimResult.removed).toBe(0);
    expect(trimResult.cannons).toHaveLength(5);
  });

  it('downgrade com talento nível 5: fragata(5+10=15) suporta mais canhões', () => {
    const player = { talents: { canhoes: 5 } };
    applyTalentBonuses(player, TALENT_DEFS);

    const cannonsEquipados = Array.from({ length: 15 }, (_, i) => `cannon_${i}`);

    const maxFragata = calcMaxCannons(SHIP_DEFS.fragata, player.talentCannonBonus, MAX_CANNON_SLOTS);
    expect(maxFragata).toBe(15); // 5 base + 10 talento

    const trimResult = trimCannons(cannonsEquipados, maxFragata);
    expect(trimResult.removed).toBe(0); // sem corte!
  });

  it('reset de talentos com fragata: talento nível 5 → 0 corta de 15 para 5', () => {
    // Antes do reset: talento nível 5 na fragata → 15 slots
    const playerComTalento = { talents: { canhoes: 5 } };
    applyTalentBonuses(playerComTalento, TALENT_DEFS);
    const maxAntes = calcMaxCannons(SHIP_DEFS.fragata, playerComTalento.talentCannonBonus, MAX_CANNON_SLOTS);
    expect(maxAntes).toBe(15);

    const cannonsEquipados = Array.from({ length: 15 }, (_, i) => `cannon_${i}`);

    // Após reset: talento zerado → talentCannonBonus = 0
    const playerSemTalento = { talents: { canhoes: 0 } };
    applyTalentBonuses(playerSemTalento, TALENT_DEFS);
    const maxDepois = calcMaxCannons(SHIP_DEFS.fragata, playerSemTalento.talentCannonBonus || 0, MAX_CANNON_SLOTS);
    expect(maxDepois).toBe(5);

    const trimResult = trimCannons(cannonsEquipados, maxDepois);
    expect(trimResult.removed).toBe(10);
    expect(trimResult.cannons).toHaveLength(5);
  });
});

// ── filterOwnedCannons — estoque, não presença ────────────────────────────────
//
// O `equip_cannon_sync` validava com `inventory.includes(cid)`, que responde
// "sim" para CADA elemento da lista: um pacote forjado com quatro `c6` passava
// inteiro por quem possuía um só. Duplicação de canhão, e canhão é o eixo de
// dano do jogo. A régua agora é contagem — cada unidade equipada desconta uma
// do porão.

describe('filterOwnedCannons — quantidade possuída', () => {
  it('EXPLOIT: 4x c6 com apenas 1 no inventário equipa 1', () => {
    const incoming  = ['c6', 'c6', 'c6', 'c6'];
    const inventory = ['c1', 'c1', 'c1', 'c6'];
    expect(filterOwnedCannons(incoming, inventory)).toEqual(['c6']);
  });

  it('EXPLOIT: 20x c6 sem nenhum no inventário equipa 0', () => {
    const incoming = Array.from({ length: 20 }, () => 'c6');
    expect(filterOwnedCannons(incoming, ['c1', 'c1', 'c1'])).toEqual([]);
  });

  it('uso normal: equipar exatamente o que possui passa inteiro', () => {
    const inventory = ['c1', 'c1', 'c1'];
    expect(filterOwnedCannons(['c1', 'c1', 'c1'], inventory)).toEqual(['c1', 'c1', 'c1']);
  });

  it('uso normal: equipar menos do que possui passa inteiro', () => {
    expect(filterOwnedCannons(['c1'], ['c1', 'c1', 'c1'])).toEqual(['c1']);
  });

  it('desconta por id: 2 c6 + 1 c1 possuídos, pedido de 4 c6 + 2 c1', () => {
    const incoming  = ['c6', 'c6', 'c6', 'c6', 'c1', 'c1'];
    const inventory = ['c6', 'c6', 'c1'];
    expect(filterOwnedCannons(incoming, inventory)).toEqual(['c6', 'c6', 'c1']);
  });

  it('preserva a ORDEM do pedido (o slot 0 do jogador continua o slot 0)', () => {
    const incoming  = ['c1', 'c6', 'c1', 'c6'];
    const inventory = ['c6', 'c1', 'c1'];
    expect(filterOwnedCannons(incoming, inventory)).toEqual(['c1', 'c6', 'c1']);
  });

  it('canhão que não está no inventário cai', () => {
    expect(filterOwnedCannons(['c1', 'c6'], ['c1'])).toEqual(['c1']);
  });

  it('não modifica os arrays recebidos', () => {
    const incoming  = ['c6', 'c6'];
    const inventory = ['c6'];
    filterOwnedCannons(incoming, inventory);
    expect(incoming).toEqual(['c6', 'c6']);
    expect(inventory).toEqual(['c6']);
  });

  it('inventário vazio: nada passa', () => {
    expect(filterOwnedCannons(['c1', 'c6'], [])).toEqual([]);
  });

  it('pedido vazio: lista vazia', () => {
    expect(filterOwnedCannons([], ['c1', 'c1'])).toEqual([]);
  });

  it('argumentos ausentes não estouram', () => {
    expect(filterOwnedCannons(undefined, undefined)).toEqual([]);
    expect(filterOwnedCannons(['c1'], undefined)).toEqual([]);
    expect(filterOwnedCannons(undefined, ['c1'])).toEqual([]);
  });
});

// ── hasSpareCannon — o equip_cannon avulso ────────────────────────────────────
//
// O 'add' do `equip_cannon` empilhava sem olhar o inventário nenhuma vez: era
// pior que o sync, porque nem exigia possuir a primeira unidade.

describe('hasSpareCannon — sobrou unidade no porão?', () => {
  it('possui 3, equipou 2 → pode equipar mais um', () => {
    expect(hasSpareCannon('c1', ['c1', 'c1'], ['c1', 'c1', 'c1'])).toBe(true);
  });

  it('possui 3, equipou 3 → não pode', () => {
    expect(hasSpareCannon('c1', ['c1', 'c1', 'c1'], ['c1', 'c1', 'c1'])).toBe(false);
  });

  it('EXPLOIT: não possui nenhum → não pode equipar o primeiro', () => {
    expect(hasSpareCannon('c6', [], ['c1', 'c1', 'c1'])).toBe(false);
  });

  it('conta por id — c1 equipado não gasta a vaga do c6', () => {
    expect(hasSpareCannon('c6', ['c1', 'c1'], ['c1', 'c1', 'c6'])).toBe(true);
  });

  it('inventário ausente não estoura', () => {
    expect(hasSpareCannon('c6', [], undefined)).toBe(false);
  });
});

// ── Integração: os dois caminhos de equipar canhão ────────────────────────────

describe('Integração — pacote forjado não duplica canhão', () => {
  const CANNON_DEFS = { c1: { id: 'c1' }, c6: { id: 'c6' } };

  /** Espelha handleEquipCannonSync (server.js). */
  function equipSync(player, msg) {
    const incoming = (msg.cannons || [])
      .slice(0, player.maxCannons)
      .filter(cid => CANNON_DEFS[cid]);
    player.cannons = filterOwnedCannons(incoming, player.inventory.cannons);
    return player.cannons;
  }

  /** Espelha o ramo 'add' de handleEquipCannon (server.js). */
  function equipAdd(player, cannonId) {
    if (!CANNON_DEFS[cannonId]) return player.cannons;
    const cabe   = player.cannons.length < player.maxCannons;
    const possui = hasSpareCannon(cannonId, player.cannons, player.inventory?.cannons);
    if (cabe && possui) player.cannons.push(cannonId);
    return player.cannons;
  }

  it('equip_cannon_sync com 4x c6 possuindo 1 equipa 1 (não 4)', () => {
    const player = {
      maxCannons: 5,
      cannons:    [],
      inventory:  { cannons: ['c1', 'c1', 'c1', 'c6'] },
    };
    const result = equipSync(player, { type: 'equip_cannon_sync', cannons: ['c6', 'c6', 'c6', 'c6'] });
    expect(result).toEqual(['c6']);
    expect(result).toHaveLength(1);
  });

  it('equip_cannon_sync legítimo do armazém continua funcionando', () => {
    const player = {
      maxCannons: 5,
      cannons:    [],
      inventory:  { cannons: ['c1', 'c1', 'c1', 'c6', 'c6'] },
    };
    // O que _equip_all_cannon manda: tudo o que cabe e é possuído.
    const result = equipSync(player, { cannons: ['c6', 'c6', 'c1', 'c1', 'c1'] });
    expect(result).toEqual(['c6', 'c6', 'c1', 'c1', 'c1']);
  });

  it('id inventado é descartado antes do estoque', () => {
    const player = { maxCannons: 5, cannons: [], inventory: { cannons: ['c1'] } };
    expect(equipSync(player, { cannons: ['c99', 'c1'] })).toEqual(['c1']);
  });

  it('o limite de slots continua valendo junto com o estoque', () => {
    const player = {
      maxCannons: 3,
      cannons:    [],
      inventory:  { cannons: Array.from({ length: 10 }, () => 'c6') },
    };
    const result = equipSync(player, { cannons: Array.from({ length: 10 }, () => 'c6') });
    expect(result).toHaveLength(3);
  });

  it('equip_cannon "add" repetido não passa do que possui', () => {
    const player = {
      maxCannons: 20,
      cannons:    [],
      inventory:  { cannons: ['c6', 'c6', 'c6'] },   // possui 3
    };
    for (let i = 0; i < 20; i++) equipAdd(player, 'c6');
    expect(player.cannons).toEqual(['c6', 'c6', 'c6']);
  });

  it('equip_cannon "add" sem possuir nenhum não equipa nada', () => {
    const player = {
      maxCannons: 20,
      cannons:    [],
      inventory:  { cannons: ['c1', 'c1', 'c1'] },
    };
    for (let i = 0; i < 20; i++) equipAdd(player, 'c6');
    expect(player.cannons).toEqual([]);
  });
});

// ── Login: a ficha salva também passa pelo estoque ────────────────────────────

describe('Login — equipped_cannons do DB é filtrado por estoque', () => {
  it('conta já explorada volta ao que realmente possui', () => {
    // Linha do DB gravada pelo exploit: 4 c6 equipados, 1 c6 no porão.
    const savedEquipped    = ['c6', 'c6', 'c6', 'c6'];
    const inventoryCannons = ['c1', 'c1', 'c1', 'c6'];
    expect(filterOwnedCannons(savedEquipped, inventoryCannons)).toEqual(['c6']);
  });

  it('ficha legítima atravessa o login intacta', () => {
    const savedEquipped    = ['c1', 'c1', 'c1'];
    const inventoryCannons = ['c1', 'c1', 'c1'];
    expect(filterOwnedCannons(savedEquipped, inventoryCannons)).toEqual(['c1', 'c1', 'c1']);
  });
});
