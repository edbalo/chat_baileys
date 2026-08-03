import mongoose from 'mongoose';

const SessaoClienteSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true }, // ex: "551199999999@s.whatsapp.net"
  estado: { 
    type: String, 
    enum: ['BOT_TRIAGEM', 'AGUARDANDO_HUMANO', 'CONCLUIDO'], 
    default: 'BOT_TRIAGEM' 
  },
  historico: { type: Array, default: [] },
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.model('SessaoCliente', SessaoClienteSchema);