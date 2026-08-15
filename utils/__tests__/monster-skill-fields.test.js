/**
 * Campo no topo que ninguém copia SOME EM SILÊNCIO.
 *
 * O builder no fim de monster_skills.js copia uma lista FIXA de campos do topo
 * da skill para o RELIC_DEFS e o ATTACK_DEFS, e depois espalha `...s.relic` /
 * `...s.npc`. Um modificador escrito no lugar errado — `cc` no topo em vez de
 * dentro de `relic`/`npc`, por exemplo — não dá erro nenhum: ele simplesmente
 * não chega aos motores, e a skill roda sem o slow/stun/empurrão que o dado
 * dizia ter. O próprio arquivo já avisa disso no comentário do `expandMs`.
 *
 * Este teste é o guarda: qualquer chave nova no topo de uma skill tem de estar
 * na lista de copiadas, senão o autor é avisado na hora em vez de descobrir em
 * playtest que a skill "não aplica o efeito".
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { MONSTER_SKILLS, MONSTER_RELIC_DEFS, MONSTER_ATTACK_DEFS } =
  require('../../constants/monster_skills');

/** Chaves do topo que o builder REALMENTE propaga (ver o laço no fim do arquivo). */
const COPIADAS_DO_TOPO = new Set([
  'relicId', 'name', 'icon', 'rarity', 'star', 'vfx', 'source', 'shape', 'special',
  'follow', 'dash', 'wallPerStep', 'rangeFromCannons', 'pattern', 'gapAngle',
  'expandMs', 'atCaster', 'travelMs', 'dropIntervalMs', 'dropWarnMs', 'turnRate',
  'targetMode',
  // puramente editoriais: existem para quem lê a tabela, não para os motores
  'desc',
  // os dois lados
  'relic', 'npc',
]);

/** Modificadores que só valem POR LADO — no topo não chegam a lugar nenhum. */
const SO_POR_LADO = ['cc', 'ticks', 'growth', 'spinSpeed', 'drainHealPct',
                     'damagePct', 'damageMult', 'radius', 'length', 'width',
                     'angle', 'count', 'spread', 'safeRadius', 'band'];

describe('nenhuma skill escreve campo no topo que o builder ignora', () => {
  it.each(Object.keys(MONSTER_SKILLS))('%s', (key) => {
    const s = MONSTER_SKILLS[key];
    const perdidas = Object.keys(s).filter(k => !COPIADAS_DO_TOPO.has(k));
    expect(perdidas, `${key}: chave(s) no topo que ninguém copia — mova para dentro de relic/npc `
      + `ou acrescente ao builder: ${perdidas.join(', ')}`).toEqual([]);
  });
});

describe('os modificadores por lado ficam onde os motores leem', () => {
  it.each(Object.keys(MONSTER_SKILLS))('%s', (key) => {
    const s = MONSTER_SKILLS[key];
    for (const campo of SO_POR_LADO) {
      expect(s[campo], `${key}: '${campo}' no TOPO não chega aos motores`).toBeUndefined();
    }
  });
});

describe('toda skill chega inteira nas duas visões', () => {
  it.each(Object.keys(MONSTER_SKILLS))('%s', (key) => {
    const s = MONSTER_SKILLS[key];
    const r = MONSTER_RELIC_DEFS[s.relicId];
    const a = MONSTER_ATTACK_DEFS[key];
    expect(r, 'sem entrada de relíquia').toBeDefined();
    expect(a, 'sem entrada de ataque').toBeDefined();

    // O `cc` declarado num lado tem de sobreviver até o def daquele lado.
    if (s.relic.cc) expect(r.cc, `${key}: cc da relíquia sumiu`).toEqual(s.relic.cc);
    if (s.npc.cc)   expect(a.cc, `${key}: cc do bicho sumiu`).toEqual(s.npc.cc);

    // Forma e VFX são a promessa da tabela: as duas faces desenham o mesmo.
    expect(r.shape).toBe(a.shape);
    expect(r.vfx).toBe(a.vfx);
  });
});

describe('relicIds são únicos e sequenciais', () => {
  it('nenhum id repetido', () => {
    const ids = Object.values(MONSTER_SKILLS).map(s => s.relicId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
