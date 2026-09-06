// managers/tax-boat-manager.js — O barco da coleta semanal
//
// Uma vez por semana, no dia de cada ilha, o imposto que ela acumulou sai da
// praça num barco e navega até a ilha. Quem quiser o dinheiro tem de afundá-lo
// pelo caminho.
//
//   CHEGOU INTEIRO   o imposto é dividido IGUALMENTE entre os membros da guilda
//                    dona da ilha.
//   FOI AFUNDADO     o imposto é dividido entre quem bateu nele, na proporção
//                    do dano que cada um causou.
//
// ── O dano é contado por NOME, não por id de sessão ──────────────────────────
// "PvP total: se o jogador morrer, o dano continua contando". O id de entidade
// morre com o jogador e nasce outro no respawn; o nome da conta não. Contar por
// nome é o que faz a promessa acima ser verdade — inclusive para quem afundou o
// barco e desconectou antes do fim, que recebe pelo caminho offline do banco.
//
// ── A travessia de mapas ─────────────────────────────────────────────────────
// O barco não teleporta: ele percorre a MESMA malha de fronteiras que um
// jogador percorreria (constants/maps.js → sideMap). Cada perna da rota é
// "chegue à borda que leva ao próximo mapa"; ao encostar nela, ele reaparece na
// borda oposta do mapa seguinte. É isso que dá aos perseguidores a chance de
// cortar caminho e esperá-lo do outro lado.
//
// Servidor envia: tax_boat_warning, tax_boat_state (dentro do `state` da zona),
//                 tax_boat_result, island_notice
'use strict';

const { pushOutOfIslands } = require('../utils/collision');
const {
  ISLAND_DEFS, TAX_BOAT_HP, TAX_BOAT_SPEED, TAX_BOAT_WAYPOINT_REACH,
  TAX_BOAT_LEG_TIMEOUT_MS, TAX_BOAT_WARN_MS, FORCE_EVENT_TEST_POT,
  weekKey, nextEventAt, islandHull,
} = require('../constants/islands');

/** Onde a borda "solta" o barco no mapa seguinte — espelha BORDER_SPAWN do server. */
const BORDER_INSET = 120;
/** Curva por tique, em radianos. Barco pesado vira devagar. */
const TURN_RATE = 0.04;
/**
 * Quanto tempo a nau segue contornando depois de encostar numa ilha.
 *
 * Ela mirava o waypoint em LINHA RETA e mais nada. Quando a reta passava por
 * cima de uma ilha — o que acontece sempre que o ponto de entrada e o de saída
 * do mapa estão alinhados com o centro — ela encostava na pedra e ficava lá,
 * empurrada de volta a cada tique, até a perna vencer por tempo. Era o caso da
 * rota do Mercado: DUAS pernas inteiras (mapas 10 e 11) terminavam sem a nau
 * ter saído do lugar, e o evento virava meia hora de barco parado.
 *
 * O contorno não é um desvio aleatório como o dos bichos (que só precisam
 * vaguear): ao encostar, a nau escolhe a TANGENTE da ilha que mais aponta para
 * o destino e segue nela até se ver livre da pedra por este tempo.
 *
 * O LADO é escolhido UMA vez por encontro e não muda até a nau se soltar. Essa
 * é a parte que não é óbvia: reescolher a cada encosto faz o lado inverter
 * exatamente no meio do contorno (passada a metade, a outra tangente é a que
 * "mais aponta para o destino"), e a nau fica indo e voltando na mesma pedra
 * para sempre. Com o lado travado ela dobra o costão e segue viagem.
 */
const DESVIO_MS = 4000;
/**
 * Berço: a folga que a nau dá a uma ilha ao planejar a travessia.
 *
 * O contorno acima é a última linha de defesa — bom para raspar num costão de
 * passagem, ruim para uma ilha bem no meio da reta. E é exatamente isso que
 * acontece no Banco e na arena do Mar dos Renegados: eles ficam no CENTRO do
 * mapa, e a nau entra por uma borda mirando a oposta, ou seja, em cima deles.
 * Contornando de perto ela orbitava a ilha sem nunca sair do lado errado.
 *
 * Com o berço a rota é planejada: se a reta até a saída passa perto demais de
 * uma ilha, a nau ganha um ponto de passagem ao LARGO dela e só depois retoma o
 * rumo. É o que um capitão faria, e é o que faz a travessia se ler como uma
 * rota em vez de um encosto atrás do outro.
 */
const BERTH = 90;
/**
 * A que distância do centro da praça a nau larga as amarras.
 *
 * Ela nascia em (0,0) do mapa da praça — que é EXATAMENTE onde ficam o Farol, o
 * Mercado e o Banco. O Mercado e o Banco têm colisores próprios, e a nau nascia
 * dentro deles: `pushOutOfIslands` a empurrava de um colisor para o outro a
 * cada tique e ela ficava parada na praça até a perna vencer por tempo — seis
 * minutos de evento em que não havia barco nenhum navegando.
 *
 * Em vez de um número fixo (que envelhece quando a praça ganha um colisor), o
 * ponto de partida é PROCURADO: anda para fora na direção da viagem até achar
 * água livre. Ver `_pontoDePartida`.
 */
const DEPARTURE_STEP = 20;
const DEPARTURE_MAX  = 700;
/** Distância do centro da ilha em que a coleta é considerada entregue. */
const ARRIVAL_RADIUS = 220;

class TaxBoatManager {
  /**
   * @param {Function} sendToFn        sendTo(ws, msg)
   * @param {Function} addEventFn      addEvent(evt, mapLevel)
   * @param {Map}      players         id → player
   * @param {Object}   db              DBManager
   * @param {Object}   islandManager   IslandManager
   * @param {Object}   guildManager    GuildManager
   * @param {Object}   journal         JournalManager
   * @param {Object}   SRC             JournalManager.SRC
   * @param {Object}   mapDefs         MAP_DEFS
   */
  constructor(sendToFn, addEventFn, players, db, islandManager, guildManager, journal, SRC, mapDefs) {
    this.send     = sendToFn;
    this.addEvent = addEventFn;
    this.players  = players;
    this.db       = db;
    this.islands  = islandManager;
    this.guilds   = guildManager;
    this.journal  = journal;
    this.SRC      = SRC;
    this.mapDefs  = mapDefs || {};

    /** islandId → viagem em curso. Normalmente vazio: é um evento por semana. */
    this.trips = new Map();
    this._warned = new Map();   // islandId → weekKey do aviso já dado

    /** Injetados pelo server.js (mesmo par do IslandManager). */
    this.registerEntity   = null;
    this.unregisterEntity = null;
    this.uid = null;
  }

  destroy() {
    for (const trip of this.trips.values()) this._despawn(trip);
    this.trips.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tique
  // ═══════════════════════════════════════════════════════════════════════════

  update(now, dt) {
    this._checkSchedule(now);
    for (const trip of [...this.trips.values()]) this._advance(trip, now, dt);
  }

  /** Chegou a hora de alguma ilha? (e avisa um minuto antes) */
  _checkSchedule(now) {
    for (const ilha of this.islands.islands.values()) {
      if (this.trips.has(ilha.id)) continue;
      const quando = ilha.nextEventAt || 0;
      if (!quando) continue;

      const semana = weekKey(now);
      if (quando - now <= TAX_BOAT_WARN_MS && quando > now) {
        if (this._warned.get(ilha.id) !== semana) {
          this._warned.set(ilha.id, semana);
          this._avisar(ilha);
        }
        continue;
      }
      if (now < quando) continue;

      // A hora chegou. Marca a semana ANTES de qualquer coisa: se a coleta for
      // cancelada (ilha sem dono) ou falhar no meio, ela não pode ficar
      // tentando de novo a cada tique até o dia acabar.
      ilha.lastEventWeek = semana;
      ilha.nextEventAt   = nextEventAt(ilha.id, now + 1000);
      this.islands._save(ilha);

      if (!ilha.ownerGuildId) {
        // "Se não houver guilda dona no momento da coleta: imposto NÃO é
        // recolhido, evento cancelado naquela semana." O bolo continua na ilha:
        // apagá-lo puniria a próxima dona pelo vazio da semana anterior.
        this._broadcastAll({
          type: 'island_notice',
          message: `🏝 ${ilha.def.name} não tem dono — a coleta desta semana foi cancelada.`,
        });
        console.log(`[Coleta] ${ilha.def.name}: cancelada (sem dono)`);
        continue;
      }
      if (!(ilha.taxPot > 0)) {
        this._broadcastAll({
          type: 'island_notice',
          message: `🏝 ${ilha.def.name}: nada arrecadado nesta semana, o barco não zarpa.`,
        });
        continue;
      }
      this._zarpar(ilha, now);
    }
  }

  /**
   * Faz a coleta desta ilha zarpar AGORA. É a ferramenta de teste do evento: o
   * ciclo normal é semanal (constants/islands.js → weekday + EVENT_HOUR_UTC) e
   * esperar até sexta-feira para ver o barco navegar não é um jeito de
   * desenvolver o barco.
   *
   * Não é um atalho de balanceamento: quem chama é a aba de evento do painel
   * da guilda, só o líder da guilda DONA, e o que zarpa é o imposto que a ilha
   * realmente acumulou. Um bolo vazio recebe FORCE_EVENT_TEST_POT — sem isso o
   * teste não teria barco nenhum para afundar, que é justamente o que ele
   * existe para exercitar.
   *
   * A coleta forçada NÃO consome a semana: `lastEventWeek` e `nextEventAt`
   * ficam onde estavam, e a coleta de verdade acontece no dia dela.
   *
   * @returns {{ok:true, amount:number}|{ok:false, reason:string}}
   */
  forceStart(islandId, now = Date.now()) {
    const ilha = this.islands?.islands?.get(Number(islandId));
    if (!ilha)                   return { ok: false, reason: 'Ilha desconhecida.' };
    if (this.trips.has(ilha.id)) return { ok: false, reason: 'A coleta desta ilha já está a caminho.' };
    if (!ilha.ownerGuildId)      return { ok: false, reason: 'A ilha não tem guilda dona.' };

    if (!(ilha.taxPot > 0)) {
      ilha.taxPot = FORCE_EVENT_TEST_POT;
      this.islands._save(ilha);
    }
    const antes = ilha.taxPot;
    this._zarpar(ilha, now);
    console.log(`[Coleta] ${ilha.def.name}: partida FORÇADA (teste) com ${antes} de ouro`);
    return { ok: true, amount: antes };
  }

  _avisar(ilha) {
    const dona = ilha.ownerGuildId ? this.guilds?.guilds?.get(ilha.ownerGuildId) : null;
    this._broadcastAll({
      type: 'tax_boat_warning',
      islandId: ilha.id,
      islandName: ilha.def.name,
      venueName: ilha.def.venueName,
      amount: ilha.taxPot || 0,
      ownerTag: dona?.tag || null,
      inMs: TAX_BOAT_WARN_MS,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // A viagem
  // ═══════════════════════════════════════════════════════════════════════════

  _zarpar(ilha, now) {
    const def   = ilha.def;
    const rota  = def.route.slice();
    const dona  = this.guilds.guilds.get(ilha.ownerGuildId);

    // O bônus do "Barco de Coleta" (skill de guilda) entra AQUI, sobre o valor
    // que sai da praça. Aplicá-lo na entrega faria o número anunciado no aviso
    // não bater com o que cai no bolso.
    const bonus = Math.max(0, Number(dona?.skills?.tax_boat_pct || 0)) * 0.10;
    const valor = Math.round((ilha.taxPot || 0) * (1 + bonus));

    // O bolo sai da ilha na hora de zarpar: ele agora está no barco, e o que
    // acontecer com ele é assunto da viagem. Sem isto, um imposto cobrado
    // durante o trajeto entraria no mesmo bolo que já está a caminho.
    ilha.taxPot = 0;
    this.islands._save(ilha);

    const primeiro = rota[0];
    const mapSize  = (this.mapDefs[primeiro] || {}).size || 1200;
    const id = this.uid ? this.uid() : `taxboat_${ilha.id}_${now}`;

    // A nau tem a cara da ILHA que a mandou: o mesmo casco da guarda que o
    // jogador enfrenta lá em cima (ver islandHull). Era um galeão genérico do
    // catálogo, igual a qualquer outro navio no mar — e o evento inteiro é
    // "aquele barco ali é o imposto da minha praça indo embora".
    const casco = islandHull(ilha.id) || {};

    const boat = {
      id,
      isNPC: true, isTaxBoat: true,
      islandId: ilha.id,
      name: `Coleta do ${def.venueName}`,
      x: 0, y: 0, z: 0, rotation: 0, speed: 0,
      hp: TAX_BOAT_HP, maxHp: TAX_BOAT_HP,
      dead: false,
      mapLevel: primeiro,
      npcModel:     casco.model     || '/models/ships/galleon.glb',
      npcScale:     casco.scale     || 0,
      npcYOffset:   casco.yOffset   || 0,
      npcRotOffset: casco.rotOffset || 0,
      // O raio do casco, e não um número próprio: a nau precisa ser fácil de
      // acertar, e "fácil" é o tamanho que ela tem na tela.
      hitRadius: casco.hitRadius || 26,
    };

    const trip = {
      islandId: ilha.id,
      guildId:  ilha.ownerGuildId,
      amount:   valor,
      route:    rota,
      leg:      0,
      legStart: now,
      via:      undefined,   // ponto de passagem em curso (ver _viaPoint)
      boat,
      /** nome do jogador → dano total. Sobrevive à morte de quem bateu. */
      damage: new Map(),
      target: null,
    };
    trip.target = this._exitPoint(rota[0], rota[1], mapSize);
    // Larga as amarras FORA da praça, na direção da viagem (ver DEPARTURE_STEP).
    const partida = this._pontoDePartida(primeiro, trip.target);
    boat.x = partida.x; boat.z = partida.z;
    boat.rotation = Math.atan2(trip.target.x - boat.x, trip.target.z - boat.z);

    this.trips.set(ilha.id, trip);
    if (this.registerEntity) this.registerEntity(id, boat);

    this._broadcastAll({
      type: 'tax_boat_warning',
      islandId: ilha.id, islandName: def.name, venueName: def.venueName,
      amount: valor, sailed: true, inMs: 0,
      route: rota,
    });
    console.log(`[Coleta] ${def.name}: barco zarpou do ${def.venueName} com ${valor} de ouro ` +
                `(rota ${rota.join('→')})`);
  }

  /**
   * Círculos que a nau precisa contornar neste mapa: a ilha inteira quando ela
   * não tem colisores, ou um círculo por colisor quando tem (é o que impede a
   * floresta submersa do mapa 11 — cem colisores pequenos espalhados — de
   * virar um único obstáculo do tamanho do mapa).
   */
  _obstaculos(mapa) {
    if (!this._obsCache) this._obsCache = new Map();
    const cache = this._obsCache.get(mapa);
    if (cache) return cache;

    const def = this.mapDefs[mapa] || {};
    const out = [];
    for (const val of Object.values(def)) {
      if (!val || typeof val !== 'object' || !val.islandRadius || !val.center) continue;
      const cx = val.center.x || 0, cz = val.center.z || 0;
      const partes = (val.colliders || []).map(c => ({
        x: cx + (c.x || 0), z: cz + (c.z || 0),
        r: c.shape === 'circle' ? (c.r || 0) : Math.hypot(c.hw || 0, c.hh || 0),
      }));

      // ── Uma ilha COMPACTA vira UM círculo, não uma dúzia ──────────────────
      // Contornar colisor por colisor não funciona numa construção fechada: a
      // arena do mapa 11 é doze caixas encaixadas, e o desvio da pior delas
      // larga a nau em cima da seguinte — ela ficava presa dentro do conjunto,
      // batendo de uma parede na outra até a perna vencer por tempo. Um
      // círculo que engloba a construção inteira é contornado DE UMA VEZ.
      //
      // O critério é o TAMANHO relativo ao mapa: uma construção compacta
      // (arena, Banco, Mercado — todas abaixo de 25% do mapa) vira o círculo
      // envolvente; um espalhamento que cobre meio mapa (a floresta submersa
      // do 11, cem colisores de 15 unidades ao longo de milhares) continua
      // colisor a colisor, senão o mapa inteiro viraria obstáculo.
      const raio = partes.reduce(
        (m, c) => Math.max(m, Math.hypot(c.x - cx, c.z - cz) + c.r),
        val.islandRadius || 0);
      const limite = ((def.size || 1200) * 0.25);

      if (raio <= limite) out.push({ x: cx, z: cz, r: raio });
      else { out.push({ x: cx, z: cz, r: val.islandRadius }); out.push(...partes); }
    }
    this._obsCache.set(mapa, out);
    return out;
  }

  /**
   * Ponto de passagem ao largo da ilha que atravessa a reta `de`→`para`, ou
   * null quando o caminho está limpo. Ver BERTH.
   */
  _viaPoint(mapa, de, para) {
    const dx = para.x - de.x, dz = para.z - de.z;
    const len = Math.hypot(dx, dz);
    if (!len) return null;
    const ux = dx / len, uz = dz / len;

    // A ilha que mais invade a reta — resolver a pior de cada vez, e recalcular
    // ao chegar no desvio, é o que faz a nau costurar entre várias sem precisar
    // de um planejador de rota de verdade.
    let pior = null;
    for (const o of this._obstaculos(mapa)) {
      const berco = o.r + BERTH;
      const t = (o.x - de.x) * ux + (o.z - de.z) * uz;
      if (t < 0 || t > len) continue;                 // não está entre os dois
      const px = de.x + ux * t, pz = de.z + uz * t;
      const dist = Math.hypot(o.x - px, o.z - pz);
      if (dist >= berco) continue;                    // passa longe o bastante
      const pen = berco - dist;
      if (!pior || pen > pior.pen) pior = { o, px, pz, pen, berco };
    }
    if (!pior) return null;

    // Desloca perpendicular à rota, para o lado da ilha em que a nau já está —
    // trocar de lado aqui seria dar meia-volta no meio do mar.
    const nx = -uz, nz = ux;
    const daIlha = (pior.o.x - pior.px) * nx + (pior.o.z - pior.pz) * nz;
    const lado = daIlha > 0 ? -1 : 1;
    return {
      x: pior.o.x + nx * lado * pior.berco,
      z: pior.o.z + nz * lado * pior.berco,
      dir: null, via: true,
    };
  }

  /**
   * O primeiro palmo de água livre saindo do centro da praça na direção da
   * viagem. Anda para fora de DEPARTURE_STEP em DEPARTURE_STEP até
   * `pushOutOfIslands` parar de empurrar — assim a nau sempre nasce colada na
   * praça (é de lá que ela tem de ser vista saindo) sem depender de um raio
   * escrito à mão, que envelheceria na primeira vez que a praça ganhasse um
   * colisor novo.
   */
  _pontoDePartida(mapa, alvo) {
    const mapDef = this.mapDefs[mapa];
    const len = Math.hypot(alvo.x, alvo.z) || 1;
    const ux  = alvo.x / len, uz = alvo.z / len;
    const teste = { x: 0, z: 0 };
    for (let d = 0; d <= DEPARTURE_MAX; d += DEPARTURE_STEP) {
      teste.x = ux * d; teste.z = uz * d;
      // margem maior que a do passeio (30): a nau começa folgada da pedra em
      // vez de raspando nela.
      if (!pushOutOfIslands(teste, mapDef, 45)) return { x: teste.x, z: teste.z };
    }
    return { x: ux * DEPARTURE_MAX, z: uz * DEPARTURE_MAX };
  }

  /**
   * Ponto da borda do mapa `from` que leva a `to`. Quando a borda é dividida
   * em faixas (o norte do mapa 11 dá em três ilhas), mira o MEIO da faixa certa
   * — que é exatamente o que resolveBorderTarget vai ler quando ele chegar lá.
   */
  _exitPoint(from, to, mapSize) {
    const def  = this.mapDefs[from] || {};
    const size = mapSize || def.size || 1200;
    const lim  = size / 2 - BORDER_INSET;
    const entry = (def.sideMap && def.sideMap[0]) || {};

    for (const dir of Object.keys(entry)) {
      const raw = entry[dir];
      const alvos = Array.isArray(raw) ? raw : [raw];
      const idx = alvos.indexOf(to);
      if (idx < 0) continue;

      // Centro da faixa `idx` ao longo do eixo transversal da borda.
      const t = (idx + 0.5) / alvos.length;
      const along = (t - 0.5) * size;

      // ── A convenção de eixo é a do servidor, não a intuitiva ──────────────
      // BORDER_TEST em server.js: norte = z NEGATIVO, sul = z positivo,
      // left(oeste) = x negativo, right(leste) = x positivo. Os quatro sinais
      // aqui estavam invertidos, e o efeito era silencioso: a perna terminava
      // do mesmo jeito (o barco chegava a UMA borda) e a viagem completava,
      // só que espelhada — a coleta saía do Farol rumo ao SUL enquanto a ilha
      // fica ao norte. Quem fosse esperá-la no caminho olhava para o lado
      // errado do mar, e quem estava na praça via o barco sumir de costas.
      if (dir === 'norte') return { x: along, z: -lim, dir };
      if (dir === 'sul')   return { x: along, z:  lim, dir };
      if (dir === 'left')  return { x: -lim,  z: along, dir };
      if (dir === 'right') return { x:  lim,  z: along, dir };
    }
    // Rota mal configurada: segue para o centro e a perna vence por tempo.
    return { x: 0, z: 0, dir: null };
  }

  /**
   * Onde o barco reaparece ao entrar no mapa seguinte — na borda OPOSTA à que
   * ele usou para sair, como qualquer jogador que atravessa (ver BORDER_SPAWN_AT
   * no server.js). Saiu pelo norte (z negativo) → entra pelo sul (z positivo).
   */
  _entryPoint(dir, toMap, along) {
    const size = (this.mapDefs[toMap] || {}).size || 1200;
    const lim  = size / 2 - BORDER_INSET;
    const a    = Math.max(-lim, Math.min(lim, along || 0));
    switch (dir) {
      case 'norte': return { x: a, z:  lim };
      case 'sul':   return { x: a, z: -lim };
      case 'left':  return { x:  lim, z: a };
      case 'right': return { x: -lim, z: a };
      default:      return { x: 0, z: 0 };
    }
  }

  _advance(trip, now, dt) {
    const boat = trip.boat;
    if (boat.dead) { this._finish(trip, false, now); return; }

    const ultimo = trip.leg >= trip.route.length - 1;

    // ── Última perna: navega até o centro da ilha ────────────────────────────
    if (ultimo) {
      const dx = 0 - boat.x, dz = 0 - boat.z;
      if (Math.sqrt(dx * dx + dz * dz) <= ARRIVAL_RADIUS) { this._finish(trip, true, now); return; }
      // Sem berço aqui: o destino É a ilha, e ARRIVAL_RADIUS (220) já para a
      // nau bem antes do costão. Planejar um desvio faria ela contornar o
      // próprio ponto de entrega.
      this._steer(boat, { x: 0, z: 0 }, dt, now);
      return;
    }

    // ── Ponto de passagem ao largo da ilha ──────────────────────────────────
    // Recalculado quando `via` está indefinido: no começo da perna e a cada vez
    // que a nau alcança um desvio. Assim ela costura entre várias ilhas
    // resolvendo uma de cada vez (ver _viaPoint).
    if (trip.via === undefined) {
      trip.via = this._viaPoint(boat.mapLevel, boat, trip.target);
    }
    if (trip.via) {
      const vdx = trip.via.x - boat.x, vdz = trip.via.z - boat.z;
      if (Math.sqrt(vdx * vdx + vdz * vdz) <= TAX_BOAT_WAYPOINT_REACH) {
        trip.via = undefined;                       // chegou: replaneja daqui
      } else {
        this._steer(boat, trip.via, dt, now);
        // A perna ainda pode vencer por tempo mesmo desviando — o teto é da
        // PERNA, não do trecho.
        if (now - trip.legStart <= TAX_BOAT_LEG_TIMEOUT_MS) return;
      }
    }

    const alvo = trip.target;
    const dx = alvo.x - boat.x, dz = alvo.z - boat.z;
    const perto = Math.sqrt(dx * dx + dz * dz) <= TAX_BOAT_WAYPOINT_REACH;
    const venceu = now - trip.legStart > TAX_BOAT_LEG_TIMEOUT_MS;

    if (perto || venceu) {
      const de   = trip.route[trip.leg];
      const para = trip.route[trip.leg + 1];
      const dir  = alvo.dir;
      const along = (dir === 'norte' || dir === 'sul') ? boat.x : boat.z;
      const p = this._entryPoint(dir, para, along);

      boat.mapLevel = para;
      boat.x = p.x; boat.z = p.z;
      trip.leg      += 1;
      trip.legStart  = now;
      trip.via       = undefined;   // mapa novo, plano novo

      if (trip.leg < trip.route.length - 1) {
        trip.target = this._exitPoint(para, trip.route[trip.leg + 1],
                                      (this.mapDefs[para] || {}).size);
      } else {
        trip.target = { x: 0, z: 0, dir: null };
      }
      boat.rotation = Math.atan2(trip.target.x - boat.x, trip.target.z - boat.z);

      this._broadcastAll({
        type: 'island_notice',
        message: `⛵ O barco da coleta entrou em ${(this.mapDefs[para] || {}).name || `mapa ${para}`}.`,
      });
      console.log(`[Coleta] barco ${de}→${para}${venceu ? ' (perna venceu por tempo)' : ''}`);
      return;
    }

    this._steer(boat, alvo, dt, now);
  }

  _steer(boat, alvo, dt, now = Date.now()) {
    // Contornando uma ilha? Então a mira é a tangente escolhida no encosto, e
    // não o waypoint — voltar a mirar o destino aqui a jogaria de volta contra
    // a pedra no tique seguinte.
    const contornando = boat._desvioAte && now < boat._desvioAte;
    const desejado = contornando
      ? boat._desvioRot
      : Math.atan2(alvo.x - boat.x, alvo.z - boat.z);

    let diff = desejado - boat.rotation;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    boat.rotation += Math.max(-TURN_RATE, Math.min(TURN_RATE, diff));

    boat.speed = Math.min(boat.speed + 0.02, TAX_BOAT_SPEED);
    boat.x += Math.sin(boat.rotation) * boat.speed * dt * 30;
    boat.z += Math.cos(boat.rotation) * boat.speed * dt * 30;

    const antesX = boat.x, antesZ = boat.z;
    if (!pushOutOfIslands(boat, this.mapDefs[boat.mapLevel], 30)) return;

    // Encostou. O empurrão é a NORMAL de saída da ilha (foi para onde ela
    // jogou a nau); as duas tangentes são a normal girada um quarto de volta
    // para cada lado.
    const nx = boat.x - antesX, nz = boat.z - antesZ;
    const n  = Math.hypot(nx, nz);
    if (!n) return;

    // Encontro NOVO (estava solta) → escolhe o lado que mais aponta para o
    // destino. Encontro em curso → mantém o lado, custe o que custar: é o que
    // impede a nau de inverter no meio do contorno e orbitar a ilha.
    if (!contornando) {
      const ax = alvo.x - boat.x, az = alvo.z - boat.z;
      boat._desvioLado = ((-nz * ax) + (nx * az)) >= 0 ? 1 : -1;
    }
    const lado = boat._desvioLado || 1;
    boat._desvioRot = Math.atan2((-nz / n) * lado, (nx / n) * lado);
    boat._desvioAte = now + DESVIO_MS;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dano e desfecho
  // ═══════════════════════════════════════════════════════════════════════════

  /** Chamado pelo projectile-manager a cada acerto no barco. */
  recordDamage(boat, atirador, dano) {
    if (!boat?.isTaxBoat || !atirador?.name || !(dano > 0)) return;
    const trip = this.trips.get(boat.islandId);
    if (!trip) return;
    trip.damage.set(atirador.name, (trip.damage.get(atirador.name) || 0) + Math.round(dano));
  }

  /**
   * Este jogador é da ESCOLTA desta nau?
   *
   * A guilda dona da ilha não é mais uma espectadora do próprio evento: o
   * papel dela na travessia é PROTEGER o barco, e quem protege não pode
   * afundar. Sem esta regra a coleta era um alvo neutro para todo mundo,
   * inclusive para a irmandade que ia receber o dinheiro — e um membro
   * distraído mirando no que estava na frente jogava fora o imposto da semana
   * inteira. Do lado da escolta o barco fica IMUNE (nem tiro, nem queimadura,
   * nem relíquia) e a bala de cura passa a fazer efeito nele.
   *
   * A comparação é pela guilda REGISTRADA NA VIAGEM (`trip.guildId`), não pela
   * dona atual da ilha: a ilha pode trocar de mão no meio da travessia, e o
   * ouro que está no mar é da guilda que o mandou zarpar.
   *
   * @param {object} boat   a nau (precisa do `islandId`)
   * @param {object} player quem atirou
   * @returns {boolean}
   */
  isGuardian(boat, player) {
    if (!boat?.isTaxBoat || !player) return false;
    const trip = this.trips.get(boat.islandId);
    if (!trip || !trip.guildId) return false;
    return this.guilds?.guildOf(player)?.id === trip.guildId;
  }

  /**
   * Cura da escolta: devolve quanto entrou de fato (0 se a nau já estava
   * cheia, se quem curou não é da escolta, ou se a viagem já acabou).
   *
   * O teto é o `maxHp` da nau como qualquer outra entidade — a escolta segura
   * o barco de pé, não o transforma num alvo que não afunda.
   */
  healBoat(boat, player, amount) {
    if (!(amount > 0) || !this.isGuardian(boat, player)) return 0;
    if (boat.dead || boat.hp >= boat.maxHp) return 0;
    const antes = boat.hp;
    boat.hp = Math.min(boat.maxHp, boat.hp + Math.round(amount));
    return boat.hp - antes;
  }

  /** Chamado pelo projectile-manager quando o barco chega a zero. */
  onBoatSunk(boat) {
    const trip = this.trips.get(boat?.islandId);
    if (trip) this._finish(trip, false, Date.now());
  }

  _finish(trip, chegou, now) {
    this.trips.delete(trip.islandId);
    this._despawn(trip);

    const ilha = this.islands.islands.get(trip.islandId);
    const nome = ilha?.def?.name || `Ilha ${trip.islandId}`;

    if (chegou) this._pagarGuilda(trip, ilha, nome);
    else        this._pagarSaqueadores(trip, nome);

    this._broadcastAll({
      type: 'tax_boat_result',
      islandId: trip.islandId,
      arrived: chegou,
      amount: trip.amount,
      islandName: nome,
    });

    // Fim da coleta = fim da semana da ilha: torres novas, sem dono, disputa
    // aberta de novo (ver o pedido, "Ciclo Semanal / Reset").
    if (ilha) this.islands.resetIsland(ilha, now).catch(() => {});
  }

  _despawn(trip) {
    if (this.unregisterEntity) this.unregisterEntity(trip.boat.id);
    trip.boat.dead = true;
  }

  /** Chegou inteiro: divide IGUALMENTE entre os membros da guilda dona. */
  _pagarGuilda(trip, ilha, nome) {
    const g = this.guilds.guilds.get(trip.guildId);
    if (!g || !g.members.size) {
      console.log(`[Coleta] ${nome}: chegou, mas a guilda sumiu — nada pago`);
      return;
    }
    const nomes = [...g.members.keys()];
    const parte = Math.floor(trip.amount / nomes.length);
    if (parte <= 0) return;

    for (const n of nomes) this._creditar(n, parte, this.SRC.ISLAND_COLLECT, nome);

    console.log(`[Coleta] ${nome}: chegou inteiro — ${trip.amount} dividido por ${nomes.length} membros`);
    this._broadcastAll({
      type: 'island_notice',
      message: `⛵ A coleta de ${nome} chegou! [${g.tag}] dividiu ${trip.amount.toLocaleString('pt-BR')} 🪙.`,
    });
  }

  /** Afundado: divide entre quem bateu, na proporção do dano. */
  _pagarSaqueadores(trip, nome) {
    const total = [...trip.damage.values()].reduce((s, d) => s + d, 0);
    if (total <= 0) {
      console.log(`[Coleta] ${nome}: barco perdido sem dano registrado — nada pago`);
      return;
    }
    let melhor = { nome: '?', ouro: 0 };
    for (const [quem, dano] of trip.damage) {
      const parte = Math.floor(trip.amount * (dano / total));
      if (parte <= 0) continue;
      this._creditar(quem, parte, this.SRC.ISLAND_RAID, nome);
      if (parte > melhor.ouro) melhor = { nome: quem, ouro: parte };
    }
    console.log(`[Coleta] ${nome}: barco afundado — ${trip.amount} dividido entre ${trip.damage.size} saqueador(es)`);
    this._broadcastAll({
      type: 'island_notice',
      message: `💥 O barco de ${nome} foi afundado! ${trip.damage.size} saqueador(es) dividiram ` +
               `${trip.amount.toLocaleString('pt-BR')} 🪙 — maior quinhão: ${melhor.nome}.`,
    });
  }

  /**
   * Paga um jogador esteja ele online ou não. Online é na memória (o autosave
   * levaria o número); offline vai direto no banco, pelo mesmo caminho da taxa
   * de guilda — e NUNCA os dois, que é como se paga em dobro ou coisa nenhuma.
   */
  _creditar(nome, ouro, fonte, detalhe) {
    let online = null;
    this.players.forEach(p => { if (!online && p?.name === nome) online = p; });

    if (online) {
      online.gold = (online.gold || 0) + ouro;
      this.journal?.ledger(online, fonte, { gold: ouro }, { detail: detalhe });
      this.send(online.ws, { type: 'currency_update', gold: online.gold, dobroes: online.dobroes });
      this.send(online.ws, {
        type: 'island_notice',
        message: `🪙 Espólio da coleta: +${ouro.toLocaleString('pt-BR')} de ouro.`,
      });
      this.db.save(online, true)?.catch?.(() => {});
      return;
    }
    this.db.creditOfflineGold(nome, ouro)
      .then(() => this.journal?.ledgerByName?.(nome, fonte, { gold: ouro }, { detail: detalhe }))
      .catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Estado para o cliente
  // ═══════════════════════════════════════════════════════════════════════════

  /** O barco entra no `state` da zona como qualquer entidade. */
  snapshotFor(zone) {
    const out = [];
    for (const trip of this.trips.values()) {
      const b = trip.boat;
      if (b.dead || b.mapLevel !== zone) continue;
      out.push({
        id: b.id, name: b.name,
        x: b.x, y: b.y, z: b.z, rotation: b.rotation, speed: b.speed,
        hp: b.hp, maxHp: b.maxHp, dead: false,
        isNPC: true, isTaxBoat: true,
        islandId: b.islandId, mapLevel: b.mapLevel,
        npcModel: b.npcModel,
      });
    }
    return out;
  }

  /** Viagem em curso, para o HUD ("o barco está no mapa X"). */
  activeTrips() {
    return [...this.trips.values()].map(t => ({
      islandId: t.islandId,
      amount:   t.amount,
      mapLevel: t.boat.mapLevel,
      hp:       t.boat.hp,
      maxHp:    t.boat.maxHp,
      leg:      t.leg,
      route:    t.route,
    }));
  }

  _broadcastAll(msg) {
    this.players.forEach(p => { if (p?.ws) this.send(p.ws, msg); });
  }
}

module.exports = TaxBoatManager;
