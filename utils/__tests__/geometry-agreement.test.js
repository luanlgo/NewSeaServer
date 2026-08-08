/**
 * As DUAS implementações de geometria têm de concordar.
 *
 * O `_isHit` do attack-manager (caminho do BICHO) tem ramos próprios de
 * `circle`, `cone` e `line`; só `ring`/`multi`/`rays` delegam ao
 * `MonsterSkillManager.inShape` (caminho da RELÍQUIA). Corrigir a geometria
 * compartilhada e esquecer a duplicada já custou DUAS regressões:
 *
 *   • faixa por passo da Barragem  → o bicho seguiu batendo o corredor antigo;
 *   • setores da Salva de Bombordo → o bicho seguiu batendo o disco inteiro.
 *
 * Nos dois casos a relíquia ficou certa e o bicho errado, em silêncio. Este
 * teste varre um tabuleiro de pontos e exige a MESMA resposta das duas nas
 * skills que usam os modificadores do bestiário.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const M = require('../../managers/monster-skill-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');

/** Acesso ao _isHit sem subir um NPC de verdade. */
const am = new AttackManager(() => {}, null);

/** Skills cujo acerto depende de um modificador que mora no `inShape`. */
const COM_MODIFICADOR = Object.entries(ATTACK_DEFS)
  .filter(([, d]) => d.sectorCount || d.stepCount || d.band)
  .map(([id]) => id);

describe('cobertura', () => {
  it('há skills com modificador para conferir', () => {
    expect(COM_MODIFICADOR.length).toBeGreaterThan(2);
  });
});

describe('_isHit (bicho) concorda com inShape (relíquia)', () => {
  for (const id of COM_MODIFICADOR) {
    const def = ATTACK_DEFS[id];
    // `ring` já delegava desde sempre; o valor está em `circle` e `line`.
    if (!['circle', 'line', 'ring'].includes(def.shape)) continue;

    it(`${id} (${def.shape})`, () => {
      const alcance = (def.radius || def.length || 200) * 1.3;
      const cast = { x: 0, z: 0 };
      // Cast mirando em +X, para `line` ter direção definida.
      const tx = alcance, tz = 0;
      const dx = 1, dz = 0;

      let conferidos = 0;
      for (let k = 0; k < 3; k++) {
        const atk = { ...def, _tickIndex: k, _tickCount: 4, _gapFacing: 0 };
        for (let x = -alcance; x <= alcance; x += alcance / 8) {
          for (let z = -alcance; z <= alcance; z += alcance / 8) {
            const p = { id: 'p', x, z };
            const origem = def.shape === 'line' ? cast : { x: tx, z: tz };
            const doBicho  = am._isHit(p, atk, tx, tz, cast);
            const daReliquia = M.inShape(atk, def.shape,
              origem.x, origem.z, dx, dz, null, p);
            expect(doBicho,
              `${id} leva ${k} em (${x.toFixed(0)},${z.toFixed(0)})`)
              .toBe(daReliquia);
            conferidos++;
          }
        }
      }
      expect(conferidos).toBeGreaterThan(100);
    });
  }
});
