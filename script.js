/*
   script.js — Maceió Acessível (versão com Firebase / Firestore)

   O que este arquivo faz:
   - Conecta o site ao Firestore (banco de dados compartilhado)
   - Mostra os registros em tempo real para todos os visitantes
   - Mapa interativo (Leaflet + OpenStreetMap) e busca de endereços (Nominatim)
   - Fotos: reduz e comprime a imagem no navegador e guarda dentro do
     próprio registro (sem Cloud Storage, então não precisa de cartão)
   - Formulário, filtros, apoios, lightbox, estatísticas

*/

// Console do Firebase - Configurações do projeto
const CONFIGURACAO_FIREBASE = {
  apiKey: "AIzaSyDWyc1WYzo6dnWgxO9Y5NhIIvVPPauYd-M",
  authDomain: "assecibilidademaceio.firebaseapp.com",
  projectId: "assecibilidademaceio",
  storageBucket: "assecibilidademaceio.firebasestorage.app",
  messagingSenderId: "650526137963",
  appId: "1:650526137963:web:be57d5402178aea82d5b2e",
  measurementId: "G-EGSK59Q43H"
};

// Banco de dados
const NOME_COLECAO_REGISTROS   = 'registros'; // nome da coleção no Firestore
const LIMITE_REGISTROS_NO_FEED = 50;          // quantos registros carregar (os mais recentes)

// Fotos
const MAXIMO_FOTOS_POR_REGISTRO  = 3;      // regras do Firestore também limitam em 3
const MAXIMO_MB_ARQUIVO_ORIGINAL = 10;     // tamanho máximo da foto antes da compressão
const LARGURA_MAXIMA_FOTO_PX     = 800;    // a foto é reduzida para no máximo esta largura
const QUALIDADE_INICIAL_JPEG     = 0.7;    // 0 a 1
const QUALIDADE_MINIMA_JPEG      = 0.4;    // abaixo disso a foto passa a ser reduzida em tamanho
const TAMANHO_MAXIMO_FOTO_BYTES  = 250000; // ~250 KB por foto (3 fotos ficam abaixo de 1 MiB do Firestore)
const TAMANHO_MAXIMO_REGISTRO_BYTES = 900000; // trava de segurança (limite do Firestore: 1 MiB)

// Textos
const MAXIMO_CARACTERES_DESCRICAO = 2000;
const MAXIMO_CARACTERES_NOME      = 60;
const MAXIMO_CARACTERES_LOCAL     = 200;

// Mapa
const CENTRO_MAPA           = [-9.6658, -35.7350]; // Maceió
const ZOOM_INICIAL_MAPA     = 13;
const ZOOM_MINIMO_AO_MARCAR = 16;

// Interface
const DURACAO_TOAST_MS     = 3200;
const ESPERA_BUSCA_MS      = 500;              // espera após parar de digitar para buscar o endereço
const CHAVE_APOIOS_LOCAL   = 'mac-apoios';     // guarda no navegador quais registros a pessoa já apoiou

// Mapeamento de código de categoria para rótulo exibido
const ROTULOS_CATEGORIA = {
  fisica:   '🦽 Física',
  visual:   '👁️ Visual',
  auditiva: '👂 Auditiva',
  multipla: '♿ Geral'
};
const CATEGORIAS_VALIDAS = Object.keys(ROTULOS_CATEGORIA);

// Aceita somente fotos no formato data:image/...;base64,... (evita conteúdo malicioso vindo do banco)
const PADRAO_FOTO_VALIDA = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;


/*
   ESTADO GLOBAL DA APLICAÇÃO
*/

// Registros recebidos do Firestore (atualizado em tempo real)
let registros = [];

// Situação da conexão: 'carregando' | 'ok' | 'nao-configurado' | 'indisponivel' | 'erro'
let statusFirebase = 'carregando';

// Instância do Firestore
let banco = null;

// Aba ativa do formulário: 'sugestao' | 'denuncia'
let abaAtiva = 'sugestao';

// Filtro ativo no feed: 'todos' | 'sugestao' | 'denuncia'
let filtroAtivo = 'todos';

// Local selecionado no mapa
let latSelecionada      = null;
let lngSelecionada      = null;
let enderecoSelecionado = '';

// Fotos já comprimidas, prontas para enviar: array de { nome, dataUrl }
let fotosCarregadas = [];

// Mapa Leaflet e marcador ativo
let mapaFormulario, marcadorMapa;

// Timer para esperar o usuário parar de digitar na busca de endereço
let timerDebounceLocal;

// Evita envio duplicado enquanto um registro está sendo salvo
let enviandoRegistro = false;


/*
   FIREBASE / FIRESTORE
*/

/** Confere se o firebaseConfig foi preenchido. */
function firebaseConfigurado() {
  return ['apiKey', 'projectId', 'appId'].every(chave => {
    const valor = CONFIGURACAO_FIREBASE[chave];
    return valor && !String(valor).startsWith('COLE_AQUI');
  });
}

/**
 * Inicia o Firebase. Retorna true se o banco estiver pronto para uso.
 * Usa a versão "compat" do SDK, carregada por <script> no index.html,
 * para o site funcionar também abrindo o arquivo direto no navegador.
 */
function iniciarFirebase() {
  if (!firebaseConfigurado()) {
    statusFirebase = 'nao-configurado';
    return false;
  }

  if (typeof firebase === 'undefined') {
    statusFirebase = 'indisponivel';
    return false;
  }

  try {
    firebase.initializeApp(CONFIGURACAO_FIREBASE);
    banco = firebase.firestore();
    return true;
  } catch (erro) {
    console.error('Erro ao iniciar o Firebase:', erro);
    statusFirebase = 'erro';
    return false;
  }
}

/**
 * Fica ouvindo a coleção de registros. Sempre que alguém envia ou apoia
 * um registro, o feed e as estatísticas atualizam sozinhos.
 */
function escutarRegistros() {
  banco
    .collection(NOME_COLECAO_REGISTROS)
    .orderBy('criadoEm', 'desc')
    .limit(LIMITE_REGISTROS_NO_FEED)
    .onSnapshot(
      (resultado) => {
        registros = resultado.docs.map(documento =>
          // 'estimate' mostra o registro na hora, antes do servidor confirmar a data
          normalizarRegistro(documento.id, documento.data({ serverTimestamps: 'estimate' }))
        );
        statusFirebase = 'ok';
        renderizarTudo();
      },
      (erro) => {
        console.error('Erro ao ler os registros:', erro);
        statusFirebase = 'erro';
        renderizarTudo();
        exibirToast('Não foi possível carregar os registros.', true);
      }
    );
}

/**
 * Limpa e valida os dados vindos do banco antes de exibir.
 * Como qualquer pessoa pode gravar no banco, nada é confiado "no escuro".
 */
function normalizarRegistro(id, dados) {
  const ehNumero = (valor) => typeof valor === 'number' && Number.isFinite(valor);

  return {
    id:        String(id),
    tipo:      dados.tipo === 'denuncia' ? 'denuncia' : 'sugestao',
    titulo:    String(dados.titulo || '').slice(0, 80),
    descricao: String(dados.descricao || '').slice(0, MAXIMO_CARACTERES_DESCRICAO),
    bairro:    String(dados.bairro || '').slice(0, MAXIMO_CARACTERES_LOCAL),
    autor:     String(dados.autor || 'Anônimo').slice(0, MAXIMO_CARACTERES_NOME),
    data:      /^\d{4}-\d{2}-\d{2}$/.test(dados.data) ? dados.data : '',
    votos:     ehNumero(dados.votos) ? Math.max(0, Math.trunc(dados.votos)) : 0,
    lat:       ehNumero(dados.lat) ? dados.lat : null,
    lng:       ehNumero(dados.lng) ? dados.lng : null,
    cats:      (Array.isArray(dados.cats) ? dados.cats : [])
                 .filter(c => CATEGORIAS_VALIDAS.includes(c)).slice(0, CATEGORIAS_VALIDAS.length),
    fotos:     (Array.isArray(dados.fotos) ? dados.fotos : [])
                 .filter(f => typeof f === 'string' && PADRAO_FOTO_VALIDA.test(f))
                 .slice(0, MAXIMO_FOTOS_POR_REGISTRO)
  };
}


/*
   MAPA INTERATIVO (Leaflet)
*/

/**
 * Inicializa o mapa centralizado em Maceió (tiles do OpenStreetMap, sem chave de API).
 * Clique no mapa: posiciona o marcador e descobre o endereço do ponto.
 */
function inicializarMapa() {
  mapaFormulario = L.map('mapa-formulario', {
    zoomControl: true,
    attributionControl: false
  }).setView(CENTRO_MAPA, ZOOM_INICIAL_MAPA);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
  }).addTo(mapaFormulario);

  mapaFormulario.on('click', async function (evento) {
    const { lat, lng } = evento.latlng;
    posicionarPinoMapa(lat, lng);
    const endereco = await geocodificarReverso(lat, lng);
    definirLocalSelecionado(lat, lng, endereco);
  });
}

/** Posiciona (ou move) o marcador laranja e aproxima o mapa do ponto. */
function posicionarPinoMapa(lat, lng) {
  if (marcadorMapa) mapaFormulario.removeLayer(marcadorMapa);

  marcadorMapa = L.circleMarker([lat, lng], {
    radius: 9,
    fillColor: '#F0A45D',
    fillOpacity: 1,
    color: 'white',
    weight: 3
  }).addTo(mapaFormulario);

  mapaFormulario.setView([lat, lng], Math.max(mapaFormulario.getZoom(), ZOOM_MINIMO_AO_MARCAR));
  document.getElementById('dica-mapa').style.display = 'none';
}

/** Guarda o local escolhido e atualiza a interface. */
function definirLocalSelecionado(lat, lng, endereco) {
  latSelecionada      = lat;
  lngSelecionada      = lng;
  enderecoSelecionado = endereco;

  document.getElementById('texto-local-selecionado').textContent = endereco;
  document.getElementById('tag-local-selecionado').style.display = 'flex';
  document.getElementById('input-localizacao').value = endereco;

  ocultarSugestoes();
}

/** Remove o local selecionado e volta o mapa ao estado inicial. */
function limparLocalizacao() {
  latSelecionada      = null;
  lngSelecionada      = null;
  enderecoSelecionado = '';

  if (marcadorMapa) {
    mapaFormulario.removeLayer(marcadorMapa);
    marcadorMapa = null;
  }

  document.getElementById('tag-local-selecionado').style.display = 'none';
  document.getElementById('input-localizacao').value = '';
  document.getElementById('dica-mapa').style.display = 'block';
}


/*
   BUSCA DE ENDEREÇOS (Nominatim / OpenStreetMap)
*/

/** Busca endereços no Nominatim, sempre dentro de Maceió, Alagoas. */
async function buscarLocalizacao() {
  const consulta = document.getElementById('input-localizacao').value.trim();
  if (!consulta) return;

  exibirCarregandoSugestoes();

  try {
    const resposta = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json` +
      `&q=${encodeURIComponent(consulta + ', Maceió, Alagoas')}` +
      `&limit=5&accept-language=pt-BR`
    );
    const resultados = await resposta.json();
    exibirSugestoes(resultados);
  } catch (erro) {
    ocultarSugestoes();
    exibirToast('Não foi possível buscar o endereço. Tente clicar no mapa.', true);
  }
}

/** Converte coordenadas em endereço legível (rua, bairro, cidade). */
async function geocodificarReverso(lat, lng) {
  try {
    const resposta = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json` +
      `&lat=${lat}&lon=${lng}&accept-language=pt-BR`
    );
    const dados = await resposta.json();

    if (dados.display_name) {
      const endereco = dados.address || {};
      const partes   = [
        endereco.road,
        endereco.suburb || endereco.neighbourhood,
        endereco.city   || endereco.town
      ].filter(Boolean);

      return partes.join(', ') ||
             dados.display_name.split(',').slice(0, 3).join(',').trim();
    }
  } catch (erro) {
    // Se falhar, usa as coordenadas como endereço
  }

  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** Busca automaticamente depois que a pessoa para de digitar. */
function aoDigitarLocal() {
  clearTimeout(timerDebounceLocal);
  const consulta = document.getElementById('input-localizacao').value.trim();
  if (consulta.length < 3) { ocultarSugestoes(); return; }
  timerDebounceLocal = setTimeout(buscarLocalizacao, ESPERA_BUSCA_MS);
}

/** Enter no campo de localização dispara a busca. */
function aoTeclarLocal(evento) {
  if (evento.key === 'Enter') {
    evento.preventDefault();
    buscarLocalizacao();
  }
}

function exibirCarregandoSugestoes() {
  const el = document.getElementById('sugestoes-local');
  el.innerHTML = '<div class="sugestao-carregando">Buscando...</div>';
  el.style.display = 'block';
}

/** Lista as sugestões. Os dados vão em atributos data-* e o clique é tratado mais abaixo. */
function exibirSugestoes(resultados) {
  const el = document.getElementById('sugestoes-local');

  if (!resultados || resultados.length === 0) {
    el.innerHTML = '<div class="sugestao-carregando">Nenhum resultado. Tente clicar no mapa.</div>';
    el.style.display = 'block';
    return;
  }

  el.innerHTML = resultados.map(r => {
    const rotulo = r.display_name.split(',').slice(0, 3).join(',').trim();
    return `<div class="item-sugestao-local"
                 data-lat="${Number(r.lat)}"
                 data-lng="${Number(r.lon)}"
                 data-rotulo="${escaparHtml(rotulo)}">${escaparHtml(rotulo)}</div>`;
  }).join('');

  el.style.display = 'block';
}

function ocultarSugestoes() {
  document.getElementById('sugestoes-local').style.display = 'none';
}

/** Escolhe uma sugestão da lista e leva o mapa até ela. */
function selecionarSugestao(lat, lng, rotulo) {
  posicionarPinoMapa(lat, lng);
  definirLocalSelecionado(lat, lng, rotulo);
}

// Clique em uma sugestão da lista
document.getElementById('sugestoes-local').addEventListener('click', (evento) => {
  const item = evento.target.closest('.item-sugestao-local');
  if (!item) return;
  selecionarSugestao(Number(item.dataset.lat), Number(item.dataset.lng), item.dataset.rotulo);
});

// Clique fora do campo fecha a lista
document.addEventListener('click', (evento) => {
  if (!evento.target.closest('.wrap-busca-local')) ocultarSugestoes();
});


/*
   FOTOS: COMPRESSÃO E PRÉ-VISUALIZAÇÃO
*/

const areaUpload = document.getElementById('area-upload');

areaUpload.addEventListener('dragover', (e) => {
  e.preventDefault();
  areaUpload.classList.add('arrastando');
});

areaUpload.addEventListener('dragleave', () => {
  areaUpload.classList.remove('arrastando');
});

areaUpload.addEventListener('drop', (e) => {
  e.preventDefault();
  areaUpload.classList.remove('arrastando');
  processarFotos({ target: { files: e.dataTransfer.files, value: '' } });
});

/** Tamanho aproximado, em bytes, de uma imagem em data URL (base64). */
function tamanhoEmBytes(dataUrl) {
  return Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
}

/** Carrega o arquivo de imagem em um elemento <img>. */
function carregarImagem(arquivo) {
  return new Promise((resolver, rejeitar) => {
    const endereco = URL.createObjectURL(arquivo);
    const imagem   = new Image();
    imagem.onload  = () => { URL.revokeObjectURL(endereco); resolver(imagem); };
    imagem.onerror = () => { URL.revokeObjectURL(endereco); rejeitar(new Error('Imagem inválida')); };
    imagem.src     = endereco;
  });
}

/**
 * Reduz a foto para no máximo LARGURA_MAXIMA_FOTO_PX e converte para JPEG.
 * Se ainda ficar maior que TAMANHO_MAXIMO_FOTO_BYTES, baixa a qualidade
 * e, por último, diminui o tamanho até caber.
 */
async function comprimirImagem(arquivo) {
  const imagem  = await carregarImagem(arquivo);
  let largura   = Math.min(imagem.naturalWidth, LARGURA_MAXIMA_FOTO_PX);
  let qualidade = QUALIDADE_INICIAL_JPEG;

  for (let tentativa = 0; tentativa < 10; tentativa++) {
    const escala = largura / imagem.naturalWidth;
    const tela   = document.createElement('canvas');
    tela.width   = Math.max(1, Math.round(imagem.naturalWidth  * escala));
    tela.height  = Math.max(1, Math.round(imagem.naturalHeight * escala));

    const contexto = tela.getContext('2d');
    contexto.fillStyle = '#FFFFFF'; // fundo branco (PNG transparente viraria preto no JPEG)
    contexto.fillRect(0, 0, tela.width, tela.height);
    contexto.drawImage(imagem, 0, 0, tela.width, tela.height);

    const dataUrl = tela.toDataURL('image/jpeg', qualidade);
    if (tamanhoEmBytes(dataUrl) <= TAMANHO_MAXIMO_FOTO_BYTES) return dataUrl;

    if (qualidade > QUALIDADE_MINIMA_JPEG) {
      qualidade = Math.max(qualidade - 0.1, QUALIDADE_MINIMA_JPEG);
    } else {
      largura = Math.round(largura * 0.8);
    }
  }

  throw new Error('Não foi possível reduzir a foto');
}

/** Recebe os arquivos escolhidos (ou arrastados), valida, comprime e mostra a miniatura. */
async function processarFotos(evento) {
  const arquivos = Array.from(evento.target.files || []);
  evento.target.value = ''; // permite escolher o mesmo arquivo de novo

  if (fotosCarregadas.length >= MAXIMO_FOTOS_POR_REGISTRO) {
    exibirToast(`Limite de ${MAXIMO_FOTOS_POR_REGISTRO} fotos atingido.`, true);
    return;
  }

  for (const arquivo of arquivos) {
    if (fotosCarregadas.length >= MAXIMO_FOTOS_POR_REGISTRO) {
      exibirToast(`Só as primeiras ${MAXIMO_FOTOS_POR_REGISTRO} fotos foram adicionadas.`, true);
      break;
    }

    if (!arquivo.type.startsWith('image/')) continue;

    if (arquivo.size > MAXIMO_MB_ARQUIVO_ORIGINAL * 1024 * 1024) {
      exibirToast(`"${arquivo.name}" ultrapassa ${MAXIMO_MB_ARQUIVO_ORIGINAL} MB.`, true);
      continue;
    }

    try {
      const dataUrl = await comprimirImagem(arquivo);
      fotosCarregadas.push({ nome: arquivo.name, dataUrl });
      renderizarPreviewsFotos();
    } catch (erro) {
      exibirToast(`Não foi possível usar a foto "${arquivo.name}".`, true);
    }
  }
}

function removerFoto(indice) {
  fotosCarregadas.splice(indice, 1);
  renderizarPreviewsFotos();
}

/** Miniaturas das fotos selecionadas, com botão de remoção. */
function renderizarPreviewsFotos() {
  document.getElementById('previews-fotos').innerHTML = fotosCarregadas.map((foto, i) => `
    <div class="miniatura-foto">
      <img src="${foto.dataUrl}" alt="${escaparHtml(foto.nome)}"/>
      <button class="btn-remover-foto" data-acao="remover-foto" data-indice="${i}" title="Remover">✕</button>
    </div>
  `).join('');
}

document.getElementById('previews-fotos').addEventListener('click', (evento) => {
  const botao = evento.target.closest('[data-acao="remover-foto"]');
  if (botao) removerFoto(Number(botao.dataset.indice));
});


/*
   ABAS E CATEGORIAS DO FORMULÁRIO
*/

/** Alterna entre "Sugestão" e "Denúncia" e troca o texto de apoio. */
function trocarAba(botao) {
  document.querySelectorAll('.aba-tipo').forEach(t => t.classList.remove('ativo'));
  botao.classList.add('ativo');
  abaAtiva = botao.dataset.tipo;

  document.getElementById('msg-contexto-formulario').textContent = abaAtiva === 'denuncia'
    ? 'Conhece um local onde a acessibilidade foi instalada mas está danificada, bloqueada ou simplesmente não funciona? Registre aqui.'
    : 'Tem alguma ideia de como um espaço público poderia ser mais inclusivo? Calçada sem rampa, sinalização inadequada, falta de piso tátil? Conte pra gente.';
}

/**
 * Deixa o visual da categoria igual ao estado do checkbox (marcado = destacado).
 * O estado real fica no checkbox; a classe "selecionado" é só a aparência.
 */
function atualizarVisualCategoria(checkbox) {
  checkbox.closest('.opcao-categoria').classList.toggle('selecionado', checkbox.checked);
}

// O clique no rótulo marca o checkbox sozinho; aqui só reagimos à mudança dele
document.querySelector('.grade-categorias').addEventListener('change', (evento) => {
  if (evento.target.matches('input[type="checkbox"]')) {
    atualizarVisualCategoria(evento.target);
  }
});


/*
   ENVIO DO REGISTRO (grava no Firestore)
*/

/** Data de hoje no horário local, no formato AAAA-MM-DD. */
function dataLocalISO() {
  const hoje = new Date();
  const mes  = String(hoje.getMonth() + 1).padStart(2, '0');
  const dia  = String(hoje.getDate()).padStart(2, '0');
  return `${hoje.getFullYear()}-${mes}-${dia}`;
}

/** Valida os campos, grava o registro no Firestore e limpa o formulário. */
async function enviarRegistro() {
  if (enviandoRegistro) return;

  if (!banco) {
    exibirToast('O banco de dados ainda não está conectado.', true);
    return;
  }

  const titulo    = document.getElementById('input-titulo').value.trim();
  const descricao = document.getElementById('input-descricao').value.trim();
  const nome      = document.getElementById('input-nome').value.trim() || 'Anônimo';
  const local     = document.getElementById('input-localizacao').value.trim();

  const categorias = Array.from(
    document.querySelectorAll('.opcao-categoria input:checked')
  ).map(input => input.value);

  // Validações
  if (!titulo)    { exibirToast('Adicione um título para o registro.', true); return; }
  if (!descricao) { exibirToast('A descrição não pode ficar em branco.', true); return; }
  if (descricao.length > MAXIMO_CARACTERES_DESCRICAO) {
    exibirToast(`A descrição pode ter no máximo ${MAXIMO_CARACTERES_DESCRICAO} caracteres.`, true);
    return;
  }
  if (!enderecoSelecionado && !local) {
    exibirToast('Informe ou marque o local no mapa.', true);
    return;
  }

  const novoRegistro = {
    tipo:      abaAtiva,
    titulo:    titulo,
    descricao: descricao,
    bairro:    (enderecoSelecionado || local).slice(0, MAXIMO_CARACTERES_LOCAL),
    cats:      categorias,
    autor:     nome.slice(0, MAXIMO_CARACTERES_NOME),
    data:      dataLocalISO(),
    criadoEm:  firebase.firestore.FieldValue.serverTimestamp(), // data/hora oficial do servidor
    votos:     0,
    lat:       latSelecionada,
    lng:       lngSelecionada,
    fotos:     fotosCarregadas.map(f => f.dataUrl)
  };

  // Trava de segurança: o Firestore recusa documentos acima de 1 MiB
  const tamanhoEstimado = novoRegistro.fotos.reduce((soma, f) => soma + f.length, 0)
                        + titulo.length + descricao.length + 1000;
  if (tamanhoEstimado > TAMANHO_MAXIMO_REGISTRO_BYTES) {
    exibirToast('As fotos ficaram grandes demais. Remova alguma e tente de novo.', true);
    return;
  }

  // Bloqueia o botão durante o envio
  const botaoEnviar = document.querySelector('.btn-enviar');
  enviandoRegistro = true;
  botaoEnviar.disabled = true;
  botaoEnviar.textContent = 'Enviando...';

  try {
    await banco.collection(NOME_COLECAO_REGISTROS).add(novoRegistro);

    // Limpa o formulário
    document.getElementById('input-titulo').value = '';
    document.getElementById('input-descricao').value = '';
    document.getElementById('input-nome').value = '';
    document.querySelectorAll('.opcao-categoria input').forEach(input => {
      input.checked = false;
      atualizarVisualCategoria(input);
    });
    fotosCarregadas = [];
    renderizarPreviewsFotos();
    limparLocalizacao();

    exibirToast(abaAtiva === 'sugestao'
      ? '✓ Sugestão enviada! Obrigado pela contribuição.'
      : '✓ Denúncia registrada! Obrigado por ajudar.');

    setTimeout(() => {
      document.getElementById('lista-registros').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 400);
  } catch (erro) {
    console.error('Erro ao salvar o registro:', erro);
    exibirToast('Não foi possível enviar. Confira a conexão e as regras do Firestore.', true);
  } finally {
    enviandoRegistro = false;
    botaoEnviar.disabled = false;
    botaoEnviar.textContent = 'Enviar registro →';
  }
}


/*
   APOIOS (VOTOS)
*/

/** Lê do navegador a lista de registros que esta pessoa já apoiou. */
function obterApoiosLocais() {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_APOIOS_LOCAL) || '[]');
  } catch (erro) {
    return [];
  }
}

function verificarApoio(id) {
  return obterApoiosLocais().includes(id);
}

function guardarApoioLocal(id, apoiado) {
  const lista = obterApoiosLocais().filter(item => item !== id);
  if (apoiado) lista.push(id);
  try { localStorage.setItem(CHAVE_APOIOS_LOCAL, JSON.stringify(lista)); } catch (erro) {}
}

/**
 * Soma 1 apoio no registro. Cada navegador apoia uma vez só (as regras do
 * Firestore também só aceitam somar 1 por vez, e nunca diminuir).
 */
async function apoiarRegistro(id) {
  if (!banco) return;

  if (verificarApoio(id)) {
    exibirToast('Você já apoiou este registro.');
    return;
  }

  guardarApoioLocal(id, true); // marca na hora; desfaz se o envio falhar
  renderizarFeed();

  try {
    await banco.collection(NOME_COLECAO_REGISTROS).doc(id).update({
      votos: firebase.firestore.FieldValue.increment(1)
    });
  } catch (erro) {
    console.error('Erro ao registrar apoio:', erro);
    guardarApoioLocal(id, false);
    renderizarFeed();
    exibirToast('Não foi possível registrar o apoio.', true);
  }
}


/*
   FILTRO DO FEED E LIGHTBOX
*/

function filtrarFeed(botao) {
  document.querySelectorAll('.pílula-filtro').forEach(p => p.classList.remove('ativo'));
  botao.classList.add('ativo');
  filtroAtivo = botao.dataset.filtro;
  renderizarFeed();
}

function abrirLightbox(src) {
  document.getElementById('lightbox-imagem').src = src;
  document.getElementById('lightbox').classList.add('aberto');
}

function fecharLightbox() {
  document.getElementById('lightbox').classList.remove('aberto');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') fecharLightbox();
});

// Cliques dentro da lista de registros: apoiar e ampliar foto
document.getElementById('lista-registros').addEventListener('click', (evento) => {
  const alvo = evento.target.closest('[data-acao]');
  if (!alvo) return;

  if (alvo.dataset.acao === 'apoiar')  apoiarRegistro(alvo.dataset.id);
  if (alvo.dataset.acao === 'ampliar') abrirLightbox(alvo.getAttribute('src'));
});


/*
   RENDERIZAÇÃO DO FEED
*/

/** Mensagem exibida no lugar da lista enquanto o banco não está pronto. */
function montarAvisoStatus() {
  const mensagens = {
    'carregando':      'Carregando registros...',
    'nao-configurado': 'O banco de dados ainda não foi conectado. Cole o firebaseConfig no topo do arquivo script.js para ativar os registros.',
    'indisponivel':    'Não foi possível carregar o Firebase. Verifique a conexão com a internet e recarregue a página.',
    'erro':            'Não foi possível carregar os registros. Verifique a conexão e as regras do Firestore.'
  };
  return `<div class="aviso-status">${mensagens[statusFirebase] || mensagens['erro']}</div>`;
}

/** Desenha os cards de registro respeitando o filtro ativo. */
function renderizarFeed() {
  const listaEl = document.getElementById('lista-registros');
  const vazioEl = document.getElementById('estado-vazio');

  if (statusFirebase !== 'ok') {
    listaEl.innerHTML = montarAvisoStatus();
    vazioEl.style.display = 'none';
    return;
  }

  const filtrados = filtroAtivo === 'todos'
    ? registros
    : registros.filter(r => r.tipo === filtroAtivo);

  if (filtrados.length === 0) {
    listaEl.innerHTML = '';
    vazioEl.style.display = 'block';
    return;
  }

  vazioEl.style.display = 'none';

  listaEl.innerHTML = filtrados.map(registro => {
    const apoiado = verificarApoio(registro.id);

    const dataFmt = registro.data
      ? new Date(registro.data + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
      : '';

    const tagsCat = registro.cats
      .map(c => `<span class="tag-categoria">${ROTULOS_CATEGORIA[c]}</span>`)
      .join('');

    // As fotos já passaram pela validação em normalizarRegistro()
    const htmlFotos = registro.fotos.length > 0
      ? `<div class="registro-fotos">
           ${registro.fotos.map(src =>
             `<img class="foto-registro" src="${src}" alt="Foto anexada ao registro" data-acao="ampliar" />`
           ).join('')}
         </div>`
      : '';

    const linkMapa = (registro.lat !== null && registro.lng !== null)
      ? `<a class="link-ver-mapa"
            href="https://www.openstreetmap.org/?mlat=${registro.lat}&mlon=${registro.lng}#map=17/${registro.lat}/${registro.lng}"
            target="_blank" rel="noopener">🗺️ Ver no mapa</a>`
      : '';

    return `
      <div class="card-registro">

        <div class="registro-topo">
          <span class="badge-tipo ${registro.tipo === 'sugestao' ? 'badge-tipo--sugestao' : 'badge-tipo--denuncia'}">
            ${registro.tipo === 'sugestao' ? '💡 Sugestão' : '🚨 Denúncia'}
          </span>
          <span class="registro-meta">${escaparHtml(registro.autor)}${dataFmt ? ' · ' + dataFmt : ''}</span>
        </div>

        ${tagsCat ? `<div class="registro-categorias">${tagsCat}</div>` : ''}

        <div class="registro-titulo">${escaparHtml(registro.titulo)}</div>
        <div class="registro-descricao">${escaparHtml(registro.descricao)}</div>

        ${htmlFotos}
        ${linkMapa}

        <div class="registro-rodape">
          <span class="registro-local">📍 ${escaparHtml(registro.bairro)}</span>
          <div class="area-votos">
            <button class="btn-apoiar ${apoiado ? 'apoiado' : ''}"
                    data-acao="apoiar"
                    data-id="${escaparHtml(registro.id)}"
                    ${apoiado ? 'disabled' : ''}>
              👍 ${apoiado ? 'Apoiado' : 'Apoiar'} <strong>${registro.votos}</strong>
            </button>
          </div>
        </div>

      </div>`;
  }).join('');
}


/*
   ESTATÍSTICAS E CONTADORES
*/

function renderizarEstatisticas() {
  const totalSugestoes = registros.filter(r => r.tipo === 'sugestao').length;
  const totalDenuncias = registros.filter(r => r.tipo === 'denuncia').length;
  const totalBairros   = new Set(registros.map(r => r.bairro.toLowerCase().trim())).size;
  const totalVotos     = registros.reduce((soma, r) => soma + r.votos, 0);

  animarContador('count-sugestoes', totalSugestoes);
  animarContador('count-denuncias', totalDenuncias);
  animarContador('count-bairros',   totalBairros);
  animarContador('count-votos',     totalVotos);

  const contagemCats = { fisica: 0, visual: 0, auditiva: 0, multipla: 0 };
  registros.forEach(r => r.cats.forEach(cat => { contagemCats[cat]++; }));

  document.getElementById('t-fisica').textContent   = contagemCats.fisica;
  document.getElementById('t-visual').textContent   = contagemCats.visual;
  document.getElementById('t-auditiva').textContent = contagemCats.auditiva;
  document.getElementById('t-multipla').textContent = contagemCats.multipla;
}

/** Anima um número do valor atual até o valor final. */
function animarContador(idElemento, valorAlvo) {
  const el           = document.getElementById(idElemento);
  const valorInicial = parseInt(el.textContent) || 0;
  const duracao      = 600; // milissegundos
  const inicio       = performance.now();

  function etapa(agora) {
    const progresso = Math.min((agora - inicio) / duracao, 1);
    el.textContent  = Math.round(valorInicial + (valorAlvo - valorInicial) * progresso);
    if (progresso < 1) requestAnimationFrame(etapa);
  }

  requestAnimationFrame(etapa);
}

function renderizarTudo() {
  renderizarFeed();
  renderizarEstatisticas();
}


/*
   TOAST E FUNÇÕES AUXILIARES
*/

/** Mostra uma mensagem rápida no canto da tela. Em vermelho quando erro = true. */
function exibirToast(mensagem, erro = false) {
  const toast = document.getElementById('toast');
  toast.textContent      = mensagem;
  toast.style.background = erro ? '#8B1A1A' : 'var(--azul-profundo)';
  toast.classList.add('visivel');
  setTimeout(() => toast.classList.remove('visivel'), DURACAO_TOAST_MS);
}

/** Escapa caracteres especiais para inserir texto de usuário no HTML com segurança. */
function escaparHtml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


/*
   INICIALIZAÇÃO
*/

renderizarTudo();   // mostra "Carregando..." (ou o aviso de configuração)
inicializarMapa();

if (iniciarFirebase()) {
  escutarRegistros();
} else {
  renderizarTudo();  // mostra o aviso do motivo (não configurado, indisponível ou erro)
}
