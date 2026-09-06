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
  'targetMode', 'burstAtCenter',
  // Invocações e perseguição. Subiram para o topo na convergência de 2026-09-05
  // e, na primeira tentativa, NÃO foram acrescentadas aos builders — as quatro
  // invocações viraram 'hunt' e a tromba parou de grudar, sem erro nenhum.
  // Foi este teste que pegou.
  'summonMode', 'spawnAtCaster', 'sticky',
  // `relicDisabled` chega ao RELIC_DEFS com outro nome (`disabled`) e ao
  // SKILLS_BY_SOURCE como ausencia — e propagada, so nao homonimamente.
  'relicDisabled',
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

    // ── As duas faces são A MESMA SKILL (2026-09-05) ───────────────────
    // Este guarda já permitiu divergência deliberada: um bloco `relic` podia
    // declarar nome/vfx/forma próprios e a skill se partia em duas — o bicho
    // fazia uma coisa, a relíquia que ele dropava fazia outra. Nove skills
    // ficaram assim, e o relato foi direto ao ponto: "matei o chefe e ele está
    // usando as relíquias antigas".
    //
    // A regra agora é a oposta, e é dura: o que o bicho MOSTRA é o que a
    // relíquia dele ENTREGA. Se uma skill precisar mesmo divergir um dia, o
    // lugar de decidir isso é aqui — uma lista de exceções explicitada e
    // justificada, não um override silencioso dentro do `relic`.
    expect(r.name,  `${key}: nome diverge entre as faces`).toBe(a.name);
    expect(r.vfx,   `${key}: vfx diverge entre as faces`).toBe(a.vfx);
    expect(r.shape, `${key}: forma diverge entre as faces`).toBe(a.shape);
    expect(r.special || null, `${key}: special diverge entre as faces`)
      .toBe(a.special || null);
    // E a identidade tem de vir do TOPO, não de um override: é o que impede a
    // divergência de voltar por descuido.
    for (const campo of ['name', 'vfx', 'shape', 'special']) {
      expect(s.relic[campo], `${key}: '${campo}' dentro de relic{} — suba para o topo`)
        .toBeUndefined();
      expect(s.npc[campo], `${key}: '${campo}' dentro de npc{} — suba para o topo`)
        .toBeUndefined();
    }
  });
});

describe('relicIds são únicos e sequenciais', () => {
  it('nenhum id repetido', () => {
    const ids = Object.values(MONSTER_SKILLS).map(s => s.relicId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
