/**
 * O que o bicho DROPA tem de ser o que ele USA.
 *
 * A promessa da tabela é "o ataque que te matou é a relíquia que cai". O pool
 * de drop vinha do nome do MODELO, e isso desalinhou o Verme: ele lutava com o
 * conjunto do mob (`wyrm_*`) mas o modelo é `wrim_boss.glb`, então largava as
 * relíquias de BOSS (`wyrm_boss_*`). E as do mob ficaram indroppáveis — nenhum
 * NPC no jogo usa o modelo `wrim.glb`.
 *
 * Agora o pool sai dos ATAQUES do bicho.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// O projectile-manager puxa o db-manager no topo (tenta conectar ao subir).
const dbPath = require.resolve('../../managers/db-manager.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { save: () => {} },
};

const { MONSTER_SKILLS, SKILLS_BY_SOURCE } = require('../../constants/monster_skills');
const { MAP_DEFS } = require('../../constants/index.js');

/** relicId de cada ataque do bestiário. */
const relicDe = (a) => MONSTER_SKILLS[a] && MONSTER_SKILLS[a].relicId;

/**
 * Todo bicho de mapa que usa ataques do bestiário — NPCs comuns E bosses.
 * Os bosses moram num bloco à parte (`boss:`), e esquecê-los faz metade do
 * bestiário parecer órfã.
 */
const BICHOS = [];
for (const [lvl, m] of Object.entries(MAP_DEFS)) {
  for (const [tipo, def] of [['npc', m.npc], ['boss', m.boss]]) {
    if (!def || !Array.isArray(def.attacks)) continue;
    if (!def.attacks.some(a => MONSTER_SKILLS[a])) continue;
    BICHOS.push({ lvl: `${lvl}/${tipo}`, npc: def });
  }
}

describe('cobertura', () => {
  it('há bichos de bestiário nos mapas', () => {
    expect(BICHOS.length).toBeGreaterThan(0);
  });
});

describe('o pool de drop é o repertório do bicho', () => {
  for (const { lvl, npc } of BICHOS) {
    it(`mapa ${lvl} (${npc.names}) solta o que usa`, () => {
      const doAtaque = npc.attacks.map(relicDe).filter(Boolean).sort();
      expect(doAtaque.length, 'nenhum ataque de bestiário reconhecido')
        .toBeGreaterThan(0);

      // O que o modelo diria — o critério ANTIGO.
      const stem = String(npc.model || '').split('/').pop().replace(/\.glb$/i, '');
      const doModelo = (SKILLS_BY_SOURCE[stem] || []).slice().sort();

      // Não precisam ser iguais (o Verme usa os dois conjuntos), mas tudo o que
      // o modelo prometia tem de estar no repertório — senão sobra relíquia
      // que ninguém larga.
      for (const rid of doModelo) {
        expect(doAtaque, `${rid} vinha do modelo mas o bicho não usa`)
          .toContain(rid);
      }
    });
  }
});

describe('nenhuma relíquia do bestiário fica órfã', () => {
  it('todo relicId de bicho é largado por ALGUM bicho', () => {
    const largados = new Set();
    for (const { npc } of BICHOS) {
      for (const a of npc.attacks) {
        const rid = relicDe(a);
        if (rid) largados.add(rid);
      }
    }
    const orfas = Object.values(MONSTER_SKILLS)
      .map(s => s.relicId)
      .filter(rid => !largados.has(rid));
    expect(orfas, `relíquias que ninguém larga: ${orfas.join(', ')}`)
      .toHaveLength(0);
  });
});

describe('o Verme usa os dois conjuntos', () => {
  const verme = BICHOS.find(b => String(b.npc.model || '').includes('wrim'));

  it('existe e usa o modelo de boss', () => {
    expect(verme, 'não achei o Verme nos mapas').toBeTruthy();
    expect(verme.npc.model).toContain('wrim_boss');
  });

  it('tem os 8 ataques (mob + boss)', () => {
    const doMob  = SKILLS_BY_SOURCE.wrim;
    const doBoss = SKILLS_BY_SOURCE.wrim_boss;
    const dele   = verme.npc.attacks.map(relicDe);
    for (const rid of [...doMob, ...doBoss]) {
      expect(dele, `${rid} fora do repertório`).toContain(rid);
    }
  });
});
