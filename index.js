import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason, 
  downloadMediaMessage 
} from '@whiskeysockets/baileys'; 
import pino from 'pino';
import open from 'open';
import fs from 'fs';
import { processarMensagemCliente, processarAudioCliente } from './geminiService.js';
import { conectarBanco } from './db.js';
import SessaoCliente from './models/sessaocliente.js';
import Triagem from './models/triagem.js';

const MODO_TESTE = true; 

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static('public'));

let sock;
let whatsappConectado = false;
const PASTA_AUTH = 'auth_info_baileys';

const ESTADOS = {
  BOT_TRIAGEM: 'BOT_TRIAGEM',
  AGUARDANDO_HUMANO: 'AGUARDANDO_HUMANO',
  CONCLUIDO: 'CONCLUIDO'
};

// =============================================================================
// GERENCIADOR DE ESTADOS NO MONGODB
// =============================================================================
async function obterEstadoCliente(id) {
  let sessao = await SessaoCliente.findOne({ id });
  if (!sessao) {
    sessao = await SessaoCliente.create({ id, estado: ESTADOS.BOT_TRIAGEM });
  }
  return sessao;
}

async function atualizarEstadoCliente(id, novoEstado) {
  return await SessaoCliente.findOneAndUpdate(
    { id },
    { estado: novoEstado, updatedAt: new Date() },
    { upsert: true, new: true }
  );
}

// =============================================================================
// CONEXÃO WHATSAPP (COM LIMPEZA AUTOMÁTICA EM CASO DE ERRO 401/LOGGED OUT)
// =============================================================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_AUTH);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }), 
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      whatsappConectado = true;
      io.emit('whatsapp_status', 'Conectado com sucesso!');
      console.log('✅ WhatsApp conectado via Código de Pareamento!');
    }

    if (connection === 'close') {
      whatsappConectado = false;
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      
      // Identifica se o erro foi de deslogado/não autorizado (Erro 401)
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

      console.log(`⚠️ Conexão fechada. Motivo / Status Code: ${statusCode}`);
      io.emit('whatsapp_status', 'Conexão perdida. Reiniciando pareamento...');

      // Limpa os arquivos temporários caso o acesso tenha sido negado (401) ou não registrado
      if (isLoggedOut || !sock?.authState?.creds?.registered) {
        console.log('🧹 Limpando dados da pasta auth_info_baileys para permitir novo código...');
        try {
          fs.rmSync(PASTA_AUTH, { recursive: true, force: true });
        } catch (e) {
          console.error('Erro ao limpar pasta de autenticação:', e.message);
        }
      }

      // Reinicia a conexão do Baileys para aguardar a nova tentativa
      connectToWhatsApp();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!MODO_TESTE && msg.key.fromMe) continue;
      if (!msg.message) continue;

      const remetente = msg.key.remoteJid;
      const nomeCliente = MODO_TESTE && msg.key.fromMe ? 'Você (Cliente Simulado)' : (msg.pushName || remetente.split('@')[0]);

      const sessaoCliente = await obterEstadoCliente(remetente);

      if (sessaoCliente.estado === ESTADOS.AGUARDANDO_HUMANO) {
        console.log(`[TRAVA DO BOT] Mensagem de "${nomeCliente}" ignorada pela IA (Cliente em fila humana).`);
        
        const textoExtra = msg.message.conversation || msg.message.extendedTextMessage?.text || '[Mídia/Áudio]';
        
        await Triagem.findOneAndUpdate(
          { remetenteOriginal: remetente, ativa: true },
          { $push: { mensagensExtras: textoExtra } }
        );

        io.emit('mensagem_extra_espera', {
          numero: remetente.replace('@s.whatsapp.net', '').replace('@lid', ''),
          mensagem: textoExtra,
          remetenteOriginal: remetente
        });
        
        continue;
      }

      let triagem = null;

      if (msg.message.audioMessage) {
        console.log(`🎤 Baixando e processando áudio de "${nomeCliente}"...`);
        try {
          const bufferAudio = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { 
              logger: pino({ level: 'silent' }),
              reuploadRequest: sock.updateMediaMessage 
            }
          );

          const mimeType = msg.message.audioMessage.mimetype || 'audio/ogg';
          triagem = await processarAudioCliente(nomeCliente, bufferAudio, mimeType);

          if (triagem.transcricao) {
            console.log(`💬 Transcrição do Áudio: "${triagem.transcricao}"`);
          }
        } catch (err) {
          console.error('Erro ao baixar mídia de áudio:', err);
          continue;
        }
      } else {
        const textoMensagem = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!textoMensagem || textoMensagem.trim() === '') continue;

        triagem = await processarMensagemCliente(nomeCliente, textoMensagem);
      }

      if (triagem) {
        if (triagem.respostaParaCliente) {
          await sock.sendMessage(remetente, { text: triagem.respostaParaCliente });
        }

        if (triagem.transferirParaBalcao === true) {
          await atualizarEstadoCliente(remetente, ESTADOS.AGUARDANDO_HUMANO);

          const dadosTriagem = {
            idMensagem: msg.key.id,
            remetenteOriginal: remetente,
            horario: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
            numero: remetente.replace('@s.whatsapp.net', '').replace('@lid', ''),
            nomeCliente,
            intencao: triagem.intencao,
            urgencia: triagem.urgencia || false,
            transcricao: triagem.transcricao || '',
            itensFiltradosParaOrcamento: triagem.itensFiltradosParaOrcamento || [],
            observacoesDoCliente: triagem.observacoesDoCliente || '',
            resumoTriagem: triagem.resumoTriagem,
            respostaParaCliente: triagem.respostaParaCliente,
            mensagensExtras: [],
            ativa: true
          };

          await Triagem.findOneAndUpdate(
            { remetenteOriginal: remetente },
            dadosTriagem,
            { upsert: true, new: true }
          );

          io.emit('nova_triagem', dadosTriagem);
        } else {
          console.log(`[Autoatendimento] Atendimento de "${nomeCliente}" concluído sem transferência.`);
        }
      }
    }
  });
}

// =============================================================================
// EVENTOS DO SOCKET.IO (GERAÇÃO DE CÓDIGO COM RECONEXÃO AUTOMÁTICA)
// =============================================================================
io.on('connection', async (socket) => {
  if (whatsappConectado) {
    socket.emit('whatsapp_status', 'Conectado com sucesso!');
  } else {
    socket.emit('whatsapp_status', 'Desconectado');
  }

  socket.on('solicitar_codigo_pareamento', async (numeroTelefone) => {
    try {
      const numeroLimpo = numeroTelefone.replace(/\D/g, '');

      if (!numeroLimpo || numeroLimpo.length < 10) {
        socket.emit('erro_pareamento', 'Número de telefone inválido. Digite com DDD.');
        return;
      }

      // Verifica se o WhatsApp já está realmente conectado e registrado
      if (sock?.authState?.creds?.registered && whatsappConectado) {
        socket.emit('whatsapp_status', 'Este WhatsApp já está conectado!');
        return;
      }

      // Se o socket estiver inativo, reinicia antes de tentar gerar
      if (!sock || !sock.ws || !sock.ws.isOpen) {
        console.log('🔄 Socket do WhatsApp inativo. Reiniciando instância para novo código...');
        await connectToWhatsApp();
      }

      const aguardarEGerarCodigo = async (tentativas = 0) => {
        if (sock?.ws?.isOpen) {
          try {
            const codigo = await sock.requestPairingCode(numeroLimpo);
            console.log(`🔑 Código de Pareamento Gerado: ${codigo}`);
            socket.emit('codigo_pareamento_gerado', codigo);
          } catch (errCodigo) {
            console.error('Erro ao chamar requestPairingCode:', errCodigo);
            socket.emit('erro_pareamento', 'Falha no WhatsApp. Aguarde alguns segundos e clique em Gerar Código novamente.');
          }
        } else if (tentativas < 15) {
          console.log(`[PAREAMENTO] Aguardando conexão pronta... (tentativa ${tentativas + 1})`);
          setTimeout(() => aguardarEGerarCodigo(tentativas + 1), 1000);
        } else {
          socket.emit('erro_pareamento', 'O WhatsApp demorou para responder. Clique em Gerar Código novamente.');
        }
      };

      await aguardarEGerarCodigo();

    } catch (err) {
      console.error('Erro ao gerar código de pareamento:', err.message);
      socket.emit('erro_pareamento', 'Erro ao processar solicitação.');
    }
  });

  try {
    const listaTriagens = await Triagem.find({ ativa: true });
    socket.emit('carregar_triagens_iniciais', listaTriagens);
  } catch (err) {
    console.error('Erro ao buscar triagens no MongoDB:', err.message);
  }

  socket.on('finalizar_atendimento', async (data) => {
    const { remetenteOriginal, numero } = data;
    const targetId = remetenteOriginal || `${numero}@s.whatsapp.net`;
    
    await atualizarEstadoCliente(targetId, ESTADOS.BOT_TRIAGEM);
    await Triagem.findOneAndUpdate({ remetenteOriginal: targetId }, { ativa: false });

    io.emit('atendimento_finalizado', { remetenteOriginal: targetId, numero });
    console.log(`[PAINEL] Atendimento de ${numero} foi finalizado. Bot reativado para este cliente.`);
  });
});

// Inicialização
async function iniciar() {
  await conectarBanco();
  await connectToWhatsApp();

  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log('--------------------------------------------------');
    console.log(` Painel da Farmácia rodando na porta: ${PORT}`);
    console.log('--------------------------------------------------');

    if (process.env.NODE_ENV !== 'production') {
      try {
        await open(url);
      } catch (err) {
        console.log('Acesse no navegador:', url);
      }
    }
  });
}

iniciar();
