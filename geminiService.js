import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { obterDadosPlanilha } from './excelService.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Captura a data e hora atual do sistema no fuso horário do Brasil (América/São_Paulo)
 */
function obterDataEHoraAtual() {
  const agora = new Date();
  return agora.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * =============================================================================
 * PROMPT ÚNICO E CENTRALIZADO DE REGRAS DA FARMÁCIA
 * Todas as regras de negócio, triagem e decisões do bot ficam AQUI.
 * Modifique este trecho para atualizar o comportamento de texto, áudio e mídias.
 * =============================================================================
 */
function GERAR_PROMPT_SISTEMA(nomeCliente, historicoMensagens = '') {
  const informacoesFarmacia = obterDadosPlanilha();
  const momentoAtual = obterDataEHoraAtual(); // Exemplo esperado: "10/08/2026, 20:30:00"

  return `
Você é o atendente virtual de triagem de uma farmácia movimentada.
Seu objetivo é simular um atendimento humano cortês, ágil e eficiente, decidindo se a dúvida do cliente pode ser resolvida pelo próprio bot ou se exige intervenção humana no balcão/farmacêutico.

MOMENTO ATUAL DO ATENDIMENTO: ${momentoAtual}

INFORMAÇÕES ATUALIZADAS DA FARMÁCIA (Planilha Excel):${informacoesFarmacia}

HISTÓRICO COMPLETO DA CONVERSA / ENTRADA:${historicoMensagens}

=============================================================================
REGRAS OBRIGATÓRIAS DE SAUDAÇÃO E HORÁRIO:
- EXTRAIA a hora atual a partir do "MOMENTO ATUAL DO ATENDIMENTO": ${momentoAtual} .
- IGNORE a saudação dita pelo cliente (se o cliente disser "bom dia" sendo ainda de noite, CORRIJA na sua resposta).
- Defina o cumprimento no campo 'respostaParaCliente' ESTRITAMENTE de acordo com o horário do sistema:
  * De 00:00h até 11:59h: Use obrigatoriamente "Bom dia"
  * De 12:00h até 17:59h: Use obrigatoriamente "Boa tarde"
  * De 18:00h e 23:59h: Use obrigatoriamente "Boa noite"
- No histórico das mensagens: ${historicoMensagens} se você ja deu ou bom dia, ou boa tarde, ou boa noite, não dar mais e 
  ir direto ao assunto como cliente, sendo breve e rápido.

=============================================================================
REGRAS DE VERIFICAÇÃO DE HORÁRIO DE FUNCIONAMENTO:
- Compare o MOMENTO ATUAL com os horários presentes nas INFORMAÇÕES DA FARMÁCIA.
- Se o cliente perguntar se está aberto/fechado ou fizer um pedido fora do horário:
  * Responda educadamente em pouquíssimas palavras informando o status atual e o horário de reabertura.

=============================================================================
REGRAS DE TRIAGEM E DECISÃO DE TRANSFERÊNCIA:

1. REGRA SOBERANA - SOLICITAÇÃO DE FARMACÊUTICO OU ATENDIMENTO HUMANO:
   - Se o cliente pedir para falar com o FARMACÊUTICO, com um atendente humano ou balcão:      
     * Defina SEMPRE 'transferirParaBalcao = true'.
     * Defina 'urgencia = true' se for referente a sintomas, medicamentos controlados ou orientação técnica.
     * Crie um 'resumoTriagem' claro informando: "Cliente solicitou atendimento direto com o farmacêutico/balcão."
     * Responda ao cliente de forma curta, informando que está chamando o farmacêutico/atendente.

2. QUANDO O BOT RESPONDE SOZINHO (transferirParaBalcao = false):
   - Saudações e cumprimentos sociais isolados.
   - Dúvidas gerais sobre horário de funcionamento, se está aberto/fechado ou feriados.
   - Informações sobre formas de pagamento (Pix, Cartão, Dinheiro).
   - Consultas sobre taxas de delivery por quilometragem (conforme planilha).
   - Localização ou endereço da farmácia.
   -> Responda com clareza e de forma curtíssima e sem incomodar a equipe do balcão.

3. QUANDO PASSAR PARA O BALCÃO (transferirParaBalcao = true):
   - Pedidos de orçamento de receitas, listas de medicamentos, cotação de preços ou estoque.
   - Envio de foto/PDF de receita ou caixinha de remédio.
   - Pedidos de indicação de remédios para sintomas.
   - Solicitou falar com o farmacêutico ou balcão.
   - Status de encomendas ("meu remédio chegou?").
   - Confirmação/Envio de comprovante Pix.
   - Solicitação de entrega/delivery ativa de medicamentos.
   Obs.: Seja curtíssimo ao responder o cliente, de forma educada, não use muitas palavras.

4. ANÁLISE DE MÍDIAS, ÁUDIOS E MÚLTIPLAS MENSAGENS:
   - ÁUDIO: Transcreva o áudio com precisão e inclua no campo 'transcricao'.
   - FOTOS / PDFS DE RECEITAS: Identifique e transcreva os medicamentos e dosagens.
   - Se o cliente indicar filtros (ex: "Não precisa do 1º item da receita" ou "Inclua fralda"):
     * Aplique o filtro e liste apenas os itens solicitados no 'resumoTriagem' ou 'itensFiltradosParaOrcamento'.
   - Se houver múltiplas mensagens em sequência, consolide TODOS os itens ou pedidos em uma lista única no 'resumoTriagem'.
`;
}
/**
 * MOTOR CENTRAL DE PROCESSAMENTO DA IA
 * Executa a chamada no Gemini injetando o prompt unificado.
 */
async function executarTriagemGeral(nomeCliente, historicoOuTexto, mediaParts = []) {
  const model = genAI.getGenerativeModel({ 
    model: 'gemini-2.5-flash-lite',
    generationConfig: { responseMimeType: "application/json" }
  });

  const promptText = GERAR_PROMPT_SISTEMA(nomeCliente, historicoOuTexto);
  const contents = mediaParts.length > 0 ? [promptText, ...mediaParts] : promptText;

  const result = await model.generateContent(contents);
  const text = result.response.text();
  return JSON.parse(text);
}

/**
 * 1. PROCESSA MENSAGENS DE TEXTO DO CLIENTE
 */
export async function processarMensagemCliente(nomeCliente, historicoMensagens) {
  try {
    return await executarTriagemGeral(nomeCliente, historicoMensagens);
  } catch (error) {
    console.error("Erro no processamento do Gemini (Texto):", error.message);
    return {
      cliente: nomeCliente,
      intencao: "Atendimento Geral",
      transferirParaBalcao: true,
      urgencia: false,
      resumoTriagem: "Erro no processamento da IA. Requer verificação humana no balcão.",
      respostaParaCliente: "Olá! Só um instante, vou transferir você para um atendente."
    };
  }
}

/**
 * 2. PROCESSA MENSAGENS DE ÁUDIO DO CLIENTE
 */
export async function processarAudioCliente(nomeCliente, audioBuffer, mimeType = 'audio/ogg') {
  const audioPart = {
    inlineData: {
      data: audioBuffer.toString('base64'),
      mimeType: mimeType
    }
  };

  try {
    return await executarTriagemGeral(nomeCliente, "[ÁUDIO ENVIADO PELO CLIENTE]", [audioPart]);
  } catch (error) {
    console.error("Erro no processamento de áudio pelo Gemini:", error.message);
    return {
      transcricao: "[Áudio não transcrito]",
      cliente: nomeCliente,
      intencao: "Atendimento por Áudio",
      transferirParaBalcao: true,
      urgencia: false,
      resumoTriagem: "Erro ao processar áudio ou solicitação humana. Requer atendimento no balcão.",
      respostaParaCliente: "Recebi seu áudio! Vou transferir você para um atendente!"
    };
  }
}

/**
 * 3. PROCESSA FOTOS DE RECEITAS, PRODUTOS E ARQUIVOS PDF
 */
export async function processarMidiaCliente(nomeCliente, fileBuffer, mimeType, historicoMensagens = '') {
  const mediaPart = {
    inlineData: {
      data: fileBuffer.toString('base64'),
      mimeType: mimeType
    }
  };

  try {
    const contexto = `[ARQUIVO/MÍDIA ENVIADO PELO CLIENTE]\nHistórico prévio:\n${historicoMensagens}`;
    return await executarTriagemGeral(nomeCliente, contexto, [mediaPart]);
  } catch (error) {
    console.error("Erro no processamento de mídia pelo Gemini:", error.message);
    return {
      cliente: nomeCliente,
      intencao: "Orçamento por Mídia",
      transferirParaBalcao: true,
      urgencia: false,
      itensFiltradosParaOrcamento: [],
      observacoesDoCliente: "Erro na leitura automática da imagem/PDF",
      resumoTriagem: "Cliente enviou imagem/PDF de receita. Favor verificar manualmente.",
      respostaParaCliente: "Recebi seu arquivo! Vou encaminhar para a nossa equipe do balcão/farmacêutico agora mesmo."
    };
  }
}