# QuickDrop Text Clipboard — plano de produto e implementação

> Documento vivo. Atualize os checkboxes e o histórico ao concluir cada PR.
>
> Status geral: **planejado**  
> Última atualização: 2026-08-12

## Visão

Transformar a atual “Sala de texto” em um clipboard temporário entre máquinas, acessível pela web e, progressivamente, pela CLI, tray do Windows e barra do Linux.

A promessa principal deve caber em uma frase:

> Digite o mesmo código nas duas máquinas. Se ainda não existir, o QuickDrop cria; se existir, abre.

O usuário não deve precisar entender a diferença entre criar e entrar, cadastrar uma conta ou transportar um código aleatório quando a conveniência for mais importante que a privacidade.

## Problema atual

A implementação atual tem uma base técnica útil — persistência em PostgreSQL, WebSocket, presença, edição em tempo real, PIN, expiração e exportação — mas apresenta o produto como uma sala colaborativa, enquanto o trabalho principal é transferir texto rapidamente.

Problemas identificados:

- “Código da sala” parece permitir escolher o código, mas serve somente para entrar.
- “Criar nova sala” ignora o código preenchido e gera outro código.
- As ações “Entrar” e “Criar nova sala” obrigam o usuário a conhecer uma distinção desnecessária.
- Códigos aleatórios de seis caracteres são inconvenientes quando não há clipboard compartilhado.
- PIN aparece antes de ser necessário e aumenta a carga cognitiva.
- “Copiar código” e “Enviar como arquivo” têm destaque, mas falta a ação primária “Copiar texto”.
- Presença, cursores e colaboração têm mais destaque que o ato de enviar e copiar conteúdo.
- `/?c=CODIGO` funciona, mas `/t/CODIGO` é mais legível e fácil de ditar/digitar.
- O modelo atual usa `code` como chave primária; uma sala removida por soft delete impede reutilizar o mesmo código no futuro.

## Princípios de produto

1. **Um código, uma ação:** abrir e criar fazem parte da mesma operação.
2. **Progressive disclosure:** opções de segurança aparecem quando solicitadas, não no caminho principal.
3. **Rápido por padrão, privado por escolha:** códigos curtos são convenientes, mas adivinháveis; isso deve ser explícito.
4. **Texto primeiro:** colar e copiar devem ser as ações mais evidentes.
5. **URLs humanas:** a URL compartilhável deve ser `/t/CODIGO`.
6. **Efêmero por padrão:** códigos públicos curtos não podem deixar texto abandonado por longos períodos.
7. **Sem becos arquiteturais:** web, desktop, tray/bar e CLI devem reutilizar o mesmo núcleo de domínio.
8. **Privacidade de métricas:** medir somente eventos de funil; nunca armazenar código, PIN ou conteúdo em analytics.

## Referências de mercado

- **Dontpad / cl1p.net:** URL ou nome escolhido pelo usuário; abrir o mesmo endereço em outra máquina.
- **Magic Wormhole:** códigos humanos, descartáveis e apropriados para digitação manual; transferência com confirmação entre peers.
- **PairDrop:** descoberta e pareamento persistente entre dispositivos, envio de texto e integração com SO/CLI.
- **Wormhole:** criptografia no cliente e chave no fragmento da URL, que não é enviado ao servidor.
- **KDE Connect:** clipboard entre dispositivos conhecidos, com ação nativa no sistema operacional.

O diferencial desejado é combinar a simplicidade de um clipboard por código, uma evolução segura para conteúdo privado e integração nativa com máquinas recorrentes.

---

# Roadmap em PRs

## Fase 1 — Quick Code

Objetivo: validar o fluxo de menor atrito usando a infraestrutura atual, sem ainda transformar o documento em timeline ou integrar texto ao tray/bar.

### PR 1 — Fundamento de códigos reutilizáveis

**Status:** planejado

**Objetivo:** preparar o domínio e o banco para códigos personalizados que possam ser reutilizados após a expiração.

- [ ] Criar `id` UUID como chave primária de `text_rooms`.
- [ ] Manter `code` como identificador público normalizado.
- [ ] Adicionar unicidade somente para salas ativas (`deleted_at is null`).
- [ ] Migrar salas existentes sem perder conteúdo ou expiração.
- [ ] Permitir reutilizar um código depois do soft delete.
- [ ] Definir e testar corrida de criação do mesmo código.
- [ ] Preservar criação aleatória e endpoints existentes durante a transição.
- [ ] Documentar rollback e compatibilidade da migração.

**Critérios de aceite:**

- Duas requisições concorrentes não criam duas salas ativas com o mesmo código.
- Um código de sala expirada pode ser criado novamente.
- Salas existentes continuam acessíveis.
- Testes de repositório, serviço, migração e suíte completa passam.

### PR 2 — API atômica “abrir ou criar”

**Status:** planejado

**Objetivo:** remover da API de produto a distinção entre entrar e criar para o modo rápido.

- [ ] Definir normalização e caracteres permitidos para códigos personalizados.
- [ ] Aceitar códigos de 1 a 16 caracteres.
- [ ] Implementar operação atômica `open-or-create`.
- [ ] Retornar `{ code, created, protected }`.
- [ ] Se a sala existir, abrir normalmente.
- [ ] Se não existir, criar com o código solicitado.
- [ ] Tratar colisão protegida sem revelar conteúdo ou detalhes indevidos.
- [ ] Manter `POST /api/text` com código aleatório para compatibilidade e modo privado.
- [ ] Aplicar rate limit à criação sem bloquear aberturas legítimas de forma excessiva.
- [ ] Adicionar testes de código mínimo, máximo, normalização, inválido, concorrência, PIN e expiração.

**Decisão proposta para validação:** letras ASCII, números, `_` e `-`, normalizados em maiúsculas, sem espaços, de 1 a 16 caracteres. Reservar slugs de aplicação como `API`, `INSTALL`, `WINDOWS`, `LINUX` e `F` se a rota curta de host dedicado for adotada.

### PR 3 — Nova entrada “Um código, uma ação”

**Status:** planejado

**Objetivo:** entregar o novo modelo mental na web.

- [ ] Trocar “Sala de texto” por “Clipboard temporário”.
- [ ] Trocar “Código da sala” por “Digite um código”.
- [ ] Exibir exemplo que inclua código de uma letra.
- [ ] Substituir “Entrar” + “Criar nova sala” por um único botão “Abrir”.
- [ ] Submeter com Enter.
- [ ] Consumir a operação `open-or-create`.
- [ ] Mostrar feedback contextual: “Clipboard criado” ou “Clipboard aberto”.
- [ ] Mover PIN para “Opções de privacidade”.
- [ ] Manter ação secundária “Gerar código privado”.
- [ ] Explicar que códigos curtos são públicos e adivinháveis.
- [ ] Reduzir o espaço vertical e priorizar campo + ação acima da dobra.
- [ ] Garantir estados de loading, erro e navegação por teclado.
- [ ] Garantir layout mobile e desktop.

**Wireframe de referência:**

```text
Compartilhe texto entre máquinas

Digite o mesmo código nos dois computadores.

[ A, DEV, SERVER1, 42...                     ] [ Abrir ]

Pode ser uma letra, palavra ou número.
Não use códigos simples para conteúdo sensível.

[ Gerar código privado ]
```

### PR 4 — Clipboard orientado a copiar

**Status:** planejado

**Objetivo:** tornar recebimento e cópia mais óbvios que colaboração visual.

- [ ] Adicionar “Copiar texto” como ação primária quando houver conteúdo.
- [ ] Adicionar feedback “Copiado”.
- [ ] Adicionar “Limpar” com confirmação adequada.
- [ ] Adicionar “Compartilhar link”.
- [ ] Usar `/t/CODIGO` como URL canônica visível e copiável.
- [ ] Destacar discretamente conteúdo remoto novo.
- [ ] Manter foco no editor quando o clipboard estiver vazio.
- [ ] Evitar sobrescrever seleção/edição local sem aviso.
- [ ] Rebaixar “Enviar como arquivo” para ação secundária.
- [ ] Simplificar ou ocultar cursores remotos e typing no modo clipboard.
- [ ] Revisar acessibilidade e atalhos de teclado.

### PR 5 — Expiração e segurança do modo rápido

**Status:** planejado

**Objetivo:** reduzir o risco de códigos curtos reutilizados exporem conteúdo abandonado.

- [ ] Separar política de TTL por tipo de sala (`custom` e `generated/private`).
- [ ] Usar TTL inicial recomendado de 30 minutos após o último cliente sair para códigos personalizados públicos.
- [ ] Não expirar enquanto houver clientes conectados.
- [ ] Exibir a expiração na interface.
- [ ] Implementar “Limpar agora”.
- [ ] Avaliar opção “Apagar depois de copiar”.
- [ ] Garantir limpeza de dados e reutilização do código após expiração.
- [ ] Revisar enumeração, brute force, logs e mensagens de erro.
- [ ] Não afirmar que código curto é secreto.
- [ ] Definir headers de segurança e política de cache para texto.

### PR 6 — Métricas de funil com privacidade

**Status:** planejado

**Objetivo:** descobrir onde o fluxo perde usuários sem coletar conteúdo sensível.

- [ ] Definir provedor ou armazenamento agregado antes de instrumentar.
- [ ] Medir abertura da tela de clipboard.
- [ ] Medir abrir/criar código, somente com resultado e tipo — nunca o código.
- [ ] Medir primeira publicação de texto, somente como evento.
- [ ] Medir conexão do segundo dispositivo.
- [ ] Medir uso de “Copiar texto”.
- [ ] Medir erro por categoria técnica.
- [ ] Documentar retenção, anonimização e opt-out, se aplicável.
- [ ] Criar painel do funil: visita → clipboard aberto → texto publicado → segundo dispositivo → cópia.

## Definição de conclusão da Fase 1

- [ ] Um usuário consegue digitar `A` nas duas máquinas e compartilhar texto sem distinguir criar de entrar.
- [ ] O fluxo principal exige um campo e uma ação.
- [ ] O texto recebido possui ação de cópia evidente.
- [ ] A URL pública é humana e fácil de digitar.
- [ ] Códigos públicos têm expiração curta e aviso de segurança.
- [ ] Códigos expirados podem ser reutilizados.
- [ ] O fluxo antigo de código aleatório continua disponível como modo privado/compatível.
- [ ] O funil pode ser avaliado sem registrar código ou conteúdo.

---

## Fase 2 — Feed de clipboard e integrações rápidas

Objetivo: substituir gradualmente o documento único por drops independentes e levar o fluxo aos ambientes em que abrir o navegador é inconveniente.

### PRs propostas

#### PR 7 — Modelo de drops

- [ ] Criar entidade `text_drops` associada ao clipboard.
- [ ] Cada envio gera um item independente e imutável.
- [ ] Definir retenção e limite de itens/tamanho.
- [ ] Migrar ou representar o texto legado sem perda.
- [ ] Eliminar conflitos last-writer-wins no fluxo principal.

#### PR 8 — Timeline compacta

- [ ] Mostrar itens recentes em ordem cronológica.
- [ ] Copiar, excluir e reenviar individualmente.
- [ ] Detectar visualmente URL, comando, JSON e texto comum sem executar conteúdo.
- [ ] Oferecer “Limpar todos”.

#### PR 9 — CLI multiplataforma

- [ ] Definir comando `qd`/`quickdrop text`.
- [ ] `echo "texto" | qd A` publica.
- [ ] `qd A` recebe/imprime.
- [ ] `qd A --copy` integra com clipboard local.
- [ ] Suportar Linux e Windows.
- [ ] Documentar uso em SSH, Guacamole e servidores.

#### PR 10 — QuickPanel no tray/bar

- [ ] Adicionar alternância Arquivo/Texto na janela compacta.
- [ ] “Colar e enviar” para código recente.
- [ ] “Esperar texto”/abrir clipboard.
- [ ] Mostrar códigos recentes somente no armazenamento local.
- [ ] Notificar novo texto com ação “Copiar”.
- [ ] Abrir experiência completa no navegador.
- [ ] Não ativar auto-cópia sem consentimento explícito.

## Definição de conclusão da Fase 2

- [ ] Vários snippets não se sobrescrevem.
- [ ] O usuário envia e recebe texto pelo terminal.
- [ ] Windows tray e barra Linux oferecem ações rápidas de texto.
- [ ] A web continua sendo a interface completa.

---

## Fase 3 — My Devices e privacidade ponta a ponta

Objetivo: eliminar códigos para máquinas recorrentes e oferecer um modo privado com garantias técnicas claras.

### PRs propostas

#### PR 11 — Identidade local e pareamento

- [ ] Criar identidade do dispositivo local, sem conta obrigatória.
- [ ] Parear por código ou QR de curta duração.
- [ ] Armazenar segredo longo no storage seguro disponível por plataforma.
- [ ] Nomear e revogar dispositivos.
- [ ] Não usar códigos humanos como segredo persistente.

#### PR 12 — Dispositivos conhecidos

- [ ] Listar peers conhecidos online/offline.
- [ ] “Enviar clipboard para Notebook/Servidor/Celular”.
- [ ] Entrega pendente com retenção claramente definida.
- [ ] Confirmação de entrega e cópia.
- [ ] Controles de bloqueio e revogação.

#### PR 13 — Private Drop com E2EE

- [ ] Elaborar threat model antes da implementação.
- [ ] Criptografar no cliente com primitivas Web Crypto auditáveis.
- [ ] Manter chave fora da parte da URL enviada ao servidor, por exemplo no fragmento.
- [ ] Autenticar leitura e escrita sem expor conteúdo.
- [ ] Definir rotação, expiração e recuperação impossível de chaves.
- [ ] Fazer revisão de segurança independente antes de prometer E2EE em produção.

#### PR 14 — PWA e compartilhamento nativo

- [ ] Instalação PWA.
- [ ] Web Share Target para receber texto compartilhado.
- [ ] Atalhos de ação rápida.
- [ ] QR para abrir/parear no celular.
- [ ] Avaliar service worker e notificações sem comprometer privacidade.

## Definição de conclusão da Fase 3

- [ ] Dispositivos recorrentes trocam texto sem digitar códigos.
- [ ] O usuário pode revogar qualquer dispositivo.
- [ ] Conteúdo privado é criptografado antes de chegar ao servidor.
- [ ] As garantias e limitações de segurança estão documentadas com precisão.

---

# Arquitetura-alvo

## Camadas de produto

### Quick Code

- Código escolhido pelo usuário.
- Público e adivinhável por natureza.
- Criação/abertura em uma ação.
- Curta duração.
- Sem cadastro.

### Private Drop

- Código ou link gerado.
- Uso único ou curta duração.
- PIN durante transição; E2EE como estado final.
- Adequado para conteúdo sensível somente quando a garantia criptográfica estiver entregue.

### My Devices

- Pareamento persistente.
- Segredos longos por dispositivo.
- Envio nativo pelo tray, barra, CLI e share menu.
- Revogação explícita.

## Evolução de dados sugerida

```text
text_rooms
  id uuid primary key
  code varchar(16) not null
  kind custom | generated | private
  created_at
  updated_at
  expires_at
  deleted_at

unique active code: (code) where deleted_at is null

text_drops (Fase 2)
  id uuid primary key
  room_id uuid references text_rooms(id)
  content text
  content_type text
  created_at
  expires_at
  deleted_at
```

O endpoint de abrir/criar deve ser atômico. O banco é a fonte da verdade para exclusividade; checar e depois inserir apenas na aplicação não é suficiente.

## Compatibilidade

Durante a Fase 1:

- preservar `POST /api/text` para criação aleatória;
- preservar `POST /api/text/:code/access` enquanto clientes existentes dependem dele;
- preservar WebSocket, snapshots e versão;
- introduzir o novo fluxo de forma aditiva;
- não remover PIN antes de existir alternativa privada;
- manter links `?c=` funcionando, mas promover `/t/CODIGO`.

## Segurança e abuso

- Códigos de uma letra têm espaço de busca minúsculo e devem ser tratados como públicos.
- Mensagens de produto não devem chamar códigos curtos de senha, segredo ou proteção.
- Criação e escrita precisam de rate limit; leitura precisa de defesa contra enumeração abusiva sem inviabilizar o uso.
- Nunca registrar conteúdo, PIN ou código completo em analytics.
- Revisar logs HTTP e WebSocket para evitar vazamento acidental.
- Conteúdo não deve entrar em cache compartilhado.
- E2EE só deve ser anunciado após implementação e revisão do threat model.

## Questões abertas

- [ ] Códigos devem aceitar somente ASCII ou Unicode normalizado?
- [ ] O código público será case-insensitive? A proposta atual é sim, normalizado em maiúsculas.
- [ ] `_` e `-` devem ser aceitos na primeira versão ou apenas letras/números?
- [ ] A operação abrir/criar de uma sala protegida pede PIN sem revelar que ela existe?
- [ ] Qual é o TTL ideal depois do último cliente: 15, 30 ou 60 minutos?
- [ ] “Apagar depois de copiar” será decisão de quem criou, de qualquer peer ou por item?
- [ ] A rota canônica continuará no domínio principal ou terá host curto dedicado?
- [ ] Quando migrar do documento único para drops: após métricas da Fase 1 ou em paralelo?
- [ ] Qual armazenamento seguro usar para identidade de dispositivo em cada plataforma?

# Processo de execução

Para cada PR:

1. Criar branch dedicada a partir de `main` atualizada.
2. Referenciar este documento na descrição.
3. Marcar o PR correspondente como **em andamento** neste arquivo.
4. Implementar apenas o escopo listado; novas ideias vão para questões abertas/backlog.
5. Incluir testes de regressão e critérios de aceite.
6. Atualizar README e regras de negócio quando o comportamento mudar.
7. Após merge, marcar checkboxes concluídos, registrar o PR no histórico e definir o próximo PR.

## Histórico

| PR | Escopo | Status | Link |
|---|---|---|---|
| — | Documento inicial do roadmap | Em revisão | — |
| 1 | Fundamento de códigos reutilizáveis | Planejado | — |
| 2 | API atômica abrir ou criar | Planejado | — |
| 3 | Nova entrada “Um código, uma ação” | Planejado | — |
| 4 | Clipboard orientado a copiar | Planejado | — |
| 5 | Expiração e segurança | Planejado | — |
| 6 | Métricas privadas do funil | Planejado | — |
