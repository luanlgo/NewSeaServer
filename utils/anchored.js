// utils/anchored.js
//
// O que está CRAVADO no mundo e não pode ser deslocado por skill nenhuma.
//
// Relato de 2026-09-06: "as torres do mapa estão podendo ser arrastadas pela
// Muralha de Maré — foi um exemplo, mas tem outras relíquias que empurram".
// São oito, e por três caminhos diferentes:
//
//   cc.pushDist / cc.pullTo   r23, r27, r31, r50, r54   → _applyCC
//   anel que aperta           r25, r47                  → _castCollapsingRing
//   engolir                   r48                       → _castSwallow
//
// O empurrão é aplicado escrevendo `e.x`/`e.z` direto. Num barco isso é um
// tranco e a vida segue — ele navega de volta. Numa TORRE não existe "de
// volta": a posição dela é o slot (`towerSlotPos`), ela não tem locomoção, e o
// `snapshotFor` manda `t.x/t.z` para o cliente. Empurrada uma vez, ela fica no
// lugar novo até morrer e renascer — dá para arrastar a torre para longe da
// ilha e cercá-la fora do alcance de quem defende.
//
// ── Por que um módulo, e não um `if (e.isTower)` em cada sítio ──────────────
// Mesma razão de utils/invincibility.js, utils/shield.js e utils/allies.js: são
// três sítios hoje, e a próxima relíquia que empurrar vai nascer sem lembrar de
// nenhum deles. Com o predicado num lugar só, a pergunta certa ("isso pode ser
// movido?") fica fácil de achar e a resposta não diverge.
//
// ── Quem NÃO entra ──────────────────────────────────────────────────────────
// • Chefe — já é barrado antes, por outra regra (`!e.isBoss`, a convenção de
//   que chefe só leva slow). São coisas diferentes: chefe não é deslocado por
//   equilíbrio, torre não é deslocada porque não faz sentido físico.
// • Nau do imposto (`isTaxBoat`) e barco de missão — navegam. Um empurrão os
//   tira da rota por um instante e o próprio movimento corrige.
// • A torre de treino do mapa 5: ela não é entidade do pool de NPC (mora em
//   `MAP_DEFS[5].training`), então nenhuma skill a alcança.

'use strict';

/**
 * Esta entidade está cravada no mundo?
 *
 * @param {Object} e entidade do pool (jogador, NPC, torre…)
 * @returns {boolean} true = nenhum empurrão, puxão ou teleporte de skill a move
 */
function isAnchored(e) {
  return !!(e && e.isTower);
}

module.exports = { isAnchored };
