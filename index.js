import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason, 
  downloadMediaMessage 
} from '@whiskeysockets/baileys'; 
import pino from 'pino';
import open from 'open';
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
// CONEXÃO WHATSAPP
// =============================================================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }), 
    printQRInTerminal: false 
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrImageUrl = await QRCode.toDataURL(qr);
      io.emit('qr_code', qrImageUrl);
    }

    if (connection === 'open') {
      whatsappConectado = true;
      io.emit('whatsapp_status', 'Conectado com sucesso!');
    }

    if (connection === 'close') {
      whatsappConectado = false;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      io.emit('whatsapp_status', 'Conexão perdida. Tentando reconectar...');
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!MODO_TESTE && msg.key.fromMe) continue;
      if (!msg.message) continue;

      const remetente = msg.key.remoteJid;
      const nomeCliente = MODO_TESTE && msg.key.fromMe ? 'Você (Cliente Simulado)' : (msg.pushName || remetente.split('@')[0]);

      // 1. Busca estado no MongoDB
      const sessaoCliente = await obterEstadoCliente(remetente);

      if (sessaoCliente.estado === ESTADOS.AGUARDANDO_HUMANO) {
        console.log(`[TRAVA DO BOT] Mensagem de "${nomeCliente}" ignorada pela IA (Cliente em fila humana).`);
        
        const textoExtra = msg.message.conversation || msg.message.extendedTextMessage?.text || '[Mídia/Áudio]';
        
        // Atualiza a triagem no MongoDB adicionando a nova mensagem
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

          // Salva ou atualiza a triagem no MongoDB
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
// EVENTOS DO SOCKET.IO
// =============================================================================
io.on('connection', async (socket) => {
  if (whatsappConectado) {
    socket.emit('whatsapp_status', 'Conectado com sucesso!');
  } else {
    socket.emit('whatsapp_status', 'Desconectado');
  }

  // Carrega do MongoDB apenas as triagens ativas ao conectar/atualizar o painel
  try {
    const listaTriagens = await Triagem.find({ ativa: true });
    socket.emit('carregar_triagens_iniciais', listaTriagens);
  } catch (err) {
    console.error('Erro ao buscar triagens no MongoDB:', err.message);
  }

  socket.on('finalizar_atendimento', async (data) => {
    const { remetenteOriginal, numero } = data;
    const targetId = remetenteOriginal || `${numero}@s.whatsapp.net`;
    
    // Libera o bot para o cliente
    await atualizarEstadoCliente(targetId, ESTADOS.BOT_TRIAGEM);
    
    // Desativa a triagem no banco de dados
    await Triagem.findOneAndUpdate({ remetenteOriginal: targetId }, { ativa: false });

    io.emit('atendimento_finalizado', { remetenteOriginal: targetId, numero });
    console.log(`[PAINEL] Atendimento de ${numero} foi finalizado. Bot reativado para este cliente.`);
  });
});

// Inicialização: Conecta primeiro ao MongoDB e depois ao WhatsApp/Servidor
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