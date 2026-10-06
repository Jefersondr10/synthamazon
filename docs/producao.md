# SynthAmazon em produção

## Arquitetura

A aplicação é publicada em `https://synthamazon.nucleodeoperacao.com.br/`, no diretório `/docker/synthamazon` da VPS Hostinger. O login usa Google por meio do OAuth2 Proxy, com lista explícita de contas autorizadas.

`deploy/compose.yml` define os serviços:

- `app`: servidor Node.js, interface e SQLite persistente, em rede interna.
- `login`: OAuth2 Proxy, conectado à rede interna e ao gateway HTTPS.
- `collector`: coletor Amazon separado, com uma execução por loja e checkpoints persistidos.

A próxima rodada de cada loja é planejada para 15 minutos após o término da anterior. Limites e demora da Amazon podem ampliar o intervalo real. A interface consulta dados já importados; atualizar a tela não dispara uma coleta completa.

## Arquivos fora do repositório

- `data/`: banco SQLite, arquivos auxiliares, coletas, histórico e snapshots de custos.
- `secrets/oauth2.cfg`, `secrets/google-client-secret`, `secrets/cookie-secret` e `secrets/proxy-password`.
- `secrets/amazon/<storeId>.json`: uma autorização independente por loja.
- `config/erp-costs.json`: configuração privada da empresa e do escopo da integração de custos.
- Backups e logs de operação.

Os arquivos de segredo montados no Docker precisam ser legíveis pelo UID 1000, com acesso restrito. Use o modelo `deploy/oauth2.cfg.example` para configurar o login. As credenciais locais DPAPI do Windows não são portáveis para o Linux.

## Publicação

Um commit ou push no GitHub **não altera a produção automaticamente**. A publicação continua sendo uma etapa separada, após revisar e testar a versão.

```sh
node --test
docker compose -f deploy/compose.yml build app
docker compose -f deploy/compose.yml up -d --no-deps app
docker compose -f deploy/compose.yml --profile collect ps
```

Antes de publicar, preserve uma versão anterior da imagem e confira quais serviços usam os arquivos alterados. Alterações somente na interface não exigem reiniciar login ou coletor. Mudanças no coletor precisam de uma transição controlada, sem importação concorrente para a mesma loja. Não sobrescreva `data/`, `secrets/` nem configurações privadas ao atualizar o código.

O upstream do login é `http://synthamazon-backend:3000/`. O aplicativo valida a identidade recebida do proxy junto com o segredo privado, Host, HTTPS e, nas gravações, Origin e CSRF. Preserve esse contrato. A rede confiável do proxy deve corresponder à rede real do gateway.

## Backups e restauração

`deploy/backup.py` e os arquivos `synthamazon-backup.service` e `.timer` fazem parte da rotina de cópias consistentes do SQLite. Os dados e as credenciais precisam ser preservados separadamente do código. Uma cópia mantida apenas na mesma VPS não protege contra a perda completa do servidor.

Para restaurar o SQLite, pare todos os escritores, preserve uma cópia consistente do estado atual, valide `PRAGMA integrity_check` na cópia escolhida e só então substitua a base. Trate WAL/SHM com os escritores parados e confira permissões antes de reiniciar. Não restaure uma base antiga sobre anotações recentes sem reconciliação.

## Integração de custos

Os arquivos `export-erp-costs.py`, `erp-cost-history.sql` e `synthamazon-erp-costs.*` mantêm a integração com o ERP. O exportador confere empresa e lojas autorizadas antes de gerar um snapshot mínimo e atômico. Os vínculos explícitos do ERP são preservados e os custos já registrados nas vendas não são recalculados quando o custo atual muda.
