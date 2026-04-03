// debug-server.js
const express = require('express');
const app = express();
const PORT = 3001; // Porta diferente do jogo

app.get('/glb/:modelName', (req, res) => {
  const modelName = req.params.modelName;
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
          <title>Debug GLB: ${modelName}</title>
          <style>
              body { margin:0; background:#111; color:white; font-family:monospace; }
              #controls {
                  position:absolute; top:10px; left:10px; 
                  background:rgba(0,0,0,0.8); padding:15px; 
                  border-radius:5px; z-index:100;
              }
              input[type=range] { width:200px; }
          </style>
      </head>
      <body>
          <div id="controls">
              <h3>🔧 Debug: ${modelName}</h3>
              <div>
                  <label>Rotação: <input type="range" id="rot" min="0" max="360" value="0"></label>
              </div>
              <div>
                  <label>Escala: <input type="range" id="scale" min="-10" max="20" step="0.1" value="1"></label>
              </div>
              <div>
                  <label>Pos Y: <input type="range" id="posY" min="-20" max="20" step="0.1" value="0"></label>
              </div>
              <button id="reload">↻ Recarregar</button>
              <select id="modelList">
                  <option value="/models/ships/fragata.glb">fragata</option>
                  <option value="/models/ships/sloop.glb">sloop</option>
                  <option value="/models/ships/brigantine.glb">brigantine</option>
                  <option value="/models/ships/schooner.glb">schooner</option>
                  <option value="/models/ships/galleon.glb">galleon</option>
                  <option value="/models/ships/frigate.glb">frigate</option>
                  <option value="/models/ships/royal_fortune.glb">royal_fortune</option>
                  <option value="/models/ships/adventure_galley.glb">adventure_galley</option>
                  <option value="/models/ships/whydah_galley.glb">whydah_galley</option>
                  <option value="/models/ships/queen_annes_revenge.glb">queen_anne_s_revenge</option>
                  <option value="/models/ships/fancy.glb">fancy</option>
                  <option value="/models/ships/legendary_ghost_pirate_ship.glb">legendary_ghost_pirate_ship</option>

                  <option value="/models/monster/abyssal_reef_stalker.glb">abyssal_reef_stalker</option>
                  <option value="/models/monster/giant_crab_octopus.glb">giant_crab_octopus</option>
                  <option value="/models/monster/dreadfin_leviathan.glb">dreadfin_leviathan</option>
                  <option value="/models/monster/abyssal_sovereign.glb">abyssal_sovereign</option>
                  <option value="/models/monster/gilded_reef_manta.glb">gilded_reef_manta</option>
                  <option value="/models/monster/harbor_warden_the_coinbreaker.glb">harbor_warden_the_coinbreaker</option>

                  <option value="/models/places/merchant_tropical.glb">merchant_tropical</option>
              </select>
              <button id="save">Salvar</button>
          </div>
          
          <script type="importmap">
              {
                  "imports": {
                      "three": "https://unpkg.com/three@0.128.0/build/three.module.js",
                      "three/addons/": "https://unpkg.com/three@0.128.0/examples/jsm/"
                  }
              }
          </script>
          
          <script type="module">
              import * as THREE from 'three';
              import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
              import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

              const scene = new THREE.Scene();
              scene.background = new THREE.Color(0x1a1a2e);
              
              const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
              camera.position.set(5, 5, 10);
              
              const renderer = new THREE.WebGLRenderer({ antialias: true });
              renderer.setSize(window.innerWidth, window.innerHeight);
              renderer.shadowMap.enabled = true;
              renderer.shadowMap.type = THREE.PCFSoftShadowMap;
              document.body.appendChild(renderer.domElement);

              const controls = new OrbitControls(camera, renderer.domElement);
              controls.enableDamping = true;

              // Luzes
              const ambient = new THREE.AmbientLight(0x404060);
              scene.add(ambient);
              
              const sun = new THREE.DirectionalLight(0xffeedd, 2);
              sun.position.set(5, 10, 5);
              sun.castShadow = true;
              sun.shadow.mapSize.set(1024, 1024);
              scene.add(sun);

              // Grid
              const gridHelper = new THREE.GridHelper(20, 20, 0x88aaff, 0x335588);
              scene.add(gridHelper);
              
              const axesHelper = new THREE.AxesHelper(5);
              scene.add(axesHelper);

              // Loader
              // Adicione compressão Draco nos GLBs
              const dracoLoader = new THREE.DracoLoader();
              const loader = new GLTFLoader();
              loader.setDRACOLoader(dracoLoader);
              let currentModel = null;

              function loadModel(name) {
                  const path = name;
                  console.log('Carregando:', path);
                  
                  if (currentModel) scene.remove(currentModel);
                  
                  loader.load(
                      path,
                      (gltf) => {
                          currentModel = gltf.scene;
                          
                          // Auto-center
                          const box = new THREE.Box3().setFromObject(currentModel);
                          const center = box.getCenter(new THREE.Vector3());
                          const size = box.getSize(new THREE.Vector3());
                          
                          currentModel.position.sub(center);
                          currentModel.position.y += size.y / 2;
                          
                          // Aplicar controles atuais
                          currentModel.rotation.y = (rotInput.value * Math.PI) / 180;
                          currentModel.scale.setScalar(parseFloat(scaleInput.value));
                          currentModel.position.y += parseFloat(posYInput.value);
                          
                          // Shadows
                          currentModel.traverse((node) => {
                              if (node.isMesh) {
                                  node.castShadow = true;
                                  node.receiveShadow = true;
                              }
                          });
                          
                          scene.add(currentModel);
                          
                          controls.target.set(0, size.y/2, 0);
                          console.log('✅ Modelo carregado:', size);
                      },
                      undefined,
                      (error) => console.error('❌ Erro:', error)
                  );
              }

              // UI Controls
              const rotInput = document.getElementById('rot');
              const scaleInput = document.getElementById('scale');
              const posYInput = document.getElementById('posY');
              const modelSelect = document.getElementById('modelList');
              
              rotInput.addEventListener('input', () => {
                  if (currentModel) currentModel.rotation.y = (rotInput.value * Math.PI) / 180;
              });
              
              scaleInput.addEventListener('input', () => {
                  if (currentModel) currentModel.scale.setScalar(parseFloat(scaleInput.value));
              });
              
              posYInput.addEventListener('input', () => {
                  if (currentModel) {
                      // Preservar posição base + offset
                      const box = new THREE.Box3().setFromObject(currentModel);
                      const size = box.getSize(new THREE.Vector3());
                      currentModel.position.y = size.y/2 + parseFloat(posYInput.value);
                  }
              });
              
              document.getElementById('reload').addEventListener('click', () => {
                  loadModel(modelSelect.value);
              });
              
              modelSelect.addEventListener('change', () => {
                  loadModel(modelSelect.value);
              });

              document.getElementById('save').addEventListener('click', () => {
                console.log('Salvar modelo:', modelSelect.value, 'Rot:', rotInput.value, 'Scale:', scaleInput.value, 'PosY:', posYInput.value);
              });

              // Carregar modelo inicial
              loadModel('${modelName}');

              function animate() {
                  requestAnimationFrame(animate);
                  controls.update();
                  renderer.render(scene, camera);
              }
              animate();

              window.addEventListener('resize', () => {
                  camera.aspect = window.innerWidth / window.innerHeight;
                  camera.updateProjectionMatrix();
                  renderer.setSize(window.innerWidth, window.innerHeight);
              });
          </script>
      </body>
      </html>
  `);
});

app.get('/sea', (req, res) => {
  // Lê os presets direto das MAP_DEFS do servidor (sempre sincronizado com constants.js)
  const toHex = n => '#' + ((n || 0) >>> 0).toString(16).padStart(6, '0');
  const presets = {};
  for (let i = 1; i <= 3; i++) {
      const v = (MAP_DEFS[i] || {}).visual || {};
      presets[i] = {
      name:             MAP_DEFS[i]?.name || 'Mapa ' + i,
      bgColor:          toHex(v.bgColor),
      fogColor:         toHex(v.fogColor),
      fogDensity:       v.fogDensity       ?? 0.002,
      ambientColor:     toHex(v.ambientColor),
      ambientIntensity: v.ambientIntensity ?? 0.8,
      sunColor:         toHex(v.sunColor),
      sunIntensity:     v.sunIntensity     ?? 2.5,
      ocean1:           toHex(v.ocean1),
      ocean2:           toHex(v.ocean2),
      hasMoon:          !!v.hasMoon,
      hasDenseNebula:   !!v.hasDenseNebula,
      };
  }

  // GLSL injetado via JSON.stringify (evita conflito de backticks no template literal)
  const glslOceanVert = [
      'uniform float uTime;',
      'varying vec2 vUv;',
      'varying float vHeight;',
      'void main(){',
      '  vUv = uv;',
      '  vec3 pos = position;',
      '  float h = sin(pos.x * 0.03 + uTime) * 1.5',
      '          + sin(pos.z * 0.04 + uTime * 0.8) * 1.2',
      '          + sin((pos.x + pos.z) * 0.02 + uTime * 1.2) * 0.8;',
      '  pos.y = h; vHeight = h;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);',
      '}',
  ].join('\n');

  const glslOceanFrag = [
      'uniform vec3 uColor1; uniform vec3 uColor2;',
      'varying vec2 vUv; varying float vHeight;',
      'void main(){',
      '  float t = clamp((vHeight + 3.0) / 6.0, 0.0, 1.0);',
      '  vec3 col = mix(uColor2, uColor1, t);',
      '  float foam = smoothstep(0.6, 1.0, t);',
      '  col = mix(col, vec3(0.6, 0.75, 0.9), foam * 0.2);',
      '  gl_FragColor = vec4(col, 1.0);',
      '}',
  ].join('\n');

  const glslSkyVert = 'varying vec3 vPos; void main(){ vPos=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';

  const glslSkyFrag = [
      'varying vec3 vPos; uniform float uTime; uniform vec3 uBgColor;',
      'void main(){',
      '  float h = normalize(vPos).y;',
      '  vec3 zenith  = uBgColor * 0.45;',
      '  vec3 mid     = uBgColor * 0.85;',
      '  vec3 horizon = min(uBgColor * 1.8, vec3(1.0));',
      '  vec3 sky = mix(mid, zenith, clamp(h, 0.0, 1.0));',
      '  sky = mix(horizon, sky, smoothstep(0.0, 0.3, h));',
      '  float star = step(0.9995, fract(sin(dot(normalize(vPos),vec3(127.1,311.7,74.2)))*43758.5));',
      '  sky += star * 0.8 * clamp(h, 0.0, 1.0);',
      '  gl_FragColor = vec4(sky, 1.0);',
      '}',
  ].join('\n');

  res.send(`<!DOCTYPE html>
  <html><head>
  <meta charset="utf-8">
  <title>🌊 Debug: Mar</title>
  <style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#000;color:#ccc;font-family:monospace;overflow:hidden}
  #cv{position:fixed;top:0;left:0}
  #panel{position:fixed;top:0;right:0;width:290px;height:100vh;background:rgba(5,10,20,0.94);
  border-left:1px solid #1a2a3a;overflow-y:auto;padding:12px;z-index:10}
  h3{color:#5af;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;
  border-bottom:1px solid #1a2a3a;padding:6px 0 4px;margin:10px 0 6px}
  h3:first-child{margin-top:0}
  .row{display:flex;align-items:center;gap:6px;margin:3px 0;min-height:22px}
  label{font-size:11px;color:#8ab;flex:1;white-space:nowrap}
  input[type=color]{width:34px;height:22px;border:1px solid #334;padding:1px;
  cursor:pointer;background:#111;border-radius:2px;flex-shrink:0}
  input[type=range]{flex:1;accent-color:#5af;cursor:pointer}
  input[type=checkbox]{width:15px;height:15px;cursor:pointer;accent-color:#5af}
  .val{font-size:10px;color:#7cf;min-width:48px;text-align:right;flex-shrink:0}
  .presets{display:flex;gap:4px;margin-bottom:10px}
  .pbtn{flex:1;padding:5px 2px;font-size:10px;font-family:monospace;
  background:#0a1a2a;border:1px solid #234;color:#7af;cursor:pointer;border-radius:3px;
  transition:background .15s}
  .pbtn:hover,.pbtn.active{background:#1a3a5a;border-color:#5af;color:#fff}
  .tone-row{display:flex;gap:3px;margin:4px 0}
  .tbtn{flex:1;padding:4px 2px;font-size:9px;font-family:monospace;
  background:#0a1020;border:1px solid #234;color:#8ab;cursor:pointer;border-radius:2px}
  .tbtn.active{background:#1a2a4a;border-color:#5af;color:#fff}
  .copybtn{width:100%;padding:7px;font-size:11px;font-family:monospace;
  background:#0a2a0a;border:1px solid #2a4a2a;color:#7f7;cursor:pointer;
  border-radius:3px;margin-top:10px;transition:background .15s}
  .copybtn:hover{background:#1a3a1a}
  #output{font-size:9px;color:#9f9;background:#050f05;border:1px solid #1a3a1a;
  padding:6px;margin-top:6px;border-radius:3px;white-space:pre;
  max-height:160px;overflow-y:auto;display:none;line-height:1.5}
  .sep{height:1px;background:#1a2a3a;margin:4px 0}
  .hint{font-size:9px;color:#567;margin-top:4px;line-height:1.4}
  </style>
  </head><body>
  <canvas id="cv"></canvas>
  <div id="panel">
  <div style="font-size:13px;color:#7cf;font-weight:bold;margin-bottom:8px">🌊 Debug: Mar</div>

  <div class="presets" id="presets-row"></div>

  <h3>🌌 Céu &amp; Fundo</h3>
  <div class="row"><label>bgColor</label><input type="color" id="bgColor"><span class="val" id="bgColorV"></span></div>
  <div class="row"><label>fogColor</label><input type="color" id="fogColor"><span class="val" id="fogColorV"></span></div>
  <div class="row"><label>fogDensity</label><input type="range" id="fogDensity" min="0" max="0.03" step="0.0001"><span class="val" id="fogDensityV"></span></div>

  <h3>💡 Luz Ambiente</h3>
  <div class="row"><label>ambientColor</label><input type="color" id="ambientColor"><span class="val" id="ambientColorV"></span></div>
  <div class="row"><label>Intensidade</label><input type="range" id="ambientIntensity" min="0" max="4" step="0.05"><span class="val" id="ambientIntensityV"></span></div>

  <h3>☀️ Sol</h3>
  <div class="row"><label>sunColor</label><input type="color" id="sunColor"><span class="val" id="sunColorV"></span></div>
  <div class="row"><label>Intensidade</label><input type="range" id="sunIntensity" min="0" max="6" step="0.1"><span class="val" id="sunIntensityV"></span></div>

  <h3>🌊 Oceano</h3>
  <div class="row"><label>ocean1 (cristas)</label><input type="color" id="ocean1"><span class="val" id="ocean1V"></span></div>
  <div class="row"><label>ocean2 (vales)</label><input type="color" id="ocean2"><span class="val" id="ocean2V"></span></div>

  <h3>✨ Extras</h3>
  <div class="row"><label>hasMoon (lua)</label><input type="checkbox" id="hasMoon"></div>
  <div class="row"><label>hasDenseNebula (estrelas)</label><input type="checkbox" id="hasDenseNebula"></div>

  <h3>🎛️ Tone Mapping</h3>
  <div class="tone-row">
      <button class="tbtn" id="tm-aces"     onclick="setTone('aces')">ACES</button>
      <button class="tbtn" id="tm-reinhard" onclick="setTone('reinhard')">Reinhard</button>
      <button class="tbtn" id="tm-linear"   onclick="setTone('linear')">Linear</button>
      <button class="tbtn" id="tm-none"     onclick="setTone('none')">Nenhum</button>
  </div>
  <div class="row" style="margin-top:4px">
      <label>Exposure</label>
      <input type="range" id="exposure" min="0.1" max="2.5" step="0.05" value="0.9">
      <span class="val" id="exposureV">0.90</span>
  </div>
  <p class="hint">💡 Se o mapa estiver vermelho, tente trocar o tone mapping</p>

  <button class="copybtn" onclick="copyConsts()">📋 Copiar como constants.js</button>
  <pre id="output"></pre>
  </div>

  <script type="importmap">
  {"imports":{"three":"https://unpkg.com/three@0.128.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.128.0/examples/jsm/"}}
  </script>
  <script type="module">
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

  // ── Presets vindos direto do server (MAP_DEFS) ────────────────────
  const PRESETS = ${JSON.stringify(presets)};
  const OCEAN_VERT = ${JSON.stringify(glslOceanVert)};
  const OCEAN_FRAG = ${JSON.stringify(glslOceanFrag)};
  const SKY_VERT   = ${JSON.stringify(glslSkyVert)};
  const SKY_FRAG   = ${JSON.stringify(glslSkyFrag)};

  // ── Renderer ──────────────────────────────────────────────────────
  const canvas = document.getElementById('cv');
  const W = () => window.innerWidth - 290;
  const H = () => window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(W(), H());
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1628);
  scene.fog = new THREE.FogExp2(0x0a1628, 0.002);

  const camera = new THREE.PerspectiveCamera(60, W()/H(), 0.1, 2000);
  camera.position.set(0, 80, 160);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  // ── Luzes ─────────────────────────────────────────────────────────
  const ambient = new THREE.AmbientLight(0x2244aa, 0.8);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffd080, 2.5);
  sun.position.set(100, 200, 80);
  sun.castShadow = true;
  scene.add(sun);

  const fillLight = new THREE.DirectionalLight(0x4488cc, 0.6);
  fillLight.position.set(-80, 60, -100);
  scene.add(fillLight);

  // ── Lua ───────────────────────────────────────────────────────────
  const moonMesh = new THREE.Mesh(
  new THREE.SphereGeometry(12, 16, 16),
  new THREE.MeshStandardMaterial({ color: 0xdde8ff, emissive: 0xaabbee, emissiveIntensity: 0.6 })
  );
  moonMesh.position.set(-200, 280, -400);
  moonMesh.visible = false;
  scene.add(moonMesh);

  const moonLight = new THREE.PointLight(0x8899cc, 0, 600);
  moonLight.position.copy(moonMesh.position);
  scene.add(moonLight);

  // ── Estrelas (nebula) ─────────────────────────────────────────────
  const starBuf = new Float32Array(600 * 3);
  for (let i = 0; i < 600; i++) {
  const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * 0.5;
  const r  = 800 + Math.random() * 200;
  starBuf[i*3]   = r * Math.sin(ph) * Math.cos(th);
  starBuf[i*3+1] = Math.abs(r * Math.cos(ph)) + 80;
  starBuf[i*3+2] = r * Math.sin(ph) * Math.sin(th);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starBuf, 3));
  const nebulaParticles = new THREE.Points(starGeo,
  new THREE.PointsMaterial({ color: 0xddeeff, size: 2.5, transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true }));
  nebulaParticles.visible = false;
  scene.add(nebulaParticles);

  // ── Névoa do chão ─────────────────────────────────────────────────
  const mistBuf = new Float32Array(80 * 3);
  for (let i = 0; i < 80; i++) {
  mistBuf[i*3]   = (Math.random() - 0.5) * 2200;
  mistBuf[i*3+1] = 1.5 + Math.random() * 4;
  mistBuf[i*3+2] = (Math.random() - 0.5) * 2200;
  }
  const mistGeo = new THREE.BufferGeometry();
  mistGeo.setAttribute('position', new THREE.BufferAttribute(mistBuf, 3));
  const mistParticles = new THREE.Points(mistGeo,
  new THREE.PointsMaterial({ color: 0x334466, size: 28, transparent: true, opacity: 0.12, depthWrite: false, sizeAttenuation: true }));
  mistParticles.visible = false;
  scene.add(mistParticles);

  // ── Oceano ────────────────────────────────────────────────────────
  const waveU = {
  uTime:   { value: 0 },
  uColor1: { value: new THREE.Color(0x0a3060) },
  uColor2: { value: new THREE.Color(0x0d1f3c) },
  };
  const oceanMat = new THREE.ShaderMaterial({ uniforms: waveU, vertexShader: OCEAN_VERT, fragmentShader: OCEAN_FRAG });
  const oceanMesh = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400, 64, 64), oceanMat);
  oceanMesh.rotation.x = -Math.PI / 2;
  scene.add(oceanMesh);

  // ── Céu ───────────────────────────────────────────────────────────
  const skyU = { uTime: waveU.uTime, uBgColor: { value: new THREE.Color(0x0a1628) } };
  const skyMat = new THREE.ShaderMaterial({ side: THREE.BackSide, uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), skyMat));

  // ── Referência visual (navio simplificado) ────────────────────────
  const shipHull = new THREE.Mesh(
  new THREE.BoxGeometry(6, 2.5, 18),
  new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.8 })
  );
  shipHull.position.y = 1.2;
  shipHull.castShadow = true;
  scene.add(shipHull);

  const mastGeo = new THREE.CylinderGeometry(0.2, 0.2, 18, 8);
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x4a3010 });
  const mast = new THREE.Mesh(mastGeo, mastMat);
  mast.position.set(0, 11.5, 0);
  scene.add(mast);

  const sailMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 12),
  new THREE.MeshStandardMaterial({ color: 0xeeddbb, side: THREE.DoubleSide, roughness: 0.9 })
  );
  sailMesh.position.set(0, 12, 0);
  sailMesh.castShadow = true;
  scene.add(sailMesh);

  // ── Animação ──────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  waveU.uTime.value = t * 0.5;
  shipHull.position.y = 1.2 + Math.sin(t * 0.6) * 0.4;
  shipHull.rotation.z = Math.sin(t * 0.5) * 0.03;
  mast.position.y     = shipHull.position.y + 10.3;
  sailMesh.position.y = shipHull.position.y + 11;
  if (moonMesh.visible) {
      moonMesh.material.emissiveIntensity = 0.5 + Math.sin(t * 0.4) * 0.15;
      moonLight.intensity = 1.0 + Math.sin(t * 0.4) * 0.2;
  }
  controls.update();
  renderer.render(scene, camera);
  }
  animate();

  // ── Redimensionar ─────────────────────────────────────────────────
  window.addEventListener('resize', () => {
  camera.aspect = W() / H();
  camera.updateProjectionMatrix();
  renderer.setSize(W(), H());
  });

  // ── Aplicar visual ────────────────────────────────────────────────
  function applyVisual(v) {
  scene.background.set(v.bgColor);
  scene.fog.color.set(v.fogColor);
  scene.fog.density = v.fogDensity;
  waveU.uColor1.value.set(v.ocean1);
  waveU.uColor2.value.set(v.ocean2);
  skyU.uBgColor.value.set(v.bgColor);
  ambient.color.set(v.ambientColor);
  ambient.intensity = v.ambientIntensity;
  sun.color.set(v.sunColor);
  sun.intensity = v.sunIntensity;
  moonMesh.visible    = v.hasMoon;
  moonLight.intensity = v.hasMoon ? 1.2 : 0;
  nebulaParticles.visible = v.hasDenseNebula;
  mistParticles.visible   = v.hasDenseNebula;
  }

  // ── Ler UI ────────────────────────────────────────────────────────
  function getUI() {
  const c = id => document.getElementById(id);
  return {
      bgColor:          c('bgColor').value,
      fogColor:         c('fogColor').value,
      fogDensity:       parseFloat(c('fogDensity').value),
      ambientColor:     c('ambientColor').value,
      ambientIntensity: parseFloat(c('ambientIntensity').value),
      sunColor:         c('sunColor').value,
      sunIntensity:     parseFloat(c('sunIntensity').value),
      ocean1:           c('ocean1').value,
      ocean2:           c('ocean2').value,
      hasMoon:          c('hasMoon').checked,
      hasDenseNebula:   c('hasDenseNebula').checked,
  };
  }

  function setVal(id, v) {
  const el = document.getElementById(id + 'V');
  if (!el) return;
  if (typeof v === 'number') el.textContent = v < 1 ? v.toFixed(4) : v.toFixed(2);
  else el.textContent = v;
  }

  function setUI(v) {
  const keys = ['bgColor','fogColor','ambientColor','sunColor','ocean1','ocean2'];
  keys.forEach(k => { document.getElementById(k).value = v[k]; setVal(k, v[k]); });
  const nums = ['fogDensity','ambientIntensity','sunIntensity'];
  nums.forEach(k => { document.getElementById(k).value = v[k]; setVal(k, v[k]); });
  document.getElementById('hasMoon').checked        = v.hasMoon;
  document.getElementById('hasDenseNebula').checked = v.hasDenseNebula;
  }

  // ── Tone mapping ──────────────────────────────────────────────────
  const TM_MAP = {
  aces:     THREE.ACESFilmicToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  linear:   THREE.LinearToneMapping,
  none:     THREE.NoToneMapping,
  };
  window.setTone = function(mode) {
  renderer.toneMapping = TM_MAP[mode] || THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = parseFloat(document.getElementById('exposure').value);
  oceanMat.needsUpdate = true; skyMat.needsUpdate = true;
  document.querySelectorAll('.tbtn').forEach(b => b.classList.remove('active'));
  document.getElementById('tm-' + mode).classList.add('active');
  };

  // ── Presets ───────────────────────────────────────────────────────
  const presetsRow = document.getElementById('presets-row');
  Object.entries(PRESETS).forEach(function(entry) {
  const n = entry[0], p = entry[1];
  const btn = document.createElement('button');
  btn.className = 'pbtn';
  btn.id = 'pb' + n;
  btn.textContent = 'Mapa ' + n;
  btn.title = p.name;
  btn.onclick = function() { applyPreset(Number(n)); };
  presetsRow.appendChild(btn);
  });

  window.applyPreset = function(n) {
  const p = PRESETS[n]; if (!p) return;
  setUI(p);
  applyVisual(p);
  document.querySelectorAll('.pbtn').forEach(b => b.classList.remove('active'));
  const pb = document.getElementById('pb' + n);
  if (pb) pb.classList.add('active');
  };

  // ── Copiar como constants.js ──────────────────────────────────────
  function to0x(hex) { return '0x' + hex.replace('#','').toLowerCase(); }

  window.copyConsts = function() {
  const v = getUI();
  const lines = [
      'visual: {',
      '  bgColor:          ' + to0x(v.bgColor)      + ',',
      '  fogColor:         ' + to0x(v.fogColor)      + ',',
      '  fogDensity:       ' + v.fogDensity          + ',',
      '  ambientColor:     ' + to0x(v.ambientColor)  + ',',
      '  ambientIntensity: ' + v.ambientIntensity     + ',',
      '  sunColor:         ' + to0x(v.sunColor)       + ',',
      '  sunIntensity:     ' + v.sunIntensity         + ',',
      '  ocean1:           ' + to0x(v.ocean1)         + ',',
      '  ocean2:           ' + to0x(v.ocean2)         + ',',
      '  hasMoon:          ' + v.hasMoon              + ',',
      '  hasDenseNebula:   ' + v.hasDenseNebula       + ',',
      '},',
  ];
  const txt = lines.join('\\n');
  const out = document.getElementById('output');
  out.textContent = txt;
  out.style.display = 'block';
  if (navigator.clipboard) navigator.clipboard.writeText(txt);
  };

  // ── Wire all inputs → live update ─────────────────────────────────
  document.querySelectorAll('#panel input').forEach(function(inp) {
  inp.addEventListener('input', function() {
      setVal(inp.id, inp.type === 'color' ? inp.value : parseFloat(inp.value));
      if (inp.id === 'exposure') {
      renderer.toneMappingExposure = parseFloat(inp.value);
      return;
      }
      applyVisual(getUI());
  });
  });

  // Inicializa com Mapa 1 + ACES como padrão do jogo
  applyPreset(1);
  setTone('aces');

  </script>
  </body></html>`);
});

app.listen(PORT, () => {
  console.log(`🔧 Debug server on http://localhost:${PORT}`);
});