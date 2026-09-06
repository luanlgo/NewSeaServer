/**
 * O chefe mundial — o único evento de SERVIDOR do jogo.
 *
 * Ele veio da versão de navegador e atravessou a migração sem nunca ser
 * revisado. A revisão de 2026-09-06 achou três coisas, e cada `it` aqui é uma
 * delas virada de cabeça para baixo:
 *
 *   1. os números eram os de 2025: 25.000 de vida, quando a Viúva Afogada tem
 *      10.000.000 e um NPC do Mar dos Renegados tem 3.000.000. O "DEUS DO MAR"
 *      morria mais rápido que o bicho comum do mapa 4;
 *   2. `mapLevel: [1, 2]` — ele só nascia nos dois mapas iniciais, batendo
 *      42.000 onde o barco do jogador tem 1.000 de vida, e longe de qualquer
 *      um com nível para enfrentá-lo;
 *   3. o cliente Godot não tratava NENHUMA das cinco mensagens dele. O anúncio
 *      É a feature: sem ele, "mundial" não quer dizer nada.
 *
 * O (3) é guardado do lado do cliente (tests/test_main_configs.gd); aqui moram
 * o (1) e o (2), que são dado.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { WORLD_BOSS_DEF, MAP_DEFS, ATTACK_DEFS } = require('../../constants');

const DEF = WORLD_BOSS_DEF[0];

describe('o chefe mundial existe e está inteiro', () => {
  it('todos os ataques dele existem no catálogo', () => {
    // Ataque que não existe não dá erro: o bicho sorteia, não acha, e fica
    // parado. Num chefe que aparece uma vez por evento, isso passaria meses.
    for (const id of DEF.attacks || []) {
      expect(ATTACK_DEFS[id], `ataque '${id}' não existe`).toBeDefined();
    }
    expect((DEF.attacks || []).length).toBeGreaterThan(0);
  });

  it('o modelo e a recompensa estão declarados', () => {
    expect(DEF.model).toMatch(/\.glb$/);
    expect(DEF.dobraoMin).toBeGreaterThan(0);
    expect(DEF.dobraoMax).toBeGreaterThanOrEqual(DEF.dobraoMin);
    expect(DEF.xpPerKill).toBeGreaterThan(0);
  });
});

describe('ele nasce onde alguém pode enfrentá-lo', () => {
  it('todo mapa da lista existe', () => {
    for (const lvl of DEF.mapLevel) {
      expect(MAP_DEFS[lvl], `mapa ${lvl} não existe`).toBeDefined();
    }
  });

  it('nenhum mapa inicial — ele bate mais que a vida de um barco novo', () => {
    // O `cannon_shot` dele tem damageMult 3: são 42.000 por tiro no PISO da
    // dificuldade. O barco do mapa 1 não chega perto disso.
    for (const lvl of DEF.mapLevel) {
      expect(MAP_DEFS[lvl].xpRequired,
        `mapa ${lvl} é inicial demais para um chefe que bate ${DEF.baseDamage * 3}`)
        .toBeGreaterThan(0);
    }
  });

  it('nenhum mapa de PvP — evento de servidor não pode virar emboscada', () => {
    for (const lvl of DEF.mapLevel) {
      expect(MAP_DEFS[lvl].pvpZone, `mapa ${lvl} é zona ${MAP_DEFS[lvl].pvpZone}`)
        .not.toBe('red');
    }
  });

  it('nenhum é masmorra bônus — lá dentro só entra quem tem a chave', () => {
    for (const lvl of DEF.mapLevel) {
      expect(MAP_DEFS[lvl].isBonusMap, `mapa ${lvl} é masmorra`).toBeFalsy();
    }
  });
});

describe('os números acompanham o jogo, não a versão de navegador', () => {
  // A âncora é a Viúva Afogada (chefe do mapa 6), que é hoje o alvo mais duro
  // com vida fixa. O chefe mundial tem de estar na mesma ORDEM DE GRANDEZA —
  // não precisa ser maior (ele tem prazo para morrer, ela não), mas ficar três
  // zeros abaixo é o bug que esta suíte existe para pegar.
  const VIUVA = MAP_DEFS[6].boss;

  it('a vida está na faixa do chefe de mapa mais duro', () => {
    // Teto afrouxado de ×2 para ×5 em 2026-09-06, à tarde: a Viúva caiu de 10 M
    // para 2 M (pedido do Luang) e o chefe mundial ficou nos 8 M da manhã, ou
    // seja ×4 dela. Não é o número que está errado — é a banda: o parágrafo
    // acima diz "mesma ORDEM DE GRANDEZA", e ×4 é a mesma ordem. Apertar em ×2
    // faria este guarda cobrar uma proporção que ninguém decidiu.
    //
    // ⚠️ Fica REGISTRADO que a proporção mudou: o chefe mundial passou a ser
    // 4× a Viúva, onde de manhã era 0,8×. Se o playtest disser que ele ficou
    // longo demais, é o `baseHp` dele em exploration.js que desce — não esta
    // banda, que só existe para pegar erro de casa decimal.
    expect(DEF.baseHp).toBeGreaterThan(VIUVA.baseHp / 4);
    expect(DEF.baseHp).toBeLessThanOrEqual(VIUVA.baseHp * 5);
  });

  it('o dano está na faixa do chefe de mapa mais duro', () => {
    expect(DEF.baseDamage).toBeGreaterThan(VIUVA.baseDamage / 2);
    expect(DEF.baseDamage).toBeLessThanOrEqual(VIUVA.baseDamage * 3);
  });

  it('a regeneração é um freio, não uma corrida de DPS mínimo', () => {
    // Acima de ~1% da vida por segundo, um grupo que não some certo dano nunca
    // termina — e o jogador não tem como saber por quê.
    const pctPorSeg = DEF.regenPerSec / DEF.baseHp;
    expect(pctPorSeg).toBeLessThan(0.01);
    expect(pctPorSeg).toBeGreaterThan(0);
  });

  it('a janela dá tempo de atravessar o mapa E lutar', () => {
    // 10 min era o valor de quando ele nascia no mapa 1 (7.200 de lado, ~45
    // un/s ⇒ ~2,5 min só de travessia) com 25.000 de vida. Com 8 milhões, a
    // janela tem de caber a viagem mais a briga.
    expect(DEF.expireDelay).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });

  it('a recompensa vale mais que um NPC comum de fim de jogo', () => {
    // O espólio é dividido por dano entre todos, então o número cheio é o piso
    // de "valeu largar o que eu estava fazendo". Um NPC do mapa 11 larga
    // 10.000–25.000 dobrões sozinho.
    const npc11 = MAP_DEFS[11].npc;
    expect(DEF.dobraoMax).toBeGreaterThanOrEqual(npc11.dobraoMin / 2);
    expect(DEF.xpPerKill).toBeGreaterThan(npc11.xpPerKill * 10);
  });
});
