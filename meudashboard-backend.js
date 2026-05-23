/**
 * MeuDashboard - Backend Node.js
 * Rastreamento de produtividade via WhatsApp
 */

const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const mongoose = require('mongoose');
const { Anthropic } = require('@anthropic-ai/sdk');
const speech = require('@google-cloud/speech');
const socketIO = require('socket.io');
const cors = require('cors');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

app.use(express.json());
app.use(cors());
app.use(express.static('.'));

const server = require('http').createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).catch(err => console.log('MongoDB erro:', err.message));

const atividadeSchema = new mongoose.Schema({
  usuario_id: String,
  timestamp: { type: Date, default: Date.now },
  dia: String,
  hora_inicio: String,
  hora_fim: String,
  tipo_atividade: String,
  cliente: String,
  produto: String,
  valor: Number,
  duracao_minutos: Number,
  contexto: String,
  status: String,
  transcript: String,
  whatsapp_message_id: String
});

const Atividade = mongoose.model('Atividade', atividadeSchema);

// WEBHOOK WhatsApp
app.post('/webhook', async (req, res) => {
  try {
    const { entry } = req.body;
    
    if (!entry || !entry[0] || !entry[0].changes[0]) {
      return res.status(200).send('OK');
    }

    const message = entry[0].changes[0].value.messages?.[0];
    const from = entry[0].changes[0].value.contacts?.[0].wa_id;

    if (!message) {
      return res.status(200).send('OK');
    }

    console.log(`📱 Nova mensagem: ${message.type}`);

    if (message.type === 'audio') {
      await processarAudio(message, from);
    } else if (message.type === 'text') {
      await processarTexto(message.text.body, from);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Erro webhook:', error);
    res.status(200).send('OK');
  }
});

// Verificar webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_TOKEN) {
    console.log('✓ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// Processar áudio
async function processarAudio(message, from) {
  try {
    console.log('🎙️  Processando áudio...');

    const mediaId = message.audio.id;
    const audioBuffer = await baixarAudioWhatsApp(mediaId);
    const transcript = await transcreverAudio(audioBuffer);
    console.log(`📝 Transcrição: "${transcript}"`);

    const dados = await extrairDadosComIA(transcript);
    console.log('✓ Dados extraídos:', dados);

    const atividade = new Atividade({
      usuario_id: from,
      dia: new Date().toDateString(),
      hora_inicio: dados.hora_inicio,
      hora_fim: dados.hora_fim,
      tipo_atividade: dados.tipo_atividade,
      cliente: dados.cliente,
      produto: dados.produto,
      valor: dados.valor,
      duracao_minutos: dados.duracao_minutos,
      contexto: dados.contexto,
      status: dados.status,
      transcript: transcript,
      whatsapp_message_id: message.id
    });

    await atividade.save();
    console.log('💾 Salvo no banco');

    notificarDashboard(from, dados);
    await responderWhatsApp(from, dados);

  } catch (error) {
    console.error('❌ Erro ao processar áudio:', error.message);
  }
}

// Baixar áudio
async function baixarAudioWhatsApp(mediaId) {
  try {
    console.log(`📥 Baixando áudio ${mediaId}...`);

    const metaResponse = await axios.get(
      `https://graph.instagram.com/v17.0/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      }
    );

    const audioUrl = metaResponse.data.url;

    const audioResponse = await axios.get(audioUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer'
    });

    return audioResponse.data;
  } catch (error) {
    console.error('❌ Erro ao baixar:', error.message);
    throw error;
  }
}

// Transcrever
async function transcreverAudio(audioBuffer) {
  try {
    const speechClient = new speech.SpeechClient();

    const audio = {
      content: Buffer.from(audioBuffer).toString('base64')
    };

    const config = {
      encoding: 'OGG_OPUS',
      sampleRateHertz: 16000,
      languageCode: 'pt-BR',
    };

    const request = { audio, config };

    console.log('🎤 Transcrevendo...');
    const [response] = await speechClient.recognize(request);

    const transcript = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');

    if (!transcript) {
      throw new Error('Nenhum texto transcrito');
    }

    console.log('✓ Transcrição ok');
    return transcript;
  } catch (error) {
    console.error('❌ Erro transcrição:', error.message);
    throw error;
  }
}

// Extrair com IA
async function extrairDadosComIA(transcript) {
  try {
    console.log('🤖 Enviando para Claude...');

    const client = new Anthropic();

    const message = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: `Analise este áudio de trabalho em português:

"${transcript}"

Extraia em JSON (sem markdown, só JSON puro):
{
  "hora_inicio": "HH:MM ou null",
  "hora_fim": "HH:MM ou null",
  "tipo_atividade": "Reunião|Proposta|Follow-up|Chegada|Pausa|Prospecção|Admin|Outro",
  "cliente": "Nome ou null",
  "produto": "Produto ou null",
  "valor": número ou null,
  "duracao_minutos": número ou null,
  "contexto": "Descrição breve",
  "status": "Completo|Agendado|Ativo",
  "confidence": 0.95
}

Responda APENAS com JSON válido.`
        }
      ],
    });

    const jsonText = message.content[0].text.trim();
    const cleanJson = jsonText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const dados = JSON.parse(cleanJson);
    console.log('✓ Dados extraídos');
    return dados;
  } catch (error) {
    console.error('❌ Erro extração:', error.message);
    throw error;
  }
}

// Processar texto
async function processarTexto(texto, from) {
  try {
    console.log('📝 Processando texto...');
    
    const dados = await extrairDadosComIA(texto);
    
    const atividade = new Atividade({
      usuario_id: from,
      dia: new Date().toDateString(),
      hora_inicio: dados.hora_inicio,
      hora_fim: dados.hora_fim,
      tipo_atividade: dados.tipo_atividade,
      cliente: dados.cliente,
      produto: dados.produto,
      valor: dados.valor,
      duracao_minutos: dados.duracao_minutos,
      contexto: dados.contexto,
      status: dados.status,
      transcript: texto
    });

    await atividade.save();
    notificarDashboard(from, dados);
    await responderWhatsApp(from, dados);
  } catch (error) {
    console.error('❌ Erro texto:', error);
  }
}

// Notificar dashboard
function notificarDashboard(usuarioId, dados) {
  try {
    console.log('📤 Atualizando dashboard...');
    io.to(usuarioId).emit('novaAtividade', {
      timestamp: new Date(),
      ...dados
    });
    console.log('✓ Dashboard notificado');
  } catch (error) {
    console.error('❌ Erro notificação:', error);
  }
}

// Responder WhatsApp
async function responderWhatsApp(from, dados) {
  try {
    console.log('💬 Enviando confirmação...');

    const mensagem = `✅ Atividade registrada!

📌 ${dados.tipo_atividade}
${dados.cliente ? `👤 ${dados.cliente}` : ''}
${dados.produto ? `📦 ${dados.produto}` : ''}
⏱️ ${dados.duracao_minutos || '?'} min
${dados.valor ? `💰 R$ ${(dados.valor / 1000).toFixed(1)}K` : ''}`;

    await axios.post(
      `https://graph.instagram.com/v17.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: mensagem }
      },
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      }
    );

    console.log('✓ Resposta enviada');
  } catch (error) {
    console.error('❌ Erro resposta:', error.message);
  }
}

// APIs
app.get('/api/atividades/:usuarioId', async (req, res) => {
  try {
    const { usuarioId } = req.params;
    const hoje = new Date().toDateString();

    const atividades = await Atividade.find({
      usuario_id: usuarioId,
      dia: hoje
    }).sort({ timestamp: -1 });

    const totalMinutos = atividades.reduce((sum, a) => sum + (a.duracao_minutos || 0), 0);
    const totalCaptacao = atividades.reduce((sum, a) => sum + (a.valor || 0), 0);

    res.json({
      atividades,
      metricas: {
        horas: (totalMinutos / 60).toFixed(1),
        atividades: atividades.length,
        captacao: totalCaptacao,
        producaoHora: totalCaptacao > 0 ? Math.round(totalCaptacao / (totalMinutos / 60) / 1000) + 'K' : '0K'
      }
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// Socket.io
io.on('connection', (socket) => {
  console.log(`✓ Cliente: ${socket.id}`);

  socket.on('autenticar', (usuarioId) => {
    socket.join(usuarioId);
    console.log(`✓ ${usuarioId} online`);
  });

  socket.on('disconnect', () => {
    console.log(`✗ Desconectado: ${socket.id}`);
  });
});

// Iniciar
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║     🎯 MeuDashboard - Rodando              ║
║     Porta: ${PORT}                        ║
╚════════════════════════════════════════════╝
  `);
});

module.exports = app;
