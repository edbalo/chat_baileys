import mongoose from 'mongoose';

export async function conectarBanco() {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('A variável MONGODB_URI não foi definida no arquivo .env ou no Render.');
    }
    await mongoose.connect(uri);
    console.log('✅ Conectado ao MongoDB com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao conectar ao MongoDB:', error.message);
    process.exit(1);
  }
}