// utils/invincibility.js
// As janelas em que NADA te machuca: a Névoa Espectral (r2) e o período seguro
// de quem acabou de renascer.
//
// ── Duas tentativas, e por que esta é a certa ───────────────────────────────
// A relíquia nasceu com 5 s de imunidade e isso era resposta boa demais para
// qualquer coisa: apagava a fase inteira de um chefe, e no PvP bastava apertar
// para vencer a troca. A correção foi trocar tempo por CARGA — a bolha aparava
// UM golpe e sumia — e essa correção trocou um problema por outro pior: contra
// uma salva de canhão a carga morria no primeiro projétil da rajada e os outros
// cinco entravam inteiros. Na prática a relíquia deixou de fazer alguma coisa,
// e o pior é que o jogador não tinha como perceber POR QUÊ: a bolha aparecia,
// piscava, e a vida caía do mesmo jeito.
//
// Hoje ela é de novo uma JANELA DE TEMPO, mas curta (2 s, em RELIC_DEFS.r2).
// Dois segundos não apagam fase de chefe — que era a queixa dos cinco — e
// atravessam uma salva inteira, que é a única coisa que a relíquia sempre
// prometeu. E o número mora num lugar só: para rebalancear, mexa no `duration`
// da r2 em constants/relics.js.
//
// ── Uma função e um campo, ainda assim num módulo ───────────────────────────
// A bolha é lida em SEIS lugares (projétil, ataque em área, cast de chefe, a
// presa da Bocarra, as skills do bestiário e os dois tiques de dano contínuo),
// cada um num manager diferente. Enquanto a checagem estava copiada em todos,
// alguém acrescentava um caminho de dano novo e ele nascia sem escudo nenhum —
// foi exatamente o que aconteceu com o motor do bestiário.
//
// ── O que a bolha NÃO barra ─────────────────────────────────────────────────
// Nada: durante os 2 s ela barra tudo, DoT inclusive (ver processDots no
// server.js). Quando o prazo vence, o laço do servidor anuncia
// `relic_effect_end` e o desenho se apaga sozinho.
'use strict';

/** A bolha está de pé? */
function isInvincible(e, now = Date.now()) {
  return !!(e && e.relicInvincibleExpires && now < e.relicInvincibleExpires);
}

/**
 * O jogador está no período seguro pós-renascimento?
 *
 * ── Por que isto veio morar aqui ────────────────────────────────────────────
 * Pela MESMA razão do `isInvincible`, e com o mesmo final: a checagem
 * `p.safeUntil && now < p.safeUntil` estava copiada em doze lugares (tiro,
 * ataque de bicho, torre, aggro de NPC…) e o motor genérico do bestiário —
 * que hoje roda as 34 skills E as 34 relíquias feitas a partir delas — nasceu
 * sem nenhuma delas. Resultado: durante os 30 s de trégua, canhão não te
 * acertava mas QUALQUER relíquia acertava.
 *
 * O playtest achou pelo caminho mais desagradável: morrer para a Bocarra
 * Torácica, apertar reviver e morrer de novo na mesma mordida.
 */
function isSafeAfterRespawn(e, now = Date.now()) {
  return !!(e && e.safeUntil && now < e.safeUntil);
}

/** Qualquer uma das duas janelas — é o que todo caminho de dano deve perguntar. */
function isUntouchable(e, now = Date.now()) {
  return isInvincible(e, now) || isSafeAfterRespawn(e, now);
}

module.exports = { isInvincible, isSafeAfterRespawn, isUntouchable };
