/**
 * Torres cravadas e chefes que pagam XP — relato de playtest de 2026-09-06.
 *
 *   "as torres do mapa estão podendo ser arrastadas pela Muralha de Maré, foi
 *    um exemplo mas tem outras relíquias que empurram"
 *   "todos os bosses têm que dar XP"
 *
 * Os dois defeitos têm a mesma cara: nada dá erro, o jogo só faz a coisa
 * errada em silêncio. A torre sai do lugar e fica lá; o chefe morre e paga
 * zero. Por isso os dois viraram guarda de tabela, não teste de um caso.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { isAnchored }   = require('../anchored.js');
const { MAP_DEFS }     = require('../../constants/maps.js');
const { MONSTER_SKILLS } = require('../../constants/monster_skills.js');
const { TOWER_TYPES, TOWER_PROD } = require('../../constants/islands.js');

// ═══════════════════════════════════════════════════════════════════════════
describe('torre não sai do lugar', () => {
  const torre  = { id: 't1', isNPC: true, isTower: true, x: 100, z: 0 };
  const barco  = { id: 'p1', x: 100, z: 0 };
  const chefe  = { id: 'b1', isNPC: true, isBoss: true, x: 100, z: 0 };

  it('a torre é reconhecida como cravada; barco e chefe não', () => {
    expect(isAnchored(torre)).toBe(true);
    // Chefe também não é deslocado, mas por OUTRA regra (`!e.isBoss`, a
    // convenção de que chefe só leva slow). Misturar as duas faria o dia em que
    // uma delas mudar arrastar a outra junto.
    expect(isAnchored(chefe)).toBe(false);
    expect(isAnchored(barco)).toBe(false);
    expect(isAnchored(null)).toBe(false);
    expect(isAnchored({})).toBe(false);
  });

  it('todas as skills que DESLOCAM passam por um caminho guardado', () => {
    // O relato citou a Muralha de Maré, mas são oito, por três caminhos. Se
    // aparecer uma nona forma de deslocar, ela cai aqui como desconhecida em
    // vez de descobrir sozinha que a torre anda.
    const CAMINHOS = {
      cc:       '_applyCC',
      collapse: '_castCollapsingRing',
      swallow:  '_castSwallow',
    };
    const achadas = [];
    for (const [, s] of Object.entries(MONSTER_SKILLS)) {
      const cc = (s.relic && s.relic.cc) || {};
      let via = null;
      if (cc.pushDist || cc.pullTo != null) via = CAMINHOS.cc;
      if (s.special === 'collapse') via = CAMINHOS.collapse;
      if (s.special === 'swallow')  via = CAMINHOS.swallow;
      if (via) achadas.push({ id: s.relicId, nome: s.name, via });
    }

    expect(achadas.length, 'mudou o conjunto de skills que empurram')
      .toBe(8);
    // A do relato, nomeada: ela é o caso que o Luang viu acontecer.
    expect(achadas.find(a => a.id === 'r31'), 'a Muralha de Maré saiu da lista')
      .toMatchObject({ via: '_applyCC' });

    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'managers', 'monster-skill-manager.js'), 'utf8');
    expect(src).toContain("require('../utils/anchored')");
    // Um guard por caminho — três ao todo.
    expect((src.match(/isAnchored\(/g) || []).length,
      'algum caminho de deslocamento ficou sem o guard de torre')
      .toBeGreaterThanOrEqual(4);   // 1 require + 3 usos
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('todo chefe paga XP', () => {
  // Sem `xpPerKill` o _rollPot do boss-manager devolve bossXp 0, e o
  // `xpShare` de cada agressor sai zerado. Não é "pouco XP": é NENHUM, sem
  // erro e sem aviso. Dois chefes viveram assim — a Viúva (mapa 6) e o Mímico
  // (mapa 10), justamente os dois mais longos do jogo.
  const chefes = Object.entries(MAP_DEFS)
    .filter(([, d]) => d.boss)
    .map(([lvl, d]) => [Number(lvl), d.boss]);

  it('há chefe para conferir', () => {
    expect(chefes.length).toBeGreaterThanOrEqual(5);
  });

  for (const [lvl, boss] of chefes) {
    it(`mapa ${lvl} — ${boss.name}`, () => {
      expect(boss.xpPerKill, `${boss.name} não paga XP nenhum`).toBeGreaterThan(0);
    });
  }

  it('o XP acompanha o dobrão do próprio chefe', () => {
    // A régua NÃO é o número do mapa: o mapa 6 é a última etapa regular e paga
    // mais que o 10, que é ilha, e isso já valia para o dobrão antes deste
    // teste existir. O que amarra os dois é a razão XP/dobrão, que os chefes
    // dos mapas 2, 3, 6 e 10 mantêm em 0,67 (o do mapa 1 é o tutorial e paga
    // relativamente mais). A banda é larga de propósito: ela não existe para
    // travar balanceamento, e sim para pegar zero esquecido e erro de casa
    // decimal — as duas formas pelas quais os dois buracos nasceram.
    for (const [lvl, boss] of chefes) {
      if (!boss.dobraoMin) continue;
      const razao = boss.xpPerKill / boss.dobraoMin;
      expect(razao, `mapa ${lvl} (${boss.name}): ${boss.xpPerKill} de XP para `
                  + `${boss.dobraoMin} de dobrão está fora da escala do jogo`)
        .toBeGreaterThan(0.4);
      expect(razao).toBeLessThan(2.0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('escala das torres', () => {
  // TOWER_PROD é a cópia deliberada contra a qual TOWER_TYPES é conferida —
  // é ela que faz uma escala de playtest gritar antes de subir. Ver islands.js.
  it('as duas tabelas concordam', () => {
    for (const [id, prod] of Object.entries(TOWER_PROD)) {
      expect(TOWER_TYPES[id].hp,     `hp da torre ${id}`).toBe(prod.hp);
      expect(TOWER_TYPES[id].damage, `dano da torre ${id}`).toBe(prod.damage);
    }
  });

  it('a escala de 2026-09-06 está aplicada: vida ×2, dano ×3', () => {
    expect(TOWER_TYPES.fraca).toMatchObject({ hp:  2_000_000, damage:  90_000 });
    expect(TOWER_TYPES.media).toMatchObject({ hp: 40_000_000, damage: 150_000 });
    expect(TOWER_TYPES.forte).toMatchObject({ hp: 80_000_000, damage: 150_000 });
  });

  it('torre mais cara nunca é mais fraca', () => {
    const ordem = ['fraca', 'media', 'forte'];
    for (let i = 1; i < ordem.length; i++) {
      expect(TOWER_TYPES[ordem[i]].hp)
        .toBeGreaterThanOrEqual(TOWER_TYPES[ordem[i - 1]].hp);
      expect(TOWER_TYPES[ordem[i]].damage)
        .toBeGreaterThanOrEqual(TOWER_TYPES[ordem[i - 1]].damage);
    }
  });
});
