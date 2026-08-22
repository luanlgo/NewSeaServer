import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { recalcMaxHp } from '../talent-logic.js';
import { SHIP_DEFS, maxHealersFor } from '../../constants/ships.js';
import { pirateCapacityFor } from '../../constants/pirates.js';
import { BONUS_NPC_DEFS, rollBonusShip } from '../../constants/bonus_dungeons.js';

// ── Por que este teste existe ─────────────────────────────────────────────────
// Os três navios de masmorra viviam SÓ no BONUS_NPC_DEFS, fora do SHIP_DEFS.
// Meia dúzia de sistemas resolve o navio ativo com `SHIP_DEFS[activeShip] ||
// SHIP_DEFS.fragata`, então todos eles caíam no fallback SEM ERRO NENHUM: o
// navio mais raro do jogo saía com 1 vela, 5 curandeiros, capacidade de pirata
// normal, os multiplicadores da fragata, e não contava para a diária de elite.
//
// O sintoma que denunciou tudo foi a vida: comprar o upgrade de vida na Ilha do
// Comércio recalculava o maxHp sobre a fragata e derrubava ~200k para ~20k.
//
// Nenhum teste de unidade pegava isso — cada função isolada estava certa, o
// errado era o DADO que faltava na tabela. Daí a checagem ser sobre a tabela.

const BONUS_SHIP_IDS = [
  'colossal_ghost_pirate_galleon',
  'massive_imperial_warship',
  'gigantic_mechanical_pirate_ship',
];

describe('navios bônus estão no SHIP_DEFS', () => {
  it.each(BONUS_SHIP_IDS)('%s existe na tabela', (id) => {
    expect(SHIP_DEFS[id], `${id} fora do SHIP_DEFS → tudo cai no fallback da fragata`)
      .toBeDefined();
  });

  it.each(BONUS_SHIP_IDS)('%s é elite (curandeiros e diária de elite)', (id) => {
    expect(SHIP_DEFS[id].isElite).toBe(true);
    expect(maxHealersFor(id)).toBe(10);                      // era 5 no fallback
  });

  it.each(BONUS_SHIP_IDS)('%s mantém a capacidade de pirata explícita', (id) => {
    // Este NÃO era um dos sistemas quebrados: a SHIP_PIRATE_CAPACITY tem entrada
    // nominal para os três e é consultada ANTES do SHIP_DEFS. Fica travado aqui
    // porque agora o fallback por isElite (40) também os alcançaria, e apagar a
    // entrada nominal passaria a rebaixá-los de 50 para 40 sem ninguém notar.
    expect(pirateCapacityFor(id)).toBe(50);
  });

  it.each(BONUS_SHIP_IDS)('%s tem 3 velas, não a 1 da fragata', (id) => {
    expect(SHIP_DEFS[id].sails).toBe(3);
  });

  it.each(BONUS_SHIP_IDS)('%s traz os multiplicadores explícitos', (id) => {
    const d = SHIP_DEFS[id];
    // Herdavam os da fragata por acidente; agora são escolha, não sobra.
    expect(d.damageMult).toBeDefined();
    expect(d.speedMult).toBeDefined();
    expect(d.dropBonus).toBeDefined();
  });

  it.each(BONUS_SHIP_IDS)('%s é bonusOnly — não se compra nem se lista', (id) => {
    expect(SHIP_DEFS[id].bonusOnly).toBe(true);
    expect(SHIP_DEFS[id].price).toBeUndefined();
  });

  it('o hp da tabela é o PISO da rolagem (hpMin), não um valor solto', () => {
    for (const id of BONUS_SHIP_IDS) {
      expect(SHIP_DEFS[id].hp).toBe(BONUS_NPC_DEFS[id].stats.hpMin);
      expect(SHIP_DEFS[id].maxCannons).toBe(BONUS_NPC_DEFS[id].stats.cannonMin);
    }
  });

  it('TODO navio que uma masmorra dropa tem entrada — inclusive um futuro', () => {
    // Esta é a que pega a masmorra nº 4: sem entrada no SHIP_DEFS ela nasce com
    // o bug inteiro de volta (1 vela, 5 curandeiros, vida da fragata).
    const dropados = Object.values(BONUS_NPC_DEFS)
      .filter(n => n.shipDropId).map(n => n.shipDropId);
    expect(dropados.length).toBeGreaterThan(0);
    for (const id of dropados) {
      expect(SHIP_DEFS[id], `${id} dropa de masmorra mas não está no SHIP_DEFS`)
        .toBeDefined();
      expect(SHIP_DEFS[id].bonusOnly).toBe(true);
    }
  });

  it('os stats são DERIVADOS, não escritos à mão no ships.js', () => {
    // O piso vive em dois arquivos por natureza. Enquanto ele for derivado, um
    // rebalanceamento da masmorra move os dois juntos; escrito à mão, o
    // ships.js passa a mentir em silêncio — que é o que quase aconteceu quando
    // o bonus_dungeons.js foi rebalanceado no meio da implementação.
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'constants', 'ships.js'), 'utf8',
    );
    expect(src, 'ships.js não deriva mais do BONUS_NPC_DEFS da masmorra')
      .toContain("require('./bonus_dungeons')");
    expect(src, 'as entradas do navio bônus voltaram a ser escritas à mão')
      .toContain('..._BONUS_SHIP_DEFS');
    // O modelo também vem do BONUS_NPC_DEFS — se alguém recadastrar à mão e o
    // caminho do GLB mudar lá, isto acusa.
    for (const id of BONUS_SHIP_IDS) {
      expect(SHIP_DEFS[id].model).toBe(BONUS_NPC_DEFS[id].model);
    }
  });
});

describe('a instância rolada vence o piso da tabela', () => {
  const TALENT_DEFS = {};

  it('recalcMaxHp com override usa o HP rolado, não o SHIP_DEFS', () => {
    const ship   = rollBonusShip(BONUS_NPC_DEFS.gigantic_mechanical_pirate_ship);
    const player = {
      activeShip: 'gigantic_mechanical_pirate_ship',
      talents: {}, shipIslandUpgrades: { hp: 0, defense: 0, damage: 0 },
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS, ship.maxHp);
    expect(player.maxHp).toBe(ship.maxHp);
  });

  it('o upgrade de vida SOMA sobre o HP rolado — não troca pelo da fragata', () => {
    const ship   = rollBonusShip(BONUS_NPC_DEFS.gigantic_mechanical_pirate_ship);
    const player = {
      activeShip: 'gigantic_mechanical_pirate_ship',
      talents: {}, shipIslandUpgrades: { hp: 0, defense: 0, damage: 0 },
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS, ship.maxHp);
    const semUpgrade = player.maxHp;

    player.shipIslandUpgrades.hp = 1;
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS, ship.maxHp);

    // Este é O bug: antes o maxHp DESPENCAVA aqui, para o HP da fragata.
    expect(player.maxHp).toBeGreaterThan(semUpgrade);
    expect(player.maxHp).toBe(semUpgrade + Math.round(ship.maxHp * 0.05));
  });

  it('sem override o piso é o navio certo, nunca mais a fragata', () => {
    const player = {
      activeShip: 'gigantic_mechanical_pirate_ship',
      talents: {}, shipIslandUpgrades: { hp: 0, defense: 0, damage: 0 },
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(SHIP_DEFS.gigantic_mechanical_pirate_ship.hp);
    expect(player.maxHp).not.toBe(SHIP_DEFS.fragata.hp);
  });
});

describe('os caminhos do servidor respeitam bonusOnly', () => {
  const SERVER_JS = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'server.js'), 'utf8',
  );

  // Com os navios no SHIP_DEFS, os handlers que fazem `SHIP_DEFS[msg.shipId]`
  // passariam a aceitá-los vindos de um pacote forjado. A flag é a barreira.
  it.each(['handleBuyNavio', 'handleBuyEliteShip', 'handleEquipNavio'])(
    '%s barra navio bonusOnly', (fnName) => {
      const i = SERVER_JS.indexOf(`function ${fnName}(`);
      expect(i, `${fnName} não encontrada`).toBeGreaterThan(-1);
      const corpo = SERVER_JS.slice(i, i + 1200);
      expect(corpo, `${fnName} aceita navio bônus por pacote forjado`)
        .toMatch(/bonusOnly/);
    });

  it('recalcMaxHp do server passa o override do navio bônus', () => {
    const i = SERVER_JS.indexOf('function recalcMaxHp(player)');
    expect(i).toBeGreaterThan(-1);
    const corpo = SERVER_JS.slice(i, i + 400);
    expect(corpo, 'recalcMaxHp ignora activeBonusShipStats — o bug de 200k→20k')
      .toMatch(/activeBonusShipStats/);
  });
});
