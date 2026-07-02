/* ============================================================
   CONFIGURAÇÃO DO SUPABASE
   Troque pelos dados do SEU projeto:
   Supabase > Project Settings > API > Project URL / anon public key
============================================================ */
const SUPABASE_URL = 'https://azwnhychxfpwpbobvoip.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1uphWuzAbz9unMX9j75PEg_w1pp-LOG';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ============================================================
   CAMADA DE ARMAZENAMENTO
   Imita a API window.storage usada originalmente no artifact do
   Claude (get/set/list/delete), mas gravando de verdade na
   tabela "app_storage" do Supabase. Assim o resto do código do
   jogo praticamente não muda.
============================================================ */
const storage = {
  async get(key) {
    const { data, error } = await supabaseClient
      .from('app_storage')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { key, value: JSON.stringify(data.value) };
  },
  async set(key, value) {
    const parsedValue = JSON.parse(value);
    const { error } = await supabaseClient
      .from('app_storage')
      .upsert({ key, value: parsedValue, updated_at: new Date().toISOString() });
    if (error) throw error;
    return { key, value };
  },
  async delete(key) {
    const { error } = await supabaseClient
      .from('app_storage')
      .delete()
      .eq('key', key);
    if (error) throw error;
    return { key, deleted: true };
  },
  async list(prefix) {
    let query = supabaseClient.from('app_storage').select('key');
    if (prefix) query = query.like('key', `${prefix}%`);
    const { data, error } = await query;
    if (error) throw error;
    return { keys: (data || []).map(row => row.key) };
  }
};

/* ============================================================
   LÓGICA DO JOGO (igual ao original, só trocando window.storage
   pela camada "storage" acima)
============================================================ */
const TAMANHO_PADRAO = 10;

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
      <input type="text" placeholder="Nome e sobrenome" value="${nome.replace(/"/g,'&quot;')}" oninput="cadNomes[${i}]=this.value">
      <button class="lixeira" onclick="removerCampo(${i})">✕</button>
    `;
    wrap.appendChild(div);
  });
}
function adicionarCampoNome(){
  cadNomes.push('');
  renderCampos();
}
function removerCampo(i){
  cadNomes.splice(i,1);
  renderCampos();
}
function inicializarCadastro(){
  cadNomes = new Array(TAMANHO_PADRAO).fill('');
  renderCampos();
  document.getElementById('cadStatus').innerHTML = '';
}

async function carregarCadastroExistente(){
  const n = document.getElementById('cadGrupoNum').value;
  if(!n) return;
  document.getElementById('cadStatus').innerHTML = '<div class="spinner"></div>';
  try{
    const r = await storage.get(`grupo:${n}:membros`);
    if(r && r.value){
      cadNomes = JSON.parse(r.value);
      if(cadNomes.length < TAMANHO_PADRAO){
        while(cadNomes.length < TAMANHO_PADRAO) cadNomes.push('');
      }
    } else {
      cadNomes = new Array(TAMANHO_PADRAO).fill('');
    }
  }catch(e){
    cadNomes = new Array(TAMANHO_PADRAO).fill('');
  }
  renderCampos();
  document.getElementById('cadStatus').innerHTML = '';
}

async function salvarGrupo(){
  const n = document.getElementById('cadGrupoNum').value;
  const status = document.getElementById('cadStatus');
  if(!n){ status.innerHTML = '<div class="aviso">Informe o número do grupo.</div>'; return; }
  const nomes = cadNomes.map(x=>x.trim()).filter(x=>x.length>0);
  if(nomes.length < 2){ status.innerHTML = '<div class="aviso">Cadastre pelo menos 2 pessoas.</div>'; return; }
  status.innerHTML = '<div class="spinner"></div>';
  try{
    await storage.set(`grupo:${n}:membros`, JSON.stringify(nomes));
    status.innerHTML = `<div class="aviso">✅ Grupo ${n} salvo com ${nomes.length} pessoas!</div>`;
  }catch(e){
    status.innerHTML = '<div class="aviso">Erro ao salvar. Tente novamente.</div>';
  }
}

/* ---------------- JOGO ---------------- */
let jogoGrupo = null;
let jogoMembros = [];
let jogoApresentadorIdx = 0;
let jogoTally = {}; // nome -> {acertos, erros}
let jogoMarcacaoAtual = {}; // nome ouvinte -> 'acerto'|'erro'|null

async function iniciarJogo(){
  const n = document.getElementById('jogarGrupoNum').value;
  const erroEl = document.getElementById('jogarSelecionarErro');
  erroEl.innerHTML = '';
  if(!n){ erroEl.innerHTML = '<div class="aviso">Informe o número do grupo.</div>'; return; }
  erroEl.innerHTML = '<div class="spinner"></div>';
  try{
    const r = await storage.get(`grupo:${n}:membros`);
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
  document.getElementById('jogoProgressoTxt').textContent = `Apresentador ${jogoApresentadorIdx+1} de ${total}`;
  document.getElementById('jogoGrupoTxt').textContent = `Grupo ${jogoGrupo}`;
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
      <div class="nome">${nome}</div>
      <div class="par-botoes">
        <button class="toggle acerto" id="ac_${safeId}" onclick="marcar('${nome.replace(/'/g,"\\'")}','acerto')">✓ Acertou</button>
        <button class="toggle erro" id="er_${safeId}" onclick="marcar('${nome.replace(/'/g,"\\'")}','erro')">✕ Errou</button>
      </div>
    `;
    wrap.appendChild(div);
  });
  atualizarBotaoProximo();
}

function marcar(nome, tipo){
  jogoMarcacaoAtual[nome] = tipo;
  const safeId = nome.replace(/[^a-zA-Z0-9]/g,'_');
  document.getElementById('ac_'+safeId).classList.toggle('on', tipo==='acerto');
  document.getElementById('er_'+safeId).classList.toggle('on', tipo==='erro');
  atualizarBotaoProximo();
}

function atualizarBotaoProximo(){
  const todosMarcados = Object.values(jogoMarcacaoAtual).every(v => v !== null);
  const btn = document.getElementById('btnProximoApresentador');
  btn.disabled = !todosMarcados;
  const ultimo = jogoApresentadorIdx === jogoMembros.length - 1;
  btn.textContent = ultimo ? 'Finalizar grupo' : 'Próximo apresentador';
}

async function proximoApresentador(){
  Object.entries(jogoMarcacaoAtual).forEach(([nome, tipo])=>{
    if(tipo === 'acerto') jogoTally[nome].acertos++;
    else if(tipo === 'erro') jogoTally[nome].erros++;
  });

  if(jogoApresentadorIdx === jogoMembros.length - 1){
    await finalizarGrupo();
  } else {
    jogoApresentadorIdx++;
    renderApresentador();
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
    await storage.set(`grupo:${jogoGrupo}:resultado`, JSON.stringify(resultado));
  }catch(e){}
  mostrarResultadoNaTela(resultado);
  irPara('resultado-grupo');
}

/* ---------------- RESULTADO DE UM GRUPO ---------------- */
async function verResultadoGrupo(){
  const n = document.getElementById('resGrupoNum').value;
  const erroEl = document.getElementById('resSelecionarErro');
  if(!n){ erroEl.innerHTML = '<div class="aviso">Informe o número do grupo.</div>'; return; }
  erroEl.innerHTML = '<div class="spinner"></div>';
  try{
    const r = await storage.get(`grupo:${n}:resultado`);
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
  pessoas.sort((a,b)=> b.pct - a.pct || b.acertos - a.acertos);

  const maxAcerto = Math.max(...pessoas.map(p=>p.pct));
  const minAcerto = Math.min(...pessoas.map(p=>p.pct));
  const maisAcertaram = pessoas.filter(p=>p.pct === maxAcerto).map(p=>p.nome);
  const maisErraram = pessoas.filter(p=>p.pct === minAcerto).map(p=>p.nome);

  let html = `
    <div class="destaque-box" >
      <div class="rotulo">🏆 Quem mais acertou</div>
      <div class="nomes">${maisAcertaram.join(' · ')}</div>
      <div class="valor">${maxAcerto}% de acerto</div>
    </div>
    <div class="destaque-box" style="background:linear-gradient(135deg,#FF6200);">
      <div class="rotulo">👎🏻 Quem mais errou</div>
      <div class="nomes">${maisErraram.join(' · ')}</div>
      <div class="valor">${minAcerto}% de acerto</div>
    </div>
    <div class="secao-titulo">Ranking completo · Grupo ${resultado.grupo}</div>
  `;
  pessoas.forEach((p,i)=>{
    html += `
      <div class="ranking-item">
        <div class="pos">${i+1}º</div>
        <div class="info">
          <strong>${p.nome}</strong>
          <span>${p.acertos} acertos · ${p.erros} erros</span>
        </div>
        <div class="pill ${p.pct>=50?'verde-escuro':'vermelho'}">${p.pct}%</div>
      </div>
    `;
  });
  document.getElementById('resGrupoConteudo').innerHTML = html;
}

/* ---------------- PAINEL GERAL ---------------- */
async function abrirPainel(){
  irPara('painel');
  const conteudo = document.getElementById('painelConteudo');
  conteudo.innerHTML = '<div class="spinner"></div>';
  try{
    const lista = await storage.list('grupo:');
    const chaves = (lista && lista.keys) ? lista.keys : [];
    const chavesResultado = chaves.filter(k => k.endsWith(':resultado'));

    if(chavesResultado.length === 0){
      conteudo.innerHTML = '<div class="vazio">Nenhum grupo finalizou a dinâmica ainda.<br>Assim que os grupos terminarem, os resultados aparecem aqui.</div>';
      return;
    }

    const resultados = [];
    for(const chave of chavesResultado){
      try{
        const r = await storage.get(chave);
        if(r && r.value) resultados.push(JSON.parse(r.value));
      }catch(e){}
    }

    // Agregação por grupo
    const grupos = resultados.map(res=>{
      let acertos=0, erros=0;
      Object.values(res.porPessoa).forEach(v=>{ acertos+=v.acertos; erros+=v.erros; });
      const total = acertos+erros;
      const pct = total>0 ? Math.round((acertos/total)*100) : 0;
      return {grupo: res.grupo, acertos, erros, pct};
    });
    grupos.sort((a,b)=> b.pct - a.pct);

    const maxG = Math.max(...grupos.map(g=>g.pct));
    const minG = Math.min(...grupos.map(g=>g.pct));
    const gruposMaisAcertaram = grupos.filter(g=>g.pct===maxG).map(g=>`Grupo ${g.grupo}`);
    const gruposMaisErraram = grupos.filter(g=>g.pct===minG).map(g=>`Grupo ${g.grupo}`);

    // Agregação por pessoa (chave única = grupo+nome)
    const pessoas = [];
    resultados.forEach(res=>{
      Object.entries(res.porPessoa).forEach(([nome, v])=>{
        const total = v.acertos+v.erros;
        const pct = total>0 ? Math.round((v.acertos/total)*100) : 0;
        pessoas.push({nome, grupo: res.grupo, acertos:v.acertos, erros:v.erros, pct});
      });
    });
    const maxP = Math.max(...pessoas.map(p=>p.pct));
    const minP = Math.min(...pessoas.map(p=>p.pct));
    const pessoasMaisAcertaram = pessoas.filter(p=>p.pct===maxP);
    const pessoasMaisErraram = pessoas.filter(p=>p.pct===minP);

    let html = `
      <div class="destaque-box" style="background:linear-gradient(135deg,#0b7705);">
        <div class="rotulo">🏆 Grupo que mais acertou</div>
        <div class="nomes">${gruposMaisAcertaram.join(' · ')}</div>
        <div class="valor">${maxG}% de acerto</div>
      </div>
      <div class="destaque-box" style="background:linear-gradient(135deg,#EC7000);">
        <div class="rotulo">👎🏻 Grupo que mais errou</div>
        <div class="nomes">${gruposMaisErraram.join(' · ')}</div>
        <div class="valor">${minG}% de acerto</div>
      </div>

      <div class="destaque-box" style="background:linear-gradient(135deg,#0b7705);">
        <div class="rotulo">⭐ Pessoa(s) que mais acertaram</div>
        <div class="nomes">${pessoasMaisAcertaram.map(p=>`${p.nome} (Grupo ${p.grupo})`).join(' · ')}</div>
        <div class="valor">${maxP}% de acerto</div>
      </div>
      <div class="destaque-box" style="background:linear-gradient(135deg,#EC7000);">
        <div class="rotulo">😅 Pessoa(s) que mais erraram</div>
        <div class="nomes">${pessoasMaisErraram.map(p=>`${p.nome} (Grupo ${p.grupo})`).join(' · ')}</div>
        <div class="valor">${minP}% de acerto</div>
      </div>

      <div class="secao-titulo">Ranking de grupos (${grupos.length} finalizados)</div>
    `;
    grupos.forEach((g,i)=>{
      html += `
        <div class="ranking-item">
          <div class="pos">${i+1}º</div>
          <div class="info">
            <strong>Grupo ${g.grupo}</strong>
            <span>${g.acertos} acertos · ${g.erros} erros</span>
          </div>
          <div class="pill ${g.pct>=50?'verde-escuro':'vermelho'}">${g.pct}%</div>
        </div>
      `;
    });

    conteudo.innerHTML = html;
  }catch(e){
    conteudo.innerHTML = '<div class="aviso">Erro ao carregar o painel. Toque em atualizar para tentar novamente.</div>';
  }
}

inicializarCadastro();
