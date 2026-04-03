import { describe, it, expect } from 'vitest';
import { calcMaxCannons, trimCannons } from '../combat-calc.js';
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
