import mongoose from 'mongoose';

const TriagemSchema = new mongoose.Schema({
  remetenteOriginal: { type: String, required: true, unique: true }, // Serve de ID único
  idMensagem: { type: String },
  horario: { type: String },
  numero: { type: String },
  nomeCliente: { type: String },
  intencao: { type: String },
  urgencia: { type: Boolean, default: false },
  transcricao: { type: String, default: '' },
  itensFiltradosParaOrcamento: [String],
  observacoesDoCliente: { type: String, default: '' },
  resumoTriagem: { type: String },
  respostaParaCliente: { type: String },
  mensagensExtras: [String],
  ativa: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Triagem', TriagemSchema);