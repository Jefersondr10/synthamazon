# SynthAmazon

Sistema de gestão da Amazon Brasil para ORIGEM COMERCIO, HD COMÉRCIO e MultiVendas Prime. Interface web com temas claro/escuro, seleção de uma ou várias lojas e adaptação para celular.

- **Produção:** https://synthamazon.nucleodeoperacao.com.br/
- **Repositório privado:** https://github.com/Jefersondr10/synthamazon

## Funcionalidades

- Dashboard financeiro, pedidos, lançamentos e rastreio operacional.
- Gerenciamento individual e em massa de reembolsos, devoluções e cobranças, com status da análise, anotações, ID do caso e protocolos SAFE-T.
- Estoque FBA com previsão de duração, planejamento, alertas e relatório para download.
- Vendas por produto com períodos, canais, ranking e alertas de mudança de desempenho.
- Custos integrados ao sistema de estoque, vinculação de produtos agrupada por ASIN e custo registrado por venda sem recalcular vendas anteriores.
- Coletas da SP-API em processo separado, histórico com checkpoints e base SQLite persistente.

O status operacional informado pela Amazon é somente para consulta. O acompanhamento da equipe é editado em **Status da análise**. Protocolos SAFE-T conhecidos são metadados; sua presença não comprova pagamento.

## Requisitos e execução local

Requer Node.js 24 ou superior, com SQLite integrado. A aplicação não tem dependências npm externas. O cofre de credenciais local é específico do Windows e usa Python 3 com DPAPI.

```sh
node --test
node src/cli.mjs check
npm start
```

No PowerShell, use `npm.cmd` caso a política local bloqueie o script `npm.ps1`. A aplicação local escuta apenas em `127.0.0.1` e informa um link temporário para iniciar a sessão. Esse link não deve ser compartilhado.

Sem dados e credenciais configurados, o clone não contém pedidos reais nem faz importações automaticamente. As configurações não secretas das lojas ficam em `config/`; prefixos de variáveis de ambiente são definidos em cada arquivo. Para a configuração local, consulte `src/setup.mjs` e os scripts específicos de loja em `scripts/`.

```sh
npm run pilot:setup
npm run pilot:collect
npm run monitor
```

Esses comandos usam a loja padrão. O coletor de produção gerencia as três lojas separadamente. Evite importadores concorrentes para a mesma loja.

## Produção

A VPS executa aplicação, login Google e coletor em serviços separados. Veja [instruções de produção](docs/producao.md) e [configuração Docker](deploy/compose.yml). Enviar código ao GitHub não publica alterações automaticamente na VPS.

## Estrutura

| Diretório | Conteúdo |
| --- | --- |
| `public/` | Interface, estilos e módulos das telas |
| `src/` | Servidor, coletores, persistência e regras de negócio |
| `config/` | Configurações não secretas das lojas |
| `deploy/` | Docker, serviços, backups e integração de custos |
| `scripts/` | Configuração e verificações locais |
| `test/` | Testes automatizados com dados fictícios |
| `docs/` | Instruções de produção revisadas |

Os relatórios internos das etapas anteriores permanecem fora do repositório. As regras funcionais atuais são implementadas no código e nos testes.

## Dados e credenciais

O GitHub contém o código, não os dados da operação. Bancos SQLite, coletas Amazon, custos importados, credenciais, tokens, chaves, logs e backups ficam fora do versionamento. O arquivo de exemplo do OAuth contém apenas referências e marcadores, nunca os segredos reais.

Os dados persistidos e as credenciais precisam de backups próprios. Clonar este repositório não recupera pedidos, anotações, vínculos de produtos nem o histórico de custos de uma instalação existente. Datas, custos e créditos desconhecidos permanecem explicitamente ausentes; não devem ser substituídos por valores inventados.
