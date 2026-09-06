// constants/guilds.js — Guildas (irmandades de piratas)
//
// Tudo que é NÚMERO da feature mora aqui. O manager (managers/guild-manager.js)
// só executa regra; quem quiser balancear mexe neste arquivo e em mais nenhum.
//
// ── O que uma guilda é ───────────────────────────────────────────────────────
//   • um NOME e uma TAG que aparecem ao lado do pirata
//   • um COFRE próprio (ouro + dobrões) alimentado por doação e pela taxa
//   • um NÍVEL (1..25) que sobe com o XP que os membros ganham jogando
//   • SKILLS que fortalecem a PRÓPRIA guilda (nível, cofre, ilha), limitadas
//     pelo nível dela — nenhuma cola número na ficha do membro
//
// ── Por que a taxa é do bolso, e não da renda ────────────────────────────────
// A taxa cobra uma fatia do ouro que o membro TEM na mão, uma vez por dia. É o
// que o pedido descreve e é o que torna o cofre da guilda uma decisão coletiva
// de verdade: guilda com taxa alta enche rápido, mas espanta quem acumula ouro
// para comprar navio. Note que 5% ao dia é MUITO — quem senta em 10 milhões
// paga 500 mil por dia. O botão de freio é TAX_MAX_PCT.
'use strict';

/** Custo de fundar uma guilda, em ouro. */
const GUILD_CREATE_COST = 500_000;

/** Nível máximo da guilda (e teto de qualquer skill dela). */
const GUILD_MAX_LEVEL = 25;

/** Fatia do XP de cada membro que também vai para a guilda (não tira do membro). */
const GUILD_XP_SHARE = 0.10;

/**
 * Fatia do OURO DE ABATE de cada membro que também entra no cofre — mesma
 * lógica do XP, e pela mesma razão: não sai do bolso de ninguém, é dinheiro
 * criado pelo fato de o membro caçar sob a bandeira.
 *
 * ── Por que só ouro de abate ────────────────────────────────────────────────
 * Ouro entra no jogador por muitos caminhos (banco, leilão, venda de navio,
 * missão), e quase todos são MOVIMENTO de ouro que já existe. Taxar sacar do
 * banco encheria o cofre com o mesmo ouro várias vezes, e a guilda ficaria rica
 * com um membro passando dinheiro de um bolso para o outro. Abate é a única
 * fonte que CRIA ouro — é a contraparte exata do XP, que também só é criado
 * caçando. Ver GuildManager._creditGold e utils/helpers.js::noteKillGold.
 */
const GUILD_GOLD_SHARE = 0.10;

/** Taxa diária: 0% a 5%, em passos de 0,1 pontos percentuais. */
const TAX_MAX_PCT  = 0.05;
const TAX_STEP_PCT = 0.001;
/** Intervalo entre duas cobranças da mesma guilda. */
const TAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Limites de texto — o nome e a tag aparecem no mundo, então são curtos. */
const NAME_MIN = 3;
const NAME_MAX = 24;
const TAG_MIN  = 2;
const TAG_MAX  = 5;
/** Letras, números, espaço e alguns acentos. Nada de BBCode nem controle. */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} '._-]*$/u;
const TAG_RE  = /^[\p{L}\p{N}]+$/u;

/** Doação mínima de dobrões — impede encher o extrato com doação de 1. */
const DONATE_MIN_DOBROES = 1;

/**
 * Vagas na guilda por nível. Guilda recém-fundada cabe 20; no nível 25 cabe 45.
 * Não é só número: é o que faz subir de nível valer para quem já tem skills no
 * teto.
 */
function memberCap(level) {
  const lvl = Math.max(1, Math.min(GUILD_MAX_LEVEL, Math.floor(level || 1)));
  return 20 + Math.floor(lvl / 5) * 5;
}

/**
 * XP para sair do nível `level` e chegar no seguinte. Curva geométrica de 1,25
 * sobre GUILD_XP_LEVEL1: 100.000 do 1 para o 2, ~16,9 milhões do 24 para o 25,
 * ~84,3 milhões acumulados no caminho inteiro.
 *
 * ── O primeiro nível é a régua de tudo ──────────────────────────────────────
 * Subir de nível tem de ser DIFÍCIL: o nível é o que destrava skill, vaga de
 * membro e alíquota de imposto da ilha, e uma guilda que passa do 1 para o 2 na
 * primeira tarde transforma os 25 níveis numa tabela de progresso qualquer.
 * Com GUILD_XP_SHARE em 10%, 100.000 de XP de guilda são 1 milhão de XP caçado
 * pelos membros SOMADOS — semanas de uma guilda ativa para o primeiro degrau, e
 * 843 milhões para chegar ao 25. É o número que faz o nível 25 ser o fim do
 * jogo da guilda, não uma etapa.
 *
 * Mexer aqui muda a curva inteira: cada nível é este valor × 1,25^(nível−1).
 */
const GUILD_XP_LEVEL1 = 100_000;

function xpToNextLevel(level) {
  const lvl = Math.max(1, Math.floor(level || 1));
  if (lvl >= GUILD_MAX_LEVEL) return Infinity;
  return Math.floor(GUILD_XP_LEVEL1 * Math.pow(1.25, lvl - 1));
}

/**
 * As skills da guilda — TODAS voltadas para a IRMANDADE, nenhuma para o bolso
 * do membro.
 *
 * ── A virada de 2026-09-06 ──────────────────────────────────────────
 * Quatro das sete davam poder direto ao jogador: +% de ouro, de dobrão, de XP e
 * de vida máxima, para todo membro, online ou não. Elas transformavam a guilda
 * numa árvore de talentos paralela — entrar numa guilda grande valia mais que
 * qualquer decisão de build, e quem jogava sozinho ficava para trás por um
 * motivo que não tinha nada a ver com jogar.
 *
 * Agora o eixo é outro: a guilda investe no cofre para a PRÓPRIA guilda crescer
 * — subir de nível mais rápido, encher o cofre mais rápido, segurar a ilha. O
 * membro ganha por tabela (ilha defendida, cofre cheio, nível alto destrava
 * vaga e alíquota), nunca por um número colado na ficha dele.
 *
 * As duas primeiras são a espinha: elas mexem na FATIA do que o membro produz
 * que também vai para a irmandade. Note que a fatia NÃO sai do bolso de ninguém
 * (ver GUILD_XP_SHARE / GUILD_GOLD_SHARE) — subir essas skills não cobra nada
 * do membro, só faz a caçada dele render mais para a bandeira.
 *
 * `stat` é a chave que o resto do servidor lê (ver GuildManager.bonusFor), e
 * TODAS têm hoje quem as leia:
 *   guild_xp_pct / guild_gold_pct   _creditXp / _creditGold  (guild-manager)
 *   tower_hp_pct / tower_dmg_pct    handleBuild              (island-manager)
 *   tower_repair_pct                _sweepRepair             (island-manager)
 *   tax_boat_pct                    _zarpar                  (tax-boat-manager)
 *
 * As de ilha (`island: true`) só produzem efeito enquanto a guilda DOMINA uma
 * ilha — o painel avisa isso no cartão. Não confundir com "não implementada":
 * skill que existe no dado e não tem quem a leia no motor é o tipo de coisa que
 * some sem dar erro nenhum, e nenhuma destas está nessa situação.
 *
 * Custos: `costGold`/`costDobroes` são o preço para comprar o nível N (1 = o
 * primeiro). Linear no nível.
 */
const GUILD_SKILLS = [
  {
    // O caçador continua ganhando o XP dele inteiro; o que cresce é a cópia
    // que a guilda recebe por ele ter caçado sob a bandeira. É a skill que
    // encurta a subida de nível, e nível é o que destrava tudo o mais.
    id: 'guild_xp_pct', icon: '✨', name: 'Crônica da Irmandade',
    desc: 'XP que a GUILDA ganha com os abates dos membros.',
    stat: 'guild_xp_pct',   pctPerLevel: 0.10,
    costGold: 200_000, costDobroes: 50,
  },
  {
    id: 'guild_gold_pct', icon: '🪙', name: 'Quinhão do Cofre',
    desc: 'Ouro que o COFRE ganha com os abates dos membros.',
    stat: 'guild_gold_pct', pctPerLevel: 0.10,
    costGold: 200_000, costDobroes: 50,
  },
  {
    id: 'tower_hp_pct', icon: '🗼', name: 'Muralha da Ilha',
    desc: 'Vida das torres da ilha da guilda.',
    stat: 'tower_hp_pct', pctPerLevel: 0.10,
    costGold: 150_000, costDobroes: 30,
    island: true,
  },
  {
    id: 'tower_dmg_pct', icon: '🎯', name: 'Artilharia da Ilha',
    desc: 'Dano das torres da ilha da guilda.',
    stat: 'tower_dmg_pct', pctPerLevel: 0.05,
    costGold: 150_000, costDobroes: 30,
    island: true,
  },
  {
    // Reparo mais rápido é o contrapeso do cerco: sem ele, uma ilha castigada
    // durante a noite passa o dia seguinte inteiro voltando ao normal. O ouro
    // do conserto continua saindo do cofre — a skill acelera, não barateia.
    id: 'tower_repair_pct', icon: '🔨', name: 'Estaleiro da Ilha',
    desc: 'Velocidade do conserto das torres.',
    stat: 'tower_repair_pct', pctPerLevel: 0.10,
    costGold: 120_000, costDobroes: 25,
    island: true,
  },
  {
    // O bônus do barco da coleta é da GUILDA, e não do jogador, porque é a
    // guilda que arrecada e é a guilda que perde se o barco afundar. Note que
    // ele engorda o valor que ZARPA: se o barco for afundado, quem lucra com o
    // investimento é quem o afundou. É um risco que a dona da ilha assume.
    id: 'tax_boat_pct', icon: '⛵', name: 'Barco de Coleta',
    desc: 'Imposto que o barco da coleta leva da praça.',
    stat: 'tax_boat_pct', pctPerLevel: 0.10,
    costGold: 250_000, costDobroes: 60,
    island: true,
  },
];

/**
 * As que SAÍRAM — e o que elas custavam.
 *
 * Guildas já gastaram cofre nelas, e apagar a linha do dado apagaria o
 * investimento junto: o nível salvo viraria uma chave que `bonusFor` ignora, em
 * silêncio, para sempre. A tabela existe para o GuildManager devolver ao cofre,
 * no boot, tudo o que foi pago — uma vez, e aí a chave some do `skills`.
 *
 * Os custos têm de ser os que estavam em vigor quando foram compradas; por isso
 * são cópias congeladas, e não referências ao catálogo vivo.
 */
const RETIRED_GUILD_SKILLS = {
  gold_pct:      { name: 'Butim Farto',         costGold: 200_000, costDobroes: 50 },
  dobrao_pct:    { name: 'Cofre Pirata',        costGold: 250_000, costDobroes: 80 },
  xp_pct:        { name: 'Sabedoria dos Mares', costGold: 200_000, costDobroes: 50 },
  member_hp_pct: { name: 'Casco da Irmandade',  costGold: 300_000, costDobroes: 100 },
};

/** O que devolver ao cofre por uma skill aposentada que está no nível `lvl`. */
function retiredRefund(id, lvl) {
  const def = RETIRED_GUILD_SKILLS[id];
  const n = Math.max(0, Math.floor(Number(lvl) || 0));
  if (!def || n <= 0) return null;
  // O preço é linear no nível (nível k custou base × k), então o total pago até
  // o nível n é base × n(n+1)/2.
  const soma = (n * (n + 1)) / 2;
  return { name: def.name, level: n,
           gold: def.costGold * soma, dobroes: def.costDobroes * soma };
}

/** Índice por id — o manager valida `skillId` por aqui. */
const GUILD_SKILL_BY_ID = Object.fromEntries(GUILD_SKILLS.map(s => [s.id, s]));

/** Preço para subir a skill `id` do nível atual para o seguinte. */
function skillUpCost(id, currentLevel) {
  const def = GUILD_SKILL_BY_ID[id];
  if (!def) return null;
  const next = Math.floor(currentLevel || 0) + 1;
  if (next > GUILD_MAX_LEVEL) return null;
  return {
    level:   next,
    gold:    def.costGold    * next,
    dobroes: def.costDobroes * next,
  };
}

module.exports = {
  GUILD_CREATE_COST,
  GUILD_MAX_LEVEL,
  GUILD_XP_SHARE,
  GUILD_GOLD_SHARE,
  GUILD_XP_LEVEL1,
  TAX_MAX_PCT,
  TAX_STEP_PCT,
  TAX_INTERVAL_MS,
  NAME_MIN, NAME_MAX, TAG_MIN, TAG_MAX, NAME_RE, TAG_RE,
  DONATE_MIN_DOBROES,
  GUILD_SKILLS,
  GUILD_SKILL_BY_ID,
  RETIRED_GUILD_SKILLS,
  retiredRefund,
  memberCap,
  xpToNextLevel,
  skillUpCost,
};
