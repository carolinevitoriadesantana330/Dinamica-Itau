/* ======================================================================
   GP DO CONHECIMENTO — Quiz Itaú (tema F1)
   Lógica do jogo. Ver a explicação no chat para o racional de arquitetura
   (broadcast em vez de postgres_changes, fallback por polling, etc.)
   ====================================================================== */

/* ----------------------------------------------------------------------
   1) CONFIGURAÇÃO — troque estes valores antes de publicar
   ---------------------------------------------------------------------- */
const SUPABASE_URL = "https://azwnhychxfpwpbobvoip.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_1uphWuzAbz9unMX9j75PEg_w1pp-LOG";

const SENHA_ADMIN = "itau2026"; // troque antes do evento — ver aviso de segurança no chat
const TEMPO_PERGUNTA_MS = 15000; // 15 segundos por pergunta
const PONTOS_MAX = 1000;         // pontos por acertar instantaneamente
const PONTOS_MIN_ACERTO = 500;   // pontos mínimos por acertar (mesmo respondendo no último segundo)
const NOME_CANAL_REALTIME = "gpq-estado-corrida";
const INTERVALO_POLL_MS = 4000;  // frequência do "auto-cura" além do broadcast

const LETRAS = ["A", "B", "C", "D"];
const BANDEIRAS = ["🔴", "🔵", "🟡", "🟢"]; // vermelha / azul / amarela / verde — mesma ordem das cores CSS cor-0..cor-3

/* ----------------------------------------------------------------------
   2) ESTADO LOCAL (em memória, por aba/dispositivo)
   ---------------------------------------------------------------------- */
let sb = null;                     // cliente supabase
let canal = null;                  // canal de broadcast
let PERGUNTAS = [];                // carregado do bloco <script id="dados-perguntas">
let jogadorAtual = null;           // { id, nome, pontos_total }
let isAdmin = false;

let estadoAplicadoEm = null;       // timestamp (string ISO) do último estado já processado — evita reprocessar
let faseAtual = "lobby";
let perguntaIndexAtual = 0;        // 1-based, casa com PERGUNTAS[perguntaIndexAtual - 1]
let horaInicioPerguntaMs = null;   // Date.now() equivalente ao "iniciado_em" do estado
let jaRespondeuNumero = 0;         // qual número de pergunta o jogador já respondeu (evita responder 2x)
let respostaLocalAtual = null;     // { pergunta, opcaoIndex, acertou, pontosGanhos } — guardado até o admin revelar

let timerHandle = null;
let pollHandle = null;

let painelUltimaPerguntaRenderizada = 0; // controla quando tocar a animação do semáforo no telão

/* ----------------------------------------------------------------------
   3) BOOT
   ---------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", iniciar);

function iniciar() {
  carregarPerguntas();
  iniciarClienteSupabase();
  restaurarJogadorLocal();
  conectarRealtime();
  buscarEstadoRemoto(true);
  pollHandle = setInterval(() => buscarEstadoRemoto(false), INTERVALO_POLL_MS);

  // só o admin, só durante uma pergunta ativa, para acompanhar respostas chegando —
  // não gera nenhuma carga extra nos 140 celulares dos pilotos
  setInterval(() => {
    if (isAdmin && document.body.dataset.tela === "admin" && faseAtual === "pergunta") {
      atualizarContagemJogadores();
    }
  }, 3000);

  // rodapé do telão: contadores de participantes/respostas, atualizados
  // direto no painel do administrador (que agora também é o telão)
  setInterval(() => {
    if (isAdmin) atualizarRodapePainel();
  }, 3000);
}

function iniciarClienteSupabase() {
  if (SUPABASE_URL.includes("COLOQUE_AQUI") || SUPABASE_ANON_KEY.includes("COLOQUE_AQUI")) {
    mostrarToast("⚠️ Configure SUPABASE_URL e SUPABASE_ANON_KEY no script.js", "erro");
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function carregarPerguntas() {
  try {
    const bloco = document.getElementById("dados-perguntas");
    const dados = JSON.parse(bloco.textContent);
    if (!Array.isArray(dados) || dados.length === 0) throw new Error("lista vazia");
    PERGUNTAS = dados.slice(0, 10).map((p, i) => {
      if (!p.pergunta || !Array.isArray(p.opcoes) || p.opcoes.length !== 4 || typeof p.correta !== "number") {
        throw new Error("pergunta " + (i + 1) + " está com formato inválido");
      }
      return p;
    });
  } catch (e) {
    console.error("Erro ao carregar perguntas:", e);
    mostrarToast("⚠️ Erro no formato das perguntas (veja o console)", "erro");
    PERGUNTAS = [];
  }
}

/* ----------------------------------------------------------------------
   4) NAVEGAÇÃO ENTRE TELAS
   ---------------------------------------------------------------------- */
function irPara(tela) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("ativo"));
  const alvo = document.getElementById("tela-" + tela);
  if (alvo) alvo.classList.add("ativo");
  document.body.dataset.tela = tela;

  const btnVoltar = document.getElementById("btnVoltar");
  btnVoltar.style.display = tela === "home" ? "none" : "block";
}

/* ----------------------------------------------------------------------
   5) TOASTS (avisos discretos, importantes para transparência de rede)
   ---------------------------------------------------------------------- */
function mostrarToast(msg, tipo) {
  const wrap = document.getElementById("toastWrap");
  const el = document.createElement("div");
  el.className = "toast" + (tipo === "erro" ? " erro" : "");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function formatarPontos(n) {
  return Math.max(0, Math.round(n || 0)).toLocaleString("pt-BR");
}

/* ----------------------------------------------------------------------
   6) JOGADOR — cadastro e reconexão
   ---------------------------------------------------------------------- */
function restaurarJogadorLocal() {
  const id = localStorage.getItem("gpq_jogador_id");
  const nome = localStorage.getItem("gpq_jogador_nome");
  if (id && nome) {
    jogadorAtual = { id, nome, pontos_total: 0 };
    // confirma no banco em segundo plano (pode ter sido apagado num "reiniciar jogo do zero")
    sb.from("jogadores").select("id,nome,pontos_total").eq("id", id).maybeSingle()
      .then(({ data, error }) => {
        if (error || !data) {
          // jogador não existe mais no banco — limpa e deixa a pessoa entrar de novo
          localStorage.removeItem("gpq_jogador_id");
          localStorage.removeItem("gpq_jogador_nome");
          jogadorAtual = null;
          return;
        }
        jogadorAtual = data;
        document.getElementById("lobbyNome").textContent = data.nome;
      });
  }
}

async function entrarComoJogador() {
  const input = document.getElementById("nomeJogador");
  const nome = (input.value || "").trim();
  const statusEl = document.getElementById("entrarStatus");
  statusEl.textContent = "";

  if (nome.length < 2) {
    statusEl.textContent = "Digite seu nome completo.";
    return;
  }
  if (!PERGUNTAS.length) {
    statusEl.textContent = "O quiz ainda não foi configurado (perguntas ausentes).";
    return;
  }

  try {
    const { data, error } = await sb.from("jogadores").insert({ nome }).select("id,nome,pontos_total").single();
    if (error) throw error;
    jogadorAtual = data;
    localStorage.setItem("gpq_jogador_id", data.id);
    localStorage.setItem("gpq_jogador_nome", data.nome);
    document.getElementById("lobbyNome").textContent = data.nome;
    irPara("lobby");
    buscarEstadoRemoto(true); // sincroniza caso a corrida já tenha começado
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Não deu para entrar agora. Verifique sua internet e tente de novo.";
  }
}

function verificarEstadoAgora() {
  mostrarToast("Verificando...");
  buscarEstadoRemoto(true);
}

/* ----------------------------------------------------------------------
   7) TIMER — usado tanto na tela do piloto quanto no telão
   ---------------------------------------------------------------------- */
function iniciarTimerVisual(barraEl, txtEl, aoZerar) {
  if (timerHandle) clearInterval(timerHandle);
  function tick() {
    const passado = Date.now() - horaInicioPerguntaMs;
    const restanteMs = Math.max(0, TEMPO_PERGUNTA_MS - passado);
    const pct = Math.max(0, Math.min(100, (restanteMs / TEMPO_PERGUNTA_MS) * 100));
    if (barraEl) {
      barraEl.style.width = pct + "%";
      barraEl.style.background =
        pct > 55 ? "var(--bandeira-verde)" : pct > 25 ? "var(--bandeira-amarela)" : "var(--bandeira-vermelha)";
    }
    if (txtEl) txtEl.textContent = Math.ceil(restanteMs / 1000) + "s";
    if (restanteMs <= 0) {
      clearInterval(timerHandle);
      if (aoZerar) aoZerar();
    }
  }
  tick();
  timerHandle = setInterval(tick, 250);
}

/* ----------------------------------------------------------------------
   8) TELA DO PILOTO — pergunta e resposta
   ---------------------------------------------------------------------- */
function renderPerguntaJogador() {
  const p = PERGUNTAS[perguntaIndexAtual - 1];
  if (!p || !jogadorAtual) return;

  const jaRespondeu = jaRespondeuNumero === perguntaIndexAtual;

  document.getElementById("pgProgressoTxt").textContent =
    "Pergunta " + perguntaIndexAtual + " de " + PERGUNTAS.length;
  const elPerguntaTxt = document.getElementById("pgPerguntaTexto");
  if (elPerguntaTxt) elPerguntaTxt.textContent = p.pergunta;
  document.getElementById("pgAvisoRespondido").style.display = jaRespondeu ? "block" : "none";

  const container = document.getElementById("pgOpcoes");
  container.innerHTML = "";
  p.opcoes.forEach((texto, i) => {
    const btn = document.createElement("button");
    btn.className = "opcao-btn cor-" + i;
    if (jaRespondeu && respostaLocalAtual && respostaLocalAtual.pergunta === perguntaIndexAtual && respostaLocalAtual.opcaoIndex === i) {
      btn.classList.add("selecionada");
    }
    btn.disabled = jaRespondeu;
    btn.innerHTML =
      '<span class="letra">' + LETRAS[i] + "</span><span class=\"opcao-texto\">" + escaparHtml(texto) + "</span>";
    btn.onclick = () => responder(i);
    container.appendChild(btn);
  });

  irPara("pergunta");
  // ao cronômetro chegar a zero, o piloto vê imediatamente se pontuou ou
  // errou — não precisa mais esperar o administrador revelar
  iniciarTimerVisual(
    document.getElementById("pgBarraTempo"),
    document.getElementById("pgTempoTxt"),
    () => {
      if (jaRespondeuNumero !== perguntaIndexAtual) responder(-1);
      if (respostaLocalAtual && respostaLocalAtual.pergunta === perguntaIndexAtual) {
        mostrarFeedback(respostaLocalAtual.opcaoIndex, respostaLocalAtual.acertou, respostaLocalAtual.pontosGanhos);
      }
    }
  );
}

async function responder(opcaoIndex) {
  if (jaRespondeuNumero === perguntaIndexAtual) return; // trava local contra duplo toque
  jaRespondeuNumero = perguntaIndexAtual;

  document.querySelectorAll("#pgOpcoes .opcao-btn").forEach((b, i) => {
    b.disabled = true;
    if (i === opcaoIndex) b.classList.add("selecionada");
  });
  document.getElementById("pgAvisoRespondido").style.display = "block";

  const p = PERGUNTAS[perguntaIndexAtual - 1];
  const tempoMs = Math.min(Math.max(Date.now() - horaInicioPerguntaMs, 0), TEMPO_PERGUNTA_MS);
  const acertou = opcaoIndex >= 0 && opcaoIndex === p.correta;
  const pontosGanhos = calcularPontos(acertou, tempoMs);

  // guarda o resultado localmente, mas só mostra na tela quando o admin
  // clicar em "revelar resultado" — é isso que sincroniza todo mundo vendo
  // o próprio resultado junto, na hora certa
  respostaLocalAtual = { pergunta: perguntaIndexAtual, opcaoIndex, acertou, pontosGanhos };

  const novoTotal = (jogadorAtual.pontos_total || 0) + pontosGanhos;
  jogadorAtual.pontos_total = novoTotal;

  enviarRespostaComRetentativa({
    jogador_id: jogadorAtual.id,
    pergunta_id: perguntaIndexAtual,
    opcao_escolhida: opcaoIndex,
    correta: acertou,
    tempo_resposta_ms: tempoMs,
    pontos_ganhos: pontosGanhos,
  }, novoTotal);
}

function calcularPontos(acertou, tempoMs) {
  if (!acertou) return 0;
  const fracaoRestante = 1 - tempoMs / TEMPO_PERGUNTA_MS;
  return Math.round(PONTOS_MIN_ACERTO + (PONTOS_MAX - PONTOS_MIN_ACERTO) * fracaoRestante);
}

async function enviarRespostaComRetentativa(payload, novoTotal, tentativa = 1) {
  try {
    const { error } = await sb.from("respostas").insert(payload);
    if (error && error.code !== "23505") throw error; // 23505 = já respondeu (ok, ignora)
    await sb.from("jogadores").update({ pontos_total: novoTotal }).eq("id", jogadorAtual.id);
  } catch (e) {
    console.error("Falha ao enviar resposta, tentativa " + tentativa, e);
    if (tentativa < 3) {
      setTimeout(() => enviarRespostaComRetentativa(payload, novoTotal, tentativa + 1), 900 * tentativa);
    } else {
      mostrarToast("⚠️ Sua resposta pode não ter sido salva. Verifique a internet.", "erro");
    }
  }
}

function mostrarFeedback(opcaoIndex, acertou, pontosGanhos) {
  document.getElementById("fbIcone").textContent = opcaoIndex < 0 ? "⏱️" : acertou ? "✅" : "❌";
  document.getElementById("fbTitulo").textContent =
    opcaoIndex < 0 ? "Tempo esgotado!" : acertou ? "Você acertou!" : "Resposta errada";
  document.getElementById("fbPontos").textContent = "+" + formatarPontos(pontosGanhos) + " pontos";
  document.getElementById("fbPontosTotal").textContent = formatarPontos(jogadorAtual.pontos_total);
  irPara("feedback");
}

/* ----------------------------------------------------------------------
   9) REALTIME — broadcast (empurra na hora) + polling (auto-cura)
   ---------------------------------------------------------------------- */
function conectarRealtime() {
  canal = sb.channel(NOME_CANAL_REALTIME, { config: { broadcast: { self: false } } });
  canal.on("broadcast", { event: "estado" }, ({ payload }) => aplicarEstado(payload, false));
  canal.subscribe((status) => {
    const pill = document.getElementById("adminConexao");
    if (!pill) return;
    if (status === "SUBSCRIBED") {
      pill.textContent = "🟢 conectado";
      pill.className = "pill pill-ok";
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      pill.textContent = "🔴 reconectando...";
      pill.className = "pill pill-erro";
      setTimeout(conectarRealtime, 2000);
    }
  });
}

async function buscarEstadoRemoto(forcar) {
  try {
    const { data, error } = await sb.from("jogo_estado").select("*").eq("id", 1).maybeSingle();
    if (error || !data) return;
    aplicarEstado(data, forcar);
  } catch (e) {
    console.error("Falha ao buscar estado remoto:", e);
  }
}

async function escreverEstado(campos) {
  const registro = { id: 1, atualizado_em: new Date().toISOString(), ...campos };
  try {
    await sb.from("jogo_estado").upsert(registro);
  } catch (e) {
    console.error("Falha ao gravar estado:", e);
    mostrarToast("⚠️ Falha ao salvar o estado da corrida. Tente novamente.", "erro");
    return;
  }
  canal.send({ type: "broadcast", event: "estado", payload: registro });
  aplicarEstado(registro, true); // aplica localmente também (quem manda também precisa ver)
}

/* ----------------------------------------------------------------------
   10) MÁQUINA DE ESTADOS — o coração do sincronismo entre telas
   ---------------------------------------------------------------------- */
function aplicarEstado(estado, forcar) {
  if (!estado || !estado.fase) return;
  if (!forcar && estadoAplicadoEm && estado.atualizado_em && estado.atualizado_em <= estadoAplicadoEm) return;
  estadoAplicadoEm = estado.atualizado_em || estadoAplicadoEm;

  faseAtual = estado.fase;
  perguntaIndexAtual = estado.pergunta_atual || 0;
  horaInicioPerguntaMs = estado.iniciado_em ? new Date(estado.iniciado_em).getTime() : null;

  atualizarTelaAdminSeAberta(estado);
  atualizarTelaPainelSeAberta(estado);
  atualizarTelaJogadorSeAplicavel(estado);
}

function atualizarTelaJogadorSeAplicavel(estado) {
  if (!jogadorAtual) return; // esta aba é só o telão / ainda não é jogador
  const telaAtiva = document.body.dataset.tela;
  // não mexe se a pessoa estiver no admin ou ainda não entrou
  if (telaAtiva === "admin" || telaAtiva === "home" || telaAtiva === "entrar") return;

  if (estado.fase === "lobby") {
    if (telaAtiva !== "lobby") irPara("lobby");
    document.getElementById("lobbyMensagem").textContent = "Aguardando o administrador dar a largada da corrida...";
  } else if (estado.fase === "pergunta") {
    renderPerguntaJogador();
  } else if (estado.fase === "revelacao" || estado.fase === "ranking") {
    if (jaRespondeuNumero !== perguntaIndexAtual) {
      // não respondeu a tempo (perdeu o próprio timer local) — fecha a pergunta como errada
      responder(-1);
    }
    // só agora, quando o admin revela o resultado, é que o piloto vê quantos
    // pontos ganhou — antes disso ele só sabia que a resposta foi enviada
    if (respostaLocalAtual && respostaLocalAtual.pergunta === perguntaIndexAtual && telaAtiva !== "feedback") {
      mostrarFeedback(respostaLocalAtual.opcaoIndex, respostaLocalAtual.acertou, respostaLocalAtual.pontosGanhos);
    }
    document.querySelector("#tela-feedback .fb-aguardando").textContent =
      estado.fase === "ranking" ? "Veja o ranking parcial no telão! 🏆" : "Veja o resultado no telão! 📊";
  } else if (estado.fase === "fim") {
    finalizarTelaJogador();
  }
}

async function finalizarTelaJogador() {
  try {
    const { data } = await sb.from("jogadores").select("pontos_total").eq("id", jogadorAtual.id).maybeSingle();
    if (data) jogadorAtual.pontos_total = data.pontos_total;
  } catch (e) { /* usa o valor local mesmo se a busca falhar */ }
  document.getElementById("fimPontosJogador").textContent = formatarPontos(jogadorAtual.pontos_total);
  irPara("fim-jogador");
}

/* ----------------------------------------------------------------------
   11) PAINEL PÚBLICO (telão)
   ---------------------------------------------------------------------- */
function tentarTelaCheiaHorizontal() {
  // em notebook ligado a projetor isso não muda nada (já é horizontal);
  // em tablet/celular usado como telão, força tela cheia deitada — falha
  // silenciosamente onde o navegador não suportar, sem travar o app
  const raiz = document.documentElement;
  if (raiz.requestFullscreen) {
    raiz.requestFullscreen().then(() => {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock("landscape").catch(() => {});
      }
    }).catch(() => {});
  }
}

function atualizarTelaPainelSeAberta(estado) {
  if (!isAdmin) return;
  const el = document.getElementById("painelConteudo");
  const rodape = document.getElementById("painelRodape");

  // rodapé de contadores só faz sentido durante a corrida (pergunta/revelação/
  // ranking) — na largada e no pódio já tem outras informações na tela
  // (guardado com "if (rodape)" pra nunca travar o resto do desenho do
  // telão caso esse elemento não exista por algum HTML desatualizado)
  if (rodape) {
    const mostrarRodape = estado.fase === "pergunta" || estado.fase === "revelacao" || estado.fase === "ranking";
    rodape.style.display = mostrarRodape ? "flex" : "none";
    if (mostrarRodape) atualizarRodapePainel();
  }

  if (estado.fase === "lobby") {
    painelUltimaPerguntaRenderizada = 0;
    el.innerHTML =
      '<div class="painel-lobby">' +
      '<div class="semaforo espera" id="painelSemaforo"><span class="luz"></span><span class="luz"></span><span class="luz"></span><span class="luz"></span><span class="luz"></span></div>' +
      "<h2>Aguardando a largada 🏁</h2>" +
      '<div class="painel-contagem-linha"><p id="painelContagem">Pilotos na grid: ' + (estado.total_jogadores ?? "—") + '</p>' +
      '<button class="btn-atualizar-telao" id="btnAtualizarTelao" onclick="atualizarPilotosManual()" title="Atualizar quantidade de pilotos" aria-label="Atualizar quantidade de pilotos">🔄</button></div></div>';
  } else if (estado.fase === "pergunta") {
    const novaPergunta = perguntaIndexAtual !== painelUltimaPerguntaRenderizada;
    painelUltimaPerguntaRenderizada = perguntaIndexAtual;
    if (novaPergunta) {
      tocarLargadaEDepois(() => renderPerguntaPainel());
    } else {
      renderPerguntaPainel();
    }
  } else if (estado.fase === "revelacao") {
    renderRevelacaoPainel(estado);
  } else if (estado.fase === "ranking") {
    renderRankingPainel(estado.ranking || []);
  } else if (estado.fase === "fim") {
    renderPodioPainel(estado.ranking || []);
  }
}

async function atualizarRodapePainel() {
  try {
    const { count: totalJogadores } = await sb.from("jogadores").select("id", { count: "exact", head: true });
    const elJogadores = document.getElementById("painelRodapeJogadores");
    if (elJogadores) elJogadores.textContent = totalJogadores ?? "—";

    const elRespostas = document.getElementById("painelRodapeRespostas");
    if (elRespostas) {
      if (perguntaIndexAtual > 0) {
        const { count: totalRespostas } = await sb
          .from("respostas").select("id", { count: "exact", head: true }).eq("pergunta_id", perguntaIndexAtual);
        elRespostas.textContent = totalRespostas ?? "0";
      } else {
        elRespostas.textContent = "0";
      }
    }
  } catch (e) {
    console.error("Falha ao atualizar rodapé do painel:", e);
  }
}

function tocarLargadaEDepois(callback) {
  const el = document.getElementById("painelConteudo");
  el.innerHTML =
    '<div class="painel-lobby"><div class="semaforo" id="largadaSemaforo">' +
    "<span class=\"luz\"></span><span class=\"luz\"></span><span class=\"luz\"></span><span class=\"luz\"></span><span class=\"luz\"></span>" +
    "</div></div>";
  const semaforo = document.getElementById("largadaSemaforo");
  const luzes = semaforo.querySelectorAll(".luz");
  luzes.forEach((luz, i) => setTimeout(() => luz.classList.add("acesa"), i * 380));
  setTimeout(() => {
    semaforo.classList.add("apagou");
    setTimeout(callback, 450);
  }, luzes.length * 380 + 500);
}

function renderPerguntaPainel() {
  const p = PERGUNTAS[perguntaIndexAtual - 1];
  if (!p) return;
  const el = document.getElementById("painelConteudo");
  el.innerHTML =
    '<div class="painel-topo"><span>Pergunta ' + perguntaIndexAtual + " de " + PERGUNTAS.length + '</span><span id="painelTempoTxt">15s</span></div>' +
    '<div class="painel-barra-wrap"><div id="painelBarra" class="painel-barra" style="width:100%"></div></div>' +
    '<div class="painel-pergunta">' + escaparHtml(p.pergunta) + "</div>" +
    '<div class="painel-opcoes">' +
    p.opcoes.map((op, i) =>
      '<div class="painel-opcao cor-' + i + '">' +
      '<span class="letra">' + LETRAS[i] + "</span><span class=\"texto\">" + escaparHtml(op) + "</span>" +
      "</div>"
    ).join("") +
    "</div>";
  const perguntaNoDisparo = perguntaIndexAtual;
  iniciarTimerVisual(document.getElementById("painelBarra"), document.getElementById("painelTempoTxt"), () => {
    // só revela se ainda estivermos na mesma pergunta que zerou (evita
    // disparo duplicado caso o admin já tenha revelado manualmente)
    if (faseAtual === "pergunta" && perguntaIndexAtual === perguntaNoDisparo) revelarResultado();
  });
}

function renderRevelacaoPainel(estado) {
  const p = PERGUNTAS[perguntaIndexAtual - 1];
  if (!p) return;
  const el = document.getElementById("painelConteudo");
  el.innerHTML =
    '<div class="painel-topo"><span>Pergunta ' + perguntaIndexAtual + " de " + PERGUNTAS.length + '</span><span>📊 Resultado</span></div>' +
    '<div class="painel-pergunta">' + escaparHtml(p.pergunta) + "</div>" +
    '<div class="painel-opcoes">' +
    p.opcoes.map((op, i) => {
      const ehCorreta = i === p.correta;
      return (
        '<div class="painel-opcao cor-' + i + (ehCorreta ? " correta" : " errada") + '">' +
        '<span class="letra">' + LETRAS[i] + "</span><span class=\"texto\">" + escaparHtml(op) + "</span>" +
        (ehCorreta ? '<span class="correta-selo">✅ Resposta certa</span>' : "") +
        "</div>"
      );
    }).join("") +
    "</div>";
}

function renderRankingPainel(ranking) {
  const el = document.getElementById("painelConteudo");
  el.innerHTML =
    '<div class="painel-ranking"><h2>🏆 Ranking parcial</h2>' +
    ranking.map((j, i) =>
      '<div class="rank-linha ' + (i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : "") + '">' +
      '<span class="pos">' + (i + 1) + "º</span><span class=\"nome\">" + escaparHtml(j.nome) + "</span>" +
      '<span class="pts">' + formatarPontos(j.pontos_total) + "</span></div>"
    ).join("") +
    "</div>";
}

function renderPodioPainel(ranking) {
  const top3 = ranking.slice(0, 3);
  const resto = ranking.slice(3, 10);
  const el = document.getElementById("painelConteudo");
  const bloco = (pos, medalha, classe) => {
    const j = top3[pos];
    if (!j) return "";
    return (
      '<div class="podio-bloco ' + classe + '"><div class="medalha">' + medalha + "</div>" +
      '<div class="nome">' + escaparHtml(j.nome) + "</div><div class=\"pts\">" + formatarPontos(j.pontos_total) + "</div></div>"
    );
  };
  el.innerHTML =
    '<div class="podio-wrap">' +
    '<div class="faixa-quadriculada"></div>' +
    "<h2>🏆 Pódio SPOD</h2><p class=\"podio-sub\">Corrida encerrada — parabéns aos pilotos!</p>" +
    '<div class="podio-blocos">' +
    bloco(1, "🥈", "podio-p2") + bloco(0, "🥇", "podio-p1") + bloco(2, "🥉", "podio-p3") +
    "</div>" +
    '<div class="podio-resto">' +
    resto.map((j, i) =>
      '<div class="rank-linha"><span class="pos">' + (i + 4) + "º</span><span class=\"nome\">" + escaparHtml(j.nome) + "</span>" +
      '<span class="pts">' + formatarPontos(j.pontos_total) + "</span></div>"
    ).join("") +
    "</div>" +
    '<div class="faixa-quadriculada" style="margin-top:28px;"></div>' +
    "</div>";
}

function escaparHtml(txt) {
  const d = document.createElement("div");
  d.textContent = txt;
  return d.innerHTML;
}

/* ----------------------------------------------------------------------
   12) ADMIN — torre de comando da corrida
   ---------------------------------------------------------------------- */
function entrarAdmin() {
  const senha = document.getElementById("senhaAdminInput").value;
  const status = document.getElementById("adminLoginStatus");
  if (senha !== SENHA_ADMIN) {
    status.textContent = "Senha incorreta.";
    return;
  }
  isAdmin = true;
  document.getElementById("adminLogin").style.display = "none";
  document.getElementById("adminPainel").style.display = "flex";
  buscarEstadoRemoto(true);
  atualizarContagemJogadores();
  tentarTelaCheiaHorizontal();
}

function atualizarTelaAdminSeAberta(estado) {
  if (!isAdmin) return;
  document.getElementById("adminFaseAtual").textContent = "fase: " + estado.fase;
  document.getElementById("adminPerguntaAtualTxt").textContent =
    estado.fase === "lobby" || !estado.pergunta_atual
      ? "corrida não iniciada"
      : (perguntaIndexAtual + " de " + PERGUNTAS.length + " — " + (PERGUNTAS[perguntaIndexAtual - 1]?.pergunta || ""));

  const ehUltimaPergunta = PERGUNTAS.length > 0 && perguntaIndexAtual >= PERGUNTAS.length;
  const mostrar = (id, condicao) => (document.getElementById(id).style.display = condicao ? "block" : "none");
  mostrar("btnIniciarCorrida", estado.fase === "lobby");
  mostrar("btnProximaPergunta", (estado.fase === "revelacao" || estado.fase === "ranking") && !ehUltimaPergunta);
  mostrar("btnEncerrarTempo", estado.fase === "pergunta");
  mostrar("btnRevelar", estado.fase === "pergunta"); // revelação já é automática ao zerar; fica como opção manual
  mostrar("btnRanking", (estado.fase === "revelacao" || estado.fase === "ranking") && !ehUltimaPergunta);
  // ao final da corrida, nenhuma outra ação automática — só o botão de revelar o pódio
  mostrar("btnEncerrarCorrida", (estado.fase === "revelacao" || estado.fase === "ranking") && ehUltimaPergunta);

  if (estado.fase === "pergunta") atualizarContagemJogadores();
}

async function atualizarContagemJogadores() {
  try {
    const { count: totalJogadores } = await sb.from("jogadores").select("id", { count: "exact", head: true });
    document.getElementById("adminTotalJogadores").textContent = totalJogadores ?? "—";

    if (perguntaIndexAtual > 0) {
      const { count: totalRespostas } = await sb
        .from("respostas").select("id", { count: "exact", head: true }).eq("pergunta_id", perguntaIndexAtual);
      document.getElementById("adminTotalRespostas").textContent = totalRespostas ?? "0";
    } else {
      document.getElementById("adminTotalRespostas").textContent = "0";
    }

    if (faseAtual === "lobby") {
      // atualiza o telão local na hora — o broadcast (self:false) não volta pra quem escreveu
      const elContagem = document.getElementById("painelContagem");
      if (elContagem) elContagem.textContent = "Pilotos na grid: " + (totalJogadores ?? "—");
      escreverEstado({ fase: "lobby", pergunta_atual: 0, total_jogadores: totalJogadores ?? 0 });
    }
  } catch (e) {
    console.error("Falha ao atualizar contagem:", e);
  }
}

async function atualizarPilotosManual() {
  const btns = [document.getElementById("btnAtualizarPilotos"), document.getElementById("btnAtualizarTelao")].filter(Boolean);
  btns.forEach((btn) => { btn.disabled = true; btn.classList.add("girando"); });
  await atualizarContagemJogadores();
  btns.forEach((btn) => { btn.classList.remove("girando"); btn.disabled = false; });
}

function iniciarCorrida() {
  if (!PERGUNTAS.length) {
    mostrarToast("⚠️ Cadastre as perguntas no HTML antes de iniciar.", "erro");
    return;
  }
  escreverEstado({ fase: "pergunta", pergunta_atual: 1, iniciado_em: new Date().toISOString() });
}

function abrirProximaPergunta() {
  const proxima = perguntaIndexAtual + 1;
  if (proxima > PERGUNTAS.length) {
    encerrarCorrida();
    return;
  }
  escreverEstado({ fase: "pergunta", pergunta_atual: proxima, iniciado_em: new Date().toISOString() });
}

function encerrarTempoAgora() {
  // reaproveita a fase "pergunta" mas com início empurrado para o passado,
  // assim todo mundo calcula o próprio cronômetro como já esgotado — sem precisar de fase nova
  escreverEstado({
    fase: "pergunta",
    pergunta_atual: perguntaIndexAtual,
    iniciado_em: new Date(Date.now() - TEMPO_PERGUNTA_MS - 1000).toISOString(),
  });
}

async function revelarResultado() {
  try {
    const { data, error } = await sb
      .from("respostas").select("opcao_escolhida").eq("pergunta_id", perguntaIndexAtual);
    if (error) throw error;
    const contagens = [0, 0, 0, 0];
    (data || []).forEach((r) => { if (r.opcao_escolhida >= 0 && r.opcao_escolhida <= 3) contagens[r.opcao_escolhida]++; });
    const total = (data || []).length;
    escreverEstado({
      fase: "revelacao",
      pergunta_atual: perguntaIndexAtual,
      contagens,
      total_respostas: total,
    });
  } catch (e) {
    console.error(e);
    mostrarToast("⚠️ Falha ao calcular o resultado.", "erro");
  }
}

async function buscarRankingTop(n) {
  // busca todo mundo + todas as respostas, e desempata no cliente — isso garante
  // que o pódio NUNCA mostra empate: 1) mais pontos, 2) mais rápido no total
  // (soma do tempo de resposta em todas as perguntas), 3) id como desempate
  // final determinístico (nunca falha, só existe pra garantir uma ordem única)
  const [{ data: jogadores, error: erroJog }, { data: respostas, error: erroResp }] = await Promise.all([
    sb.from("jogadores").select("id,nome,pontos_total"),
    sb.from("respostas").select("jogador_id,tempo_resposta_ms"),
  ]);
  if (erroJog) { console.error(erroJog); return []; }

  const tempoPorJogador = {};
  (respostas || []).forEach((r) => {
    tempoPorJogador[r.jogador_id] = (tempoPorJogador[r.jogador_id] || 0) + (r.tempo_resposta_ms || 0);
  });
  if (erroResp) console.error("Falha ao buscar tempos de resposta (desempate por pontos apenas):", erroResp);

  const comTempo = (jogadores || []).map((j) => ({
    ...j,
    tempo_total: tempoPorJogador[j.id] || 0,
  }));

  comTempo.sort((a, b) => {
    if (b.pontos_total !== a.pontos_total) return b.pontos_total - a.pontos_total;
    if (a.tempo_total !== b.tempo_total) return a.tempo_total - b.tempo_total;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return comTempo.slice(0, n);
}

async function mostrarRankingParcial() {
  const ranking = await buscarRankingTop(10);
  escreverEstado({ fase: "ranking", pergunta_atual: perguntaIndexAtual, ranking });
}

async function encerrarCorrida() {
  const ranking = await buscarRankingTop(10);
  escreverEstado({ fase: "fim", pergunta_atual: perguntaIndexAtual, ranking });
}

function reiniciarJogo() {
  if (!confirm("Isso volta a corrida para a largada (não apaga pilotos nem pontos). Confirma?")) return;
  if (!confirm("Tem certeza mesmo? Todos os pilotos voltarão para a sala de espera.")) return;
  escreverEstado({ fase: "lobby", pergunta_atual: 0, iniciado_em: null, contagens: null, ranking: null });
}
