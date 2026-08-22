// utils/invincibility.js
// Névoa Espectral (r2) — o escudo que some no primeiro golpe que apara.
//
// ── Por que um módulo para dois campos ───────────────────────────────────────
// A invencibilidade é lida em SEIS lugares (projétil, ataque em área, cast de
// chefe, a presa da Bocarra e os dois tiques de dano contínuo) e cada um vive
// num manager diferente. Enquanto ela era só uma janela de tempo, repetir
// `p.relicInvincibleExpires && now < p.relicInvincibleExpires` em todos era
// inofensivo. Agora que ela se GASTA, "consumir" precisa querer dizer a mesma
// coisa nos três caminhos que aparam dano — senão a bolha morre num deles e
// sobrevive nos outros.
//
// ── Por que expirar em vez de zerar ──────────────────────────────────────────
// O laço do servidor já anuncia o fim da bolha quando ela vence
// (`relic_effect_end`, em server.js). Zerar o campo aqui pularia esse anúncio e
// deixaria o desenho da bolha aceso no cliente para sempre. Empurrando o prazo
// para o passado, o MESMO caminho que já existia percebe e avisa — um lugar só
// decide quando a bolha some da tela.
//
// ── O que NÃO gasta a carga ──────────────────────────────────────────────────
// Dano contínuo (veneno, fogo). Um DoT já foi pago por quem o aplicou e tica
// sozinho a cada segundo: se ele consumisse a carga, usar a Névoa queimando
// valeria nada, e a relíquia deixaria de ser a resposta ao golpe grande que
// vem vindo — que é a única coisa que ela vende. Enquanto a bolha estiver de
// pé o DoT continua sendo barrado; ele só não a apaga.
'use strict';

/** A bolha está de pé? */
function isInvincible(e, now = Date.now()) {
  return !!(e && e.relicInvincibleExpires && now < e.relicInvincibleExpires);
}

/**
 * Gasta a carga: a bolha aparou um golpe e acabou aqui.
 * Chame SÓ onde o dano foi realmente barrado.
 */
function consumeInvincible(e, now = Date.now()) {
  if (!e || !e.relicInvincibleExpires) return;
  // Passado por 1 ms: `now < expires` já dá falso e o laço de expiração do
  // server.js (`now >= expires`) dispara no próximo tique com o aviso.
  e.relicInvincibleExpires = now - 1;
}

module.exports = { isInvincible, consumeInvincible };
