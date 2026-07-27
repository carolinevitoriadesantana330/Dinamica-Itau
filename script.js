/* ============================================================
   CONFIGURAÇÃO DO SUPABASE
   Troque pelos dados do SEU projeto:
   Supabase > Project Settings > API > Project URL / anon public key
============================================================ */
const SUPABASE_URL = 'https://azwnhychxfpwpbobvoip.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1uphWuzAbz9unMX9j75PEg_w1pp-LOG';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ============================================================
   LIMITES DO JOGO
============================================================ */
const MAX_GRUPOS = 20;
const TAMANHO_PADRAO = 10; // máximo de pilotos por grupo
const TEMPO_APRESENTACAO = 60; // segundos de cronômetro por apresentador

/* ============================================================
   CAMADA DE ARMAZENAMENTO
   Imita a API window.storage (get/set/list/delete), gravando na
   tabela "app_storage" do Supabase. Inclui retry automático para
   aguentar várias telas gravando/lendo ao mesmo tempo (até 20
   grupos jogando simultaneamente) sem que um erro de rede solto
   derrube a experiência.
============================================================ */
async function comRetry(fn, tentativas = 3, esperaMs = 500) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimoErro = e;
      if (i < tentativas - 1) {
        await new Promise(res => setTimeout(res, esperaMs * (i + 1)));
      }
    }
  }
  throw ultimoErro;
}

const storage = {
  async get(key) {
    return comRetry(async () => {
      const { data, error } = await supabaseClient
        .from('app_storage')
        .select('value')
        .eq('key', key)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { key, value: JSON.stringify(data.value) };
    });
  },
  async set(key, value) {
    return comRetry(async () => {
      const parsedValue = JSON.parse(value);
      const { error } = await supabaseClient
        .from('app_storage')
        .upsert({ key, value: parsedValue, updated_at: new Date().toISOString() });
      if (error) throw error;
      return { key, value };
    });
  },
  async delete(key) {
    return comRetry(async () => {
      const { error } = await supabaseClient
        .from('app_storage')
        .delete()
        .eq('key', key);
      if (error) throw error;
      return { key, deleted: true };
    });
  },
  async list(prefix) {
    return comRetry(async () => {
      let query = supabaseClient.from('app_storage').select('key');
      if (prefix) query = query.like('key', `${prefix}%`);
      const { data, error } = await query;
      if (error) throw error;
      return { keys: (data || []).map(row => row.key) };
    });
  }
};

/* ============================================================
   ACESSO DE ADMINISTRADOR (para esconder o botão "Dar largada")
   Troque 'itau-spod-2026' por um código só seu antes do evento.
   Para virar admin no SEU celular/notebook, abra o app UMA vez com:
     https://SEU-LINK/index.html?admin=itau-spod-2026
   Depois disso o app lembra (localStorage) e o botão de largada
   só aparece nesse aparelho. Ninguém mais verá esse botão.
============================================================ */
const CODIGO_ADMIN = 'itau-spod-2026';
function souAdmin(){
  try{
    const params = new URLSearchParams(window.location.search);
    if(params.get('admin') === CODIGO_ADMIN){
      localStorage.setItem('spod_admin', '1');
    }
    return localStorage.getItem('spod_admin') === '1';
  }catch(e){
    return false; // se localStorage falhar (modo privado etc.), nunca mostra o botão por padrão
  }
}

/* ============================================================
   ESCAPE DE HTML
   Nomes são digitados pelos próprios participantes e depois são
   exibidos para todo mundo (pódio, painel geral). Sem escapar,
   alguém poderia digitar algo como <script> ou "><img ...> no
   campo de nome e quebrar/injetar código na tela de todos.
============================================================ */
function escaparHtml(txt){
  const div = document.createElement('div');
  div.textContent = String(txt);
  return div.innerHTML;
}

/* ============================================================
   NAVEGAÇÃO
============================================================ */
function irPara(tela){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('ativo'));
  document.getElementById('tela-'+tela).classList.add('ativo');
  const titulos = {
    'home': ['Plenária SPOD','· Itaú · '],
    'cadastro': ['Cadastrar meus pilotos','Digite o nome e sobrenome de todos'],
    'jogar-selecionar': ['Ligue os Motores','Escolha o número do grupo'],
    'jogo': ['Rodada em andamento','Marque acertou / errou'],
    'resultado-selecionar': ['Pódio do Grupo','Escolha o número do grupo'],
    'resultado-grupo': ['Pódio do Grupo','Ranking de acertos e erros'],
    'painel': ['Pódio SPOD 🥇🥈🥉','Todos os grupos · tempo real']
  };
  document.getElementById('tituloTopo').textContent = titulos[tela][0];
  document.getElementById('subTopo').textContent = titulos[tela][1];
  document.getElementById('btnVoltar').style.display = tela==='home' ? 'none' : 'flex';
  pararCronometro();
  pararEsperaLargada();
  pararPainelAutoRefresh();
}

/* ---------------- VALIDAÇÃO DE NOME + SOBRENOME ---------------- */
function nomeValido(nome){
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  return partes.length >= 2;
}

/* ---------------- VALIDAÇÃO DE NÚMERO DE GRUPO ---------------- */
function grupoNumValido(n){
  const num = parseInt(n, 10);
  return Number.isInteger(num) && num >= 1 && num <= MAX_GRUPOS;
}

/* ---------------- CADASTRO ---------------- */
let cadNomes = [];

function renderCampos(){
  const wrap = document.getElementById('cadCampos');
  wrap.innerHTML = '';
  cadNomes.forEach((nome, i)=>{
    const div = document.createElement('div');
    div.className = 'campo-nome';
    div.innerHTML = `
      <div class="num">${i+1}</div>
      <input type="text" placeholder="Nome e sobrenome (ex: Ana Pereira)" value="${nome.replace(/"/g,'&quot;')}" oninput="cadNomes[${i}]=this.value">
      <button class="lixeira" onclick="removerCampo(${i})">✕</button>
    `;
    wrap.appendChild(div);
  });
  const btnAdd = document.getElementById('btnAdicionarPessoa');
  if(btnAdd) btnAdd.disabled = cadNomes.length >= TAMANHO_PADRAO;
}
function adicionarCampoNome(){
  if(cadNomes.length >= TAMANHO_PADRAO){
    document.getElementById('cadStatus').innerHTML = '<div class="aviso">Cada grupo pode ter no máximo ' + TAMANHO_PADRAO + ' pilotos.</div>';
    return;
  }
  cadNomes.push('');
  renderCampos();
}
function removerCampo(i){
  cadNomes.splice(i,1);
  renderCampos();
}
function inicializarCadastro(){
  cadNomes = new Array(2).fill('');
  renderCampos();
  document.getElementById('cadStatus').innerHTML = '';
}

async function carregarCadastroExistente(){
  const nInput = document.getElementById('cadGrupoNum').value;
  const status = document.getElementById('cadStatus');
  status.innerHTML = '';
  if(!nInput) return;
  if(!grupoNumValido(nInput)){
    status.innerHTML = '<div class="aviso">O número do grupo deve ser de 1 a ' + MAX_GRUPOS + '.</div>';
    cadNomes = new Array(2).fill('');
    renderCampos();
    return;
  }
  const n = parseInt(nInput, 10);
  status.innerHTML = '<div class="spinner"></div>';
  try{
    const r = await storage.get('grupo:' + n + ':membros');
    if(r && r.value){
      cadNomes = JSON.parse(r.value);
      if(cadNomes.length < 2){
        while(cadNomes.length < 2) cadNomes.push('');
      }
    } else {
      cadNomes = new Array(2).fill('');
    }
    status.innerHTML = '';
  }catch(e){
    cadNomes = new Array(2).fill('');
    status.innerHTML = '<div class="aviso">Não consegui carregar esse grupo agora. Você pode continuar digitando e tentar salvar novamente.</div>';
  }
  renderCampos();
}

async function salvarGrupo(){
  const nInput = document.getElementById('cadGrupoNum').value;
  const status = document.getElementById('cadStatus');
  if(!nInput){ status.innerHTML = '<div class="aviso">Informe o número do grupo.</div>'; return; }
  if(!grupoNumValido(nInput)){
    status.innerHTML = '<div class="aviso">O número do grupo deve ser de 1 a ' + MAX_GRUPOS + '.</div>';
    return;
  }
  const n = parseInt(nInput, 10);
  const nomes = cadNomes.map(x=>x.trim()).filter(x=>x.length>0);

  if(nomes.length < 2){ status.innerHTML = '<div class="aviso">Cadastre pelo menos 2 pessoas.</div>'; return; }
  if(nomes.length > TAMANHO_PADRAO){ status.innerHTML = '<div class="aviso">Cada grupo pode ter no máximo ' + TAMANHO_PADRAO + ' pilotos.</div>'; return; }

  const nomesInvalidos = nomes.filter(nm => !nomeValido(nm));
  if(nomesInvalidos.length > 0){
    status.innerHTML = '<div class="aviso">Digite nome <strong>e</strong> sobrenome de cada piloto (ex: "Ana Pereira"). Corrija: ' + nomesInvalidos.join(', ') + '</div>';
    return;
  }

  // Nomes duplicados no mesmo grupo quebram a contagem de acertos/erros (o app usa
  // o nome como identificador único dentro do grupo), então bloqueamos aqui.
  const nomesNormalizados = nomes.map(nm => nm.trim().toLowerCase().replace(/\s+/g,' '));
  const duplicados = nomesNormalizados.filter((nm, i) => nomesNormalizados.indexOf(nm) !== i);
  if(duplicados.length > 0){
    status.innerHTML = '<div class="aviso">Há nomes repetidos nesse grupo. Se houver duas pessoas com o mesmo nome, peça para uma delas incluir o sobrenome completo ou uma inicial do meio para diferenciar.</div>';
    return;
  }

  status.innerHTML = '<div class="spinner"></div>';
  try{
    await storage.set('grupo:' + n + ':membros', JSON.stringify(nomes));
    status.innerHTML = '<div class="aviso">✅ Grupo ' + n + ' salvo com ' + nomes.length + ' pessoas!</div>';
  }catch(e){
    status.innerHTML = '<div class="aviso">Erro ao salvar. Verifique a conexão e tente novamente.</div>';
  }
}

/* ---------------- ESTADO GLOBAL DO JOGO (LARGADA) ---------------- */
// Chave única 'jogo:estado' controlada pelo admin no Painel Geral.
// Enquanto iniciado=false, nenhum grupo consegue entrar na tela de jogo.
async function lerEstadoJogo(){
  try{
    const r = await storage.get('jogo:estado');
    if(r && r.value) return JSON.parse(r.value);
  }catch(e){}
  return { iniciado:false };
}
async function darLargada(){
  const btn = document.getElementById('btnLargada');
  if(btn) btn.disabled = true;
  try{
    await storage.set('jogo:estado', JSON.stringify({ iniciado:true, ts: Date.now() }));
  }catch(e){
    alert('Não consegui dar a largada agora. Tente novamente.');
  }
  await abrirPainel();
}
async function resetarLargada(){
  if(!confirm('Isso vai travar TODOS os grupos de volta na tela de espera, mesmo quem já está jogando. Tem certeza?')) return;
  try{
    await storage.set('jogo:estado', JSON.stringify({ iniciado:false, ts: Date.now() }));
  }catch(e){}
  await abrirPainel();
}

let esperaLargadaId = null;
function pararEsperaLargada(){
  if(esperaLargadaId){ clearInterval(esperaLargadaId); esperaLargadaId = null; }
}

let painelAutoRefreshId = null;
function pararPainelAutoRefresh(){
  if(painelAutoRefreshId){ clearInterval(painelAutoRefreshId); painelAutoRefreshId = null; }
}

/* ---------------- JOGO ---------------- */
let jogoGrupo = null;
let jogoMembros = [];
let jogoApresentadorIdx = 0;
let jogoTally = {}; // nome -> {acertos, erros}
let jogoMarcacaoAtual = {}; // nome ouvinte -> 'acerto'|'erro'|null
let cronometroId = null;
let cronometroRestante = TEMPO_APRESENTACAO;

function pararCronometro(){
  if(cronometroId){ clearInterval(cronometroId); cronometroId = null; }
}

async function iniciarJogo(){
  const nInput = document.getElementById('jogarGrupoNum').value;
  const erroEl = document.getElementById('jogarSelecionarErro');
  erroEl.innerHTML = '';
  if(!nInput){ erroEl.innerHTML = '<div class="aviso">Informe o número do grupo.</div>'; return; }
  if(!grupoNumValido(nInput)){
    erroEl.innerHTML = '<div class="aviso">O número do grupo deve ser de 1 a ' + MAX_GRUPOS + '.</div>';
    return;
  }
  const n = parseInt(nInput, 10);
  erroEl.innerHTML = '<div class="spinner"></div>';
  try{
    const estado = await lerEstadoJogo();
    if(!estado.iniciado){
      // Ainda não houve a largada geral: espera e verifica de novo periodicamente.
      erroEl.innerHTML = '<div class="aviso">🏁 Aguardando a largada do administrador. Assim que ela for dada, a corrida começa automaticamente aqui.</div>';
      pararEsperaLargada();
      esperaLargadaId = setInterval(async ()=>{
        const est2 = await lerEstadoJogo();
        if(est2.iniciado){
          pararEsperaLargada();
          erroEl.innerHTML = '';
          await carregarECarregarJogo(n, erroEl);
        }
      }, 4000);
      return;
    }
    await carregarECarregarJogo(n, erroEl);
  }catch(e){
    erroEl.innerHTML = '<div class="aviso">Erro ao verificar a largada. Tente novamente.</div>';
  }
}

async function carregarECarregarJogo(n, erroEl){
  try{
    const r = await storage.get('grupo:' + n + ':membros');
    if(!r || !r.value){
      erroEl.innerHTML = '<div class="aviso">Esse grupo ainda não foi cadastrado. Volte à etapa 1.</div>';
      return;
    }
    jogoMembros = JSON.parse(r.value);
    if(jogoMembros.length < 2){
      erroEl.innerHTML = '<div class="aviso">Esse grupo precisa de pelo menos 2 pessoas cadastradas.</div>';
      return;
    }
    jogoGrupo = n;
    jogoApresentadorIdx = 0;
    jogoTally = {};
    jogoMembros.forEach(m => jogoTally[m] = {acertos:0, erros:0});
    erroEl.innerHTML = '';
    irPara('jogo');
    renderApresentador();
  }catch(e){
    erroEl.innerHTML = '<div class="aviso">Erro ao carregar o grupo. Tente novamente.</div>';
  }
}

function renderApresentador(){
  const total = jogoMembros.length;
  const apresentador = jogoMembros[jogoApresentadorIdx];
  document.getElementById('jogoProgressoTxt').textContent = 'Apresentador ' + (jogoApresentadorIdx+1) + ' de ' + total;
  document.getElementById('jogoGrupoTxt').textContent = 'Grupo ' + jogoGrupo;
  document.getElementById('jogoBarra').style.width = ((jogoApresentadorIdx)/total*100)+'%';
  document.getElementById('jogoApresentador').textContent = apresentador;

  const ouvintes = jogoMembros.filter(m => m !== apresentador);
  jogoMarcacaoAtual = {};
  ouvintes.forEach(o => jogoMarcacaoAtual[o] = null);

  const wrap = document.getElementById('jogoOuvintes');
  wrap.innerHTML = '';
  ouvintes.forEach(nome=>{
    const div = document.createElement('div');
    div.className = 'ouvinte';
    const safeId = nome.replace(/[^a-zA-Z0-9]/g,'_');
    div.innerHTML = `
      <div class="nome">${escaparHtml(nome)}</div>
      <div class="par-botoes">
        <button class="toggle acerto" id="ac_${safeId}" onclick="marcar('${nome.replace(/'/g,"\\'")}','acerto')">✓ Acertou</button>
        <button class="toggle erro" id="er_${safeId}" onclick="marcar('${nome.replace(/'/g,"\\'")}','erro')">✕ Errou</button>
      </div>
    `;
    wrap.appendChild(div);
  });
  atualizarBotaoProximo();
  iniciarCronometro();
  jogoAvancando = false;
}

function iniciarCronometro(){
  pararCronometro();
  cronometroRestante = TEMPO_APRESENTACAO;
  atualizarCronometroTexto();
  cronometroId = setInterval(()=>{
    cronometroRestante--;
    atualizarCronometroTexto();
    if(cronometroRestante <= 0){
      pararCronometro();
      proximoApresentador();
    }
  }, 1000);
}

function atualizarCronometroTexto(){
  const el = document.getElementById('jogoCronometro');
  if(!el) return;
  const restante = Math.max(cronometroRestante,0);
  const min = Math.floor(restante / 60);
  const seg = restante % 60;
  el.textContent = '⏱️ ' + min + ':' + seg.toString().padStart(2,'0');
  el.classList.toggle('cronometro-alerta', cronometroRestante <= 10);
}

function marcar(nome, tipo){
  jogoMarcacaoAtual[nome] = tipo;
  const safeId = nome.replace(/[^a-zA-Z0-9]/g,'_');
  document.getElementById('ac_'+safeId).classList.toggle('on', tipo==='acerto');
  document.getElementById('er_'+safeId).classList.toggle('on', tipo==='erro');
  atualizarBotaoProximo();
}

function atualizarBotaoProximo(){
  const btn = document.getElementById('btnProximoApresentador');
  // O cronômetro já força o avanço automático; o botão fica liberado pra quem terminar antes do tempo.
  btn.disabled = false;
  const ultimo = jogoApresentadorIdx === jogoMembros.length - 1;
  btn.textContent = ultimo ? 'Finalizar grupo' : 'Próximo apresentador ⏭️';
}

let jogoAvancando = false; // trava para o clique manual e o disparo automático do cronômetro não avançarem 2x
async function proximoApresentador(){
  if(jogoAvancando) return;
  jogoAvancando = true;
  pararCronometro();
  Object.entries(jogoMarcacaoAtual).forEach(([nome, tipo])=>{
    if(tipo === 'acerto') jogoTally[nome].acertos++;
    else if(tipo === 'erro') jogoTally[nome].erros++;
  });

  if(jogoApresentadorIdx === jogoMembros.length - 1){
    await finalizarGrupo();
    jogoAvancando = false;
  } else {
    jogoApresentadorIdx++;
    renderApresentador(); // renderApresentador libera jogoAvancando de novo
  }
}

async function finalizarGrupo(){
  document.getElementById('jogoOuvintes').innerHTML = '<div class="spinner"></div>';
  const resultado = {
    grupo: jogoGrupo,
    porPessoa: jogoTally,
    finalizado: true,
    ts: Date.now()
  };
  try{
    await storage.set('grupo:' + jogoGrupo + ':resultado', JSON.stringify(resultado));
  }catch(e){
    // Não pode falhar em silêncio: sem isso o grupo acha que terminou, mas o resultado
    // nunca chega ao painel geral. Mantemos na mesma tela e deixamos tentar de novo.
    document.getElementById('jogoOuvintes').innerHTML = `
      <div class="aviso">⚠️ Não consegui salvar o resultado final do Grupo ${jogoGrupo}. Verifique a internet e toque em "Tentar salvar de novo" antes de sair dessa tela — se sair agora, o resultado deste grupo pode não aparecer no pódio.</div>
      <button class="btn" onclick="finalizarGrupo()">🔁 Tentar salvar de novo</button>
    `;
    document.getElementById('btnProximoApresentador').style.display = 'none';
    return;
  }
  mostrarResultadoNaTela(resultado);
  irPara('resultado-grupo');
}

/* ---------------- RESULTADO DE UM GRUPO ---------------- */
async function verResultadoGrupo(){
  const nInput = document.getElementById('resGrupoNum').value;
  const erroEl = document.getElementById('resSelecionarErro');
  if(!nInput){ erroEl.innerHTML = '<div class="aviso">Informe o número do grupo.</div>'; return; }
  if(!grupoNumValido(nInput)){
    erroEl.innerHTML = '<div class="aviso">O número do grupo deve ser de 1 a ' + MAX_GRUPOS + '.</div>';
    return;
  }
  const n = parseInt(nInput, 10);
  erroEl.innerHTML = '<div class="spinner"></div>';
  try{
    const r = await storage.get('grupo:' + n + ':resultado');
    if(!r || !r.value){
      erroEl.innerHTML = '<div class="aviso">Esse grupo ainda não finalizou a dinâmica.</div>';
      return;
    }
    erroEl.innerHTML = '';
    const resultado = JSON.parse(r.value);
    mostrarResultadoNaTela(resultado);
    irPara('resultado-grupo');
  }catch(e){
    erroEl.innerHTML = '<div class="aviso">Grupo não encontrado.</div>';
  }
}

function mostrarResultadoNaTela(resultado){
  const pessoas = Object.entries(resultado.porPessoa).map(([nome, v])=>{
    const total = v.acertos + v.erros;
    const pct = total > 0 ? Math.round((v.acertos/total)*100) : 0;
    return {nome, acertos:v.acertos, erros:v.erros, pct};
  });
  // Ranking por pessoa dentro do grupo: por % de acerto (todo mundo do mesmo grupo
  // ouve o mesmo número de apresentações, então % e total de acertos dão no mesmo —
  // mas usamos % para manter o mesmo critério do pódio individual global).
  pessoas.sort((a,b)=> b.pct - a.pct || b.acertos - a.acertos);

  const ranksGrupo = agruparPorEmpate(pessoas).slice(0,3);
  const pessoasComPosicao = comPosicoes(pessoas);

  let html = `
    <div class="secao-titulo">🏆 Pódio de pilotos · Grupo ${resultado.grupo}</div>
    ${renderPodioQuadriculado(ranksGrupo)}
    <div class="secao-titulo">Classificação completa · Grupo ${resultado.grupo}</div>
  `;
  pessoasComPosicao.forEach((p)=>{
    html += `
      <div class="ranking-item">
        <div class="pos">${p.posicao}º</div>
        <div class="info">
          <strong>${escaparHtml(p.nome)}</strong>
          <span>${p.acertos} acertos · ${p.erros} erros</span>
        </div>
        <div class="pill ${p.pct>=50?'verde':'vermelho'}">${p.pct}%</div>
      </div>
    `;
  });
  document.getElementById('resGrupoConteudo').innerHTML = html;
}

/* ---------------- EMPATE: agrupa uma lista já ordenada por % em "degraus" ----------------
   Pessoas/grupos com a mesma % ficam no mesmo degrau e sobem juntas no pódio —
   assim ninguém fica de fora só por causa da ordem de leitura dos dados. */
function agruparPorEmpate(listaOrdenadaPorPct){
  const degraus = [];
  listaOrdenadaPorPct.forEach(item=>{
    const ultimo = degraus[degraus.length-1];
    if(ultimo && ultimo[0].pct === item.pct){
      ultimo.push(item);
    } else {
      degraus.push([item]);
    }
  });
  return degraus;
}

/* ---------------- POSIÇÃO: numera uma lista ordenada por % respeitando empates ----------------
   Ranking padrão de corrida: quem empata divide a mesma posição (ex: 1º, 1º, 3º) em
   vez de ser separado arbitrariamente em 1º/2º só pela ordem de leitura dos dados. */
function comPosicoes(listaOrdenadaPorPct){
  let posicaoAtual = 0;
  let pctAnterior = null;
  return listaOrdenadaPorPct.map((item, idx)=>{
    if(pctAnterior === null || item.pct !== pctAnterior){
      posicaoAtual = idx + 1;
      pctAnterior = item.pct;
    }
    return Object.assign({}, item, { posicao: posicaoAtual });
  });
}

/* ---------------- BANDEIRA QUADRICULADA / PÓDIO (TOP 3 DEGRAUS, COM EMPATES) ----------------
   Recebe até 3 "degraus" (arrays de pessoas empatadas na mesma %), do 1º ao 3º lugar.
   Se houver empate, todas as pessoas daquela % aparecem juntas na mesma coluna. */
function renderPodioQuadriculado(degraus){
  if(!degraus || degraus.length === 0){
    return '<div class="vazio">Ainda sem dados suficientes para o pódio.</div>';
  }
  const grupo1 = degraus[0] || null;
  const grupo2 = degraus[1] || null;
  const grupo3 = degraus[2] || null;

  const coluna = (pessoas, posicao, classe) => {
    if(!pessoas || pessoas.length===0) return '<div class="podio-coluna ' + classe + '"><div class="podio-degrau ' + classe + '"></div></div>';
    const medalha = posicao===1 ? '🥇' : posicao===2 ? '🥈' : '🥉';
    const pct = pessoas[0].pct;
    // Empate: em vez de empilhar um <div> por nome (o que estourava a altura da coluna
    // quando muita gente empatava), os nomes viram "chips" numa faixa com rolagem
    // horizontal — a coluna nunca cresce verticalmente, só o conteúdo rola de lado.
    const nomesHtml = pessoas.length > 1
      ? `<div class="podio-nomes-scroll">${pessoas.map(p => `<span class="podio-chip">${escaparHtml(p.nome)}</span>`).join('')}</div>`
      : `<div class="podio-nome">${escaparHtml(pessoas[0].nome)}</div>`;
    return `
      <div class="podio-coluna ${classe}">
        <div class="podio-medalha">${medalha}</div>
        ${nomesHtml}
        <div class="podio-valor">${pct}% de acerto${pessoas.length>1 ? ' · '+pessoas.length+' empatados' : ''}</div>
        <div class="podio-degrau ${classe}">${posicao}º</div>
      </div>
    `;
  };

  return `
    <div class="podio-quadriculado">
      <div class="podio-bandeira topo"></div>
      <div class="podio-colunas">
        ${coluna(grupo2, 2, 'segundo')}
        ${coluna(grupo1, 1, 'primeiro')}
        ${coluna(grupo3, 3, 'terceiro')}
      </div>
      <div class="podio-bandeira base"></div>
    </div>
  `;
}

/* ---------------- PAINEL GERAL ---------------- */
// Chamado a cada 30s pelo auto-refresh: atualiza os dados do painel sem reiniciar a
// navegação nem piscar um spinner cheio de tela (importante pra quando o painel está
// projetado no telão sem ninguém tocando em nada).
async function atualizarPainelSilencioso(){
  if(!document.getElementById('tela-painel').classList.contains('ativo')) return;
  await abrirPainel(true);
}

async function abrirPainel(_silencioso){
  if(!_silencioso){
    irPara('painel'); // já limpa qualquer auto-refresh anterior
    pararPainelAutoRefresh();
    painelAutoRefreshId = setInterval(atualizarPainelSilencioso, 30000);
  }
  const conteudo = document.getElementById('painelConteudo');
  if(!_silencioso) conteudo.innerHTML = '<div class="spinner"></div>';
  try{
    const estado = await lerEstadoJogo();
    const lista = await storage.list('grupo:');
    const chaves = (lista && lista.keys) ? lista.keys : [];
    const chavesMembros = chaves.filter(k => k.endsWith(':membros'));
    const chavesResultado = chaves.filter(k => k.endsWith(':resultado'));
    const totalGruposCadastrados = chavesMembros.length;

    // ---- Painel do admin: contador de grupos + botão de largada ----
    // Só é montado (e só existe no HTML) se este aparelho tiver o carimbo de admin.
    let htmlAdmin = '';
    if(souAdmin()){
      htmlAdmin = `
        <div class="cartao admin-largada">
          <div class="secao-titulo" style="margin-top:0;">🎛️ Controle do administrador</div>
          <p style="font-size:13.5px;color:var(--tinta-suave);margin:0 0 12px;">
            ${totalGruposCadastrados} de ${MAX_GRUPOS} grupos já cadastraram pilotos.
          </p>
          ${estado.iniciado
            ? '<div class="aviso">🏁 Largada dada! Os grupos já podem jogar, cada apresentador com 1 minuto no cronômetro.</div><button class="btn secundario" onclick="resetarLargada()">↺ Resetar largada (nova rodada)</button>'
            : '<button class="btn" id="btnLargada" onclick="darLargada()">🏁 Dar a largada geral</button>'
          }
        </div>
      `;
    }

    if(chavesResultado.length === 0){
      conteudo.innerHTML = htmlAdmin + '<div class="vazio">Nenhum grupo finalizou a dinâmica ainda.<br>Assim que os grupos terminarem, os resultados aparecem aqui.</div>';
      return;
    }

    const resultados = [];
    for(const chave of chavesResultado){
      try{
        const r = await storage.get(chave);
        if(r && r.value) resultados.push(JSON.parse(r.value));
      }catch(e){}
    }

    // Agregação por grupo: ranking final por % de acerto do grupo.
    // Usamos % (não total bruto de acertos) porque grupos com mais gente geram mais
    // rodadas de pergunta/resposta — comparar por total absoluto favoreceria sempre
    // o grupo maior. % divide pelo total de rodadas de cada grupo, então fica justo
    // tanto para grupos pequenos quanto grandes.
    const grupos = resultados.map(res=>{
      let acertos=0, erros=0;
      Object.values(res.porPessoa).forEach(v=>{ acertos+=v.acertos; erros+=v.erros; });
      const total = acertos+erros;
      const pct = total>0 ? Math.round((acertos/total)*100) : 0;
      return {grupo: res.grupo, pct};
    });
    grupos.sort((a,b)=> b.pct - a.pct || a.grupo - b.grupo);
    const gruposComPosicao = comPosicoes(grupos);

    // Agregação por pessoa (global, entre todos os grupos), por % de acerto.
    // Também usamos % aqui pelo mesmo motivo: quem está num grupo de 10 ouve 9
    // apresentações, quem está num grupo de 2 ouve só 1 — comparar total bruto
    // penalizaria quem está em grupo pequeno. % normaliza essa diferença.
    const pessoas = [];
    resultados.forEach(res=>{
      Object.entries(res.porPessoa).forEach(([nome, v])=>{
        const total = v.acertos+v.erros;
        const pct = total>0 ? Math.round((v.acertos/total)*100) : 0;
        pessoas.push({nome, grupo: res.grupo, acertos:v.acertos, erros:v.erros, pct});
      });
    });
    pessoas.sort((a,b)=> b.pct - a.pct || a.nome.localeCompare(b.nome));
    // Pódio individual: pega os 3 primeiros DEGRAUS de %, não as 3 primeiras pessoas —
    // se houver empate, todo mundo daquela % sobe junto no mesmo degrau.
    const ranksIndividual = agruparPorEmpate(pessoas).slice(0,3);

    let html = htmlAdmin;

    html += `
      <div class="secao-titulo">🏆 Pódio individual </div>
      ${renderPodioQuadriculado(ranksIndividual)}
      <div class="secao-titulo">🏁 Classificação geral de grupos por % de acerto (${grupos.length} finalizados)</div>
    `;
    gruposComPosicao.forEach((g)=>{
      const medalha = g.posicao===1 ? '🥇' : g.posicao===2 ? '🥈' : g.posicao===3 ? '🥉' : g.posicao+'º';
      html += `
        <div class="ranking-item">
          <div class="pos">${medalha}</div>
          <div class="info">
            <strong>Grupo ${g.grupo}</strong>
          </div>
          <div class="pill ${g.pct>=50?'verde':'vermelho'}">${g.pct}%</div>
        </div>
      `;
    });

    conteudo.innerHTML = html;
  }catch(e){
    conteudo.innerHTML = '<div class="aviso">Erro ao carregar o painel. Toque em atualizar para tentar novamente.</div>';
  }
}

inicializarCadastro();
