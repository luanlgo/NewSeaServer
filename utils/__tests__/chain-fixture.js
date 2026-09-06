/**
 * Um ataque `shape: 'chain'` sintético, só para os testes.
 *
 * A cadeia ficou SEM DONO em 2026-09-05: a Descarga em Cadeia era a única skill
 * do jogo com essa forma, e ela convergiu para o Rastilho de Raios (`line`)
 * quando as duas faces do bestiário foram unificadas. A geometria continua no
 * motor — ela funciona, custou uma leva de conserto para ficar boa (o pulo
 * anunciado, o falloff, o raio de engate separado do raio de dano) e volta a
 * ser usada assim que alguma skill pedir por ela.
 *
 * O que ela perdeu foi o FIXTURE. Sem um def de verdade apontando para `chain`,
 * os três arquivos que cobrem a cadeia passariam a testar o vazio — e um motor
 * sem teste apodrece calado até alguém tentar usá-lo de novo. Este def é o
 * fixture: ele mora aqui, fora de qualquer `.test.js` (o include do vitest só
 * coleta `*.test.js`, então este arquivo não vira uma suíte vazia), e é
 * registrado no ATTACK_DEFS para o caminho real do `tryAttack` funcionar.
 *
 * Se alguma skill voltar a declarar `shape: 'chain'`, troque as referências a
 * `CHAIN_ID` pelo id dela e apague este arquivo.
 */

'use strict';

const { ATTACK_DEFS } = require('../../constants/index.js');

const CHAIN_ID = '__fixture_chain__';

// Os números são os da Descarga em Cadeia como ela era até a convergência —
// é o balanço que a leva de conserto da cadeia validou, e mudá-los aqui só
// enfraqueceria os testes que dependem deles.
ATTACK_DEFS[CHAIN_ID] = {
  id: CHAIN_ID, name: 'Cadeia (fixture de teste)', skill: CHAIN_ID,
  shape: 'chain', vfx: 'drake_bolt_trail', special: null,
  follow: false, dash: false, wallPerStep: false, rangeFromCannons: false,
  splitDamage: false, star: false, atCaster: false,
  rangeMin: 0, rangeMax: 140, count: 4, jumpRange: 90, radius: 15,
  damageMult: 2.0, falloff: 0.75, castTime: 1200, cooldown: 15000, weight: 5,
  jumpCastMs: 550,
  telegraph: { color: 0xff4400 },
};

module.exports = { CHAIN_ID, CHAIN_DEF: ATTACK_DEFS[CHAIN_ID] };
