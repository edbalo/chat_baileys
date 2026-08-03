import xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';

export function obterDadosPlanilha() {
  const caminhoPlanilha = path.resolve('./dados/informacoes.xlsx');

  // Verifica se o arquivo existe antes de tentar ler
  if (!fs.existsSync(caminhoPlanilha)) {
    return '[] (Nenhuma planilha de produtos foi cadastrada ainda)';
  }

  try {
    const workbook = xlsx.readFile(caminhoPlanilha);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const dados = xlsx.utils.sheet_to_json(sheet);
    return JSON.stringify(dados, null, 2);
  } catch (error) {
    console.error('Erro ao ler a planilha Excel:', error.message);
    return '[]';
  }
}