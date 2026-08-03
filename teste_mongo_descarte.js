import mongoose from 'mongoose';

// Substitua <usuario>, <senha> e ajuste a URL com a sua string do Atlas:
const MONGO_URI = 'mongodb://batilsta_db_user:8oxejfSb9SIK5e26@ac-xxorafv-shard-00-00.ihpcism.mongodb.net:27017,ac-xxorafv-shard-00-01.ihpcism.mongodb.net:27017,ac-xxorafv-shard-00-02.ihpcism.mongodb.net:27017/?ssl=true&replicaSet=atlas-epxfai-shard-0&authSource=admin&appName=Cluster0';

async function testarConexao() {
  try {
    console.log('⏳ Conectando ao MongoDB Atlas...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conexão estabelecida com sucesso!');

    // 1. Definir um modelo simples de teste
    const TesteSchema = new mongoose.Schema({
      mensagem: String,
      data: { type: Date, default: Date.now }
    });

    const TesteModel = mongoose.model('Teste', TesteSchema);

    // 2. Criar e salvar um documento de teste
    console.log('📝 Salvando um registro de teste...');
    const novoRegistro = await TesteModel.create({
      mensagem: 'Teste de conexão executado com sucesso!'
    });
    console.log('📄 Registro criado:', novoRegistro);

    // 3. Buscar o registro inserido
    const busca = await TesteModel.findById(novoRegistro._id);
    console.log('🔍 Registro lido do banco:', busca);

    // 4. Limpar o teste e fechar a conexão
    await TesteModel.deleteOne({ _id: novoRegistro._id });
    console.log('🗑️ Registro de teste removido.');

    await mongoose.disconnect();
    console.log('🔌 Conexão encerrada.');

  } catch (erro) {
    console.error('❌ Erro durante o teste:', erro.message);
  }
}

testarConexao();